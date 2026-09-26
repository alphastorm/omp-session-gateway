/**
 * The stable campaign's `deviceCloud` lane (ADR-032): the exact signed candidate on real cloud
 * iPhone, iPad and Android devices, through the retained Mac's candidate gateway.
 *
 * Each device runs the directory, View, Control, prompt and return journey plus the self-verifying
 * capability-sink sweep on the campaign's live OMP session, the one the Pixel's core lane drives.
 * The iPhone also installs the Home Screen app, enables background alerts with a real tap, and taps
 * an attention alert from the lane's own stock-OMP fixture into Control. Afterwards every
 * vendor-retained test record is searched for both sessions' live View and Control links.
 *
 * The lane holds the Pixel lease from its first effect until it has released every session, the
 * tunnel, the fixture, and its workspace. Its prompts and alert raise Web Push to every subscription
 * on the candidate gateway, which would land in the middle of the Pixel lanes. The cleanup lane
 * repeats that release only for an attempt that stopped before finishing it.
 */
import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { fixtureModelError } from "./omp-fixture.ts";
import type { OmpPins, PixelLease } from "./stable-qualification.ts";
import { TESTINGBOT_SESSION_ID, TESTINGBOT_TUNNEL, type TestRecord } from "./testingbot.ts";

export interface DeviceCloudIdentity {
  readonly tag: string;
  readonly candidate: { readonly tag: string; readonly sourceCommit: string; readonly archiveSha256: string; readonly archivePath: string };
  readonly omp: OmpPins;
  /** The candidate gateway's Tailscale Serve origin on the retained Mac. */
  readonly origin: string;
}

export const DEVICE_CLOUD_TARGETS = ["iphone", "ipad", "android"] as const;
export type DeviceCloudTarget = (typeof DEVICE_CLOUD_TARGETS)[number];

export interface DeviceProfile {
  readonly platform: "iOS" | "Android";
  readonly browser: "safari" | "chrome";
  /** In preference order; the first one free is used, and the evidence names it. */
  readonly models: readonly string[];
  readonly homeScreenAlerts: boolean;
}

export const DEVICE_CLOUD_PROFILES: Readonly<Record<DeviceCloudTarget, DeviceProfile>> = {
  iphone: { platform: "iOS", browser: "safari", models: ["iPhone 17 Pro Max", "iPhone 17 Pro", "iPhone 16"], homeScreenAlerts: true },
  ipad: { platform: "iOS", browser: "safari", models: ["iPad (9th generation)"], homeScreenAlerts: false },
  android: { platform: "Android", browser: "chrome", models: ["Galaxy S26", "Galaxy S25", "Galaxy S24"], homeScreenAlerts: false },
};

export const DEVICE_CLOUD_PHASES = [
  "attempt_started", "fixture_ready", "tunnel_ready", "iphone_verified", "ipad_verified", "android_verified",
  "records_audited", "evidence_complete", "restored",
] as const;
export type DeviceCloudPhase = (typeof DEVICE_CLOUD_PHASES)[number];

export type DeviceCloudObservation = boolean | number | string;
export type DeviceCloudResults = Partial<Record<DeviceCloudTarget | "audit", Record<string, DeviceCloudObservation>>>;

export interface DeviceCloudProgress extends Record<string, unknown> {
  lane: "deviceCloud";
  epoch: string;
  binding: string;
  phase: DeviceCloudPhase;
  cleanupRequired: boolean;
  /** Every WebDriver session this attempt created, recorded before the session is driven. */
  sessions: string[];
  results: DeviceCloudResults;
}

export interface DeviceCloudTargetAttempt {
  readonly epoch: string;
  /** The campaign's live OMP session, which every web journey drives. */
  readonly session: SessionMetadata;
  /** Persists a WebDriver session id before the session is driven. */
  readonly created: (sessionId: string) => Promise<void>;
}

