import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { cleanupWindows, runWindows, verifyWindowsDoctor, windowsCampaignLabel, windowsNeedsCleanup, assertWindowsPins } from "./windows-stable-qualification.ts";
import type { WindowsContext, WindowsFirewall, WindowsGuestAction, WindowsIdentity, WindowsInstance, WindowsRuntime } from "./windows-stable-qualification.ts";
import { verifyWindowsStaleLaunch, windowsPixelLauncher, waitForStableWindowsTransport } from "./windows-qualification-runtime.ts";
import { firewallEligibility } from "./vultr-target.ts";
import { parseQualificationPins } from "./stable-qualification.ts";

const epoch = "11111111-1111-4111-8111-111111111111";
const label = windowsCampaignLabel(epoch);
const identity: WindowsIdentity = {
  tag: "v0.5.3",
  candidate: { tag: "v0.5.3", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/synthetic/candidate.tar" },
  predecessor: { tag: "v0.5.2", sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64), archivePath: "/synthetic/predecessor.tar" },
  omp: parseQualificationPins(await readFile(new URL("../UPSTREAM.lock.json", import.meta.url), "utf8")),
};
const taggedDoctorChecks = { assets: true, compatibility: true, config: true, daemon: true, discoveryReadable: true,
  funnelDisabled: true, listenerLoopbackOnly: true, loopbackTrustSound: true, permissions: true, relay: true,
  serveMapping: true, serviceActive: true, serviceInstalled: true, tailscaleConnected: true,
  identityAllowed: false, pwa: false, sessionHealth: false, securityHeaders: true };
