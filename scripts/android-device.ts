/**
 * Drive Chrome on a physically attached Android device over adb + the DevTools protocol.
 *
 * Playwright cannot do this for us. `connectOverCDP` never resolves against stock
 * Chrome-for-Android: the WebSocket establishes and both sides exchange CDP frames, but Playwright
 * initializes every target and the tab list contains an undriveable `chrome-native://newtab/`.
 * Playwright's separate `_android` API works around that, but `_android.launchBrowser()` needs
 * `chrome://flags/#enable-command-line-on-non-rooted-devices` toggled by hand first, because
 * release Chrome ignores the command-line file it writes. Raw CDP has neither problem.
 *
 * Two device-specific behaviours are load-bearing and cost hours to find:
 *
 *  - Chrome must be awake. A cached Chrome (`curProcState=19 CACHED_EMPTY`) still accepts TCP on
 *    `@chrome_devtools_remote` and then never replies, which reads exactly like a protocol bug.
 *    {@link wakeChrome} starts it before any socket is opened.
 *  - `Target.createTarget`'s `url` is ignored on Android. The tab opens blank regardless, so the
 *    caller must `Page.navigate` explicitly.
 */
const DEFAULT_BROWSER_PACKAGE = "com.android.chrome";
const DEFAULT_DEVTOOLS_SOCKET = "localabstract:chrome_devtools_remote";
const ANDROID_PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u;
const ANDROID_CLASS_PATTERN = /^\.?[A-Za-z_][A-Za-z0-9_.]*(?:\.[A-Za-z_][A-Za-z0-9_.]*)*$/u;
const DEVTOOLS_SOCKET_PATTERN = /^localabstract:[A-Za-z0-9_.-]+$/u;
const DEFAULT_FORWARD_PORT = 9222;
const CALL_TIMEOUT_MS = 25_000;
const OPEN_TIMEOUT_MS = 10_000;
const LOAD_POLL_MS = 500;
const LOAD_ATTEMPTS = 60;

export interface AndroidBrowserTarget {
  readonly packageName: string;
  readonly activity: string;
  readonly devtoolsSocket: string;
}

function environmentOverride(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new Error(name + " must not be empty");
  return value.trim();
}

/** Browser process selected for physical-device evidence. Every endpoint is independently overrideable. */
export function resolveAndroidBrowserTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AndroidBrowserTarget {
  const packageName = environmentOverride(environment, "OMP_ANDROID_BROWSER_PACKAGE") ?? DEFAULT_BROWSER_PACKAGE;
  if (!ANDROID_PACKAGE_PATTERN.test(packageName)) {
    throw new Error("OMP_ANDROID_BROWSER_PACKAGE must be an Android package name");
  }

  const activity =
    environmentOverride(environment, "OMP_ANDROID_BROWSER_ACTIVITY") ??
    packageName + "/com.google.android.apps.chrome.Main";
  const [activityPackage, activityClass, extraActivityPart] = activity.split("/");
  if (
    extraActivityPart !== undefined ||
    activityPackage !== packageName ||
    activityClass === undefined ||
    !ANDROID_CLASS_PATTERN.test(activityClass)
  ) {
    throw new Error("OMP_ANDROID_BROWSER_ACTIVITY must be a component in the selected package");
  }

  const socketOverride = environmentOverride(environment, "OMP_ANDROID_DEVTOOLS_SOCKET");
  if (packageName !== DEFAULT_BROWSER_PACKAGE && socketOverride === undefined) {
    throw new Error("OMP_ANDROID_DEVTOOLS_SOCKET is required for an alternate browser package");
  }
  const devtoolsSocket = socketOverride ?? DEFAULT_DEVTOOLS_SOCKET;
  if (!DEVTOOLS_SOCKET_PATTERN.test(devtoolsSocket)) {
    throw new Error("OMP_ANDROID_DEVTOOLS_SOCKET must be a localabstract socket name");
  }
  return { packageName, activity, devtoolsSocket };
}