export interface DeviceCloudRuntime {
  now(): number;
  pause(milliseconds: number): Promise<void>;
  /** Read-only: tools, credentials, and a pinned model for every target in the vendor catalog. */
  admit(): Promise<void>;
  /** The lane's own stock-OMP fixture, whose attention request the iPhone's alert carries. */
  fixture(operation: "start" | "stop", epoch: string): Promise<void>;
  fixtureSession(epoch: string): Promise<SessionMetadata | undefined>;
  liveSession(label: string): Promise<SessionMetadata | undefined>;
  tunnel(operation: "start" | "stop", epoch: string): Promise<void>;
  /** Allocates a device, runs the target's journeys, and ends its session. */
  verify(target: DeviceCloudTarget, attempt: DeviceCloudTargetAttempt): Promise<Record<string, DeviceCloudObservation>>;
  endSession(sessionId: string): Promise<void>;
  record(sessionId: string): Promise<TestRecord | undefined>;
  /** A live capability through the candidate gateway's launch contract, for the record audit only. */
  launch(session: SessionMetadata, mode: "view" | "control"): Promise<string>;
  removeWorkspace(epoch: string): Promise<void>;
}

export interface DeviceCloudLaneInput {
  readonly identity: DeviceCloudIdentity;
  /** The label of the campaign's live OMP session, the one the Pixel's core lane also drives. */
  readonly sessionLabel: string;
  readonly progress: unknown;
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: PixelLease;
  readonly runtime: DeviceCloudRuntime;
}

const FIXTURE_PUBLICATION_MS = 2 * 60 * 1_000;
/** TestingBot finalizes a record a few seconds after its session ends. */
const RECORD_FINALIZATION_MS = 3 * 60 * 1_000;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const OBSERVATION_NAME = /^[a-z][A-Za-z]{0,47}$/u;
const SECRET_NAME = /(capability|password|secret|authKey|token|bearer)/iu;
const VERSION = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u;

/**
 * The only observations that may be text, each from a fixed grammar. Vendor and device text never
 * reaches progress otherwise: a free-form field could carry a link or reflect a credential.
 */
const OBSERVATION_TEXT: Readonly<Record<string, (value: string) => boolean>> = {
  device: value => Object.values(DEVICE_CLOUD_PROFILES).some(profile => profile.models.includes(value)),
  model: value => /^SM-[A-Z0-9]{1,12}$/u.test(value),
  os: value => VERSION.test(value),
  browser: value => value === "safari" || value === "chrome",
  browserVersion: value => VERSION.test(value),
  pushServiceHost: value => value === "web.push.apple.com",
};

function safeObservations(result: Record<string, unknown>): boolean {
  return Object.entries(result).every(([name, item]) =>
    OBSERVATION_NAME.test(name) && !SECRET_NAME.test(name) && (
      typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item) && item >= 0) ||
      (typeof item === "string" && Object.hasOwn(OBSERVATION_TEXT, name) && OBSERVATION_TEXT[name]!(item))
    ));
}

/** What the allocated session and the device's own browser report about the device. */
export interface AllocationReport {
  /** The capabilities TestingBot returned for the session it allocated. */
  readonly capabilities: Record<string, unknown>;
  readonly userAgent: string;
  readonly touchPoints: number;
  /** User-agent client hints, which Chrome answers and Safari does not. */
  readonly hints?: Record<string, unknown>;
}

const DEVICE_FAMILY: Readonly<Record<DeviceCloudTarget, (report: AllocationReport) => boolean>> = {
  iphone: report => /\biPhone\b/u.test(report.userAgent),
  // iPadOS Safari asks for desktop sites, so it reports a Mac with a touch screen.
  ipad: report => /\biPad\b/u.test(report.userAgent) || (/\bMacintosh\b/u.test(report.userAgent) && report.touchPoints > 1),
  android: report => /\bAndroid\b/u.test(report.userAgent),
};

/**
 * The device as its session and browser report it, refused unless it is the requested platform,
 * kind of device, browser, and OS release, so evidence never names hardware nobody observed. An
 * iPhone or iPad reports its model only through TestingBot's session and its release through
 * Safari's version, which ships in lockstep with iOS. A Galaxy reports its model code and release
 * through Chrome's client hints, and its evidence names the requested model beside that code.
 */
