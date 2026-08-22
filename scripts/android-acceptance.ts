/**
 * Physical-device acceptance matrix: discovery, launch authorization, and resilience.
 *
 * Runs against a real Android phone over USB adb, so CDP control survives every radio change. Two
 * Android behaviours shape the method and are worth knowing before editing this file.
 *
 * Chrome freezes the renderer while the display is off, so `Runtime.evaluate` never resolves on a
 * locked device. Lock/resume is therefore measured after waking, never during.
 *
 * A bounded in-page fetch cannot distinguish "no route" from "slow recovery" if the bound is tight.
 * An early version used 8 seconds and reported a clean recovery as a network failure. Each attempt
 * now gets 20 seconds and records the error name, so `TimeoutError` and `TypeError` stay separable,
 * and recovery is polled and timed rather than asserted at a single arbitrary instant.
 *
 * Radio state is restored in a finally block. Callers should still restore afterwards: a killed
 * process runs no finally.
 *
 * Usage: `bun scripts/android-acceptance.ts <origin> <session-cwd-label>`
 */
import { wakeAndroidDisplay, withAndroidChrome, type AndroidChromeDriver } from "./android-device.ts";
import { isProtectedLabel, targetEligibility } from "./acceptance-target.ts";

const POWER = "26";

let serial = "";

async function adb(...args: readonly string[]): Promise<string> {
  const subprocess = Bun.spawn(["adb", "-s", serial, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(subprocess.stdout).text();
  await subprocess.exited;
  return stdout.trim();
}

async function sleep(milliseconds: number): Promise<void> {
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, milliseconds);
  await settle.promise;
}

/**
 * Wakes the display and confirms it, rather than firing keyevents and hoping.
 *
 * A run where the display never came back produced `cdp-timeout` on nearly every probe, because
 * Chrome freezes the renderer while the screen is off and `Runtime.evaluate` then never resolves.
 * That is unmeasurable, not a product result, and it silently looked like a stall. Returning the
 * observed wakefulness lets a caller record "the harness could not present a visible page" instead
 * of attributing the timeout to the application.
 */
async function wake(): Promise<string> {
  return wakeAndroidDisplay((...args) => adb(...args), sleep);
}

/**
 * Brings the owned tab to the foreground and confirms the page agrees it is visible.
 *
 * A woken display is not enough: the tab can still be backgrounded, and `document.visibilityState`
 * is what actually governs whether the app's resume path runs. `Page.bringToFront` is the protocol
 * way to do this; keyevents cannot.
 */
async function ensureVisible(driver: AndroidChromeDriver): Promise<string> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await driver.send("Page.bringToFront");
    } catch {
      // Not fatal: a frozen renderer rejects it, and the retry after another wake may succeed.
    }
    try {
      const evaluation = await driver.send("Runtime.evaluate", {
        expression: "document.visibilityState",
        returnByValue: true,
      });
      const { result } = evaluation;
      if (result && typeof result === "object" && "value" in result && result.value === "visible") return "visible";
    } catch {
      // CDP timeout means the renderer is still frozen; wake again and retry.
    }
    await wake();
  }
  return "not-visible";
}

/** One reachability attempt plus the app's own rendered state, generously bounded. */
const ATTEMPT = `(async () => {
  const started = performance.now();
  const out = { online: navigator.onLine, visibility: document.visibilityState };
  try {
    const response = await fetch("/api/v1/sessions", { cache: "no-store", signal: AbortSignal.timeout(20000) });
    const payload = await response.json();
    out.status = response.status;
    out.count = payload.sessions.length;
    out.revision = payload.revision;
  } catch (error) {
    out.status = "failed";
    out.failure = error && error.name ? error.name : "unknown";
  }
  out.elapsedMs = Math.round(performance.now() - started);
  const text = document.body.innerText.replace(/\\s+/g, " ").trim();
  out.unreachableBanner = text.includes("unreachable");
  return out;
})()`;

function readValue(evaluation: Record<string, unknown>): Record<string, unknown> | undefined {
  const { result } = evaluation;
  if (!result || typeof result !== "object" || !("value" in result)) return undefined;
  const value = result.value;
  if (!value || typeof value !== "object") return undefined;
  return { ...value };
}

/** Never throws: a frozen renderer is an observation, not a harness failure. */
async function attempt(driver: AndroidChromeDriver, step: string): Promise<Record<string, unknown>> {
  try {
    const evaluation = await driver.send("Runtime.evaluate", { expression: ATTEMPT, awaitPromise: true, returnByValue: true });
    return { step, ...(readValue(evaluation) ?? { probe: "no-value" }) };
  } catch {
    return { step, probe: "cdp-timeout" };
  }
}

const timeline: Record<string, unknown>[] = [];
function record(entry: Record<string, unknown>): void {
  timeline.push(entry);
  console.error(`  ${JSON.stringify(entry)}`);
}