const doctorState = { loopbackOnly: true, logonTrigger: true, interactivePrincipal: true };
test("an authenticated transport error resets both the stability count and window", async () => {
  let now = 0; let failed = false;
  const uninterrupted: number[] = [];
  const result = await waitForStableWindowsTransport(async () => {
    if (!failed && uninterrupted.length === 1) {
      failed = true; uninterrupted.length = 0;
      throw new Error("WinRM transport not yet ready: HTTP 400");
    }
    uninterrupted.push(now);
    return { windowsBuild: 26100 };
  }, { now: () => now, sleep: async ms => { now += ms; } }, 180_000);
  expect(result.transportStabilitySamples).toBe(uninterrupted.length);
  expect(result.transportStabilitySamples).toBeGreaterThanOrEqual(3);
  expect(result.transportStabilityDurationMs).toBe(uninterrupted.at(-1)! - uninterrupted[0]!);
  expect(result.transportStabilityDurationMs).toBeGreaterThanOrEqual(60_000);
});
test("transport instability cannot extend the allocation deadline", async () => {
  let now = 0;
  await expect(waitForStableWindowsTransport(async () => {
    if (now >= 75_000) throw new Error("probe started after allocation deadline");
    throw new Error("WinRM transport not yet ready: HTTP 400");
  }, { now: () => now, sleep: async ms => { now += ms; } }, 75_000)).rejects.toThrow("stability window timed out");
  expect(now).toBe(75_000);
});
test("guest rejection is not treated as transient transport instability", async () => {
  let probes = 0; let elapsed = 0;
  const failure = new Error("provider guest shape mismatch");
  await expect(waitForStableWindowsTransport(async () => { probes += 1; throw failure; },
    { now: () => elapsed, sleep: async ms => { elapsed += ms; } }, 75_000)).rejects.toBe(failure);
  expect(probes).toBe(1);
  expect(elapsed).toBe(0);
});
test("Pixel restoration selects the installed app behind a non-exported Chrome activity", () => {
  const component = "com.android.chrome/org.chromium.chrome.browser.webapps.SameTaskWebApkActivity";
  const activities = [
    "* Task{a #10 type=standard A=101:com.android.chrome}",
    "ActivityRecord{a u0 com.android.chrome/com.google.android.apps.chrome.Main t10}",
    "* Task{b #20 type=standard A=102:org.chromium.webapk.fixture}",
    `ActivityRecord{b u0 ${component} t20}`,
  ].join("\n");
  expect(windowsPixelLauncher(activities, component)).toEqual({ packageName: "org.chromium.webapk.fixture", category: "android.intent.category.LAUNCHER" });
  expect(() => windowsPixelLauncher(activities + `\n* Task{c #21 A=103:org.chromium.webapk.other}\nActivityRecord{c u0 ${component} t21}`, component)).toThrow("ambiguous");
});
test("Pixel restoration returns to the home screen the Pixel started on", () => {
  // A home task has no affinity, so Android prints its intent component; its app answers HOME, not LAUNCHER.
  const component = "com.google.android.apps.nexuslauncher/.NexusLauncherActivity";
  const activities = [
    "* Task{d #2 type=home I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity U=0 rootTaskId=1 visible=true mode=fullscreen sz=2}",
    `ActivityRecord{d u0 ${component} t2}`,
    "rootOfTask=true task=Task{d #2 type=home I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity}",
    "* Task{e #30 type=standard A=101:com.android.chrome}",
    "ActivityRecord{e u0 com.android.chrome/com.google.android.apps.chrome.Main t30}",
  ].join("\n");
  expect(windowsPixelLauncher(activities, component)).toEqual({ packageName: "com.google.android.apps.nexuslauncher", category: "android.intent.category.HOME" });
});
function fixture(options: { development?: boolean; fail?: WindowsGuestAction; listener?: boolean; neverStarts?: boolean; vaultFails?: boolean; lostCreate?: boolean; protected?: boolean; unlabelled?: boolean; stale?: number } = {}) {
  let now = 1_800_000_000_000;
  let progress: unknown;
  const events: string[] = [];
  let instances: WindowsInstance[] = [];
  let firewalls: WindowsFirewall[] = [];
  const runtime: WindowsRuntime = {
    development: options.development === true,
    environment: options.protected ? { OMP_QUAL_PROTECTED_INSTANCES: "synthetic-owned" } : {},
    now: () => now, sleep: async ms => { now += ms; }, uuid: () => epoch,
    admit: async () => ({ admitted: true, protectionVerified: true, toolchainVerified: true }),
    provider: {
      instances: async () => instances,
      firewalls: async () => firewalls,
      instance: async id => instances.find(item => item.id === id),
      firewall: async id => firewalls.find(item => item.id === id),
      createFirewall: async description => { firewalls = [{ id: "synthetic-firewall", description }]; events.push("firewallCreated"); return firewalls[0]!; },
      configureFirewall: async () => { events.push("firewallConfigured"); },
      createInstance: async requested => {
        instances = [{ id: "synthetic-owned", label: options.unlabelled ? "unrelated" : requested, os_id: 2514, region: "ewr", plan: "vc2-2c-4gb", main_ip: "192.0.2.1", default_password: "synthetic-never-real" }];
        events.push("instanceCreated");
        if (options.lostCreate) throw new Error("response lost after provider creation");
        return instances[0]!;
      },
      destroyInstance: async id => { events.push("instanceDestroyed"); instances = instances.filter(item => item.id !== id); },
      destroyFirewall: async id => { events.push("firewallDestroyed"); firewalls = firewalls.filter(item => item.id !== id); },
    },
    saveAccess: async () => { events.push("vaultSaved"); if (options.vaultFails) throw new Error("private disk full"); },
    removeAccess: async () => { events.push("vaultRemoved"); },
    guest: async (_context: WindowsContext, action: WindowsGuestAction) => {
      now += 1_000; events.push(action);
      if (options.fail === action) throw new Error("guest operation failed");
      return {
        ready: !options.neverStarts, taskPresent: true, taskRunning: false, gatewayProcesses: 0, listeners: options.listener ? 1 : 0,
        configPreserved: true, readinessPreserved: true, readinessChanged: true, checks: taggedDoctorChecks, ...doctorState,
        namedPipe: true, generation: 1, viewStatus: 200, controlStatus: 200, staleViewStatus: options.stale ?? 409, staleControlStatus: 409, noStore: true,
        revoked: true, historySelected: true, restored: true, uninstalled: true,
        transportStabilitySamples: 3, transportStabilityDurationMs: 60_000,
      };
    },
    rdp: async () => { events.push("rdp"); },
    pixel: async () => { events.push("physicalPixel"); return { pixelIdentityAccepted: true, viewReadOnly: true, controlWritable: true, promptAccepted: true, returnedToDirectory: true }; },
    restorePixel: async () => { events.push("pixelRestored"); },
    deleteTailnet: async () => { events.push("tailnetDeleted"); },
  };
  // Installation readiness is not the automatic post-reboot readiness sample.
  const originalGuest = runtime.guest;
  if (options.neverStarts) runtime.guest = async (context, action) => ({ ...await originalGuest(context, action), ready: action !== "ready", note: "synthetic-guest-string" });
  const checkpoint = async (next: Record<string, unknown>) => { progress = structuredClone(next); events.push(`checkpoint:${String(next.phase)}`); };
  const pixel = async <T>(_owner: string, action: () => Promise<T>) => { events.push("pixelLease"); return action(); };
  return { runtime, events, checkpoint, pixel, get progress() { return progress; }, get instances() { return instances; }, get firewalls() { return firewalls; },
    run: () => runWindows({ identity, progress: undefined, checkpoint, pixel, runtime }),
    clean: () => cleanupWindows({ identity, progress, checkpoint, pixel, runtime }) };
}

