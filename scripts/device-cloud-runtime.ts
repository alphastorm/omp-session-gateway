/**
 * The production `deviceCloud` runtime: TestingBot devices driven through the tunnel on this
 * workstation, against the candidate gateway and a stock-OMP fixture on the retained Mac.
 *
 * The tunnel runs here, so Tailscale Serve sees this workstation's allowlisted login; the lane
 * proves nothing about a phone's own tailnet identity. Every page evaluation returns only counts,
 * booleans and fixed names, because TestingBot keeps a log of every WebDriver command.
 */
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { parseSessionListResponse } from "../packages/protocol/src/validation.ts";
import {
  LEAK_CONTROL_EXPRESSION,
  LEAK_SINKS,
  leakControlGaps,
  leakSweepExpression,
  runCollaborationJourney,
  type LeakControlResult,
  type LeakSweepResult,
} from "./browser-journey.ts";
import {
  attestAllocation,
  DEVICE_CLOUD_PROFILES,
  DEVICE_CLOUD_TARGETS,
  type DeviceCloudIdentity,
  type DeviceCloudObservation,
  type DeviceCloudRuntime,
  type DeviceCloudTarget,
  type DeviceCloudTargetAttempt,
  type DeviceProfile,
} from "./device-cloud-qualification.ts";
import { PUSH_FIXTURE_ASK_BODY } from "./fixtures/push-qualification-extension.ts";
import { commandPushFixture, type FixtureExecutor, type PushFixtureLocation } from "./push-qualification-fixture.ts";
import {
  TestingBotApi,
  WebDriverSession,
  endWebDriverSession,
  ensureTunnelJar,
  readTestingBotCredentials,
  serviceAccountTokenFile,
  startAllowlistProxy,
  startTunnel,
  stopTunnel,
  type AllowlistProxy,
  type CloudDevice,
  type TestingBotCredentials,
} from "./testingbot.ts";

const PROMPT_MARKER = "OMP_DEVICE_CLOUD_CONTROL_PROMPT";
/** A pinned model can be busy with another TestingBot customer; wait for one before failing. */
const DEVICE_WAIT_MS = 10 * 60 * 1_000;
const HOME_SCREEN_ICON = `type == "XCUIElementTypeIcon" AND label CONTAINS "OMP"`;
const ATTENTION_BANNER = `label CONTAINS "needs attention"`;

type Environment = Readonly<Record<string, string | undefined>>;
type Observations = Record<string, DeviceCloudObservation>;

export interface DeviceCloudFixture {
  /** Directory on the fixture host under which each attempt's fixture root is created. */
  readonly base: string;
  readonly bun: string;
  readonly binary: string;
  readonly scripts: string;
  readonly execute: FixtureExecutor;
}

export interface DeviceCloudRuntimeOptions {
  readonly identity: DeviceCloudIdentity;
  /** Local directory for each attempt's tunnel working directory. */
  readonly workspace: string;
  readonly fixture: DeviceCloudFixture;
  readonly environment: Environment;
}

function javaExecutable(environment: Environment): string {
  return environment.OMP_STABLE_JAVA ?? "/opt/homebrew/opt/openjdk@17/bin/java";
}

export function tunnelIdentifier(epoch: string): string {
  return `omp-dc-${epoch.slice(0, 8)}`;
}

/**
 * Read-only admission: Java runs, the service account yields the TestingBot credentials, and the
 * vendor catalog still offers a pinned model for every target.
 */
