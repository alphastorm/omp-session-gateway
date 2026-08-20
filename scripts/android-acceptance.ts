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
import { withAndroidChrome, type AndroidChromeDriver } from "./android-device.ts";

const WAKE = "224";
const MENU = "82";
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

async function wake(): Promise<void> {
  await adb("shell", "input", "keyevent", WAKE);
  await adb("shell", "input", "keyevent", MENU);
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
    await adb("shell", "input", "keyevent", WAKE);
    const deviceReachable = await deviceReachesHost(host);
    const probe = await attempt(driver, `${label}-${index}`);
    const sinceMs = Math.round(performance.now() - since);
    if (deviceReachable && deviceReachableFirstMs === null) deviceReachableFirstMs = sinceMs;
    record({ ...probe, deviceReachable, sinceMs });
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

const origin = process.argv[2];
const label = process.argv[3];
if (!origin || !label) {
  console.error("usage: bun scripts/android-acceptance.ts <origin> <session-cwd-label>");
  process.exit(2);
}

const host = new URL(origin).hostname;

const summary = await withAndroidChrome(async driver => {
  serial = driver.serial;
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
    await wake();
    await sleep(3000);
    const unlocked = await attempt(driver, "after-unlock");
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