export interface AndroidChromeDriver {
  /** Serial of the attached device, for evidence records. */
  readonly serial: string;
  readonly packageName: string;
  readonly androidPackageVersion: string;
  readonly browserActivity: string;
  readonly devtoolsSocket: string;
  /** Browser.getVersion, which carries the exact Chrome build and Chromium revision. */
  version(): Promise<Record<string, unknown>>;
  /** Opens a tab this process owns, so a run never disturbs the user's existing tabs. */
  openTab(): Promise<void>;
  /** Navigates the owned tab and waits for document.readyState to become complete. */
  navigate(url: string): Promise<string>;
  /** Evaluates an expression in the owned tab and returns its value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Raw escape hatch for protocol domains this helper does not wrap. */
  send(method: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function adb(serial: string | undefined, ...args: readonly string[]): Promise<string> {
  const argv = serial === undefined ? ["adb", ...args] : ["adb", "-s", serial, ...args];
  const subprocess = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if ((await subprocess.exited) !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

export function parseAndroidPackageVersion(dumpsys: string): string {
  const version = dumpsys.match(/^\s*versionName=(.+)$/mu)?.[1]?.trim();
  if (version === undefined || version.length === 0) {
    throw new Error("Android package metadata is missing versionName");
  }
  return version;
}

export function assertBrowserVersionMatchesPackage(
  packageName: string,
  androidPackageVersion: string,
  browserVersion: Readonly<Record<string, unknown>>,
): void {
  const product = browserVersion.product;
  const cdpVersion = typeof product === "string" ? product.match(/^Chrome\/(.+)$/u)?.[1] : undefined;
  if (cdpVersion !== androidPackageVersion) {
    throw new Error(
      "DevTools browser version does not match " + packageName + ": " +
        JSON.stringify(product) + " != " + JSON.stringify(androidPackageVersion),
    );
  }
}

export function assertDevtoolsEndpointMatchesPackage(
  packageName: string,
  androidPackageVersion: string,
  metadata: unknown,
): string {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("DevTools endpoint metadata is invalid");
  }
  const endpoint = metadata as Record<string, unknown>;
  if (endpoint["Android-Package"] !== packageName) {
    throw new Error("DevTools socket is not owned by " + packageName);
  }
  const product = endpoint.Browser;
  const endpointVersion = typeof product === "string" ? product.match(/^Chrome\/(.+)$/u)?.[1] : undefined;
  if (endpointVersion !== androidPackageVersion) {
    throw new Error("DevTools endpoint version does not match " + packageName);
  }
  if (typeof endpoint.webSocketDebuggerUrl !== "string") {
    throw new Error("DevTools endpoint has no browser WebSocket URL");
  }
  return endpoint.webSocketDebuggerUrl;
}

async function androidPackageVersion(serial: string, packageName: string): Promise<string> {
  return parseAndroidPackageVersion(await adb(serial, "shell", "dumpsys", "package", packageName));
}

/** The single attached device, or a clear error naming what was found instead. */
export async function requireSingleDevice(): Promise<string> {
  const listed = await adb(undefined, "devices");
  const serials = listed
    .split("\n")
    .slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(parts => parts[1] === "device")
    .map(parts => parts[0] ?? "");
  const serial = serials[0];
  if (serial === undefined) throw new Error("no authorized adb device; check the USB debugging prompt on the phone");
  if (serials.length > 1) throw new Error(`expected one device, found ${serials.length}: ${serials.join(", ")}`);
  return serial;
}

/**
 * Starts Chrome and waits for it to leave a cached process state. A cached Chrome accepts the
 * DevTools socket and never answers, so skipping this turns every later call into a timeout.
 */
async function wakeChrome(serial: string, target: AndroidBrowserTarget): Promise<void> {
  await adb(serial, "shell", "am", "start", "-W", "-n", target.activity, "-a", "android.intent.action.MAIN");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await adb(
      serial,
      "shell",
      "dumpsys",
      "activity",
      "processes",
      "|",
      "grep",
      target.packageName,
    ).catch(() => "");
    if (!state.includes("CACHED_EMPTY")) return;
    await Bun.sleep(250);
  }
}

/**
 * Opens a CDP session against Chrome on the device, hands it to `run`, and always tears down the
 * owned tab and the adb forward — including on failure, so a crashed run leaves no device state.
 */
export async function withAndroidChrome<T>(
  run: (driver: AndroidChromeDriver) => Promise<T>,
  options: { readonly port?: number } = {},
): Promise<T> {
  const port = options.port ?? DEFAULT_FORWARD_PORT;
  const target = resolveAndroidBrowserTarget();
  const serial = await requireSingleDevice();
  const packageVersion = await androidPackageVersion(serial, target.packageName);
  await wakeChrome(serial, target);
  await adb(serial, "forward", "tcp:" + port, target.devtoolsSocket);

  let webSocketDebuggerUrl: string;
  try {
    const endpointResponse = await fetch("http://127.0.0.1:" + port + "/json/version");
    if (!endpointResponse.ok) throw new Error("DevTools endpoint metadata request failed");
    webSocketDebuggerUrl = assertDevtoolsEndpointMatchesPackage(
      target.packageName,
      packageVersion,
      await endpointResponse.json(),
    );
  } catch (error) {
    await adb(serial, "forward", "--remove", "tcp:" + port).catch(() => {});
    throw error;
  }
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  let nextId = 0;
  let sessionId: string | undefined;
  let targetId: string | undefined;

  socket.onmessage = (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      error?: { message: string };
      result?: Record<string, unknown>;
    };
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result ?? {});
  };