describe("Windows qualification ownership and failure paths", () => {
  test("tagged doctor records denial while rejecting an unsafe host", () => {
    const observed = verifyWindowsDoctor({ checks: taggedDoctorChecks, ...doctorState });
    expect(observed).toMatchObject({ doctorTrue: 15, doctorChecks: 18, doctorIdentityAllowed: false, doctorPwa: false, doctorSessionHealth: false });
    expect(() => verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, loopbackTrustSound: false }, ...doctorState })).toThrow();
  });
  test("a refused response may omit CSP, but an unexpected allowed identity cannot pass", () => {
    expect(verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, securityHeaders: false }, ...doctorState })).toMatchObject({ doctorTrue: 14, doctorChecks: 18, doctorSecurityHeaders: false });
    expect(() => verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, identityAllowed: true }, ...doctorState })).toThrow();
  });
  test("missing host checks and additional failed checks are not baseline variants", () => {
    const { serveMapping: _mapping, ...incomplete } = taggedDoctorChecks;
    expect(() => verifyWindowsDoctor({ checks: incomplete, ...doctorState })).toThrow();
    expect(() => verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, extraHostCheck: false }, ...doctorState })).toThrow();
  });
  test("a healthy listener cannot qualify a non-interactive task principal", () => {
    expect(() => verifyWindowsDoctor({ checks: taggedDoctorChecks, ...doctorState, interactivePrincipal: false })).toThrow();
  });
  test("pins fail closed on an upstream change", () => {
    assertWindowsPins(identity.omp);
    expect(() => assertWindowsPins({ ...identity.omp, sourceTree: "f".repeat(40) })).toThrow("pins differ");
  });
  test("lost create response is recovered by exact epoch label and destroyed", async () => {
    const f = fixture({ lostCreate: true }); await expect(f.run()).rejects.toThrow("response lost");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]); expect(f.events).toContain("instanceDestroyed");
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("failed private vault write destroys the newly created instance", async () => {
    const f = fixture({ vaultFails: true }); await expect(f.run()).rejects.toThrow("private disk full");
    expect(f.instances).toEqual([]); expect(f.events.indexOf("instanceDestroyed")).toBeLessThan(f.events.indexOf("vaultRemoved"));
  });
  test("a resumed create intent reconciles by epoch without creating a second VM", async () => {
    const f = fixture(); await f.run();
    const interrupted = { ...f.progress as Record<string, unknown>, phase: "instance_created", settled: false, timings: { firewall_created: 0 }, facts: {} };
    await expect(runWindows({ identity, progress: interrupted, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("start a fresh epoch");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(f.events.filter(event => event === "instanceCreated")).toHaveLength(1);
  });
  test("terminal progress without the preceding observations is refused", async () => {
    const f = fixture(); await f.run();
    const invalid = { ...f.progress as Record<string, unknown>, timings: {} };
    await expect(runWindows({ identity, progress: invalid, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("phase history");
  });
  test("development repair resumes the same guest and records the failed phase attempt", async () => {
    const f = fixture({ development: true, fail: "stage" });
    await expect(f.run()).rejects.toThrow("guest operation failed");
    expect(f.instances).toHaveLength(1); expect(windowsNeedsCleanup(f.progress)).toBe(true);
    const original = f.runtime.guest;
    f.runtime.guest = async (context, action) => action === "stage" ? {} : original(context, action);
    const result = await runWindows({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime });
    expect((result.observations as Record<string, unknown>).failedPhaseAttempts).toBe(1);
    expect(f.events.filter(event => event === "instanceCreated")).toHaveLength(1);
    await f.clean(); expect(f.instances).toEqual([]);
  });
  test("protected instance is never destroyed even with the exact label", async () => {
    const f = fixture({ protected: true }); await expect(f.run()).rejects.toThrow("cleanup failed");
    expect(f.instances).toHaveLength(1); expect(f.events).not.toContain("instanceDestroyed"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("a returned unlabelled or unrelated instance is not admitted or destroyed", async () => {
    const f = fixture({ unlabelled: true }); await expect(f.run()).rejects.toThrow("foreign or protected");
    expect(f.instances[0]?.label).toBe("unrelated"); expect(f.events).not.toContain("instanceDestroyed");
  });
  test("firewalls require a positive label and reject protected IDs", () => {
    expect(firewallEligibility("synthetic", undefined, {}).eligible).toBe(false);
    expect(firewallEligibility("synthetic", "unrelated", {}).eligible).toBe(false);
    expect(firewallEligibility("synthetic", label, { OMP_QUAL_PROTECTED_FIREWALLS: "synthetic" }).eligible).toBe(false);
    expect(firewallEligibility("synthetic", label, {}).eligible).toBe(true);
  });
  test("pre-login listener fails rather than being stopped by the harness", async () => {
    const f = fixture({ listener: true }); await expect(f.run()).rejects.toThrow("pre-login");
    expect(f.events.filter(item => item === "rdp")).toHaveLength(1); expect(f.instances).toEqual([]);
  });
  test("missing automatic LogonTrigger startup times out without manual start, naming only its booleans and counts", async () => {
    const f = fixture({ neverStarts: true });
    const failure = await f.run().then(() => undefined, (error: Error) => error);
    expect(failure?.message).toMatch(/^automatic LogonTrigger startup timed out; last \{.*"ready":false/u);
    expect(failure?.message).not.toContain("synthetic-guest-string");
    expect(f.events).not.toContain("publish"); expect(f.instances).toEqual([]);
  });
  test("stale generation must be 409, not another failure status", async () => {
    const f = fixture({ stale: 404 }); await expect(f.run()).rejects.toThrow("generation/launch");
    expect(f.events).not.toContain("physicalPixel");
  });
  test("cleanup continues after a guest failure and is retryable", async () => {
    const f = fixture({ fail: "resetServe" }); await f.run();
    await expect(f.clean()).rejects.toThrow("resetServe");
    expect(f.events).toContain("logout"); expect(f.events).toContain("tailnetDeleted"); expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    await f.clean(); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("Pixel lease failure cannot keep paid resources alive or erase recovery state", async () => {
    const f = fixture(); await f.run();
    await expect(cleanupWindows({ identity, progress: f.progress, checkpoint: f.checkpoint, runtime: f.runtime,
      pixel: async () => {
        expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
        throw new Error("Pixel lease unavailable");
      },
    })).rejects.toThrow("pixelRestore");
    expect(f.events).not.toContain("vaultRemoved"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
    await f.clean(); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("checkpoint failure cannot prevent idempotent owned-resource destruction", async () => {
    const f = fixture(); await f.run();
    await expect(cleanupWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel,
      checkpoint: async () => { throw new Error("private disk full"); },
    })).rejects.toThrow();
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(f.events).toContain("tailnetDeleted"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("unknown and foreign progress fails before an effect", async () => {
    const f = fixture(); await expect(runWindows({ identity, progress: { epoch }, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("progress");
    expect(f.events).toEqual([]);
    await f.run(); const p = f.progress as Record<string, unknown>;
    await expect(cleanupWindows({ identity, progress: { ...p, binding: "e".repeat(64) }, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("foreign");
  });
  test("pass records sampled lifecycle observations without identifiers or forbidden fields", async () => {
    const f = fixture(); const result = await f.run();
    const observations = result.observations as Record<string, unknown>;
    expect(observations.preloginDurationMs).toBeGreaterThanOrEqual(30_000); expect(observations.preloginSamples).toBeGreaterThanOrEqual(3);
    expect(observations.pixelIdentityAccepted).toBe(true); expect(observations.readinessChanged).toBe(true); expect(observations.historySelected).toBe(true);
    const inspect = (value: unknown) => { if (!value || typeof value !== "object") return; for (const [key, item] of Object.entries(value)) { expect(key).not.toMatch(/capability|password|secret|authKey|token|bearer/iu); inspect(item); } };
    inspect(result); inspect(f.progress);
    const serialized = JSON.stringify(result);
    for (const forbidden of ["synthetic-owned", "synthetic-firewall", "192.0.2.1", "synthetic-never-real", label, "/synthetic/"]) expect(serialized).not.toContain(forbidden);
    expect(f.events.indexOf("pixelLease")).toBeLessThan(f.events.indexOf("physicalPixel"));
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
    const cleaned = await f.clean(); expect(cleaned).toMatchObject({ epoch, instancesRemaining: 0, firewallsRemaining: 0, tailnetDeleted: true });
    await f.clean(); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
});

describe("Windows stale launch HTTP boundary", () => {
  test("both modes refuse a stale generation without releasing a value", async () => {
    const modes: string[] = [];
    const fake = async (_url: string, options: RequestInit) => { modes.push(JSON.parse(String(options.body)).mode); return new Response('{"error":"generation_mismatch"}', { status: 409, headers: { "cache-control": "no-store" } }); };
    expect(await verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 }, fake)).toEqual({ staleViewStatus: 409, staleControlStatus: 409 });
    expect(modes).toEqual(["view", "control"]);
  });
  test.each([200, 400, 403, 404, 500])("rejects HTTP %i", async status => {
    const fake = async () => new Response("{}", { status, headers: { "cache-control": "no-store" } });
    await expect(verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 }, fake)).rejects.toThrow("409");
  });
  test("refuses a 409 that leaks a launch value", async () => {
    const fake = async () => new Response(JSON.stringify({ capability: "synthetic-value-never-real" }), { status: 409, headers: { "cache-control": "no-store" } });
    await expect(verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 }, fake)).rejects.toThrow("fail closed");
  });
});