export function attestAllocation(
  target: DeviceCloudTarget,
  requested: { readonly name: string; readonly version: string },
  report: AllocationReport,
): Record<string, DeviceCloudObservation> {
  const profile = DEVICE_CLOUD_PROFILES[target];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const leading = (version: string, parts: number) => version.split(".").slice(0, parts).join(".");
  const { capabilities, userAgent } = report;
  if (
    text(capabilities.platformName).toLowerCase() !== profile.platform.toLowerCase() ||
    text(capabilities.browserName).toLowerCase() !== profile.browser
  ) {
    throw new Error(`TestingBot allocated the ${target} session on another platform or browser`);
  }
  if (!DEVICE_FAMILY[target](report)) throw new Error(`the ${target} session's browser reports another kind of device`);
  if (profile.browser === "safari") {
    const safari = /\bVersion\/([0-9.]{1,24}) (?:Mobile\/\S+ )?Safari\//u.exec(userAgent)?.[1];
    if (safari === undefined || !VERSION.test(safari) || /\b(?:CriOS|FxiOS|EdgiOS)\//u.test(userAgent)) {
      throw new Error(`the ${target} session's browser is not Safari`);
    }
    const model = text(capabilities.deviceName);
    if (model !== requested.name) throw new Error(`TestingBot allocated another model for the ${target}`);
    if (leading(safari, 2) !== leading(requested.version, 2)) throw new Error(`the ${target} runs another iOS release`);
    return { device: model, os: leading(safari, 2), browser: "safari", browserVersion: safari };
  }
  const hints = report.hints ?? {};
  const version = text(hints.uaFullVersion);
  const release = text(hints.platformVersion);
  const model = text(hints.model);
  if (!VERSION.test(version) || !/\bChrome\//u.test(userAgent) || /\b(?:SamsungBrowser|EdgA|OPR|Firefox)\//u.test(userAgent)) {
    throw new Error(`the ${target} session's browser is not Chrome`);
  }
  if (!VERSION.test(release) || leading(release, 1) !== leading(requested.version, 1)) throw new Error(`the ${target} runs another Android release`);
  if (!/^SM-[A-Z0-9]{1,12}$/u.test(model)) throw new Error(`the ${target} is not a Galaxy phone`);
  return { device: requested.name, model, os: release, browser: "chrome", browserVersion: version };
}

/** Binds progress to the candidate, OMP, origin, device profiles, and tunnel it was recorded against. */
function binding(identity: DeviceCloudIdentity): string {
  const origin = new URL(identity.origin);
  if (origin.origin !== identity.origin || origin.protocol !== "https:") throw new Error("invalid device-cloud origin");
  if (
    identity.tag !== identity.candidate.tag || !/^[a-f0-9]{64}$/u.test(identity.candidate.archiveSha256) ||
    !/^[a-f0-9]{40}$/u.test(identity.candidate.sourceCommit) || !/^[a-f0-9]{40}$/u.test(identity.omp.sourceCommit) ||
    !/^[a-f0-9]{40}$/u.test(identity.omp.sourceTree)
  ) {
    throw new Error("invalid device-cloud identity");
  }
  return createHash("sha256").update(JSON.stringify([
    identity.tag, identity.candidate.sourceCommit, identity.candidate.archiveSha256, identity.omp, identity.origin,
    DEVICE_CLOUD_PROFILES, TESTINGBOT_TUNNEL.sha256,
  ])).digest("hex");
}

/** Refuses anything but the exact progress shape, and any evidence that could carry a secret. */
export function parseDeviceCloudProgress(value: unknown): DeviceCloudProgress {
  if (
    !isRecord(value) || Object.keys(value).sort().join(",") !== "binding,cleanupRequired,epoch,lane,phase,results,sessions" ||
    value.lane !== "deviceCloud" || typeof value.epoch !== "string" || !EPOCH.test(value.epoch) ||
    typeof value.binding !== "string" || !/^[a-f0-9]{64}$/u.test(value.binding) || typeof value.cleanupRequired !== "boolean" ||
    !DEVICE_CLOUD_PHASES.some(phase => phase === value.phase)
  ) {
    throw new Error("invalid device-cloud progress");
  }
  const sessions = value.sessions;
  if (
    !Array.isArray(sessions) || sessions.length > DEVICE_CLOUD_TARGETS.length ||
    sessions.some(id => typeof id !== "string" || !TESTINGBOT_SESSION_ID.test(id))
  ) {
    throw new Error("invalid device-cloud session record");
  }
  if (!isRecord(value.results)) throw new Error("invalid device-cloud results");
  for (const [key, result] of Object.entries(value.results)) {
    if ((key !== "audit" && !DEVICE_CLOUD_TARGETS.some(target => target === key)) || !isRecord(result)) {
      throw new Error("invalid device-cloud result");
    }
    if (!safeObservations(result)) throw new Error("unsafe device-cloud evidence");
  }
  if ((value.phase === "restored") === value.cleanupRequired) throw new Error("inconsistent device-cloud cleanup state");
  return value as DeviceCloudProgress;
}

