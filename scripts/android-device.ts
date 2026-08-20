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
const DEVTOOLS_SOCKET = "localabstract:chrome_devtools_remote";
const CHROME_PACKAGE = "com.android.chrome";
const CHROME_ACTIVITY = `${CHROME_PACKAGE}/com.google.android.apps.chrome.Main`;
const DEFAULT_FORWARD_PORT = 9222;
const CALL_TIMEOUT_MS = 25_000;
const OPEN_TIMEOUT_MS = 10_000;
const LOAD_POLL_MS = 500;
const LOAD_ATTEMPTS = 60;

export interface AndroidChromeDriver {
  /** Serial of the attached device, for evidence records. */
  readonly serial: string;
  /** `Browser.getVersion`, which carries the exact Chrome build. */
  version(): Promise<Record<string, unknown>>;
  /** Opens a tab this process owns, so a run never disturbs the user's existing tabs. */
  openTab(): Promise<void>;
  /** Navigates the owned tab and waits for `document.readyState === "complete"`. */
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
async function wakeChrome(serial: string): Promise<void> {
  await adb(serial, "shell", "am", "start", "-W", "-n", CHROME_ACTIVITY, "-a", "android.intent.action.MAIN");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await adb(serial, "shell", "dumpsys", "activity", "processes", "|", "grep", CHROME_PACKAGE).catch(
      () => "",
    );
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
  const serial = await requireSingleDevice();
  await wakeChrome(serial);
  await adb(serial, "forward", `tcp:${port}`, DEVTOOLS_SOCKET);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
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

    const driver: AndroidChromeDriver = {
      serial,
      version: () => send("Browser.getVersion", {}, false),
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

/** Device and browser identity for an evidence record. */
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
