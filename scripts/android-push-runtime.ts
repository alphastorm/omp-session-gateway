import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseSessionListResponse } from "../packages/protocol/src/validation.ts";
import type { PushDetailLevel, SessionMetadata } from "../packages/protocol/src/types.ts";
import { withAndroidChrome, requireSingleDevice, parseAndroidPackageVersion, parseKeyguardShowing, readAndroidQualificationPin, resolveAndroidBrowserTarget,
  wakeAndroidDisplay, unlockAndroidKeyguard, showAndroidPinBouncer, type AndroidAdbCommand, type AndroidChromeDriver } from "./android-device.ts";
import { closeWebApk, openWebApk, requireWebApk, webApkTasks } from "./android-webapk.ts";
import { readAndroidUi, findAndroidNotification, tapAndroidNotification, readAndroidNotificationRecords, notificationMatchesDigest, trackUnchangedNotificationPost, NotificationOverlapError, type NotificationExpectation } from "./android-notification.ts";
import { commandPushFixture, executeFixture, type FixtureExecutor, type PushFixtureLocation } from "./push-qualification-fixture.ts";
import { PUSH_FIXTURE_ASK_BODY, PUSH_FIXTURE_ASK_TITLE } from "./fixtures/push-qualification-extension.ts";
import { PAGE_PRELUDE } from "./android-leak-probe.ts";
import type { AndroidPushIdentity, AndroidPushRuntime, PushBrowserBaseline, PushDeviceBaseline, PushTapObservation } from "./android-push-qualification.ts";

export interface AndroidPushRuntimeOptions {
  readonly fixtureBase?: string;
  readonly fixtureBinary?: string;
  readonly fixtureBun?: string;
  readonly fixtureScripts?: string;
  readonly execute?: FixtureExecutor;
  readonly gatewayLogsDiscarded?: () => Promise<boolean>;
}

export function isPushNotificationRoute(value: unknown, origin: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === origin && (url.pathname === "/collab" || url.pathname.startsWith("/collab/"));
  } catch { return false; }
}

export function observePushLaunch(session: Pick<SessionMetadata, "generation" | "ask">, kind: "attention" | "activity_stop", postData: unknown):
  { currentGeneration: boolean; currentRequest: boolean; modeMatches: boolean } {
  const invalid = { currentGeneration: false, currentRequest: false, modeMatches: false };
  if (typeof postData !== "string") return invalid;
  let body: unknown;
  try { body = JSON.parse(postData); } catch { return invalid; }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid;
  return { currentGeneration: "generation" in body && body.generation === session.generation,
    currentRequest: kind === "activity_stop" || (session.ask !== undefined && "requestId" in body && body.requestId === session.ask.requestId),
    modeMatches: "mode" in body && body.mode === (kind === "attention" ? "control" : "view") };
}

type PermissionConnection = (run: (driver: Pick<AndroidChromeDriver, "browserSend">) => Promise<void>) => Promise<void>;

export function ownedPushForwards(list: string, serial: string, socket: string): string[] {
  const forwards: string[] = [];
  for (const line of list.split("\n")) {
    const [device, port, target] = line.trim().split(/\s+/u);
    if (port !== "tcp:9237" && port !== "tcp:9238") continue;
    if (device !== serial || target !== socket) throw new Error("Android Push debug forward belongs to another connection");
    forwards.push(port);
  }
  return forwards;
}

// Chrome removes CDP permission overrides when their browser connection closes.
// Keep this browser-only connection (no page target) alive for the negative window.
export async function holdAndroidNotificationDenial(origin: string, connect: PermissionConnection = run =>
  withAndroidChrome(run, { port: 9237, launchBrowser: false })): Promise<() => Promise<void>> {
  const ready = Promise.withResolvers<() => Promise<void>>();
  const release = Promise.withResolvers<void>();
  const session = connect(async driver => {
    await driver.browserSend("Browser.setPermission", { permission: { name: "notifications" }, setting: "denied", origin });
    let closing: Promise<void> | undefined;
    ready.resolve(() => closing ??= (async () => {
      try { await driver.browserSend("Browser.getVersion"); }
      finally { release.resolve(); await session; }
    })());
    await release.promise;
  });
  void session.catch(error => ready.reject(error));
  return ready.promise;
}