export function deviceCloudNeedsCleanup(progress: unknown): boolean {
  return progress !== undefined && parseDeviceCloudProgress(progress).cleanupRequired;
}

async function waitFor<T>(
  runtime: DeviceCloudRuntime,
  name: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = runtime.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (runtime.now() >= deadline) throw new Error(`device-cloud ${name} timed out`);
    await runtime.pause(2_000);
  }
}

/**
 * Searches every record the vendor kept for the live View and Control links of both sessions the
 * devices opened. The links exist only in this function's memory: nothing derived from them is
 * returned, saved, or logged. A generation change would make the search look for the wrong links,
 * so it fails instead.
 */
async function auditRecords(
  runtime: DeviceCloudRuntime,
  progress: DeviceCloudProgress,
  driven: readonly (readonly [SessionMetadata, () => Promise<SessionMetadata | undefined>])[],
  save: () => Promise<void>,
): Promise<Record<string, DeviceCloudObservation>> {
  const records: TestRecord[] = [];
  for (const sessionId of progress.sessions) {
    records.push(await waitFor(runtime, "test record finalization", async () => {
      const record = await runtime.record(sessionId);
      return record?.complete === true ? record : undefined;
    }, RECORD_FINALIZATION_MS));
  }
  const needles: string[] = [];
  for (const [before, reread] of driven) {
    const current = await reread();
    if (current === undefined || current.instanceId !== before.instanceId || current.generation !== before.generation) {
      throw new Error("a device-cloud session changed generation before its vendor records were audited");
    }
    for (const mode of ["view", "control"] as const) {
      const link = await runtime.launch(current, mode);
      needles.push(link, ...link.split(/[/?#&=]/u).filter(part => part.length >= 16));
    }
  }
  const exposing = records.filter(record => needles.some(needle => record.text.includes(needle))).length;
  const withMedia = records.filter(record => record.video || record.screenshots > 0).length;
  const audit = { records: records.length, recordsExposingLinks: exposing, recordsWithMedia: withMedia };
  progress.results.audit = audit;
  await save();
  if (exposing > 0) throw new Error(`${exposing} of ${records.length} TestingBot test records contain a live View or Control link`);
  if (withMedia > 0) throw new Error(`TestingBot kept video or screenshots for ${withMedia} of ${records.length} sessions`);
  return audit;
}

export async function preflightDeviceCloud(runtime: DeviceCloudRuntime): Promise<void> {
  await runtime.admit();
}

/** Drives one attempt from its fixture to its record audit; the caller releases it either way. */
async function drive(input: DeviceCloudLaneInput, progress: DeviceCloudProgress, save: () => Promise<void>): Promise<Record<string, unknown>> {
  const { runtime } = input;
  const advance = async (phase: DeviceCloudPhase) => {
    progress.phase = phase;
    await save();
  };
  await runtime.fixture("start", progress.epoch);
  const fixture = await waitFor(runtime, "fixture publication", () => runtime.fixtureSession(progress.epoch), FIXTURE_PUBLICATION_MS);
  const live = await waitFor(runtime, "live session", () => runtime.liveSession(input.sessionLabel), FIXTURE_PUBLICATION_MS);
  for (const session of [fixture, live]) {
    const modelError = fixtureModelError(session);
    if (modelError !== undefined) throw new Error(modelError);
    if (!session.canView || !session.canControl) throw new Error("a device-cloud session does not offer View and Control");
  }
  await advance("fixture_ready");

  await runtime.tunnel("start", progress.epoch);
  await advance("tunnel_ready");

  for (const target of DEVICE_CLOUD_TARGETS) {
    const observations = await runtime.verify(target, {
      epoch: progress.epoch,
      session: live,
      created: async sessionId => {
        progress.sessions.push(sessionId);
        await save();
      },
    });
    // Refused before it joins progress, so no vendor or device value can block a later checkpoint.
    if (!safeObservations(observations)) throw new Error(`unsafe device-cloud evidence from the ${target}`);
    progress.results[target] = observations;
    await advance(`${target}_verified`);
  }

  const audit = await auditRecords(runtime, progress, [
    [live, () => runtime.liveSession(input.sessionLabel)],
    [fixture, () => runtime.fixtureSession(progress.epoch)],
  ], save);
  await advance("records_audited");
  await advance("evidence_complete");
  return {
    passed: true,
    vendor: "TestingBot",
    tunnelVersion: TESTINGBOT_TUNNEL.version,
    targets: Object.fromEntries(DEVICE_CLOUD_TARGETS.map(target => [target, progress.results[target]])),
    audit,
  };
}

/**
 * Ends every recorded session, stops the tunnel and fixture, and removes the workspace. Each step
 * runs even if another fails, and only a complete release marks the attempt restored.
 */
async function release(runtime: DeviceCloudRuntime, progress: DeviceCloudProgress, save: () => Promise<void>): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const attempt = async (step: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      // Raw errors can carry vendor identifiers; the step name is the evidence.
      failures.push(step);
    }
  };
  await attempt("sessions", async () => {
    let ended = 0;
    for (const sessionId of progress.sessions) {
      try {
        await runtime.endSession(sessionId);
        ended += 1;
      } catch {
        // Keep ending the others.
      }
    }
    if (ended !== progress.sessions.length) throw new Error("a TestingBot session did not end");
  });
  await attempt("tunnel", () => runtime.tunnel("stop", progress.epoch));
  await attempt("fixture", () => runtime.fixture("stop", progress.epoch));
  await attempt("workspace", () => runtime.removeWorkspace(progress.epoch));
  if (failures.length > 0) throw new Error(`device-cloud cleanup failed: ${failures.join(", ")}`);
  progress.cleanupRequired = false;
  progress.phase = "restored";
  await save();
  return { epoch: progress.epoch, restored: true, sessionsEnded: progress.sessions.length, tunnelStopped: true, fixtureStopped: true };
}

export async function runDeviceCloud(input: DeviceCloudLaneInput): Promise<Record<string, unknown>> {
  const bind = binding(input.identity);
  if (input.progress !== undefined) {
    const previous = parseDeviceCloudProgress(input.progress);
    if (previous.binding !== bind) throw new Error("device-cloud progress belongs to a different candidate, origin, or device profile");
    // A driven session cannot be resumed mid-journey: release everything, then start a fresh attempt.
    if (previous.cleanupRequired) throw new Error("device-cloud attempt requires cleanup before a fresh run");
  }
  const { runtime } = input;
  await runtime.admit();
  // One lease turn covers the attempt and its release, so no Pixel lane starts while its sessions,
  // tunnel, or fixture remain.
  return input.pixel("deviceCloud", async () => {
    const progress: DeviceCloudProgress = {
      lane: "deviceCloud", epoch: randomUUID(), binding: bind, phase: "attempt_started", cleanupRequired: true, sessions: [], results: {},
    };
    // Only progress the parser accepts is saved, so the cleanup lane can always read it back.
    const save = async () => { await input.checkpoint(structuredClone(parseDeviceCloudProgress(progress))); };
    await save();
    let result: Record<string, unknown> | undefined;
    let failure: unknown;
    try {
      result = await drive(input, progress, save);
    } catch (error) {
      failure = error;
    }
    try {
      await release(runtime, progress, save);
    } catch (releaseError) {
      failure = failure === undefined ? releaseError : new AggregateError([failure, releaseError], "the device-cloud attempt and its release failed");
    }
    if (result === undefined || failure !== undefined) throw failure;
    return result;
  });
}

/** Releases an attempt that stopped before its own release finished. */
export async function cleanupDeviceCloud(input: DeviceCloudLaneInput): Promise<Record<string, unknown>> {
  const progress = parseDeviceCloudProgress(input.progress);
  if (progress.binding !== binding(input.identity)) throw new Error("device-cloud progress belongs to a different candidate, origin, or device profile");
  if (!progress.cleanupRequired) return { epoch: progress.epoch, restored: true };
  return input.pixel("deviceCloud-cleanup", () =>
    release(input.runtime, progress, async () => { await input.checkpoint(structuredClone(parseDeviceCloudProgress(progress))); }));
}