  const send = (method: string, parameters: Record<string, unknown> = {}, useSession = true) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, { resolve, reject });
      const frame: Record<string, unknown> = { id, method, params: parameters };
      if (useSession && sessionId !== undefined) frame.sessionId = sessionId;
      socket.send(JSON.stringify(frame));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, CALL_TIMEOUT_MS);
    });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("DevTools WebSocket failed; is Chrome awake and adb forwarding?"));
      setTimeout(() => reject(new Error("DevTools WebSocket open timeout")), OPEN_TIMEOUT_MS);
    });

    const browserVersion = await send("Browser.getVersion", {}, false);
    assertBrowserVersionMatchesPackage(target.packageName, packageVersion, browserVersion);

    const driver: AndroidChromeDriver = {
      serial,
      packageName: target.packageName,
      androidPackageVersion: packageVersion,
      browserActivity: target.activity,
      devtoolsSocket: target.devtoolsSocket,
      version: () => Promise.resolve(browserVersion),
      async openTab() {
        const created = await send("Target.createTarget", { url: "about:blank" }, false);
        targetId = String(created.targetId);
        const attached = await send("Target.attachToTarget", { targetId, flatten: true }, false);
        sessionId = String(attached.sessionId);
        await send("Page.enable");
        await send("Runtime.enable");
      },
      async navigate(url: string) {
        const result = await send("Page.navigate", { url });
        if (typeof result.errorText === "string") throw new Error(`navigation failed: ${result.errorText}`);
        for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
          await Bun.sleep(LOAD_POLL_MS);
          const state = await driver
            .evaluate<[string, string]>("[document.readyState, location.href]")
            .catch(() => undefined);
          if (state?.[0] === "complete" && !state[1].startsWith("about:")) return state[1];
        }
        throw new Error(`page did not finish loading: ${url}`);
      },
      async evaluate<T>(expression: string) {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        const wrapper = result.result as { value?: T } | undefined;
        return wrapper?.value as T;
      },
      send: (method, parameters) => send(method, parameters),
    };

    return await run(driver);
  } finally {
    if (targetId !== undefined) {
      await send("Target.closeTarget", { targetId }, false).catch(() => {});
    }
    socket.close();
    await adb(serial, "forward", "--remove", `tcp:${port}`).catch(() => {});
  }
}

/** Device identity for an evidence record. */
export async function deviceIdentity(serial: string): Promise<Record<string, string>> {
  const property = async (name: string) => (await adb(serial, "shell", "getprop", name)).trim();
  return {
    serial,
    androidRelease: await property("ro.build.version.release"),
    buildId: await property("ro.build.id"),
    sdk: await property("ro.build.version.sdk"),
    model: await property("ro.product.model"),
  };
}