export function createAndroidPushRuntime(identity: Pick<AndroidPushIdentity, "origin" | "omp">, options: AndroidPushRuntimeOptions = {}): AndroidPushRuntime {
  const base = options.fixtureBase ?? join(homedir(), ".local/share/omp-session-gateway/qualification/dev/androidPush/fixtures");
  let serial: string | undefined;
  let packageName: string | undefined;
  let currentEpoch: string | undefined;
  let selectedDetail: PushDetailLevel = "private";
  let observationArmed = false;
  let observedTopic = "";
  let releasePermission: (() => Promise<void>) | undefined;
  let baselineRecords = new Map<string, number>();
  const observedPosts = new Map<string, { key: string; postedAt: number }>();
  const execute = options.execute ?? executeFixture;
  const location = (epoch: string): PushFixtureLocation => ({ root: join(base, `omp-push-${epoch}`), epoch,
    bun: options.fixtureBun ?? process.execPath,
    binary: options.fixtureBinary ?? process.env.OMP_PUSH_FIXTURE_BINARY ?? "",
    scripts: options.fixtureScripts ?? resolve(import.meta.dir) });
  const command: AndroidAdbCommand = async (...args) => {
    serial ??= await requireSingleDevice();
    const child = Bun.spawn(["adb", "-s", serial, ...args], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error("Android Push device command failed");
    return output;
  };
  const mutate: AndroidAdbCommand = async (...args) => { await runtime.beforeEffect(); return command(...args); };
  const wake = async () => {
    serial ??= await requireSingleDevice();
    if (await wakeAndroidDisplay(mutate, milliseconds => Bun.sleep(milliseconds), () => unlockAndroidKeyguard(serial!)) !== "Awake") {
      throw new Error("Android Push display did not unlock");
    }
  };
  const wait = async (test: () => Promise<boolean>, name: string, milliseconds = 60_000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { if (await test()) return; await Bun.sleep(500); }
    throw new Error(`Android Push ${name} unavailable`);
  };
  const targetForOrigin = async (driver: AndroidChromeDriver): Promise<string | undefined> => {
    const result = await driver.browserSend("Target.getTargets");
    if (!Array.isArray(result.targetInfos)) throw new Error("Android target inventory unavailable");
    const targets = result.targetInfos.filter((target: unknown) => typeof target === "object" && target !== null && "type" in target &&
      target.type === "page" && "url" in target && typeof target.url === "string" && target.url.startsWith(`${identity.origin}/`));
    if (targets.length > 1) throw new Error("multiple pages for the Push origin; close them before qualification");
    const target = targets[0];
    return typeof target?.targetId === "string" ? target.targetId : undefined;
  };
  const navigateRoot = async (driver: AndroidChromeDriver) => {
    await runtime.beforeEffect();
    try { await driver.navigate(`${identity.origin}/`); }
    catch { throw new Error("Android Push directory did not load"); }
  };
  const page = async <T>(action: (driver: AndroidChromeDriver) => Promise<T>, navigate = false): Promise<T> => {
    await wake();
    packageName ??= await requireWebApk(command, identity.origin);
    await openWebApk(mutate, packageName);
    await runtime.beforeEffect();
    return withAndroidChrome(async driver => {
      let target: string | undefined;
      await wait(async () => { target = await targetForOrigin(driver); return target !== undefined; }, "WebAPK target");
      await driver.attachTab(target!);
      if (navigate) await navigateRoot(driver);
      return action(driver);
    }, { port: 9238, launchBrowser: false });
  };
  const browserState = async (driver: AndroidChromeDriver): Promise<PushBrowserBaseline> => {
    await wait(async () => driver.evaluate<boolean>('!["checking", undefined].includes(document.querySelector("#notify")?.dataset.state)'), "notification controls");
    return driver.evaluate<PushBrowserBaseline>(`(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {subscribed: !!(await registration.pushManager.getSubscription()), permission: Notification.permission,
        detail: document.querySelector('input[name="notification-detail"]:checked')?.value ?? "session"};
    })()`);
  };
  const title = (kind: "attention" | "activity_stop") => kind === "attention" ? "OMP session needs attention" : "OMP session activity stopped";
  const expectation = (session: SessionMetadata, kind: "attention" | "activity_stop", level = selectedDetail): NotificationExpectation => ({
    packageName: packageName!, tag: `omp-attention-${session.instanceId}`, title: title(kind),
    body: level === "private" ? "" : [...[session.title, session.cwdLabel].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ")].slice(0, 256).join(""),
    forbidden: [PUSH_FIXTURE_ASK_BODY, PUSH_FIXTURE_ASK_TITLE, "Qualification benign activity canary"],
  });
  const snapshot = async (epoch: string) => {
    const response = await fetch(`${identity.origin}/api/v1/sessions`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Android Push gateway snapshot refused");
    const list = parseSessionListResponse(await response.json());
    const matches = list.sessions.filter(session => session.cwdLabel === basename(location(epoch).root));
    if (matches.length > 1) throw new Error("multiple owned fixture publications");
    return matches[0];
  };
  const restoreRadios = async (state: Pick<PushDeviceBaseline, "airplane" | "wifi" | "mobile">) => {
    await mutate("shell", "cmd", "connectivity", "airplane-mode", state.airplane ? "enable" : "disable");
    await mutate("shell", "svc", "wifi", state.wifi ? "enable" : "disable");
    await mutate("shell", "svc", "data", state.mobile ? "enable" : "disable");
  };
  const phaseRecords = async () => {
    if (!observationArmed) throw new Error("Push notification phase has no record baseline");
    packageName ??= await requireWebApk(command, identity.origin);
    const records = await readAndroidNotificationRecords(command, packageName);
    if (records.some(record => record.tag.includes("omp-attention-") && !record.tag.endsWith(observedTopic) && baselineRecords.get(record.key) !== record.postedAt)) throw new NotificationOverlapError();
    return records;
  };
  const runtime: AndroidPushRuntime = {
    now: Date.now,
    pause: milliseconds => Bun.sleep(milliseconds),
    beforeEffect: async () => { throw new Error("Push runtime has no checkpoint owner"); },
    async preflight(input) {
      if (input.origin !== identity.origin) throw new Error("Push preflight origin differs from its runtime");
      const selected = resolveAndroidBrowserTarget(), stock = resolveAndroidBrowserTarget({});
      if (selected.packageName !== stock.packageName || selected.activity !== stock.activity || selected.devtoolsSocket !== stock.devtoolsSocket) throw new Error("Android Push requires the stock Chrome browser target");
      serial = await requireSingleDevice();
      if (ownedPushForwards(await command("forward", "--list"), serial, selected.devtoolsSocket).length > 0) throw new Error("Android Push debug forward is occupied; clean up its owning attempt first");
      if (!await runtime.dndOff()) throw new Error("turn Do Not Disturb off on the Pixel for the qualification window");
      packageName = await requireWebApk(command, identity.origin);
      const pin = await readAndroidQualificationPin(serial);
      pin.fill(0);
      const model = (await command("shell", "getprop", "ro.product.model")).trim();
      const android = (await command("shell", "getprop", "ro.build.version.release")).trim();
      const browser = parseAndroidPackageVersion(await command("shell", "dumpsys", "package", "com.android.chrome"));
      if (model !== "Pixel 10 Pro" || Number(android) < 13) throw new Error("Android Push requires the physical Pixel and runtime notification permissions");
      if (Bun.version !== identity.omp.bunVersion) throw new Error("Push driver Bun does not match the pin");
      const device = await runtime.device();
      if (device.forcedDoze || device.batteryOverride) throw new Error("Push qualification requires no pre-existing battery/Doze override");
      return { android, browser, webApk: true, dndOff: true };
    },
    dndOff: async () => (await command("shell", "settings", "get", "global", "zen_mode")).trim() === "0",
    async device() {
      packageName ??= await requireWebApk(command, identity.origin);
      const setting = async (name: string) => (await command("shell", "settings", "get", "global", name)).trim() === "1";
      const idle = await command("shell", "dumpsys", "deviceidle");
      const battery = await command("shell", "dumpsys", "battery");
      const window = await command("shell", "dumpsys", "window");
      return { wifi: await setting("wifi_on"), mobile: await setting("mobile_data"), airplane: await setting("airplane_mode_on"),
        forcedDoze: /mForceIdle=true/u.test(idle), batteryOverride: /UPDATES STOPPED/u.test(battery),
        awake: /mWakefulness=Awake/u.test(await command("shell", "dumpsys", "power")), locked: parseKeyguardShowing(window),
        webApkTask: webApkTasks(await command("shell", "dumpsys", "activity", "activities"), packageName).length > 0,
        chromeNotificationsAllowed: /android.permission.POST_NOTIFICATIONS: granted=true/u.test(await command("shell", "dumpsys", "package", "com.android.chrome")),
        webApkNotificationsAllowed: /android.permission.POST_NOTIFICATIONS: granted=true/u.test(await command("shell", "dumpsys", "package", packageName)) };
    },
    browser: () => page(browserState, true),
    async fixture(operation, epoch) {
      currentEpoch = epoch;
      if (operation === "start") {
        const host = location(epoch);
        if (host.binary === "") throw new Error("OMP_PUSH_FIXTURE_BINARY must name the pinned OMP entrypoint");
        const bun = await execute([host.bun, "--version"]);
        if (bun.exitCode !== 0 || bun.stdout.trim() !== identity.omp.bunVersion) throw new Error("Push fixture Bun does not match the pin");
        if ((await execute(["python3", "-c", "import os; os.forkpty"])).exitCode !== 0) throw new Error("Push fixture host requires Python 3 with forkpty");
        const extension = "fixtures/push-qualification-extension.ts";
        const expected = createHash("sha256").update(await readFile(join(import.meta.dir, extension))).digest("hex");
        const staged = await execute(["shasum", "-a", "256", join(host.scripts, extension)]);
        if (staged.exitCode !== 0 || staged.stdout.trim().split(/\s+/u)[0] !== expected) throw new Error("staged Push extension differs from lane source");
        const version = await execute([...( /\.[cm]?[jt]s$/u.test(host.binary) ? [host.bun, host.binary] : [host.binary]), "--version"]);
        if (version.exitCode !== 0 || version.stdout.trim() !== `omp/${identity.omp.version}`) throw new Error("Push fixture OMP does not match the exact pin");
      }
      await runtime.beforeEffect();
      await commandPushFixture(location(epoch), operation, execute);
    },
    snapshot,
    async beginNotificationPhase(epoch) {
      const session = await snapshot(epoch);
      if (session === undefined) throw new Error("Push fixture missing before notification phase");
      packageName ??= await requireWebApk(command, identity.origin);
      observedTopic = `omp-attention-${session.instanceId}`;
      baselineRecords = new Map((await readAndroidNotificationRecords(command, packageName)).map(record => [record.key, record.postedAt]));
      observedPosts.clear(); observationArmed = true;
    },
    async assertNotificationOwnership() {
      await phaseRecords();
    },
    async detail(level) {
      await page(async driver => {
        let state = await browserState(driver);
        if (state.permission !== "granted") throw new Error("grant origin notification permission before Android Push qualification");
        await runtime.beforeEffect();
        await driver.evaluate('document.querySelector("#settings").click()');
        if (!state.subscribed) {
          await driver.send("Runtime.evaluate", { expression: 'document.querySelector("#notify").click()', userGesture: true });
          await wait(async () => (await browserState(driver)).subscribed, "subscription");
        }
        await driver.evaluate(`document.querySelector('input[name="notification-detail"][value="${level}"]').click()`);
        await wait(async () => (await browserState(driver)).detail === level, "detail selection");
        // Reopen reconciles from the server; a checked radio alone cannot prove the save completed.
        await navigateRoot(driver);
        state = await browserState(driver);
        if (!state.subscribed || state.detail !== level) throw new Error("server did not retain selected notification detail");
        selectedDetail = level;
      }, true);
    },
    async closePwa() {
      packageName ??= await requireWebApk(command, identity.origin);
      await closeWebApk(mutate, packageName);
      await mutate("shell", "input", "keyevent", "3");
    },
    openPwa: async () => { await page(async driver => {
      await browserState(driver);
      await wait(async () => driver.evaluate<boolean>('document.readyState === "complete" && document.visibilityState === "visible" && document.querySelector("#status-banner")?.dataset.kind === "ready"'), "resumed directory");
    }); },
    async lock() {
      await mutate("shell", "input", "keyevent", "223");
      await wait(async () => parseKeyguardShowing(await command("shell", "dumpsys", "window")), "secure lock", 10_000);
    },
    async observe(session, kind, level) {
      if (!await runtime.dndOff()) throw new Error("turn Do Not Disturb off on the Pixel for the qualification window");
      const expected = expectation(session, kind, level);
      const records = (await phaseRecords()).filter(record => record.tag.endsWith(expected.tag));
      const owned = records[0];
      if (records.length === 1 && owned !== undefined) {
        if (owned.postedAt <= (baselineRecords.get(owned.key) ?? 0)) throw new Error("owned notification did not advance from its record baseline");
        trackUnchangedNotificationPost(observedPosts, session, kind, owned);
      }
      return { count: records.length, titleMatches: records.length === 1 && owned?.title === expected.title,
        bodyMatches: records.length === 1 && owned?.body === expected.body,
        forbiddenFound: records.some(record => expected.forbidden.some(value => record.text.includes(value))) };
    },
    async presentation(session, level) {
      await mutate("shell", "input", "keyevent", "224");
      await Bun.sleep(1_200);
      await runtime.assertNotificationOwnership();
      const expected = expectation(session, "attention", level);
      const found = await findAndroidNotification(mutate, expected);
      await wait(async () => {
        const records = (await phaseRecords()).filter(record => record.tag.endsWith(expected.tag));
        return records.length === 1 && records[0]!.seen && records[0]!.visibleSince >= records[0]!.postedAt;
      }, "owned lock-screen visibility", 10_000);
      const texts = found.rowNodes.flatMap(node => [node.text, node.description]);
      const body = [...[session.title, session.cwdLabel].filter((v, i, a) => v && a.indexOf(v) === i).join(" · ")].slice(0, 256).join("");
      const privateHidden = !texts.some(text => [session.title, session.cwdLabel].some(label => label !== undefined && text.includes(label)));
      const checked = { locked: parseKeyguardShowing(await command("shell", "dumpsys", "window")),
        title: texts.some(text => text.includes(title("attention"))),
        detail: level === "private" ? privateHidden : texts.some(text => text.includes(body)),
        privacy: !texts.some(text => expected.forbidden.some(value => text.includes(value))) };
      if (!Object.values(checked).every(Boolean)) throw new Error(`Android Push lock-screen mismatch: ${JSON.stringify(checked)}`);
      return true;
    },
    async tap(session, kind, stale) {
      await runtime.assertNotificationOwnership();
      await runtime.lock();
      const observation: PushTapObservation = await withAndroidChrome(async driver => {
        let attached: Promise<void> | undefined;
        let attachedError = false;
        let observerFailure = "none";
        const recordFailure = (error: unknown) => {
          attachedError = true;
          const message = error instanceof Error ? error.message : "";
          const method = ["Page.enable", "Runtime.enable", "Network.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger", "Page.addScriptToEvaluateOnNewDocument"].find(item => message.includes(item)) ?? "other";
          observerFailure = `${method}:${message.includes("timeout") ? "timeout" : message.includes("wasn't found") ? "unsupported" : "failed"}`;
        };
        let launches = 0;
        let successful = 0;
        let currentGeneration = false;
        let currentRequest = false;
        let modeMatches = false;
        let routeObserved = false;
        let routeScrubbed = false, apiScrubbed = true, metadataObserved = false;
        const observeRoute = (value: unknown) => {
          if (routeObserved || !isPushNotificationRoute(value, identity.origin)) return;
          routeObserved = true; routeScrubbed = false; apiScrubbed = true; metadataObserved = false;
        };
        let tabsSeen = 0, pagesSeen = 0, pausedTabs = 0, pausedPages = 0;
        const requests = new Set<string>();
        const attachedTargets = new Set<string>();
        const tabWatches: Promise<void>[] = [];
        let stage = "observer admission";
        const attach = (targetId: string, attachedSession?: string, paused = false) => {
          if (attachedTargets.has(targetId)) return;
          attachedTargets.add(targetId);
          const previous = attached ?? Promise.resolve();
          attached = previous.then(async () => {
            if (attachedSession === undefined) {
              await driver.attachTab(targetId);
              await driver.send("Network.enable");
            } else {
              await Promise.all([driver.sessionSend(attachedSession, "Network.enable"), driver.attachTab(targetId, attachedSession)]);
            }
            if (paused) await driver.send("Runtime.runIfWaitingForDebugger");
          }).catch(recordFailure);
        };
        const stopListening = driver.onEvent((method, params) => {
          if (method === "Target.targetInfoChanged" || method === "Target.targetCreated") {
            const target = params.targetInfo as { type?: string; url?: string } | undefined;
            if (target?.type === "page") observeRoute(target.url);
          }
          if (method === "Page.frameStartedNavigating" || method === "Page.navigatedWithinDocument") observeRoute(params.url);
          if (method === "Target.attachedToTarget") {
            const target = params.targetInfo as { type?: string } | undefined;
            if (target?.type === "tab") { tabsSeen++; if (params.waitingForDebugger === true) pausedTabs++; }
            if (target?.type === "page") { pagesSeen++; if (params.waitingForDebugger === true) pausedPages++; }
          }
          if (method === "Target.attachedToTarget") {
            const target = params.targetInfo;
            if (typeof target !== "object" || target === null || !("type" in target) || !("targetId" in target) || typeof target.targetId !== "string") return;
            const targetId = target.targetId;
            const attachedSession = params.sessionId;
            if (typeof attachedSession !== "string") { attachedError = true; return; }
            if (target.type === "tab") {
              // Current Chromium attaches tab targets at browser level, then their page children.
              // A removed WebAPK task may retain its tab shell, so existing tabs need child watches.
              const watching = Promise.all([
                driver.sessionSend(attachedSession, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }, { exclude: true }] }),
                ...(params.waitingForDebugger === true ? [driver.sessionSend(attachedSession, "Runtime.runIfWaitingForDebugger")] : []),
              ]).then(() => {}).catch(recordFailure);
              tabWatches.push(watching);
              return;
            }
            if (target.type !== "page") return;
            if ("url" in target && typeof target.url === "string" && target.url !== "" && target.url !== "about:blank" && !target.url.startsWith(`${identity.origin}/`)) {
              // Do not initialize Chrome's undriveable native new-tab page or unrelated web pages.
              if (params.waitingForDebugger === true) void driver.sessionSend(attachedSession, "Runtime.runIfWaitingForDebugger").catch(recordFailure);
              return;
            }
            if ("url" in target) observeRoute(target.url);
            attach(targetId, attachedSession, params.waitingForDebugger === true);
          }
          if (method === "Page.frameNavigated") {
            const frame = params.frame;
            if (typeof frame === "object" && frame !== null && "url" in frame) observeRoute(frame.url);
          }
          if (method === "Page.navigatedWithinDocument" && params.url === `${identity.origin}/`) routeScrubbed = true;
          if (method === "Network.requestWillBeSent") {
            const request = params.request;
            if (typeof request !== "object" || request === null || !("url" in request) || typeof request.url !== "string") return;
            observeRoute(request.url);
            if (routeObserved && request.url.startsWith(`${identity.origin}/api/`)) apiScrubbed &&= routeScrubbed;
            if (routeObserved && request.url === `${identity.origin}/api/v1/sessions`) metadataObserved = true;
            if (request.url !== `${identity.origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`) return;
            launches++;
            if (typeof params.requestId === "string") requests.add(params.requestId);
            if ("postData" in request && typeof request.postData === "string") {
              ({ currentGeneration, currentRequest, modeMatches } = observePushLaunch(session, kind, request.postData));
            }
          }
          if (method === "Network.responseReceived" && typeof params.requestId === "string" && requests.has(params.requestId)) {
            const response = params.response;
            if (typeof response === "object" && response !== null && "status" in response && response.status === 200) successful++;
          }
        });
        try {
          await driver.browserSend("Target.setDiscoverTargets", { discover: true, filter: [{ type: "tab" }, { type: "page" }, { exclude: true }] });
          await driver.browserSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "tab" }, { exclude: true }] });
          await Promise.all(tabWatches);
          if (attachedError) throw new Error("notification child observers unavailable");
          const existing = await targetForOrigin(driver);
          if (existing !== undefined) { attach(existing); await attached; }
          stage = "notification input";
          await mutate("shell", "input", "keyevent", "224");
          await Bun.sleep(1_200);
          await tapAndroidNotification(mutate, expectation(session, kind));
          stage = "keyguard authentication";
          // Menu/dismiss-keyguard would replace the notification's pending launch action.
          // Authenticate the bouncer created by the tap, without another dismiss request.
          if (parseKeyguardShowing(await command("shell", "dumpsys", "window"))) {
            try {
              let alternate = false;
              await wait(async () => {
                const nodes = await readAndroidUi(command);
                alternate = nodes.some(node => node.resource === "com.android.systemui:id/alternate_bouncer");
                return alternate || nodes.filter(node => node.systemInput).length === 1;
              }, "notification authentication surface", 15_000);
              if (alternate) await showAndroidPinBouncer(mutate);
              await wait(async () => (await readAndroidUi(command)).filter(node => node.systemInput).length === 1, "notification PIN bouncer", 15_000);
            } catch (error) {
              const nodes = await readAndroidUi(command);
              const remaining = (await readAndroidNotificationRecords(command, packageName!)).filter(record => record.tag.endsWith(`omp-attention-${session.instanceId}`)).length;
              throw new Error(`notification PIN bouncer unavailable (owned records: ${remaining}; secure inputs: ${nodes.filter(node => node.systemInput).length})`, { cause: error });
            }
            await runtime.beforeEffect();
            await unlockAndroidKeyguard(serial!);
            await wait(async () => !parseKeyguardShowing(await command("shell", "dumpsys", "window")), "notification keyguard dismissal", 20_000);
          }
          stage = "page attachment";
          await wait(async () => { if (attachedError) throw new Error("tap observer could not attach"); return attached !== undefined; }, "notification target");
          await attached;
          if (attachedError) throw new Error("tap observer could not attach");
          stage = "client destination";
          await wait(async () => {
            if (launches > 1 || successful > 1 || (stale && launches !== 0)) throw new Error("notification tap made an unexpected launch");
            // A restored tab can briefly expose its old connected DOM before the tap navigates it.
            // Never accept that surface before this tap's own revalidation/launch is observed.
            if (stale ? !metadataObserved : launches !== 1 || successful !== 1) return false;
            return driver.evaluate<boolean>(stale ?
              'location.pathname === "/" && document.querySelector("#status-banner")?.dataset.kind === "expired"' :
              `location.pathname === "/client/" && document.querySelector(".conn-chip")?.dataset.state === "connected" && (${kind === "attention" ?
                `[...document.querySelectorAll('.sh-ask-option')].some(button => button.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}) && !button.disabled)` :
                'document.querySelector(".sh-composer-input") instanceof HTMLTextAreaElement'})`);
          }, "notification destination", 90_000);
          if (!stale && !modeMatches) throw new Error("notification tap requested the wrong authority mode");
          const surface = await driver.evaluate<{ writable: boolean; readOnly: boolean; expired: boolean; scrubbed: boolean }>(`(() => {
            const editor = document.querySelector('.sh-composer-input');
            const choices = [...document.querySelectorAll('.sh-ask-option')].filter(button => button.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}));
            return { writable: (editor instanceof HTMLTextAreaElement && !editor.disabled) || (choices.length === 1 && choices[0] instanceof HTMLButtonElement && !choices[0].disabled),
              readOnly: editor instanceof HTMLTextAreaElement && editor.disabled,
              expired: location.pathname === '/' && document.querySelector('#status-banner')?.dataset.kind === 'expired',
              scrubbed: location.search === '' && location.hash === '' };
          })()`);
          return { launches, successful, currentGeneration, currentRequest, scrubbedBeforeNetwork: routeObserved && routeScrubbed && apiScrubbed && metadataObserved && surface.scrubbed,
            writable: surface.writable, readOnly: surface.readOnly, expired: surface.expired };
        } catch (error) {
          if (error instanceof NotificationOverlapError) throw error;
          // Already-observed closed values only: secondary device reads must not mask the cause.
          const diagnostics = { observerFailure, tabsSeen, pagesSeen, pausedTabs, pausedPages, launches, successful,
            currentGeneration, currentRequest, modeMatches, routeObserved, routeScrubbed, metadataObserved };
          throw new Error(`Android Push tap failed during ${stage}: ${JSON.stringify(diagnostics)}`, { cause: error });
        } finally {
          stopListening();
          // withAndroidChrome closes the owned CDP connection, detaching its auto-attached targets.
        }
      }, { port: 9238, launchBrowser: false });
      await runtime.assertNotificationOwnership();
      return observation;
    },
    async answer() {
      await wake();
      await withAndroidChrome(async driver => {
        const target = await targetForOrigin(driver);
        if (target === undefined) throw new Error("authoritative Control target unavailable");
        await driver.attachTab(target);
        await runtime.beforeEffect();
        const answered = await driver.evaluate<boolean>(`(() => {
          const buttons = [...document.querySelectorAll('.sh-ask-option')].filter(element => element.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}));
          if (buttons.length !== 1 || buttons[0].disabled) return false; buttons[0].click(); return true;
        })()`);
        if (!answered) throw new Error("authoritative Control answer unavailable");
        await wait(async () => driver.evaluate<boolean>('document.querySelector(".sh-ask-send") instanceof HTMLButtonElement && !document.querySelector(".sh-ask-send").disabled'), "selected answer submission");
        await runtime.beforeEffect();
        await driver.evaluate('document.querySelector(".sh-ask-send").click()');
      }, { port: 9238, launchBrowser: false });
    },
    async forceStop() { await runtime.closePwa(); await mutate("shell", "am", "force-stop", "com.android.chrome"); },
    async permission(value) {
      await page(async driver => {
        // Android may freeze the browser after task removal; wake it before probing
        // and releasing the retained override connection at the end of the window.
        if (value === "denied" && releasePermission === undefined) {
          await runtime.beforeEffect();
          releasePermission = await holdAndroidNotificationDenial(identity.origin);
        } else if (value !== "denied" && releasePermission !== undefined) {
          await runtime.beforeEffect();
          const release = releasePermission; releasePermission = undefined;
          await release();
        }
        await navigateRoot(driver);
        const state = await browserState(driver);
        if (state.permission !== value) throw new Error("origin notification permission did not change");
        if (value === "denied") {
          await driver.evaluate('document.querySelector("#settings").click()');
          if (!await driver.evaluate<boolean>('document.querySelector("#notify")?.dataset.state === "blocked" && document.querySelector("#notify")?.disabled === true')) throw new Error("notification Settings did not expose blocked permission");
        }
      });
    },
    async doze(enabled) {
      if (enabled) {
        await mutate("shell", "dumpsys", "battery", "unplug");
        await runtime.lock();
        await mutate("shell", "dumpsys", "deviceidle", "force-idle", "deep");
      } else {
        await mutate("shell", "dumpsys", "deviceidle", "unforce");
        await mutate("shell", "dumpsys", "battery", "reset");
      }
      const idle = await command("shell", "dumpsys", "deviceidle");
      if (/mForceIdle=true/u.test(idle) !== enabled || (enabled && !/mState=IDLE\b/u.test(idle))) throw new Error("forced Doze state mismatch");
    },
    async network(value) {
      await restoreRadios({ airplane: value === "airplane", wifi: value === "wifi", mobile: value !== "airplane" });
      await Bun.sleep(5_000);
      if (value === "airplane") return (await runtime.device()).airplane;
      if (value === "cellular") {
        const connectivity = await command("shell", "dumpsys", "connectivity");
        const networks = connectivity.split(/NetworkAgentInfo/u);
        if (!networks.some(network => network.includes("Transports: CELLULAR") && network.includes("VALIDATED"))) return false;
      }
      try {
        await page(async driver => {
          await wait(async () => driver.evaluate<boolean>(`fetch('/api/v1/sessions', {cache:'no-store', signal:AbortSignal.timeout(4000)}).then(r=>r.ok).catch(()=>false)`), "tailnet network", 45_000);
        }, true);
        return true;
      } catch { return false; }
    },
    async sinks(epoch) {
      const fixture = await snapshot(epoch);
      if (fixture === undefined) throw new Error("fixture missing for sink sweep");
      const result = await page(async driver => driver.evaluate<Record<string, boolean | number>>(`(async () => {
        ${PAGE_PRELUDE}
        const marker = 'SYNTHETIC-PUSH-SINK-CONTROL-53fa479c'; const key = ${JSON.stringify(`__push_sink_control_${epoch}`)};
        const registration = await navigator.serviceWorker.ready;
        const before = history.state; const url = location.href; let db;
        const found = new Set();
        try {
          localStorage.setItem(key,marker); sessionStorage.setItem(key,marker); document.cookie=key+'='+marker+';path=/';
          await (await caches.open(key)).put('/'+key,new Response(marker));
          db=await openDb(key,1,handle=>handle.createObjectStore('s'));
          await new Promise((resolve,reject)=>{const tx=db.transaction('s','readwrite');tx.objectStore('s').put(marker,'k');tx.oncomplete=resolve;tx.onerror=reject;});
          history.replaceState({control:marker},'', '/#'+marker);
          await registration.showNotification(marker,{tag:key,body:marker,data:{control:marker}});
          await scanSinks(value=>typeof value==='string'&&value.includes(marker),sink=>found.add(sink));
        } finally {
          localStorage.removeItem(key);sessionStorage.removeItem(key);document.cookie=key+'=;path=/;max-age=0';await caches.delete(key);
          db?.close();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(key);r.onsuccess=resolve;r.onerror=reject;});
          history.replaceState(before,'',url);for(const n of await registration.getNotifications({tag:key}))n.close();
        }
        const required=['localStorage','sessionStorage','cookie','cacheBody','indexedDB','locationHash','historyState','notificationTitle','notificationBody','notificationData'];
        const residual=[];await scanSinks(value=>typeof value==='string'&&value.includes(marker),sink=>residual.push(sink));
        const response=await fetch('/api/v1/sessions/'+${JSON.stringify(fixture.instanceId)}+'/launch',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({generation:${fixture.generation},mode:'view'})});
        if(!response.ok)throw Error('sink launch refused');
        const payload=await response.json();const raw=payload.capability;
        if(typeof raw!=='string')throw Error('sink launch missing material');
        const needles=[raw,...raw.split(/[\\/?#&=]/).filter(part=>part.length>=16)];const hits=[];
        await scanSinks(value=>typeof value==='string'&&needles.some(needle=>value.includes(needle)),sink=>hits.push(sink));
        return {detectable:required.every(sink=>found.has(sink)),clean:hits.length===0&&residual.length===0,sinks:required.length,findings:hits.length};
      })()`), true);
      const gatewayLogsDiscarded = options.gatewayLogsDiscarded ?? (async () => {
        const plist = join(homedir(), "Library/LaunchAgents/omp-session-gateway.plist");
        const stdout = await executeFixture(["plutil", "-extract", "StandardOutPath", "raw", "-o", "-", plist]);
        const stderr = await executeFixture(["plutil", "-extract", "StandardErrorPath", "raw", "-o", "-", plist]);
        return stdout.exitCode === 0 && stderr.exitCode === 0 && stdout.stdout.trim() === "/dev/null" && stderr.stdout.trim() === "/dev/null";
      });
      return { ...result, gatewayLogsDiscarded: await gatewayLogsDiscarded() };
    },
    async cleanup(step, progress) {
      currentEpoch = progress.epoch;
      switch (step) {
        case "fixtureAsk":
          // A not-yet-started fixture has nothing to settle. Stop verifies ownership before notification cleanup.
          if (await snapshot(currentEpoch) !== undefined) {
            await runtime.fixture("answer", currentEpoch);
            await wait(async () => (await snapshot(currentEpoch!))?.inputRequired !== true, "cleanup authoritative resolution", 90_000);
          }
          break;
        case "notifications":
          await page(async driver => {
            if (progress.notificationTopicDigest !== null) await driver.evaluate(`(async()=>{
              const digest = async tag => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag)))].map(byte => byte.toString(16).padStart(2,'0')).join('');
              for (const notice of await (await navigator.serviceWorker.ready).getNotifications()) if (await digest(notice.tag) === ${JSON.stringify(progress.notificationTopicDigest)}) notice.close();
            })()`);
            await driver.evaluate(`(async()=>{
              const key=${JSON.stringify(`__push_sink_control_${currentEpoch}`)};
              for(const n of await (await navigator.serviceWorker.ready).getNotifications({tag:key}))n.close();
              localStorage.removeItem(key);sessionStorage.removeItem(key);document.cookie=key+'=;path=/;max-age=0';await caches.delete(key);
              await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(key);request.onsuccess=resolve;request.onerror=reject;request.onblocked=()=>reject(Error('owned sink database is still open'));});
            })()`);
          }, true);
          if (progress.notificationTopicDigest !== null) await wait(async () => (await readAndroidNotificationRecords(command, packageName!)).every(record => !notificationMatchesDigest(record.tag, progress.notificationTopicDigest!)), "owned notification cleanup");
          break;
        case "browser":
          try {
            if (progress.browser === null) break;
            // Non-granted admission is rejected before permission/subscription mutations.
            if (progress.browser.permission === "granted") await runtime.permission("granted");
            if (progress.browser.permission === "granted" && progress.browser.subscribed) await runtime.detail(progress.browser.detail);
            else if (progress.browser.permission === "granted") await page(async driver => {
              const state = await browserState(driver);
              if (state.subscribed) { await driver.evaluate('document.querySelector("#settings").click();document.querySelector("#notify").click()');
                await wait(async () => !(await browserState(driver)).subscribed, "subscription removal"); }
            }, true);
            await page(async driver => {
              const state = await browserState(driver);
              if (state.subscribed !== progress.browser!.subscribed || state.permission !== progress.browser!.permission ||
                (state.subscribed && state.detail !== progress.browser!.detail)) throw new Error("browser baseline was not restored");
            }, true);
          } finally {
            // A killed driver loses the permission override but may leave its adb listener.
            // Fresh-process cleanup removes only this lane's exact device/socket forwards.
            serial ??= await requireSingleDevice();
            for (const port of ownedPushForwards(await command("forward", "--list"), serial, resolveAndroidBrowserTarget().devtoolsSocket)) {
              await mutate("forward", "--remove", port);
            }
          }
          break;
        case "doze": await runtime.doze(false); break;
        case "network": {
          await restoreRadios(progress.device);
          const after = await runtime.device();
          if (after.wifi !== progress.device.wifi || after.mobile !== progress.device.mobile || after.airplane !== progress.device.airplane) throw new Error("radio baseline was not restored");
          break;
        }
        case "task":
          if (progress.device.webApkTask) await runtime.openPwa(); else await runtime.closePwa();
          if (progress.device.locked || !progress.device.awake) await runtime.lock(); else await wake();
          if (progress.device.awake && progress.device.locked) await mutate("shell", "input", "keyevent", "224");
          {
            const after = await runtime.device();
            if (!Object.entries(progress.device).every(([key, value]) => after[key as keyof PushDeviceBaseline] === value)) throw new Error("device baseline was not restored");
          }
          break;
        case "fixture":
          await runtime.fixture("stop", currentEpoch);
          await wait(async () => await snapshot(currentEpoch!) === undefined, "fixture unpublication", 45_000);
          break;
      }
    },
  };
  return runtime;
}
