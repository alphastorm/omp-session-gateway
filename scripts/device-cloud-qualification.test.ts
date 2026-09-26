import { describe, expect, test } from "bun:test";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import {
  DEVICE_CLOUD_TARGETS,
  cleanupDeviceCloud,
  deviceCloudNeedsCleanup,
  parseDeviceCloudProgress,
  runDeviceCloud,
  type DeviceCloudIdentity,
  type DeviceCloudLaneInput,
  type DeviceCloudRuntime,
} from "./device-cloud-qualification.ts";
import type { PixelLease } from "./stable-qualification.ts";

// Distinctive synthetic links: never a real capability shape, so the repository leak scans stay green.
const LINKS: Record<string, Record<"view" | "control", string>> = {
  "instance-fixture": {
    view: "omp-synthetic://relay/SYNTHETIC-CLOUD-FIXTURE-VIEW-4c1e/SYNTHETIC-CLOUD-FIXTURE-VIEWKEY-9b7d2f6a",
    control: "omp-synthetic://relay/SYNTHETIC-CLOUD-FIXTURE-CTRL-8a2f/SYNTHETIC-CLOUD-FIXTURE-CTRLKEY-1d6e4b9c",
  },
  "instance-live": {
    view: "omp-synthetic://relay/SYNTHETIC-CLOUD-LIVE-VIEW-3e5d/SYNTHETIC-CLOUD-LIVE-VIEWKEY-7f0a2c8e",
    control: "omp-synthetic://relay/SYNTHETIC-CLOUD-LIVE-CTRL-6b9f/SYNTHETIC-CLOUD-LIVE-CTRLKEY-5a3d0b1f",
  },
};
const LIVE_LABEL = "omp-stable-live";