/** True when the phone itself can reach the host, independent of anything Chrome is doing. */
async function deviceReachesHost(host: string): Promise<boolean> {
  const output = await adb("shell", "ping", "-c", "1", "-W", "2", host);
  return output.includes("1 received");
}

/**
 * Polls until the directory is reachable, returning milliseconds since the disruption ended.
 *
 * Each attempt also pings the host from the device shell. That separates a slow tailnet from a
 * stuck page: if the device cannot reach the host either, the delay is not the application's.
 */
async function awaitRecovery(
  driver: AndroidChromeDriver,
  label: string,
  since: number,
  attempts: number,
  host: string,
): Promise<{ recoveredMs: number | null; deviceReachableFirstMs: number | null }> {
  let deviceReachableFirstMs: number | null = null;
  for (let index = 1; index <= attempts; index++) {
    await sleep(8000);
    // The app's resume path is driven by visibilityState, so a probe against a hidden or frozen page
    // measures nothing. Record the presentation state alongside the result so an unmeasurable run is
    // visibly unmeasurable rather than looking like an application stall.
    const presentation = await ensureVisible(driver);
    const deviceReachable = await deviceReachesHost(host);
    const probe = await attempt(driver, `${label}-${index}`);
    const sinceMs = Math.round(performance.now() - since);
    if (deviceReachable && deviceReachableFirstMs === null) deviceReachableFirstMs = sinceMs;
    record({ ...probe, presentation, deviceReachable, sinceMs });
    if (probe.status === 200) return { recoveredMs: sinceMs, deviceReachableFirstMs };
  }
  return { recoveredMs: null, deviceReachableFirstMs };
}

/** Discovery plus the full launch-authorization matrix, evaluated from the device. */
async function authorizationMatrix(driver: AndroidChromeDriver, label: string): Promise<Record<string, unknown>> {
  const script = `(async () => {
    const launch = async (id, generation, mode) => {
      const response = await fetch("/api/v1/sessions/" + id + "/launch", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ generation, mode }),
      });
      const text = await response.text();
      let code;
      try {
        const parsed = JSON.parse(text);
        code = parsed.code ?? parsed.error ?? (typeof parsed.capability === "string" ? "capability" : undefined);
      } catch { code = text.slice(0, 40); }
      return { status: response.status, code, noStore: (response.headers.get("cache-control") ?? "").includes("no-store") };
    };
    const list = await (await fetch("/api/v1/sessions", { cache: "no-store" })).json();
    const target = list.sessions.find(session => session.cwdLabel === ${JSON.stringify(label)});
    if (!target) return { error: "target not published", published: list.sessions.map(s => s.cwdLabel) };
    return {
      revision: list.revision,
      published: list.sessions.length,
      discovered: { generation: target.generation, canView: target.canView, canControl: target.canControl },
      view: await launch(target.instanceId, target.generation, "view"),
      control: await launch(target.instanceId, target.generation, "control"),
      staleView: await launch(target.instanceId, target.generation + 5, "view"),
      staleControl: await launch(target.instanceId, target.generation + 5, "control"),
      invalidGeneration: await launch(target.instanceId, 0, "view"),
      unknownSession: await launch("00000000-0000-4000-8000-000000000000", 1, "view"),
    };
  })()`;
  const evaluation = await driver.send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
  const value = readValue(evaluation);
  if (!value) throw new Error("authorization matrix returned no value");
  return value;
}

const args = process.argv.slice(2);
const acknowledgedDisposable = args.includes("--disposable-target");
const [origin, label] = args.filter(value => !value.startsWith("--"));
if (!origin || !label) {
  console.error("usage: bun scripts/android-acceptance.ts <origin> <session-cwd-label> [--disposable-target]");
  process.exit(2);
}

// Refused before any network call, so the refusal cannot depend on whether the protected session
// happens to be published at this instant.
if (isProtectedLabel(label)) {
  console.error(`REFUSED: "${label}" matches a protected pattern and can never be a target.`);
  console.error("this harness fires real view, control, and stale-generation launches at the target.");
  console.error("create a disposable session instead; a relay soak host lost 7h40m to exactly this.");
  process.exit(2);
}

const host = new URL(origin).hostname;

// Refuse an ineligible target before touching the device or the session. This runs against the
// gateway rather than the phone precisely so an ineligible target costs nothing and cannot be
// discovered halfway through a run that has already fired launches at it.
const listResponse = await fetch(new URL("/api/v1/sessions", origin), { headers: { accept: "application/json" } });
if (!listResponse.ok) {
  console.error(`could not read the session list to validate the target: HTTP ${listResponse.status}`);
  process.exit(2);
}
const listed: unknown = await listResponse.json();
const sessions =
  listed && typeof listed === "object" && "sessions" in listed && Array.isArray(listed.sessions) ? listed.sessions : [];