export async function admitDeviceCloud(environment: Environment): Promise<TestingBotCredentials> {
  let javaRuns = false;
  try {
    javaRuns = Bun.spawnSync([javaExecutable(environment), "-version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    javaRuns = false;
  }
  if (!javaRuns) throw new Error("the TestingBot tunnel needs Java; install openjdk@17 or set OMP_STABLE_JAVA");
  const credentials = await readTestingBotCredentials(serviceAccountTokenFile(environment));
  const catalog = await new TestingBotApi(credentials).devices("all");
  for (const target of DEVICE_CLOUD_TARGETS) {
    const profile = DEVICE_CLOUD_PROFILES[target];
    if (!catalog.some(device => device.platform === profile.platform && profile.models.includes(device.name))) {
      throw new Error(`TestingBot no longer offers a pinned ${target} model`);
    }
  }
  return credentials;
}

/** The candidate's hashed web bundle, read from the verified archive's listing. */
async function archiveAppAsset(archivePath: string): Promise<string> {
  const child = Bun.spawn(["tar", "-tf", archivePath], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [listing, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error("could not list the candidate archive");
  const assets = listing.split("\n").flatMap(entry => {
    const match = /^(?:\.\/)?[^/]+\/apps\/web\/dist\/assets\/(app\.[0-9a-f]+\.js)$/u.exec(entry);
    return match ? [`/assets/${match[1]}`] : [];
  });
  if (assets.length !== 1) throw new Error("the candidate archive does not contain exactly one hashed app asset");
  return assets[0]!;
}

function versionOrder(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function freeDevice(api: TestingBotApi, target: DeviceCloudTarget, profile: DeviceProfile): Promise<CloudDevice> {
  const deadline = Date.now() + DEVICE_WAIT_MS;
  for (;;) {
    const free = await api.devices("available");
    for (const model of profile.models) {
      const newest = free
        .filter(device => device.platform === profile.platform && device.name === model)
        .sort((a, b) => versionOrder(b.version, a.version))[0];
      if (newest !== undefined) return newest;
    }
    if (Date.now() >= deadline) throw new Error(`no pinned ${target} model became free on TestingBot within ${DEVICE_WAIT_MS / 60_000} minutes`);
    await Bun.sleep(15_000);
  }
}

/**
 * The `host:port` pairs the tunnel may reach: the candidate origin plus every source its
 * `connect-src` names, read from the candidate's own response. The page's CSP already confines it
 * to these; the proxy extends the same bound to everything else on the device. A source it cannot
 * pin to one host (a scheme, a wildcard, a keyword) fails closed.
 */
async function connectAllowlist(origin: string): Promise<readonly string[]> {
  const response = await fetch(`${origin}/`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  await response.body?.cancel();
  const directive = (response.headers.get("content-security-policy") ?? "")
    .split(";")
    .map(part => part.trim().split(/\s+/u))
    .find(tokens => tokens[0] === "connect-src");
  if (!response.ok || directive === undefined) throw new Error("the candidate gateway sent no connect-src policy");
  const own = new URL(origin);
  const allowed = [`${own.hostname}:${own.port || "443"}`];
  for (const source of directive.slice(1)) {
    if (source === "'self'") continue;
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("the candidate's connect-src names a source the tunnel proxy cannot pin to one host");
    }
    if (!["wss:", "https:"].includes(url.protocol) || !/^[a-z0-9.-]+$/u.test(url.hostname)) {
      throw new Error("the candidate's connect-src names a source the tunnel proxy cannot pin to one host");
    }
    allowed.push(`${url.hostname}:${url.port || "443"}`);
  }
  return allowed;
}

async function launchLink(origin: string, session: SessionMetadata, mode: "view" | "control"): Promise<string> {
  const response = await fetch(`${origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ generation: session.generation, mode }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  const link = isRecord(payload) ? payload.capability : undefined;
  if (response.status !== 200 || typeof link !== "string" || link.length < 16) {
    throw new Error(`the ${mode} launch for the vendor-record audit failed with HTTP ${response.status}`);
  }
  return link;
}

async function pollPage(session: WebDriverSession, name: string, expression: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await session.evaluate<unknown>(expression).catch(() => false) === true) return;
    if (Date.now() >= deadline) throw new Error(`${name} did not happen within ${timeoutMs / 1_000} s`);
    await Bun.sleep(1_000);
  }
}

async function pollNative(session: WebDriverSession, predicate: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const element = await session.find(predicate);
    if (element !== undefined || Date.now() >= deadline) return element;
    await Bun.sleep(1_000);
  }
}

/** Plants and detects the synthetic control secret, then launches View in-page and requires every sink clean. */
async function assertCleanSinks(session: WebDriverSession, label: string): Promise<void> {
  const gaps = leakControlGaps(await session.evaluate<LeakControlResult>(LEAK_CONTROL_EXPRESSION));
  if (gaps.missed.length > 0 || gaps.residualPlants.length > 0) {
    throw new Error(`the capability-sink detector missed ${gaps.missed.length} sinks and left ${gaps.residualPlants.length} plants`);
  }
  const sweep = await session.evaluate<LeakSweepResult>(leakSweepExpression(label, { detail: false }));
  if (sweep.error !== undefined || sweep.launchStatus !== 200 || sweep.launchCacheControl?.includes("no-store") !== true) {
    throw new Error("the in-page View launch did not return a no-store capability");
  }
  if ((sweep.findings?.length ?? 0) > 0) throw new Error(`a View capability reached ${sweep.findings?.length} browser sinks`);
}

/** Adds the current Safari page to the Home Screen and opens the installed app. */
async function installHomeScreenApp(session: WebDriverSession): Promise<void> {
  await session.context("NATIVE_APP");
  let share = await session.find(`type == "XCUIElementTypeButton" AND (label == "Share" OR name == "ShareButton")`);
  if (share === undefined) {
    const more = await session.find(`type == "XCUIElementTypeButton" AND (label == "More" OR label CONTAINS "Page Menu" OR name == "MoreButton")`);
    if (more === undefined) throw new Error("Safari offered neither Share nor More");
    await session.click(more);
    await Bun.sleep(1_500);
    share = await session.find(`label == "Share"`);
  }
  if (share === undefined) throw new Error("Safari's Share action was unavailable");
  await session.click(share);
  await Bun.sleep(2_500);
  let add = await session.find(`label == "Add to Home Screen"`);
  if (add === undefined) {
    // iOS 26 shortens the share sheet's actions; Add to Home Screen sits behind View More.
    const viewMore = await session.find(`label == "View More"`);
    if (viewMore !== undefined) {
      await session.click(viewMore);
      await Bun.sleep(2_000);
    }
    add = await session.find(`label == "Add to Home Screen"`);
  }
  if (add === undefined) throw new Error("Safari's Add to Home Screen action was unavailable");
  await session.click(add);
  await Bun.sleep(2_500);
  const confirm = await session.find(`type == "XCUIElementTypeButton" AND label == "Add"`);
  if (confirm === undefined) throw new Error("the Add to Home Screen sheet had no Add button");
  await session.click(confirm);
  await Bun.sleep(4_000);
  // A second icon would be another customer's leftover or an earlier attempt's; tapping either is a guess.
  const icons = await session.findAll(HOME_SCREEN_ICON);
  if (icons.length !== 1) throw new Error(`expected exactly one OMP Home Screen icon, found ${icons.length}`);
  await session.click(icons[0]!);
  await Bun.sleep(6_000);
}

/** Selects the installed app's standalone web view on the candidate origin and returns its context. */
async function standaloneWebView(session: WebDriverSession, origin: string): Promise<string> {
  const webViews = (await session.contexts()).filter(context => context.startsWith("WEBVIEW"));
  for (const context of webViews.reverse()) {
    await session.context(context);
    const state = await session.evaluate<unknown>(`({ standalone: navigator.standalone === true, origin: location.origin })`);
    if (isRecord(state) && state.standalone === true && state.origin === origin) return context;
  }
  throw new Error("the Home Screen app exposed no standalone web view on the candidate origin");
}

const NOTIFY_STATE = `document.querySelector("#notify")?.dataset.state`;
const OPEN_SETTINGS = `(() => { document.querySelector("#settings")?.click(); return true; })()`;

/**
 * The iPhone-only journey: install the Home Screen app, enable background alerts with a real tap
 * on the system prompt, background the app, raise an attention request, tap its banner into
 * Control, then turn alerts off so no subscription outlives the session.
 */
async function homeScreenAlerts(
  session: WebDriverSession,
  origin: string,
  ask: () => Promise<void>,
): Promise<Observations> {
  await installHomeScreenApp(session);
  const app = await standaloneWebView(session, origin);

  await session.evaluate(OPEN_SETTINGS);
  await pollPage(session, "the alerts control", `["idle", "enabled", "blocked", "unavailable"].includes(${NOTIFY_STATE})`, 30_000);
  const initial = await session.evaluate<unknown>(NOTIFY_STATE);
  if (initial !== "idle") throw new Error(`background alerts started ${String(initial)}, not idle`);
  await session.context("NATIVE_APP");
  const enable = await session.find(`label == "Enable background alerts"`);
  if (enable === undefined) throw new Error("the Enable background alerts control was not tappable");
  await session.click(enable);
  const allow = await pollNative(session, `type == "XCUIElementTypeButton" AND label == "Allow"`, 15_000);
  if (allow === undefined) throw new Error("iOS showed no notification permission prompt");
  await session.click(allow);
  await session.context(app);
  await pollPage(session, "background alerts", `${NOTIFY_STATE} === "enabled"`, 30_000);
  const subscription = await session.evaluate<unknown>(`(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const current = await registration?.pushManager.getSubscription();
    return current ? { keys: Object.keys(current.toJSON()).sort(), host: new URL(current.endpoint).host } : null;
  })()`);
  if (!isRecord(subscription) || !Array.isArray(subscription.keys) || typeof subscription.host !== "string") {
    throw new Error("background alerts reported enabled without a push subscription");
  }
  if (subscription.host !== "web.push.apple.com") throw new Error("the Home Screen app subscribed through a push service other than Apple's");

  await session.context("NATIVE_APP");
  await session.pressHome();
  await Bun.sleep(2_000);
  const asked = Date.now();
  await ask();
  let banner = await pollNative(session, ATTENTION_BANNER, 60_000);
  if (banner === undefined) {
    await session.openNotificationCenter();
    await Bun.sleep(2_000);
    banner = await session.find(ATTENTION_BANNER);
  }
  if (banner === undefined) throw new Error("the attention alert was not delivered within 60 s");
  const deliveredMs = Date.now() - asked;
  await session.click(banner);
  await Bun.sleep(4_000);
  const tapped = (await session.contexts()).filter(context => context.startsWith("WEBVIEW")).at(-1);
  if (tapped === undefined) throw new Error("tapping the alert opened no web view");
  await session.context(tapped);
  // With an ask pending, Control shows the ask's enabled option instead of the composer (as on the Pixel).
  await pollPage(session, "the tap into Control", `(() => {
    const editor = document.querySelector(".sh-composer-input");
    const choices = [...document.querySelectorAll(".sh-ask-option")].filter(button => button.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}));
    const control = (editor instanceof HTMLTextAreaElement && !editor.disabled) ||
      (choices.length === 1 && choices[0] instanceof HTMLButtonElement && !choices[0].disabled);
    return location.pathname === "/client/" && location.search === "" && location.hash === "" &&
      document.querySelector(".conn-chip")?.dataset.state === "connected" && control;
  })()`, 45_000);

  await session.navigate(`${origin}/`);
  await session.evaluate(OPEN_SETTINGS);
  await pollPage(session, "the enabled alerts control", `${NOTIFY_STATE} === "enabled"`, 30_000);
  await session.evaluate(`(() => { document.querySelector("#notify").click(); return true; })()`);
  await pollPage(session, "turning background alerts off", `(async () => ${NOTIFY_STATE} === "idle" &&
    !(await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription()))()`, 30_000);

  return {
    homeScreenApp: true,
    alertsEnabled: true,
    subscriptionOmitsExpirationTime: !subscription.keys.includes("expirationTime"),
    pushServiceHost: subscription.host,
    deliveredMs,
    tapOpenedControl: true,
    tapUrlScrubbed: true,
    alertsDisabled: true,
  };
}

export async function createDeviceCloudRuntime(options: DeviceCloudRuntimeOptions): Promise<DeviceCloudRuntime> {
  const { identity, fixture } = options;
  const { origin } = identity;
  const credentials = await readTestingBotCredentials(serviceAccountTokenFile(options.environment));
  const api = new TestingBotApi(credentials);
  const location = (epoch: string): PushFixtureLocation => ({
    root: join(fixture.base, `omp-cloud-${epoch}`), epoch, bun: fixture.bun, binary: fixture.binary, scripts: fixture.scripts,
  });
  let appAsset: string | undefined;
  // In-process: a crash takes the proxy with it, so an orphaned tunnel forwards to a closed port until cleanup stops it.
  let proxy: AllowlistProxy | undefined;

  const verify = async (target: DeviceCloudTarget, attempt: DeviceCloudTargetAttempt): Promise<Observations> => {
    const profile = DEVICE_CLOUD_PROFILES[target];
    const label = attempt.session.cwdLabel;
    if (label === undefined) throw new Error("the live OMP session published no label");
    appAsset ??= await archiveAppAsset(identity.candidate.archivePath);
    const device = await freeDevice(api, target, profile);
    const started = Date.now();
    const refusalsBefore = proxy?.refusals() ?? 0;
    const { session, capabilities } = await WebDriverSession.create(credentials, {
      platformName: profile.platform,
      browserName: profile.browser,
      "appium:deviceName": device.name,
      "appium:platformVersion": device.version,
      "tb:options": {
        realDevice: true,
        tunnelIdentifier: tunnelIdentifier(attempt.epoch),
        name: `omp-session-gateway ${target}`,
        build: `qualify:stable ${attempt.epoch.slice(0, 8)}`,
        screenrecorder: false,
        screenshot: false,
        recordLogs: false,
        public: false,
        idletimeout: 180,
        maxduration: 1_800,
      },
    }, attempt.created);
    try {
      const journey = await runCollaborationJourney(session, { origin, label, promptMarker: PROMPT_MARKER, expectedAppAsset: appAsset });
      // The browser's own report of the device; Chrome's reduced user agent leaves its details to client hints.
      const reported = await session.evaluate<unknown>(`(async () => ({
        userAgent: navigator.userAgent,
        touchPoints: navigator.maxTouchPoints,
        hints: (await navigator.userAgentData?.getHighEntropyValues?.(["uaFullVersion", "platformVersion", "model"]).catch(() => undefined)) ?? null,
      }))()`);
      if (!isRecord(reported) || typeof reported.userAgent !== "string" || typeof reported.touchPoints !== "number") {
        throw new Error(`the ${target} session's browser did not report its device`);
      }
      const allocation = attestAllocation(target, device, {
        capabilities,
        userAgent: reported.userAgent,
        touchPoints: reported.touchPoints,
        ...(isRecord(reported.hints) ? { hints: reported.hints } : {}),
      });
      await assertCleanSinks(session, label);
      const observations: Observations = {
        ...allocation,
        appAssetMatched: journey.appAsset === appAsset,
        viewReadOnly: journey.viewReadOnly,
        controlWritable: journey.controlWritable,
        promptAccepted: journey.promptAccepted,
        returnedToDirectory: journey.returnedToDirectory,
        sinksDetectable: LEAK_SINKS.length,
        sinkFindings: 0,
      };
      if (profile.homeScreenAlerts) {
        Object.assign(observations, await homeScreenAlerts(session, origin, () => commandPushFixture(location(attempt.epoch), "ask", fixture.execute)));
      }
      observations.tunnelRefusals = (proxy?.refusals() ?? 0) - refusalsBefore;
      observations.elapsedMs = Date.now() - started;
      return observations;
    } finally {
      // Cleanup ends it again from the recorded id if this fails.
      await endWebDriverSession(credentials, session.id).catch(() => undefined);
    }
  };

  const publishedSession = async (label: string): Promise<SessionMetadata | undefined> => {
    const response = await fetch(`${origin}/api/v1/sessions`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`the candidate gateway refused its session list with HTTP ${response.status}`);
    const matches = parseSessionListResponse(await response.json()).sessions.filter(session => session.cwdLabel === label);
    if (matches.length > 1) throw new Error("a device-cloud session label is published more than once");
    return matches[0];
  };

  return {
    now: Date.now,
    pause: Bun.sleep,
    admit: async () => {
      await admitDeviceCloud(options.environment);
    },
    fixture: (operation, epoch) => commandPushFixture(location(epoch), operation, fixture.execute),
    fixtureSession: epoch => publishedSession(basename(location(epoch).root)),
    liveSession: publishedSession,
    tunnel: async (operation, epoch) => {
      if (operation === "stop") {
        // The proxy first: a tunnel that outlives SIGKILL then forwards only to a closed port.
        await proxy?.close();
        proxy = undefined;
        await stopTunnel(tunnelIdentifier(epoch));
        return;
      }
      proxy = await startAllowlistProxy(await connectAllowlist(origin));
      await startTunnel({
        java: javaExecutable(options.environment),
        jar: await ensureTunnelJar(),
        directory: join(options.workspace, epoch),
        identifier: tunnelIdentifier(epoch),
        localProxyPort: proxy.port,
      }, credentials);
    },
    verify,
    endSession: sessionId => endWebDriverSession(credentials, sessionId),
    record: sessionId => api.testRecord(sessionId),
    launch: (session, mode) => launchLink(origin, session, mode),
    removeWorkspace: async epoch => {
      await rm(join(options.workspace, epoch), { recursive: true, force: true });
    },
  };
}