const identity: DeviceCloudIdentity = {
  tag: "v0.7.0-prealpha.1",
  candidate: { tag: "v0.7.0-prealpha.1", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/fixture/archive.tar" },
  omp: {
    bunVersion: "1.4.0", sourceCommit: "c".repeat(40), sourceTree: "d".repeat(40), version: "18.1.20",
    nativeTarballSha256: "e".repeat(64), nativeBinarySha256: "f".repeat(64),
  },
  origin: "https://qual-mac.example.ts.net",
};

interface Harness {
  readonly runtime: DeviceCloudRuntime;
  readonly pixel: PixelLease;
  /** Effects in order, each marked with whether the Pixel lease was held. */
  readonly effects: string[];
  readonly checkpoints: Record<string, unknown>[];
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
}

function harness(options: {
  readonly record?: (sessionId: string) => string;
  readonly media?: boolean;
  readonly generationChangesAt?: string;
  readonly generationChanges?: "fixture" | "live";
  readonly failing?: string;
} = {}): Harness {
  const effects: string[] = [];
  const checkpoints: Record<string, unknown>[] = [];
  let leased = false;
  let clock = 0;
  let published = false;
  const generations: Record<"fixture" | "live", number> = { fixture: 1, live: 1 };
  const effect = (name: string) => {
    effects.push(`${name}${leased ? "" : " (unleased)"}`);
    if (options.failing === name) throw new Error(`${name} failed with vendor detail session-secret-detail`);
  };
  const session = (kind: "fixture" | "live"): SessionMetadata => ({
    instanceId: `instance-${kind}`, generation: generations[kind], cwdLabel: kind === "live" ? LIVE_LABEL : "omp-cloud-fixture",
    model: "fixture/model", startedAt: "2026-09-26T00:00:00.000Z", lastSeenAt: "2026-09-26T00:00:00.000Z",
    canView: true, canControl: true, inputRequired: false,
  });
  const runtime: DeviceCloudRuntime = {
    now: () => clock,
    pause: async milliseconds => {
      clock += milliseconds;
    },
    admit: async () => {
      effects.push("admit");
    },
    fixture: async operation => {
      effect(`fixture ${operation}`);
      published = operation === "start";
    },
    fixtureSession: async () => (published ? session("fixture") : undefined),
    liveSession: async label => (label === LIVE_LABEL ? session("live") : undefined),
    tunnel: async operation => {
      effect(`tunnel ${operation}`);
    },
    verify: async (target, attempt) => {
      if (attempt.session.cwdLabel !== LIVE_LABEL) throw new Error("journeys must drive the live session");
      await attempt.created(`session-${target}-0001`);
      effect(`verify ${target}`);
      if (options.generationChangesAt === target) generations[options.generationChanges ?? "fixture"] += 1;
      return { device: `Fake ${target}`, os: "26.6", viewReadOnly: true, controlWritable: true, sinkFindings: 0 };
    },
    endSession: async sessionId => {
      effect(`end ${sessionId}`);
    },
    record: async sessionId => ({
      complete: true,
      text: options.record?.(sessionId) ?? JSON.stringify({ state: "COMPLETE", steps: `POST /url for ${sessionId}` }),
      video: options.media === true,
      screenshots: 0,
    }),
    launch: async (launched, mode) => LINKS[launched.instanceId]![mode],
    removeWorkspace: async () => {
      effect("workspace remove");
    },
  };
  const pixel: PixelLease = async (_owner, action) => {
    leased = true;
    try {
      return await action();
    } finally {
      leased = false;
    }
  };
  return {
    runtime,
    pixel,
    effects,
    checkpoints,
    checkpoint: async progress => {
      checkpoints.push(structuredClone(progress));
    },
  };
}

function input(test: Harness, progress: unknown = undefined): DeviceCloudLaneInput {
  return { identity, sessionLabel: LIVE_LABEL, progress, checkpoint: test.checkpoint, pixel: test.pixel, runtime: test.runtime };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
}

describe("device-cloud lane", () => {
  test("records every session before driving it, passes, and cleanup releases everything under the lease", async () => {
    const lane = harness();
    const result = await runDeviceCloud(input(lane));
    expect(result).toMatchObject({ passed: true, vendor: "TestingBot", audit: { records: 3, recordsExposingLinks: 0, recordsWithMedia: 0 } });
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress).toMatchObject({ phase: "evidence_complete", cleanupRequired: true });
    expect(progress.sessions).toEqual(DEVICE_CLOUD_TARGETS.map(target => `session-${target}-0001`));
    // Each session id reached a checkpoint before its target was driven.
    for (const target of DEVICE_CLOUD_TARGETS) {
      const firstRecorded = lane.checkpoints.findIndex(saved => JSON.stringify(saved).includes(`session-${target}-0001`));
      const verified = lane.checkpoints.findIndex(saved => saved.phase === `${target}_verified`);
      expect(firstRecorded).toBeGreaterThanOrEqual(0);
      expect(firstRecorded).toBeLessThan(verified);
    }

    const cleanup = await cleanupDeviceCloud(input(lane, progress));
    expect(cleanup).toMatchObject({ restored: true, sessionsEnded: 3 });
    expect(deviceCloudNeedsCleanup(lane.checkpoints.at(-1))).toBe(false);
    expect(lane.effects.filter(effect => effect.endsWith("(unleased)"))).toEqual([]);
    expect(lane.effects.slice(-6)).toEqual([
      "end session-iphone-0001", "end session-ipad-0001", "end session-android-0001",
      "tunnel stop", "fixture stop", "workspace remove",
    ]);
  });

  test.each([
    ["the live session's whole View link", LINKS["instance-live"]!.view],
    ["an opaque segment of the fixture's Control link", "SYNTHETIC-CLOUD-FIXTURE-CTRLKEY-1d6e4b9c"],
  ])("a vendor record holding %s fails the lane without repeating it", async (_name, leaked) => {
    const lane = harness({ record: sessionId => JSON.stringify({ steps: sessionId.includes("ipad") ? `returned ${leaked}` : "clean" }) });
    const message = await failure(runDeviceCloud(input(lane)));
    expect(message).toContain("1 of 3 TestingBot test records contain a live View or Control link");
    const saved = JSON.stringify(lane.checkpoints);
    for (const text of [message, saved]) expect(text).not.toContain("SYNTHETIC-CLOUD-");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).results.audit).toEqual({ records: 3, recordsExposingLinks: 1, recordsWithMedia: 0 });
  });

  test.each(["fixture", "live"] as const)("a %s generation change before the audit fails instead of searching for the wrong links", async kind => {
    const lane = harness({ generationChangesAt: "android", generationChanges: kind });
    expect(await failure(runDeviceCloud(input(lane)))).toContain("changed generation");
  });

  test("a vendor record with video or screenshots fails the lane", async () => {
    const lane = harness({ media: true });
    expect(await failure(runDeviceCloud(input(lane)))).toContain("kept video or screenshots for 3 of 3 sessions");
  });

  test("an interrupted attempt with recorded effects is released, never resumed", async () => {
    const first = harness({ failing: "verify ipad" });
    await failure(runDeviceCloud(input(first)));
    const interrupted = first.checkpoints.at(-1);
    expect(deviceCloudNeedsCleanup(interrupted)).toBe(true);

    const second = harness();
    expect(await failure(runDeviceCloud(input(second, interrupted)))).toContain("requires cleanup before a fresh run");
    expect(second.effects).toEqual([]);
    await cleanupDeviceCloud(input(second, interrupted));
    expect(second.effects).toEqual([
      "end session-iphone-0001", "end session-ipad-0001", "tunnel stop", "fixture stop", "workspace remove",
    ]);
  });

  test("cleanup attempts every step after a failure and keeps the attempt dirty", async () => {
    const run = harness();
    await runDeviceCloud(input(run));
    const progress = run.checkpoints.at(-1);
    const cleanup = harness({ failing: "tunnel stop" });
    const message = await failure(cleanupDeviceCloud(input(cleanup, progress)));
    expect(message).toBe("device-cloud cleanup failed: tunnel");
    expect(cleanup.effects.slice(-2)).toEqual(["fixture stop", "workspace remove"]);
    expect(cleanup.checkpoints).toEqual([]);
    expect(deviceCloudNeedsCleanup(progress)).toBe(true);
  });

  test("progress from another candidate is refused before any effect", async () => {
    const run = harness();
    await runDeviceCloud(input(run));
    const other = harness();
    const foreign = { ...input(other, run.checkpoints.at(-1)), identity: { ...identity, origin: "https://other-mac.example.ts.net" } };
    expect(await failure(cleanupDeviceCloud(foreign))).toContain("different candidate");
    expect(await failure(runDeviceCloud(foreign))).toContain("different candidate");
    expect(other.effects).toEqual([]);
  });
});