const match = sessions.find(
  (session): session is { cwdLabel: string; startedAt?: string } =>
    session !== null && typeof session === "object" && "cwdLabel" in session && session.cwdLabel === label,
);
if (!match) {
  console.error(`target "${label}" is not published; nothing was touched`);
  process.exit(2);
}
const eligibility = targetEligibility(label, match.startedAt, Date.now(), acknowledgedDisposable);
if (!eligibility.eligible) {
  console.error(`REFUSED: ${eligibility.reason}`);
  console.error("this harness fires real view, control, and stale-generation launches at the target.");
  process.exit(2);
}

const summary = await withAndroidChrome(async driver => {
  serial = driver.serial;
  const browserVersion = await driver.version();
  await wake();
  await driver.openTab();
  await driver.navigate(`${origin}/`);
  await sleep(8000);

  const authorization = await authorizationMatrix(driver, label);
  console.error(`  authorization: ${JSON.stringify(authorization)}`);
  record(await attempt(driver, "baseline"));

  let unlockMs: number | null = null;
  let airplane: { recoveredMs: number | null; deviceReachableFirstMs: number | null } = { recoveredMs: null, deviceReachableFirstMs: null };
  let doze: { recoveredMs: number | null; deviceReachableFirstMs: number | null } = { recoveredMs: null, deviceReachableFirstMs: null };
  let outageBanner: unknown = null;

  try {
    // Lock and resume.
    await adb("shell", "input", "keyevent", POWER);
    await sleep(20000);
    const wokeAt = performance.now();
    const wakefulness = await wake();
    const presentation = await ensureVisible(driver);
    await sleep(3000);
    const unlocked: Record<string, unknown> = { ...(await attempt(driver, "after-unlock")), wakefulness, presentation };
    unlockMs = Math.round(performance.now() - wokeAt);
    record({ ...unlocked, sinceMs: unlockMs });
    if (unlocked.status !== 200) unlockMs = null;

    // Total network loss and automatic recovery, with no reload.
    await adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
    await sleep(15000);
    const during = await attempt(driver, "airplane-on");
    outageBanner = during.unreachableBanner;
    record(during);
    await adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
    airplane = await awaitRecovery(driver, "airplane-recovery", performance.now(), 20, host);

    // Forced deep Doze.
    await adb("shell", "dumpsys", "battery", "unplug");
    await adb("shell", "dumpsys", "deviceidle", "force-idle");
    await sleep(20000);
    record({ step: "doze-state", idle: await adb("shell", "dumpsys", "deviceidle", "get", "deep") });
    await adb("shell", "dumpsys", "deviceidle", "unforce");
    await adb("shell", "dumpsys", "battery", "reset");
    doze = await awaitRecovery(driver, "doze-recovery", performance.now(), 6, host);
  } finally {
    await adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
    await adb("shell", "svc", "wifi", "enable");
    await adb("shell", "svc", "data", "enable");
    await adb("shell", "dumpsys", "deviceidle", "unforce");
    await adb("shell", "dumpsys", "battery", "reset");
  }

  return {
    serial: driver.serial,
    packageName: driver.packageName,
    androidPackageVersion: driver.androidPackageVersion,
    browserVersion,
    devtoolsSocket: driver.devtoolsSocket,
    browserActivity: driver.browserActivity,
    authorization,
    unlockMs,
    outageBanner,
    airplaneRecoveredMs: airplane.recoveredMs,
    airplaneDeviceReachableMs: airplane.deviceReachableFirstMs,
    dozeRecoveredMs: doze.recoveredMs,
  };
});

console.log(JSON.stringify(summary, null, 1));

const authorization = summary.authorization;
const failures: string[] = [];
const expect = (name: string, actual: unknown, wanted: unknown): void => {
  if (actual !== wanted) failures.push(`${name}: expected ${String(wanted)}, got ${String(actual)}`);
};
const status = (key: string): unknown => {
  const entry = authorization[key];
  return entry && typeof entry === "object" && "status" in entry ? entry.status : undefined;
};
expect("view launch", status("view"), 200);
expect("control launch", status("control"), 200);
expect("stale view rejected", status("staleView"), 409);
expect("stale control rejected", status("staleControl"), 409);
expect("unknown session rejected", status("unknownSession"), 404);
if (summary.unlockMs === null) failures.push("lock/resume did not recover");
// A tailnet that is still down is not an application failure, so attribute before failing.
if (summary.airplaneRecoveredMs === null) {
  failures.push(
    summary.airplaneDeviceReachableMs === null
      ? "airplane mode: the device never regained tailnet reachability within the window, so the app was never given a chance to recover"
      : `airplane mode: the device was reachable at ${String(summary.airplaneDeviceReachableMs)}ms but the app never recovered`,
  );
}
if (summary.dozeRecoveredMs === null) failures.push("Doze did not recover within the polling window");
if (summary.outageBanner !== true) failures.push("no unreachable banner during the outage");

if (failures.length > 0) {
  console.error(`FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.error("all device acceptance checks passed");
