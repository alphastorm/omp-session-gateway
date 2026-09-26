/**
 * Real-device forbidden-sink acceptance sweep.
 *
 * `docs/SECURITY.md` forbids capability material from reaching any browser persistence sink. This
 * proves that on a physical Android device against a live gateway, rather than in an emulated
 * viewport.
 *
 * Every run is self-verifying. A positive control plants a synthetic secret in all seven sinks and
 * requires the detector to find each one; only then does the real sweep run. A sweep whose detector
 * has never detected anything cannot distinguish "clean" from "broken", so the control is a gate,
 * not an option.
 *
 * The capability is never printed, logged, or written. It is fetched inside the page, reduced to a
 * length and a short digest for the evidence record, and used only as a search needle in that same
 * JavaScript context.
 *
 * Usage: `bun scripts/android-leak-sweep.ts <origin> <session-cwd-label>`
 */
import { withAndroidChrome, type AndroidChromeDriver } from "./android-device.ts";
import { isProtectedLabel, targetEligibility } from "./acceptance-target.ts";
import { ANDROID_LEAK_SWEEP_STAGES, announceAndroidStage } from "./android-stages.ts";
import {
  LEAK_CONTROL_EXPRESSION,
  LEAK_SINKS,
  leakControlGaps,
  leakSweepExpression,
  type LeakControlResult,
  type LeakSweepResult,
} from "./browser-journey.ts";

/** Plants a synthetic secret in every sink, requires detection, then removes each plant. */
async function runControl(driver: AndroidChromeDriver): Promise<LeakControlResult> {
  const evaluation = await driver.send("Runtime.evaluate", {
    expression: LEAK_CONTROL_EXPRESSION,
    awaitPromise: true,
    returnByValue: true,
  });
  return extract<LeakControlResult>(evaluation);
}

/** Launches a view capability exactly as the PWA does, then searches every sink for it. */
async function runSweep(driver: AndroidChromeDriver, label: string): Promise<LeakSweepResult> {
  const evaluation = await driver.send("Runtime.evaluate", {
    expression: leakSweepExpression(label, { detail: true }),
    awaitPromise: true,
    returnByValue: true,
  });
  return extract<LeakSweepResult>(evaluation);
}

function extract<T>(evaluation: Record<string, unknown>): T {
  const result = evaluation.result as { value?: T; description?: string } | undefined;
  if (!result || result.value === undefined) {
    throw new Error(`page evaluation returned no value: ${result?.description ?? JSON.stringify(evaluation)}`);
  }
  return result.value;
}

const origin = process.argv[2];
const label = process.argv[3];
const allowDisposableTarget = process.argv[4] === "--disposable-target";
if (!origin || !label || process.argv.length > 5 || (process.argv[4] !== undefined && !allowDisposableTarget)) {
  console.error("usage: bun scripts/android-leak-sweep.ts <origin> <session-cwd-label> [--disposable-target]");
  process.exit(2);
}
if (isProtectedLabel(label)) throw new Error("refusing protected or soak target label");
announceAndroidStage(ANDROID_LEAK_SWEEP_STAGES, "target preflight");
const targetResponse = await fetch(origin + "/api/v1/sessions", { cache: "no-store", credentials: "omit" });
if (!targetResponse.ok) throw new Error("session-list preflight failed with HTTP " + targetResponse.status);
const targetPayload = (await targetResponse.json()) as {
  sessions?: Array<{ cwdLabel: string; startedAt?: string; canView: boolean }>;
};
const targetMatches = (targetPayload.sessions ?? []).filter(session => session.cwdLabel === label);
if (targetMatches.length !== 1) throw new Error("expected exactly one disposable target; found " + targetMatches.length);
if (targetMatches[0]!.canView !== true) throw new Error("disposable target lacks View capability");
const eligibility = targetEligibility(label, targetMatches[0]!.startedAt, Date.now(), allowDisposableTarget);
if (!eligibility.eligible) throw new Error(eligibility.reason ?? "disposable target is ineligible");

announceAndroidStage(ANDROID_LEAK_SWEEP_STAGES, "Android Chrome");
const { control, sweep, serial, browser } = await withAndroidChrome(async driver => {
  const browserVersion = await driver.version();
  await driver.openTab();
  await driver.navigate(origin + "/");
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, 6000);
  await settle.promise;
  announceAndroidStage(ANDROID_LEAK_SWEEP_STAGES, "detector control");
  const control = await runControl(driver);
  announceAndroidStage(ANDROID_LEAK_SWEEP_STAGES, "capability sweep");
  const sweep = await runSweep(driver, label);
  return {
    serial: driver.serial,
    browser: {
      packageName: driver.packageName,
      androidPackageVersion: driver.androidPackageVersion,
      browserVersion,
      devtoolsSocket: driver.devtoolsSocket,
      browserActivity: driver.browserActivity,
    },
    control,
    sweep,
  };
});

announceAndroidStage(ANDROID_LEAK_SWEEP_STAGES, "verdict");

const { missed, residualPlants } = leakControlGaps(control);

console.log("device        " + serial);
console.log("browser       " + JSON.stringify(browser));
console.log(`origin        ${origin}`);
console.log(`control       planted ${control.plantedUnique.length}, detected ${control.detectedUnique.length}`);
if (missed.length > 0) {
  console.error(`DETECTOR UNPROVEN — planted but not detected: ${missed.join(", ")}`);
  process.exit(1);
}
if (residualPlants.length > 0) {
  console.error(`CONTROL LEFT RESIDUE: ${JSON.stringify(residualPlants)}`);
  process.exit(1);
}
console.log(`              all ${LEAK_SINKS.length} sinks proven detectable, no residue`);

if (sweep.error !== undefined) {
  console.error(`SWEEP FAILED: ${sweep.error}${sweep.seen ? ` (published: ${sweep.seen.join(", ")})` : ""}`);
  process.exit(1);
}
console.log(`launch        ${sweep.launchStatus} cache-control="${sweep.launchCacheControl}" keys=${sweep.launchKeys?.join(",")}`);
console.log(`capability    ${sweep.capabilityLength} chars, sha256:${sweep.capabilityDigest}, ${sweep.needleCount} needles`);
console.log(`caches        ${sweep.cacheNames?.join(", ") || "none"}`);
console.log(`indexedDB     ${sweep.indexedDbNames?.length ? sweep.indexedDbNames.join(", ") : "none"}`);
console.log(`address       ${sweep.locationHref} (hash ${sweep.locationHashLength} chars)`);

if ((sweep.findings?.length ?? 0) > 0) {
  console.error(`CAPABILITY LEAKED INTO: ${sweep.findings?.join(", ")}`);
  process.exit(1);
}
console.log(`result        clean — capability absent from all ${LEAK_SINKS.length} sinks, resource timings, and DOM`);