describe("device-cloud progress", () => {
  const valid = {
    lane: "deviceCloud", epoch: "0b8a2f64-3c1d-4e5f-9a7b-2c4d6e8f0a1b", binding: "9".repeat(64), phase: "iphone_verified",
    cleanupRequired: true, sessions: ["session-iphone-0001"], results: { iphone: { device: "iPad (9th generation)", os: "26.6", deliveredMs: 5_400 } },
  };

  test("accepts the exact shape", () => {
    expect(parseDeviceCloudProgress(valid).sessions).toEqual(["session-iphone-0001"]);
  });

  test.each([
    ["an unknown field", { ...valid, capabilityHint: "x" }],
    ["a secret-named observation", { ...valid, results: { iphone: { controlToken: "x" } } }],
    ["free text that could carry a link", { ...valid, results: { iphone: { note: "https://relay.example/join#room" } } }],
    ["an unknown result section", { ...valid, results: { desktop: { passed: true } } }],
    ["more sessions than targets", { ...valid, sessions: ["s-00000001", "s-00000002", "s-00000003", "s-00000004"] }],
    ["a restored attempt that still needs cleanup", { ...valid, phase: "restored" }],
  ])("refuses %s", (_name, progress) => {
    expect(() => parseDeviceCloudProgress(progress)).toThrow();
  });
});
