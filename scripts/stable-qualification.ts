import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION as VERSION } from "./build-release.ts";
import { parseAndroidPackageVersion, readAndroidQualificationPin, requireSingleDevice, resolveAndroidBrowserTarget } from "./android-device.ts";
import { downloadReleaseAssets } from "./release-download.ts";
import { fixtureModelError, OMP_FIXTURE_MODEL } from "./omp-fixture.ts";

const REPOSITORY = "alphastorm/omp-session-gateway";
const ESCAPED_VERSION = VERSION.replaceAll(".", "\\.");
const CANDIDATE_TAG_PATTERN = new RegExp(`^v${ESCAPED_VERSION}-prealpha\\.[1-9][0-9]*$`, "u");
const SIGNED_WORKFLOW = "signed-release.yml";
const DEBIAN_WORKFLOW = "droplet-qualification.yml";
const DEBIAN_RUN_TITLE_PREFIX = "Stable qualification";
const DEFAULT_MAC_ZONE = "fr-par-1";
const DEFAULT_MAC_NAME = "omp-macqual-01";
const DEFAULT_MAC_LOGIN = "alphastorm@github";
const DEFAULT_SESSION_LABEL = "omp-stable-pixel-qualification";
const MINIMUM_RELAY_SECONDS = 1_800;
const PROTECTED_REPOSITORY_FILES = ["STABLE_RELEASE.lock.json", "docs/RELEASE_STATUS.md"] as const;
function releaseAssetNames(version: string): readonly string[] {
  return [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    `omp-session-gateway-${version}-bun.tar`,
    `omp-session-gateway-${version}-bun.tar.sigstore.json`,
    `omp-session-gateway-${version}.spdx.json`,
    `omp-session-gateway-${version}.spdx.json.sigstore.json`,
  ];
}
function attestedAssetNames(version: string): readonly string[] {
  return [`omp-session-gateway-${version}-bun.tar`, `omp-session-gateway-${version}.spdx.json`, "SHA256SUMS"];
}
const LANE_NAMES = [
  "artifacts",
  "debian",
  "macos",
  "ompPublication",
  "android",
  "androidPush",
  "androidPushCleanup",
  "relay",
  "cleanup",
  "windows",
  "windowsCleanup",
] as const;
/** Lanes that own external resources, each paired with the lane that must release them. */
const CLEANUP_LANES = { windows: "windowsCleanup", androidPush: "androidPushCleanup" } as const;
const RECEIPT_SCHEMA_VERSION = 2;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The stable release this working tree's candidate must upgrade from and roll back to. Reads the
 * lock directly because argument parsing is synchronous, and fails loudly rather than qualifying
 * against a predecessor nobody can name.
 *
 * The lock answers this across both phases of a release, so both are handled rather than assuming
 * one: while a candidate is being qualified it still names the published stable, and once the ledger
 * is approved it names this version and records that same stable as `previousTag`.
 */
function publishedStableTag(): string {
  const lock: unknown = JSON.parse(readFileSync(join(repositoryRoot, "STABLE_RELEASE.lock.json"), "utf8"));
  const releaseTag = isRecord(lock) ? lock.releaseTag : undefined;
  const previousTag = isRecord(lock) ? lock.previousTag : undefined;
  const predecessor = releaseTag === `v${VERSION}` ? previousTag : releaseTag;
  if (typeof predecessor !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(predecessor)) {
    throw new Error("STABLE_RELEASE.lock.json must record the stable this version rolls back to");
  }
  // A release that claims itself as its own predecessor would qualify the upgrade and rollback pair
  // against nothing at all.
  if (predecessor === `v${VERSION}`) {
    throw new Error(`STABLE_RELEASE.lock.json names v${VERSION} as its own predecessor`);
  }
  return predecessor;
}
/**
 * The rollback predecessor a candidate must upgrade from and fall back to: always the currently
 * published stable, which the Debian and macOS lanes both install before the candidate.
 *
 * Derived from the stable lock rather than restated as a literal. A hand-maintained constant goes
 * stale exactly once per release and then qualifies the upgrade/rollback pair against a release
 * nobody is running: #200 fixed it from `v0.3.0` to `v0.4.0`, and it was still `v0.4.0` when 0.4.2
 * was cut. Publication rewrites the lock, so every later campaign inherits the right predecessor
 * with no edit here.
 */
const PREVIOUS_TAG = publishedStableTag();

export type StableQualificationLane = (typeof LANE_NAMES)[number];
export type LaneStatus = "pending" | "running" | "passed" | "failed";

export interface LaneReceipt {
  status: LaneStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface CandidateIdentity {
  tag: string;
  sourceCommit: string;
  archiveSha256: string;
}

export interface StableQualificationReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  tag: string;
  previousTag: string;
  status: "running" | "passed" | "failed";
  orchestratorCommit: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  candidate?: CandidateIdentity;
  /** The verified rollback predecessor that host lanes install before the candidate. */
  predecessor?: CandidateIdentity;
  lanes: Record<StableQualificationLane, LaneReceipt>;
  error?: string;
}

export interface StableQualificationOptions {
  readonly preflight: boolean;
  readonly tag: string;
  readonly previousTag: string;
  readonly receiptRoot: string;
  readonly macZone: string;
  readonly macName: string;
  readonly macLogin: string;
  readonly sessionLabel: string;
  readonly relaySeconds: number;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly echo?: boolean;
  readonly allowFailure?: boolean;
  readonly stdin?: Uint8Array;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ManagedProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
}

interface MacTarget {
  readonly sshDestination: string;
  readonly sudoPassword: string;
}

interface MacContext {
  readonly target: MacTarget;
  readonly environment: Record<string, string>;
  readonly publicOrigin: string;
}

interface StagedMacRun {
  readonly context: MacContext;
  readonly output: string;
}

export interface OmpPins {
  readonly bunVersion: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly version: string;
  readonly nativeTarballSha256: string;
  readonly nativeBinarySha256: string;
}

interface CandidateVerification extends CandidateIdentity {
  readonly assetDirectory: string;
  readonly releaseUrl: string;
}

export interface ProtectedFileSnapshot {
  readonly path: string;
  readonly sha256: string;
}

interface Checkpoint {
  (evidence: Record<string, unknown>): Promise<void>;
}

/** A signed release whose assets the orchestrator verified; lanes install from `archivePath`. */
export interface VerifiedRelease extends CandidateIdentity {
  readonly archivePath: string;
}

/** What every resource-owning lane is bound to. Nothing here is secret. */
export interface ExternalLaneIdentity {
  readonly tag: string;
  readonly previousTag: string;
  readonly orchestratorCommit: string;
  readonly receiptRoot: string;
  readonly candidate: VerifiedRelease;
  readonly predecessor: VerifiedRelease;
  readonly omp: OmpPins;
}

/** Serializes every lane that drives the single attached Pixel. */
export type PixelLease = <T>(owner: string, action: () => Promise<T>) => Promise<T>;

export interface ExternalLaneContext {
  readonly identity: ExternalLaneIdentity;
  /** The last checkpoint of an attempt a crash left running, which the lane may resume; otherwise undefined. */
  readonly progress: unknown;
  /** Persists the complete progress object, replacing the previous one. */
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: PixelLease;
}

export interface ExternalLanePreflightContext {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The admitted Pixel; read-only probes only. */
  readonly serial: string;
  readonly omp: OmpPins;
  /** The retained Mac's Tailscale Serve origin, where the candidate gateway will run. */
  readonly macOrigin: string;
}

export interface RemoteCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
/** Runs one bounded command on the retained Mac. Arguments are quoted, never interpreted locally. */
export type RemoteExecutor = (
  argv: readonly string[],
  options?: { readonly stdin?: Uint8Array; readonly timeoutMs?: number },
) => Promise<RemoteCommandResult>;

export interface AndroidPushLaneContext {
  /** The candidate gateway's Tailscale Serve origin on the retained Mac. */
  readonly origin: string;
  readonly mac: RemoteExecutor;
}

/**
 * A lane that owns external resources (a billed VM, a phone's radios and permissions) and so has a
 * cleanup lane of its own. Its progress carries a non-empty `epoch` from the first checkpoint, and
 * cleanup is idempotent: it attempts every step and fails if anything it recorded remains.
 */
export interface ExternalLaneModule<Extra extends object = object> {
  readonly preflight: (context: ExternalLanePreflightContext) => Promise<void>;
  readonly run: (context: ExternalLaneContext & Extra) => Promise<Record<string, unknown>>;
  readonly needsCleanup: (progress: unknown) => boolean;
  readonly cleanup: (context: ExternalLaneContext & Extra) => Promise<Record<string, unknown>>;
}

export interface StableQualificationLaneModules {
  readonly windows: ExternalLaneModule;
  readonly androidPush: ExternalLaneModule<AndroidPushLaneContext>;
  readonly createPixelLease: () => PixelLease;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tail(value: string, lines = 100): string {
  return value.split(/\r?\n/u).slice(-lines).join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(child => "caused by: " + errorMessage(child))].join("\n");
  }
  if (error instanceof Error && error.cause !== undefined) {
    return error.message + "\ncaused by: " + errorMessage(error.cause);
  }
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parsePositiveInteger(value: string, name: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}

export function parseStableQualificationArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StableQualificationOptions {
  let tag: string | undefined;
  let preflight = false;
  let previousTag = environment.OMP_STABLE_PREVIOUS_TAG ?? PREVIOUS_TAG;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--preflight") preflight = true;
    else if (argument === "--tag") tag = argv[++index];
    else if (argument === "--previous-tag") previousTag = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${argument ?? ""}`);
  }
  if (tag === undefined) throw new Error(`usage: bun run qualify:stable [--preflight] --tag v${VERSION}-prealpha.<n> [--previous-tag ${PREVIOUS_TAG}]`);
  if (!CANDIDATE_TAG_PATTERN.test(tag)) {
    throw new Error(`--tag must match v${VERSION}-prealpha.<positive integer>`);
  }
  if (previousTag !== PREVIOUS_TAG) {
    throw new Error(`--previous-tag must name the published ${PREVIOUS_TAG} stable`);
  }
  const receiptRoot = resolve(
    environment.OMP_STABLE_QUALIFICATION_DIR ??
      join(homedir(), ".local", "share", "omp-session-gateway", "qualification", tag),
  );
  const sessionLabel = environment.OMP_STABLE_SESSION_LABEL ?? DEFAULT_SESSION_LABEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionLabel)) {
    throw new Error("OMP_STABLE_SESSION_LABEL must be a safe single path component of at most 128 characters");
  }
  const relaySeconds = parsePositiveInteger(
    environment.OMP_STABLE_RELAY_SECONDS ?? String(MINIMUM_RELAY_SECONDS),
    "OMP_STABLE_RELAY_SECONDS",
    3_600,
  );
  if (relaySeconds < MINIMUM_RELAY_SECONDS) throw new Error("OMP_STABLE_RELAY_SECONDS must be at least 1800");
  return {
    preflight,
    tag,
    previousTag,
    receiptRoot,
    macZone: environment.OMP_STABLE_MAC_ZONE ?? DEFAULT_MAC_ZONE,
    macName: environment.OMP_STABLE_MAC_NAME ?? DEFAULT_MAC_NAME,
    macLogin: (environment.OMP_STABLE_MAC_LOGIN ?? DEFAULT_MAC_LOGIN).trim().toLowerCase(),
    sessionLabel,
    relaySeconds,
  };
}

function emptyLanes(): Record<StableQualificationLane, LaneReceipt> {
  return Object.fromEntries(LANE_NAMES.map(name => [name, { status: "pending", attempts: 0 }])) as Record<
    StableQualificationLane,
    LaneReceipt
  >;
}

export function createStableQualificationReceipt(
  tag: string,
  orchestratorCommit: string,
  previousTag: string,
): StableQualificationReceipt {
  const startedAt = now();
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    tag,
    previousTag,
    status: "running",
    orchestratorCommit,
    startedAt,
    updatedAt: startedAt,
    lanes: emptyLanes(),
  };
}

export function validateStableQualificationReceipt(
  value: unknown,
  expectedTag: string,
  expectedCommit: string,
  expectedPreviousTag: string,
): StableQualificationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("qualification receipt is invalid");
  const receipt = value as Partial<StableQualificationReceipt>;
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `qualification receipt schema ${String(receipt.schemaVersion)} predates the Windows and background Push lanes; ` +
        "start a new campaign directory rather than resuming it",
    );
  }
  if (
    receipt.tag !== expectedTag ||
    receipt.previousTag !== expectedPreviousTag ||
    receipt.orchestratorCommit !== expectedCommit
  ) {
    throw new Error(
      "qualification receipt identity is invalid; do not resume evidence across orchestrator commits or rollback predecessors",
    );
  }
  if (typeof receipt.lanes !== "object" || receipt.lanes === null) throw new Error("qualification receipt lanes are invalid");
  for (const name of LANE_NAMES) {
    const lane = receipt.lanes[name];
    if (!lane || !["pending", "running", "passed", "failed"].includes(lane.status) || !Number.isInteger(lane.attempts)) {
      throw new Error(`qualification receipt lane ${name} is invalid`);
    }
  }
  return receipt as StableQualificationReceipt;
}

function assertNoSecretFields(value: unknown, path = "receipt"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:capability|password|secret|authKey|token|bearer)/iu.test(key)) {
      throw new Error(`refusing to persist secret-bearing receipt field ${path}.${key}`);
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

async function saveReceipt(path: string, receipt: StableQualificationReceipt): Promise<void> {
  receipt.updatedAt = now();
  assertNoSecretFields(receipt);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(receipt, undefined, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
/** Serializes writes because Android and relay lanes checkpoint the same receipt concurrently. */
export function createReceiptPersister(
  path: string,
  receipt: StableQualificationReceipt,
): () => Promise<void> {
  let tail = Promise.resolve();
  return () => {
    const operation = tail.then(() => saveReceipt(path, receipt));
    tail = operation.catch(() => {});
    return operation;
  };
}

async function loadReceipt(
  path: string,
  tag: string,
  commit: string,
  previousTag: string,
): Promise<StableQualificationReceipt> {
  if (!(await Bun.file(path).exists())) return createStableQualificationReceipt(tag, commit, previousTag);
  return validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), tag, commit, previousTag);
}

export async function executeReceiptLane<T extends Record<string, unknown>>(
  receipt: StableQualificationReceipt,
  name: StableQualificationLane,
  persist: () => Promise<void>,
  action: (checkpoint: Checkpoint) => Promise<T>,
  force = false,
): Promise<T> {
  const lane = receipt.lanes[name];
  if (!force && lane.status === "passed") return (lane.evidence ?? {}) as T;
  lane.status = "running";
  lane.attempts += 1;
  lane.startedAt = now();
  delete lane.completedAt;
  delete lane.error;
  await persist();
  const checkpoint: Checkpoint = async evidence => {
    lane.evidence = { ...(lane.evidence ?? {}), ...evidence };
    await persist();
  };
  try {
    const evidence = await action(checkpoint);
    lane.status = "passed";
    lane.completedAt = now();
    lane.evidence = evidence;
    delete lane.error;
    await persist();
    return evidence;
  } catch (error) {
    lane.status = "failed";
    lane.completedAt = now();
    lane.error = "lane execution failed; inspect the qualification process output";
    await persist();
    throw error;
  }
}

/**
 * One attached Pixel serves the core Android lane, background Push, and the Windows physical
 * client. Push changes radios, Doze and notification permission, which would corrupt either other
 * lane mid-run, so every Pixel action runs alone. In-process only: RELEASE.md allows one campaign
 * at a time, and a second orchestrator process is not coordinated.
 *
 * An action that could not restore the device throws an error carrying `pixelUnrestored: true`.
 * The lease then refuses every later action, so no lane measures a phone another lane left in an
 * unknown state, and a failed restore can never be mistaken for the next lane's baseline.
 */
export function createPixelLease(log: (line: string) => void = line => console.error(line)): PixelLease {
  let tail: Promise<unknown> = Promise.resolve();
  let holder: string | undefined;
  let unrestoredBy: string | undefined;
  return (owner, action) => {
    if (holder !== undefined) log(`pixel lease: ${owner} waits for ${holder}`);
    const turn = tail.then(async () => {
      if (unrestoredBy !== undefined) {
        throw new Error(`the Pixel was left unrestored by ${unrestoredBy}; restore it before any further device lane`);
      }
      holder = owner;
      try {
        return await action();
      } catch (error) {
        if (isRecord(error) && error.pixelUnrestored === true) unrestoredBy = owner;
        throw error;
      } finally {
        holder = undefined;
      }
    });
    tail = turn.catch(() => {});
    return turn;
  };
}

type ExternalLaneName = keyof typeof CLEANUP_LANES;

function laneProgress(lane: LaneReceipt): unknown {
  return isRecord(lane.evidence) ? lane.evidence.progress : undefined;
}

function progressEpoch(progress: unknown): string | undefined {
  return isRecord(progress) && typeof progress.epoch === "string" && progress.epoch !== "" ? progress.epoch : undefined;
}

/** True only when the cleanup lane passed for the attempt its primary lane last recorded. */
export function externalCleanupCurrent(receipt: StableQualificationReceipt, name: ExternalLaneName): boolean {
  const epoch = progressEpoch(laneProgress(receipt.lanes[name]));
  const cleanup = receipt.lanes[CLEANUP_LANES[name]];
  return epoch !== undefined && cleanup.status === "passed" && cleanup.evidence?.epoch === epoch;
}

type ExternalLaneRunContext<Extra extends object> = {
  readonly identity: ExternalLaneIdentity;
  readonly pixel: PixelLease;
} & Extra;

/** Replaces the whole progress object, so no phase can pair with a previous attempt's resources. */
function externalCheckpoint(primary: LaneReceipt, persist: () => Promise<void>) {
  return async (progress: Record<string, unknown>): Promise<void> => {
    const result = primary.evidence?.result;
    primary.evidence = result === undefined ? { progress } : { progress, result };
    await persist();
  };
}

/** Releases what the primary lane recorded and binds the cleanup lane to that attempt's epoch. */
export async function cleanExternalLane<Extra extends object>(
  receipt: StableQualificationReceipt,
  name: ExternalLaneName,
  persist: () => Promise<void>,
  module: ExternalLaneModule<Extra>,
  context: ExternalLaneRunContext<Extra>,
): Promise<void> {
  const primary = receipt.lanes[name];
  await executeReceiptLane(receipt, CLEANUP_LANES[name], persist, async () => {
    const epoch = progressEpoch(laneProgress(primary)) ?? null;
    const evidence = await module.cleanup({
      ...context,
      progress: laneProgress(primary),
      checkpoint: externalCheckpoint(primary, persist),
    });
    if (module.needsCleanup(laneProgress(primary))) {
      throw new Error(`${name} cleanup returned while its progress still records resources`);
    }
    return { ...evidence, epoch };
  }, true);
}

/**
 * Runs one resource-owning lane, then always its cleanup lane.
 *
 * A crash leaves the lane `running`, and the module may resume that attempt from its last
 * checkpoint. A caught failure is never resumed: its resources are released before a new attempt
 * begins, and a failed release stops the lane there, because a second VM or a second device
 * mutation on top of unreleased ones is exactly what cleanup exists to prevent.
 */
export async function runExternalLane<Extra extends object>(
  receipt: StableQualificationReceipt,
  name: ExternalLaneName,
  persist: () => Promise<void>,
  module: ExternalLaneModule<Extra>,
  context: ExternalLaneRunContext<Extra>,
): Promise<void> {
  const primary = receipt.lanes[name];
  const cleanUp = () => cleanExternalLane(receipt, name, persist, module, context);
  const initial = primary.status;
  if (initial === "passed") {
    if (!externalCleanupCurrent(receipt, name) || module.needsCleanup(laneProgress(primary))) await cleanUp();
    return;
  }
  if (initial === "failed" && (module.needsCleanup(laneProgress(primary)) || !externalCleanupCurrent(receipt, name))) {
    await cleanUp();
  }
  const resumable = initial === "running" ? laneProgress(primary) : undefined;
  if (resumable === undefined) delete primary.evidence;
  let failure: unknown;
  try {
    await executeReceiptLane(receipt, name, persist, async () => {
      const result = await module.run({ ...context, progress: resumable, checkpoint: externalCheckpoint(primary, persist) });
      if (progressEpoch(laneProgress(primary)) === undefined) {
        throw new Error(`${name} returned without checkpointing an attempt epoch`);
      }
      return { progress: laneProgress(primary), result };
    });
  } catch (error) {
    failure = error;
  }
  try {
    await cleanUp();
  } catch (cleanupError) {
    failure = failure === undefined ? cleanupError : new AggregateError([failure, cleanupError], `${name} and its cleanup failed`);
  }
  if (failure !== undefined) throw failure;
}

/** The first reason the receipt cannot be a pass, or undefined when every lane holds. */
export function incompleteQualification(receipt: StableQualificationReceipt): string | undefined {
  const lane = LANE_NAMES.find(name => receipt.lanes[name].status !== "passed");
  if (lane !== undefined) return `qualification lane ${lane} did not pass`;
  for (const name of Object.keys(CLEANUP_LANES) as ExternalLaneName[]) {
    if (!isRecord(receipt.lanes[name].evidence?.result)) return `qualification lane ${name} passed without a result`;
    if (!externalCleanupCurrent(receipt, name)) {
      return `${CLEANUP_LANES[name]} did not pass for the attempt that ${name} recorded`;
    }
  }
  return undefined;
}

async function runCommand(command: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd ?? repositoryRoot,
    env: environment,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    subprocess.kill("SIGTERM");
    forceKillTimer = setTimeout(() => subprocess.kill("SIGKILL"), 10_000);
  }, options.timeoutMs ?? 30 * 60 * 1_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  clearTimeout(timer);
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  if (options.echo) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0) process.stderr.write(stderr);
  }
  if (timedOut) throw new Error(`${command[0] ?? "command"} timed out`);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}:\n${tail(stderr || stdout)}`);
  }
  return { exitCode, stdout, stderr };
}

async function commandOutput(command: readonly string[], options: CommandOptions = {}): Promise<string> {
  return (await runCommand(command, options)).stdout.trim();
}

async function captureProtectedFiles(): Promise<ProtectedFileSnapshot[]> {
  return Promise.all(
    PROTECTED_REPOSITORY_FILES.map(async path => ({
      path,
      sha256: sha256(await readFile(join(repositoryRoot, path))),
    })),
  );
}

export async function assertProtectedFilesUnchanged(
  snapshots: readonly ProtectedFileSnapshot[],
  root = repositoryRoot,
): Promise<void> {
  for (const snapshot of snapshots) {
    const current = sha256(await readFile(join(root, snapshot.path)));
    if (current !== snapshot.sha256) {
      throw new Error(`qualification modified protected release state: ${snapshot.path}`);
    }
  }
}

function releaseVersion(tag: string): string {
  const version = /^v([0-9]+\.[0-9]+\.[0-9]+)(?:-|$)/u.exec(tag)?.[1];
  if (version === undefined) throw new Error(`release tag ${tag} does not name a version`);
  return version;
}

function releaseArchivePath(assetDirectory: string, tag: string): string {
  return join(assetDirectory, `omp-session-gateway-${releaseVersion(tag)}-bun.tar`);
}

function candidateAssetDirectory(options: StableQualificationOptions): string {
  return join(options.receiptRoot, "assets");
}

function predecessorAssetDirectory(options: StableQualificationOptions): string {
  return join(options.receiptRoot, "predecessor-assets");
}

/**
 * Verifies one published release end to end: the signed tag, the exact asset set, GitHub release
 * state, checksums, and every attestation and Sigstore bundle. The candidate is a prerelease; the
 * predecessor must be the published stable that is GitHub Latest.
 */
async function verifyRelease(
  tag: string,
  assetDirectory: string,
  stable: boolean,
  ghToken: string,
): Promise<CandidateVerification> {
  const version = releaseVersion(tag);
  await runCommand(["git", "fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`], { timeoutMs: 120_000 });
  await runCommand(["git", "tag", "-v", tag], { timeoutMs: 120_000 });
  const sourceCommit = await commandOutput(["git", "rev-list", "-n1", tag]);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error(`${tag} did not resolve to a commit`);

  await downloadReleaseAssets(assetDirectory, () =>
    runCommand(["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", assetDirectory], {
      timeoutMs: 300_000,
    }),
  );
  const downloaded = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: assetDirectory }))).sort();
  if (JSON.stringify(downloaded) !== JSON.stringify([...releaseAssetNames(version)].sort())) {
    throw new Error(`${tag} release assets differ: ${downloaded.join(", ")}`);
  }
  const ghEnvironment = { GH_TOKEN: ghToken };
  await runCommand([process.execPath, "scripts/release-tag-state.ts", REPOSITORY, tag, sourceCommit], {
    env: ghEnvironment,
  });
  await runCommand(
    [process.execPath, "scripts/release-state.ts", REPOSITORY, tag, "false", String(!stable), String(stable), assetDirectory],
    { env: ghEnvironment },
  );
  await runCommand(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: assetDirectory });

  const signerWorkflow = `${REPOSITORY}/.github/workflows/${SIGNED_WORKFLOW}`;
  const certificateIdentity = `https://github.com/${REPOSITORY}/.github/workflows/${SIGNED_WORKFLOW}@refs/tags/${tag}`;
  for (const asset of attestedAssetNames(version)) {
    await runCommand(
      ["gh", "attestation", "verify", join(assetDirectory, asset), "--repo", REPOSITORY, "--signer-workflow", signerWorkflow, "--source-ref", `refs/tags/${tag}`],
      { timeoutMs: 300_000 },
    );
    await runCommand([
      "cosign",
      "verify-blob",
      "--bundle",
      join(assetDirectory, `${asset}.sigstore.json`),
      "--certificate-identity",
      certificateIdentity,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      join(assetDirectory, asset),
    ]);
  }
  const archiveSha256 = sha256(await readFile(releaseArchivePath(assetDirectory, tag)));
  const release = JSON.parse(
    await commandOutput(["gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "url"]),
  ) as { url?: unknown };
  if (typeof release.url !== "string") throw new Error(`${tag} release URL is missing`);
  return { tag, sourceCommit, archiveSha256, assetDirectory, releaseUrl: release.url };
}

function assertSameRelease(recorded: CandidateIdentity | undefined, verified: CandidateIdentity, role: string): void {
  if (
    recorded !== undefined &&
    (recorded.tag !== verified.tag ||
      recorded.sourceCommit !== verified.sourceCommit ||
      recorded.archiveSha256 !== verified.archiveSha256)
  ) {
    throw new Error(`${role} identity changed since the resumable receipt was created`);
  }
}

/** Built from the receipt alone, so recorded external effects stay cleanable without admission. */
function externalLaneIdentity(
  options: StableQualificationOptions,
  receipt: StableQualificationReceipt,
  orchestratorCommit: string,
  omp: OmpPins,
): ExternalLaneIdentity {
  const { candidate, predecessor } = receipt;
  if (candidate === undefined || predecessor === undefined) {
    throw new Error("external lanes require verified candidate and predecessor identities");
  }
  return {
    tag: options.tag,
    previousTag: options.previousTag,
    orchestratorCommit,
    receiptRoot: options.receiptRoot,
    candidate: { ...candidate, archivePath: releaseArchivePath(candidateAssetDirectory(options), candidate.tag) },
    predecessor: {
      ...predecessor,
      archivePath: releaseArchivePath(predecessorAssetDirectory(options), predecessor.tag),
    },
    omp,
  };
}

function remoteExecutor(target: MacTarget): RemoteExecutor {
  return (argv, options = {}) =>
    runCommand(
      [
        "ssh",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "BatchMode=yes",
        "-q",
        target.sshDestination,
        argv.map(shellQuote).join(" "),
      ],
      {
        allowFailure: true,
        timeoutMs: options.timeoutMs ?? 5 * 60 * 1_000,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      },
    );
}

async function gitQualificationRef(commit: string, output: StablePreflightRuntime["output"]): Promise<string> {
  const status = await output(["git", "--no-optional-locks", "status", "--porcelain"]);
  if (status !== "") throw new Error("stable qualification requires a clean working tree");
  const branch = await output(["git", "branch", "--show-current"]);
  if (branch === "") throw new Error("stable qualification requires a published branch, not detached HEAD");
  const remote = await output(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
  if (remote !== `${commit}\trefs/heads/${branch}`) throw new Error("published qualification branch does not match HEAD");
  return branch;
}

interface DebianWorkflowRun {
  readonly id: number;
  readonly title: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

export interface DebianQualificationRuntime {
  readonly output: (command: readonly string[], timeoutMs?: number) => Promise<string>;
  readonly execute: (
    command: readonly string[],
    options?: { readonly timeoutMs?: number; readonly allowFailure?: boolean; readonly echo?: boolean },
  ) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createDispatchId: () => string;
}

const defaultDebianRuntime: DebianQualificationRuntime = {
  output: (command, timeoutMs) => commandOutput(command, timeoutMs === undefined ? {} : { timeoutMs }),
  execute: async (command, options = {}) => {
    await runCommand(command, options);
  },
  sleep: Bun.sleep,
  createDispatchId: randomUUID,
};

async function findDebianRun(
  qualificationRef: string,
  dispatchId: string,
  orchestratorCommit: string,
  runtime: DebianQualificationRuntime,
): Promise<DebianWorkflowRun | undefined> {
  const payload = JSON.parse(
    await runtime.output(
      [
        "gh",
        "api",
        "--method",
        "GET",
        `repos/${REPOSITORY}/actions/workflows/${DEBIAN_WORKFLOW}/runs`,
        "-f",
        "event=workflow_dispatch",
        "-f",
        `branch=${qualificationRef}`,
        "-f",
        "per_page=100",
      ],
      120_000,
    ),
  ) as { workflow_runs?: unknown };
  if (!Array.isArray(payload.workflow_runs)) throw new Error("GitHub workflow-run lookup returned an invalid response");
  const title = `${DEBIAN_RUN_TITLE_PREFIX} ${dispatchId}`;
  const matches = payload.workflow_runs.filter(run => {
    if (!isRecord(run)) return false;
    return run.display_title === title && run.head_sha === orchestratorCommit;
  });
  if (matches.length > 1) throw new Error(`multiple Debian workflow runs matched dispatch ${dispatchId}`);
  const match = matches[0];
  if (!isRecord(match)) return undefined;
  if (
    typeof match.id !== "number" ||
    typeof match.display_title !== "string" ||
    typeof match.head_sha !== "string" ||
    typeof match.status !== "string" ||
    !(typeof match.conclusion === "string" || match.conclusion === null) ||
    typeof match.html_url !== "string"
  ) {
    throw new Error("GitHub workflow-run match returned invalid fields");
  }
  return {
    id: match.id,
    title: match.display_title,
    headSha: match.head_sha,
    status: match.status,
    conclusion: match.conclusion,
    url: match.html_url,
  };
}

async function waitForDebianRun(
  qualificationRef: string,
  dispatchId: string,
  orchestratorCommit: string,
  runtime: DebianQualificationRuntime,
): Promise<DebianWorkflowRun | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const run = await findDebianRun(qualificationRef, dispatchId, orchestratorCommit, runtime);
    if (run !== undefined) return run;
    await runtime.sleep(2_000);
  }
  return undefined;
}

export async function qualifyDebian(
  options: StableQualificationOptions,
  receipt: StableQualificationReceipt,
  checkpoint: Checkpoint,
  qualificationRef: string,
  runtime: DebianQualificationRuntime = defaultDebianRuntime,
): Promise<Record<string, unknown>> {
  const laneEvidence = receipt.lanes.debian.evidence ?? {};
  let dispatchId = typeof laneEvidence.dispatchId === "string" ? laneEvidence.dispatchId : undefined;
  let dispatchRequestedAt = typeof laneEvidence.dispatchRequestedAt === "string"
    ? laneEvidence.dispatchRequestedAt
    : undefined;
  let runId = typeof laneEvidence.runId === "number" ? laneEvidence.runId : undefined;
  let priorFailed = false;
  if (runId !== undefined) {
    const prior = JSON.parse(await runtime.output(["gh", "run", "view", String(runId), "--json", "status,conclusion,url"])) as {
      status?: string;
      conclusion?: string;
      url?: string;
    };
    priorFailed = prior.status === "completed" && prior.conclusion !== "success";
    if (priorFailed) {
      dispatchId = undefined;
      dispatchRequestedAt = undefined;
      runId = undefined;
    }
  }
  if (runId === undefined) {
    if (dispatchId === undefined) {
      dispatchId = runtime.createDispatchId();
      if (!/^[0-9a-f-]{36}$/u.test(dispatchId)) throw new Error("Debian dispatch id generator returned an invalid value");
      dispatchRequestedAt = undefined;
      await checkpoint({ dispatchId, dispatchRequestedAt: null, runId: null, url: null });
    }

    let discovered = await findDebianRun(qualificationRef, dispatchId, receipt.orchestratorCommit, runtime);
    if (discovered === undefined && dispatchRequestedAt === undefined) {
      dispatchRequestedAt = now();
      await checkpoint({ dispatchId, dispatchRequestedAt });
      await runtime.execute([
        "gh",
        "workflow",
        "run",
        DEBIAN_WORKFLOW,
        "--ref",
        qualificationRef,
        "-f",
        `qualification_id=${dispatchId}`,
        "-f",
        `release_tag=${options.tag}`,
        "-f",
        `previous_tag=${options.previousTag}`,
        "-f",
        "lanes=",
        "-f",
        "droplet_size=s-2vcpu-8gb-amd",
      ]);
    }
    discovered ??= await waitForDebianRun(qualificationRef, dispatchId, receipt.orchestratorCommit, runtime);
    if (discovered === undefined) {
      throw new Error(
        `Debian dispatch ${dispatchId} is not discoverable; refusing to dispatch again until the existing request is resolved`,
      );
    }
    runId = discovered.id;
    await checkpoint({ dispatchId, dispatchRequestedAt, runId, url: discovered.url });
  }
  await runtime.execute(["gh", "run", "watch", String(runId), "--exit-status"], {
    timeoutMs: 55 * 60 * 1_000,
    allowFailure: true,
    echo: true,
  });
  const result = JSON.parse(
    await runtime.output(["gh", "run", "view", String(runId), "--json", "status,conclusion,headSha,url,jobs"]),
  ) as { status?: string; conclusion?: string; headSha?: string; url?: string; jobs?: unknown[] };
  if (result.status !== "completed" || result.conclusion !== "success") {
    throw new Error(`Debian qualification run ${runId} concluded ${result.conclusion ?? result.status ?? "unknown"}`);
  }
  if (result.headSha !== receipt.orchestratorCommit) throw new Error("Debian qualification ran different orchestration source");
  if (!Array.isArray(result.jobs)) throw new Error("Debian qualification did not return job evidence");
  const observedJobs = result.jobs.map(job => isRecord(job) ? { name: job.name, conclusion: job.conclusion } : {});
  const requiredJob = observedJobs.find(job => job.name === "Qualify on disposable droplet");
  if (requiredJob?.conclusion !== "success") {
    throw new Error("Debian qualification missed successful job: Qualify on disposable droplet");
  }
  return {
    dispatchId,
    dispatchRequestedAt,
    runId,
    url: result.url,
    headSha: result.headSha,
    conclusion: result.conclusion,
  };
}

function parseCredentialAssignments(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) throw new Error("Scaleway credential file contains an unsupported line");
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^SCW_[A-Z_]+$/u.test(key) || value === "") throw new Error("Scaleway credential entry is invalid");
    values[key] = value;
  }
  return values;
}

export function parseQualificationPins(text: string): OmpPins {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.darwinArm64Native)) throw new Error("OMP qualification pin is invalid");
  const pins = {
    bunVersion: value.bunVersion,
    sourceCommit: value.commit,
    sourceTree: value.tree,
    version: value.packageVersion,
    nativeTarballSha256: value.darwinArm64Native.tarballSha256,
    nativeBinarySha256: value.darwinArm64Native.binarySha256,
  };
  if (
    typeof pins.bunVersion !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/u.test(pins.bunVersion) ||
    typeof pins.sourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(pins.sourceCommit) ||
    typeof pins.sourceTree !== "string" || !/^[0-9a-f]{40}$/u.test(pins.sourceTree) ||
    typeof pins.version !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/u.test(pins.version) ||
    !Bun.semver.satisfies(pins.version, ">=18.1.20") ||
    typeof pins.nativeTarballSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pins.nativeTarballSha256) ||
    typeof pins.nativeBinarySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pins.nativeBinarySha256)
  ) {
    throw new Error("OMP qualification pin is invalid");
  }
  return pins as OmpPins;
}

async function loadQualificationPins(): Promise<OmpPins> {
  return parseQualificationPins(await readFile(join(repositoryRoot, "UPSTREAM.lock.json"), "utf8"));
}

async function recoverRetainedMac(options: StableQualificationOptions): Promise<MacTarget> {
  const credentialPath = resolve(process.env.OMP_STABLE_SCW_CREDENTIAL_FILE ?? join(homedir(), ".scaleway-apikey"));
  const credentialMetadata = await lstat(credentialPath);
  if (!credentialMetadata.isFile() || credentialMetadata.isSymbolicLink() || credentialMetadata.uid !== process.getuid?.() || (credentialMetadata.mode & 0o077) !== 0) {
    throw new Error("Scaleway credential file must be a current-user regular file with no group or other access");
  }
  const credentials = parseCredentialAssignments(await readFile(credentialPath, "utf8"));
  const secretKey = credentials.SCW_SECRET_KEY;
  const projectId = credentials.SCW_DEFAULT_PROJECT_ID;
  if (!secretKey || !projectId) throw new Error("Scaleway credential file is missing required entries");
  const endpoint = `https://api.scaleway.com/apple-silicon/v1alpha1/zones/${encodeURIComponent(options.macZone)}/servers`;
  const listResponse = await fetch(`${endpoint}?project_id=${encodeURIComponent(projectId)}`, {
    headers: { "X-Auth-Token": secretKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!listResponse.ok) throw new Error(`Scaleway server list failed with status ${listResponse.status}`);
  const list = (await listResponse.json()) as { servers?: unknown[] };
  const matches = (list.servers ?? []).filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === options.macName,
  );
  if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
    throw new Error("expected exactly one retained Scaleway Mac");
  }
  const detailResponse = await fetch(`${endpoint}/${encodeURIComponent(matches[0].id)}`, {
    headers: { "X-Auth-Token": secretKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!detailResponse.ok) throw new Error(`Scaleway server detail failed with status ${detailResponse.status}`);
  const detail = (await detailResponse.json()) as { server?: Record<string, unknown> } & Record<string, unknown>;
  const server = detail.server ?? detail;
  if (server.status !== "ready" || server.type !== "M2-M") throw new Error("retained Scaleway Mac is not ready as M2-M");
  const user = server.ssh_username;
  const ip = server.ip;
  const sudoPassword = server.sudo_password ?? server.password;
  if (typeof user !== "string" || typeof ip !== "string" || typeof sudoPassword !== "string" || sudoPassword === "") {
    throw new Error("retained Scaleway Mac access fields are incomplete");
  }
  return { sshDestination: `${user}@${ip}`, sudoPassword };
}

export interface StablePreflightRuntime {
  readonly platform: string;
  readonly arch: string;
  readonly bunVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executable: (name: string) => string | null;
  readonly output: (command: readonly string[]) => Promise<string>;
  readonly recoverMac: (options: StableQualificationOptions) => Promise<MacTarget>;
}

const defaultPreflightRuntime: StablePreflightRuntime = {
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  environment: process.env,
  executable: Bun.which,
  output: command => commandOutput(command, { timeoutMs: 15_000 }),
  recoverMac: recoverRetainedMac,
};

/** Discard raw probe errors: SSH, adb and credential tools can include private identifiers or secrets. */
async function prerequisite<T>(description: string, probe: () => Promise<T>): Promise<T> {
  try {
    return await probe();
  } catch {
    throw new Error("Stable preflight: " + description);
  }
}

/** Admission only. No staging, receipts, dispatch, host start, or client/service mutation. */
export async function preflightStableQualification(
  options: StableQualificationOptions,
  runtime: StablePreflightRuntime = defaultPreflightRuntime,
  lanes: StableQualificationLaneModules = defaultLaneModules,
) {
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") {
    throw new Error("stable qualification orchestration currently requires a Darwin-arm64 workstation");
  }
  const ompPins = await loadQualificationPins();
  if (runtime.bunVersion !== ompPins.bunVersion) {
    throw new Error("Stable preflight: local Bun must be " + ompPins.bunVersion);
  }
  for (const name of ["adb", "security", "git", "gh", "cosign", "shasum", "ssh", "scp", "bash", "python3", "curl"]) {
    if (runtime.executable(name) === null) throw new Error("Stable preflight: required executable is missing: " + name);
  }
  const browser = resolveAndroidBrowserTarget(runtime.environment);
  const serial = await prerequisite("attach exactly one authorized Android device; resolve absent, unauthorized or ambiguous adb devices", () =>
    requireSingleDevice((...args) => runtime.output(["adb", ...args])),
  );
  await prerequisite("attached Android must be an identified Pixel with the selected browser installed", async () => {
    const model = await runtime.output(["adb", "-s", serial, "shell", "getprop", "ro.product.model"]);
    if (!model.startsWith("Pixel ")) throw new Error("not a Pixel");
    for (const property of ["ro.build.version.release", "ro.build.id"]) {
      if (await runtime.output(["adb", "-s", serial, "shell", "getprop", property]) === "") throw new Error("missing build");
    }
    parseAndroidPackageVersion(await runtime.output(["adb", "-s", serial, "shell", "dumpsys", "package", browser.packageName]));
  });
  await prerequisite("device-scoped Android qualification PIN is unavailable or invalid in the macOS Keychain", async () => {
    const pin = await readAndroidQualificationPin(serial, async (account, service) =>
      new TextEncoder().encode(await runtime.output(["security", "find-generic-password", "-a", account, "-s", service, "-w"])),
    );
    pin.fill(0);
  });
  const ghToken = await prerequisite("GitHub CLI authentication is unavailable", async () => {
    const token = await runtime.output(["gh", "auth", "token"]);
    if (token === "") throw new Error("empty token");
    const repository = JSON.parse(await runtime.output(["gh", "api", "repos/" + REPOSITORY]));
    if (!isRecord(repository) || !isRecord(repository.permissions) || repository.permissions.push !== true) {
      throw new Error("repository write permission unavailable");
    }
    return token;
  });
  for (const tag of [options.tag, options.previousTag]) {
    await prerequisite("candidate and published predecessor releases must be available with the expected release status", async () => {
      const release = JSON.parse(await runtime.output([
        "gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "tagName,isDraft,isPrerelease",
      ]));
      if (!isRecord(release) || release.tagName !== tag || release.isDraft !== false || release.isPrerelease !== (tag === options.tag)) {
        throw new Error("release metadata mismatch");
      }
    });
  }
  const orchestratorCommit = await prerequisite("cannot resolve the qualification source commit", async () => {
    const commit = await runtime.output(["git", "rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("invalid commit");
    return commit;
  });
  const qualificationRef = await prerequisite("qualification source must be a clean branch whose published HEAD matches locally", () =>
    gitQualificationRef(orchestratorCommit, runtime.output),
  );
  const target = await prerequisite("retained Mac lookup failed; check the private Scaleway credential and exactly one ready retained host", () =>
    runtime.recoverMac(options),
  );
  const macDnsName = await prerequisite("retained Mac SSH, Darwin-arm64, pinned Bun, required tools or user-owned TUN-mode Tailscale prerequisites are unavailable", async () => {
    // Match the qualifier's PATH; ~/qual is created later by artifact staging, not a prerequisite.
    const probe = [
      'set -eu',
      'export PATH="$HOME/.bun/bin:$HOME/go/bin:$PATH"',
      '[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]',
      '[ "$(bun --version)" = ' + shellQuote(ompPins.bunVersion) + ' ]',
      'for tool in bash python3 curl git shasum tar lsof launchctl sudo tailscale ifconfig; do command -v "$tool" >/dev/null; done',
      'ifconfig | python3 -c ' + shellQuote('import sys; assert "inet6 fd7a:115c:a1e0:" in sys.stdin.read()'),
      'tailscale status --json | python3 -c ' + shellQuote('import json,sys; d=json.load(sys.stdin); s=d.get("Self",{}); assert d.get("BackendState")=="Running" and not s.get("Tags") and s.get("DNSName","").rstrip("."); print(s["DNSName"].rstrip("."))'),
    ].join("; ");
    const dnsName = (await runtime.output([
      "ssh", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes", "-q", target.sshDestination, "bash -c " + shellQuote(probe),
    ])).trim();
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(dnsName)) throw new Error("retained Mac has no tailnet DNS name");
    return dnsName;
  });
  const macOrigin = `https://${macDnsName}`;
  const laneContext: ExternalLanePreflightContext = { environment: runtime.environment, serial, omp: ompPins, macOrigin };
  for (const [name, lane] of [["Windows", lanes.windows], ["background Push", lanes.androidPush]] as const) {
    try {
      await lane.preflight(laneContext);
    } catch (error) {
      throw new Error(`Stable preflight: ${name} lane admission failed`, { cause: error });
    }
  }
  return { ompPins, ghToken, orchestratorCommit, qualificationRef, target, macOrigin };
}

function macEnvironment(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateIdentity,
): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    OMP_MAC_HOST: target.sshDestination,
    OMP_MAC_TAG: options.tag,
    OMP_MAC_PREVIOUS_TAG: options.previousTag,
    OMP_MAC_LOGIN: options.macLogin,
    OMP_MAC_SUDO_PW: target.sudoPassword,
    OMP_MAC_ARCHIVE_SHA256: candidate.archiveSha256,
    OMP_MAC_SESSION_LABEL: options.sessionLabel,
  };
}

export function assertMacBuildOutput(output: string, candidate: CandidateIdentity, pins: OmpPins): void {
  if (!/doctor\s+([1-9][0-9]*)\/\1 true/u.test(output)) {
    throw new Error("Mac build output missed a passing doctor summary");
  }
  for (const expected of [
    `release-info commit:                   ${candidate.sourceCommit}`,
    candidate.archiveSha256,
    `"version":"${pins.version}"`,
    `"sourceCommit":"${pins.sourceCommit}"`,
    `"sourceTree":"${pins.sourceTree}"`,
    `"nativeSha256":"${pins.nativeBinarySha256}"`,
  ]) {
    if (!output.includes(expected)) throw new Error(`Mac build output missed required evidence: ${expected}`);
  }
}

export function assertMacLifecycleOutput(output: string, candidate: CandidateIdentity, pins: OmpPins) {
  assertMacBuildOutput(output, candidate, pins);
  for (const expected of [
    "hardware:                              Mac14,3",
    "doctor false checks                    (none)",
    "token bytes in bundle:                 0",
    "login in bundle:                       0",
    "forged header, real login allowed:     200",
    "backend at tailnet address:            refused",
    "backend at ssh address:                refused",
    "gateway returned after:",
  ]) {
    if (!output.includes(expected)) throw new Error(`Mac lifecycle output missed required evidence: ${expected}`);
  }
  const doctor = output.match(/doctor\s+(([1-9][0-9]*)\/\2) true/u)?.[1];
  const rollbackInvariants = output.match(/\b(([1-9][0-9]*)\/\2) invariants PASS\b/u)?.[1];
  const os = output.match(/^\s*host:\s+(macOS [0-9.]+ arm64)\s*$/mu)?.[1];
  if (doctor === undefined || rollbackInvariants === undefined || os === undefined) {
    throw new Error("Mac lifecycle output missed a passing doctor, rollback or host summary");
  }
  return { doctor, rollbackInvariants, os };
}
async function readMacPublicOrigin(target: MacTarget): Promise<string> {
  const result = await commandOutput([
    "ssh",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "BatchMode=yes",
    "-q",
    target.sshDestination,
    'TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"; "$TS" status --json',
  ]);
  const status = JSON.parse(result) as { Self?: { DNSName?: unknown; Tags?: unknown[] }; BackendState?: unknown };
  const dnsName = status.Self?.DNSName;
  if (status.BackendState !== "Running" || typeof dnsName !== "string" || dnsName === "" || (status.Self?.Tags?.length ?? 0) > 0) {
    throw new Error("retained Mac is not a running user-owned Tailscale node");
  }
  return `https://${dnsName.replace(/\.$/u, "")}`;
}

async function runMacScript(environment: Record<string, string>, lanes: readonly string[], timeoutMs: number): Promise<string> {
  const result = await runCommand(["bash", "scripts/qualify-macos-host.sh", ...lanes], {
    env: environment,
    timeoutMs,
    echo: true,
  });
  return `${result.stdout}${result.stderr}`;
}

async function runStagedMac(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
  lanes: readonly string[],
  timeoutMs: number,
): Promise<StagedMacRun> {
  const environment = macEnvironment(options, target, candidate);
  const cleanupContext: Pick<MacContext, "target" | "environment"> = { target, environment };
  try {
    const artifactOutput = await runMacScript(environment, ["artifact"], 10 * 60 * 1_000);
    const context: MacContext = { ...cleanupContext, publicOrigin: await readMacPublicOrigin(target) };
    const laneOutput = await runMacScript(environment, lanes, timeoutMs);
    return { context, output: `${artifactOutput}${laneOutput}` };
  } catch (error) {
    try {
      await cleanupMac(cleanupContext);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Mac qualification and recovery cleanup failed");
    }
    throw error;
  }
}

async function qualifyMacLifecycle(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
  pins: OmpPins,
): Promise<Record<string, unknown>> {
  const run = await runStagedMac(
    options,
    target,
    candidate,
    ["omp-clean", "uninstall", "install", "identity", "persistence", "rollback", "omp-build"],
    50 * 60 * 1_000,
  );
  const summaries = assertMacLifecycleOutput(run.output, candidate, pins);
  return {
    hardware: "Mac14,3",
    ...summaries,
    archiveSha256: candidate.archiveSha256,
    nativeAddonSha256: pins.nativeBinarySha256,
    outputSha256: sha256(run.output),
  };
}

async function prepareMacFixture(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
  pins: OmpPins,
): Promise<MacContext> {
  const run = await runStagedMac(
    options,
    target,
    candidate,
    ["omp-clean", "uninstall", "install", "omp-build"],
    45 * 60 * 1_000,
  );
  assertMacBuildOutput(run.output, candidate, pins);
  return run.context;
}

function ompRemoteCommand(options: StableQualificationOptions, pins: OmpPins): string {
  return [
    'export PATH="$HOME/.bun/bin:$PATH"',
    'root="$HOME/qual/$(cd "$HOME/qual" && ls -d omp-session-gateway-*-bun)"',
    `OMP_QUAL_GATEWAY_ROOT="$root" OMP_PIN_SOURCE_COMMIT=${shellQuote(pins.sourceCommit)} OMP_PIN_SOURCE_TREE=${shellQuote(pins.sourceTree)} OMP_PIN_VERSION=${shellQuote(pins.version)} OMP_PIN_BUN_VERSION=${shellQuote(pins.bunVersion)} OMP_PIN_NATIVE_TARBALL_SHA256=${shellQuote(pins.nativeTarballSha256)} OMP_PIN_NATIVE_BINARY_SHA256=${shellQuote(pins.nativeBinarySha256)} OMP_QUAL_SESSION_LABEL=${shellQuote(options.sessionLabel)} OMP_FIXTURE_MODEL=${shellQuote(OMP_FIXTURE_MODEL)} exec bash "$HOME/qual-tools/qualify-macos-omp.sh" run`,
  ].join("; ");
}

function startOmpSession(options: StableQualificationOptions, target: MacTarget, pins: OmpPins): ManagedProcess {
  return Bun.spawn(
    [
      "ssh",
      "-tt",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-q",
      target.sshDestination,
      ompRemoteCommand(options, pins),
    ],
    { cwd: repositoryRoot, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  );
}

async function stopSubprocess(process: ManagedProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  const exited = await Promise.race([process.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

export async function waitForPublishedSession(origin: string, label: string): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/sessions`, { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { sessions?: unknown[] };
      const session = (payload.sessions ?? []).find(
        (entry): entry is Record<string, unknown> => isRecord(entry) && entry.cwdLabel === label,
      );
      if (session) {
        if (!response.headers.get("cache-control")?.includes("no-store")) throw new Error("session list was cacheable");
        if (session.canView !== true || session.canControl !== true || session.generation !== 1) {
          throw new Error("mainline OMP metadata did not publish View and Control at generation 1");
        }
        const modelError = fixtureModelError(session);
        if (modelError !== undefined) throw new Error(modelError);
        return session;
      }
    }
    await Bun.sleep(1_000);
  }
  throw new Error("mainline OMP session did not publish within 90 seconds");
}

export async function verifyLaunchContracts(origin: string, session: Record<string, unknown>): Promise<Record<string, unknown>> {
  const instanceId = session.instanceId;
  const generation = session.generation;
  if (typeof instanceId !== "string" || typeof generation !== "number") throw new Error("published session identity is invalid");
  const modes: Record<string, unknown>[] = [];
  for (const mode of ["view", "control"] as const) {
    const response = await fetch(`${origin}/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ generation, mode }),
      cache: "no-store",
    });
    const payload = (await response.json()) as Record<string, unknown>;
    const valuePresent = typeof payload.capability === "string" && payload.capability.length > 0;
    const keys = Object.keys(payload).sort();
    payload.capability = "";
    if (response.status !== 200 || !response.headers.get("cache-control")?.includes("no-store") || !valuePresent) {
      throw new Error(`${mode} launch contract failed`);
    }
    modes.push({ mode, status: response.status, keys, valuePresent, noStore: true });
  }
  return { instanceId, generation, modes };
}

export async function waitForRevocation(origin: string, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/sessions`, { cache: "no-store" });
    const payload = (await response.json()) as { sessions?: Array<{ cwdLabel?: string }> };
    if (!(payload.sessions ?? []).some(session => session.cwdLabel === label)) return;
    await Bun.sleep(1_000);
  }
  throw new Error("mainline OMP session did not revoke within 45 seconds");
}

function chooseTunnelPort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("could not allocate a loopback tunnel port");
  return port;
}

async function startTunnel(target: MacTarget, port: number): Promise<ManagedProcess> {
  const process = Bun.spawn(
    [
      "ssh",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-L",
      `127.0.0.1:${port}:127.0.0.1:4317`,
      target.sshDestination,
    ],
    { cwd: repositoryRoot, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    if (process.exitCode !== null) {
      const stderr = await new Response(process.stderr).text();
      throw new Error(`SSH tunnel exited before readiness: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return process;
    } catch {
      // The listener is not ready yet.
    }
    await Bun.sleep(250);
  }
  await stopSubprocess(process);
  throw new Error("SSH loopback tunnel did not become ready");
}

async function runAndroidAcceptance(
  options: StableQualificationOptions,
  context: MacContext,
): Promise<Record<string, unknown>> {
  const browser = resolveAndroidBrowserTarget();
  const androidEnvironment = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    OMP_ANDROID_BROWSER_PACKAGE: browser.packageName,
    OMP_ANDROID_BROWSER_ACTIVITY: browser.activity,
    OMP_ANDROID_DEVTOOLS_SOCKET: browser.devtoolsSocket,
  };
  const acceptance = await runCommand(
    [process.execPath, "scripts/android-acceptance.ts", context.publicOrigin, options.sessionLabel],
    { env: androidEnvironment, timeoutMs: 15 * 60 * 1_000, echo: true },
  );
  const summary = JSON.parse(acceptance.stdout) as Record<string, unknown>;
  if (summary.packageName !== androidEnvironment.OMP_ANDROID_BROWSER_PACKAGE || summary.outageBanner !== true) {
    throw new Error("physical Android acceptance summary is incomplete");
  }
  for (const field of ["unlockMs", "airplaneRecoveredMs", "dozeRecoveredMs"] as const) {
    if (typeof summary[field] !== "number") throw new Error(`physical Android acceptance missed ${field}`);
  }
  const serial = summary.serial;
  if (typeof serial !== "string" || serial === "") throw new Error("physical Android acceptance did not identify its device");
  const [model, androidRelease, buildId] = await Promise.all([
    commandOutput(["adb", "-s", serial, "shell", "getprop", "ro.product.model"]),
    commandOutput(["adb", "-s", serial, "shell", "getprop", "ro.build.version.release"]),
    commandOutput(["adb", "-s", serial, "shell", "getprop", "ro.build.id"]),
  ]);
  if (!model.startsWith("Pixel ") || androidRelease === "" || buildId === "") {
    throw new Error("physical Android acceptance did not run on an identified Pixel build");
  }
  const collaboration = await runCommand(
    [process.execPath, "scripts/android-collab-smoke.ts", context.publicOrigin, options.sessionLabel],
    { env: androidEnvironment, timeoutMs: 5 * 60 * 1_000, echo: true },
  );
  const collaborationSummary = JSON.parse(collaboration.stdout) as Record<string, unknown>;
  for (const field of ["viewReadOnly", "controlWritable", "promptAccepted", "returnedToDirectory"] as const) {
    if (collaborationSummary[field] !== true) throw new Error(`physical Android collaboration missed ${field}`);
  }
  const leak = await runCommand(
    [process.execPath, "scripts/android-leak-sweep.ts", context.publicOrigin, options.sessionLabel],
    { env: androidEnvironment, timeoutMs: 5 * 60 * 1_000, echo: true },
  );
  const leakOutput = `${leak.stdout}${leak.stderr}`;
  for (const expected of ["planted 7, detected 7", "all 7 sinks proven detectable, no residue", "result        clean"]) {
    if (!leakOutput.includes(expected)) throw new Error(`physical Android leak sweep missed: ${expected}`);
  }
  return {
    serial,
    model,
    androidRelease,
    buildId,
    packageName: summary.packageName,
    androidPackageVersion: summary.androidPackageVersion,
    browserVersion: summary.browserVersion,
    unlockMs: summary.unlockMs,
    airplaneRecoveredMs: summary.airplaneRecoveredMs,
    dozeRecoveredMs: summary.dozeRecoveredMs,
    acceptanceOutputSha256: sha256(`${acceptance.stdout}${acceptance.stderr}`),
    collaboration: collaborationSummary,
    leakSweepOutputSha256: sha256(leakOutput),
    forbiddenSinkSweep: "7/7 detectable; clean",
  };
}

function evidenceTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : Number.NaN;
}

function validateRelayEvidence(
  summary: unknown,
  requiredSeconds: number,
  startedAt: unknown,
  completedAt: unknown,
): Record<string, unknown> {
  const start = isRecord(summary) ? evidenceTimestamp(summary.startedAt) : Number.NaN;
  const end = isRecord(summary) ? evidenceTimestamp(summary.completedAt) : Number.NaN;
  if (
    !isRecord(summary) ||
    typeof summary.durationSeconds !== "number" ||
    !Number.isSafeInteger(summary.durationSeconds) ||
    summary.durationSeconds < requiredSeconds ||
    summary.finalPhase !== "live" ||
    typeof summary.transitions !== "number" ||
    !Number.isSafeInteger(summary.transitions) ||
    summary.transitions < 0 ||
    !(start >= evidenceTimestamp(startedAt)) ||
    !(end > start && end <= evidenceTimestamp(completedAt)) ||
    // The runner floors monotonic seconds; its wall-clock timestamps may differ by a fraction of a second.
    Math.abs((end - start) / 1_000 - summary.durationSeconds) > 1
  ) {
    throw new Error(`relay evidence is missing, invalid, stale, or shorter than the required ${requiredSeconds} seconds`);
  }
  return {
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    durationSeconds: summary.durationSeconds,
    transitions: summary.transitions,
    finalPhase: summary.finalPhase,
  };
}

function assertPassedRelayEvidence(receipt: StableQualificationReceipt, requiredSeconds: number): void {
  const lane = receipt.lanes.relay;
  if (lane.status !== "passed") return;
  if (
    !Number.isSafeInteger(lane.attempts) || lane.attempts < 1 ||
    !(evidenceTimestamp(lane.startedAt) >= evidenceTimestamp(receipt.startedAt)) ||
    !(evidenceTimestamp(lane.completedAt) <= Date.now())
  ) throw new Error("passed relay evidence has invalid or stale campaign/attempt boundaries");
  validateRelayEvidence(lane.evidence, requiredSeconds, lane.startedAt, lane.completedAt);
}

async function runRelaySmoke(
  options: StableQualificationOptions,
  context: MacContext,
  tunnelPort: number,
  instanceId: string,
): Promise<Record<string, unknown>> {
  const startedAt = now();
  const result = await runCommand([process.execPath, "scripts/relay-soak.ts"], {
    env: {
      OMP_GATEWAY_SOAK_GATEWAY_ORIGIN: `http://127.0.0.1:${tunnelPort}`,
      OMP_GATEWAY_SOAK_PUBLIC_ORIGIN: context.publicOrigin,
      OMP_GATEWAY_SOAK_TAILSCALE_LOGIN: options.macLogin,
      OMP_GATEWAY_SOAK_INSTANCE_ID: instanceId,
      OMP_GATEWAY_SOAK_SECONDS: String(options.relaySeconds),
    },
    timeoutMs: (options.relaySeconds + 60) * 1_000,
    echo: true,
  });
  return validateRelayEvidence(JSON.parse(result.stdout), options.relaySeconds, startedAt, now());
}

async function cleanupMac(
  context: Pick<MacContext, "target" | "environment">,
): Promise<Record<string, unknown>> {
  const errors: unknown[] = [];
  let uninstallOutput = "";
  let ompOutput = "";
  const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      errors.push(new Error(`${label} failed`, { cause: error }));
    }
  };

  await attempt("gateway uninstall", async () => {
    uninstallOutput = await runMacScript(context.environment, ["uninstall"], 10 * 60 * 1_000);
  });
  await attempt("Tailscale Serve reset", async () => {
    await runCommand([
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-q",
      context.target.sshDestination,
      'TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"; "$TS" serve reset >/dev/null',
    ]);
  });
  await attempt("mainline OMP cleanup", async () => {
    ompOutput = await runMacScript(context.environment, ["omp-clean"], 10 * 60 * 1_000);
  });
  await attempt("qualification artifact cleanup", async () => {
    await runCommand([
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-q",
      context.target.sshDestination,
      'rm -rf "$HOME/qual" "$HOME/qual-tools"',
    ]);
  });

  for (const [output, expected] of [
    [ompOutput, '"liveOmpHosts":0,"binaryPresent":false,"sourcePresent":false'],
    [uninstallOutput, "plist present:                         no"],
    [uninstallOutput, "gui job:                               absent"],
    [uninstallOutput, "gateway pids:                          0"],
    [uninstallOutput, "listeners:                             0"],
  ] as const) {
    if (!output.includes(expected)) errors.push(new Error(`Mac cleanup missed required evidence: ${expected}`));
  }
  if (errors.length > 0) throw new AggregateError(errors, "Mac cleanup did not fully remove qualification state");
  return {
    gatewayProcesses: 0,
    gatewayListeners: 0,
    liveOmpHosts: 0,
    outputSha256: sha256(`${uninstallOutput}${ompOutput}`),
  };
}

export function receiptNeedsMacCleanup(receipt: StableQualificationReceipt): boolean {
  if (receipt.lanes.cleanup.status === "passed") return false;
  return (["macos", "ompPublication", "android", "androidPush", "relay", "cleanup"] as const).some(
    name => receipt.lanes[name].attempts > 0,
  );
}

export function markMacCleanupRequired(receipt: StableQualificationReceipt): boolean {
  const cleanup = receipt.lanes.cleanup;
  if (cleanup.status !== "passed") return false;
  cleanup.status = "pending";
  delete cleanup.startedAt;
  delete cleanup.completedAt;
  delete cleanup.error;
  delete cleanup.evidence;
  return true;
}

export async function runStableQualification(
  argv: readonly string[],
  runtime: StablePreflightRuntime = defaultPreflightRuntime,
  lanes: StableQualificationLaneModules = defaultLaneModules,
): Promise<Record<string, unknown>> {
  const options = parseStableQualificationArgs(argv, runtime.environment);
  if (options.preflight) {
    await preflightStableQualification(options, runtime, lanes);
    return {
      status: "preflight-passed",
      effects: "none; bounded read-only prerequisite probes only",
      notProven: [
        "candidate and predecessor signatures, checksums and attestations",
        "workflow dispatch authority and hosted credentials",
        "Debian and Mac lifecycle, migration, rollback and sudo authorization",
        "OMP publication/revocation and physical Android acceptance",
        "configured relay check, longer endurance coverage and cleanup",
        "Windows VM provisioning, interactive logon, lifecycle, physical client and destruction",
        "background Web Push delivery, notification taps, degraded device states and device restore",
      ],
    };
  }
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") {
    throw new Error("stable qualification orchestration currently requires a Darwin-arm64 workstation");
  }
  const receiptPath = join(options.receiptRoot, "stable-qualification.json");
  const orchestratorCommit = await prerequisite("cannot resolve the qualification source commit", () =>
    runtime.output(["git", "rev-parse", "HEAD"]),
  );
  const receipt = await loadReceipt(receiptPath, options.tag, orchestratorCommit, options.previousTag);
  receipt.status = "running";
  delete receipt.completedAt;
  delete receipt.error;
  const ompPins = await loadQualificationPins();
  const protectedFiles = await captureProtectedFiles();
  const persist = createReceiptPersister(receiptPath, receipt);
  let admitted = false;
  let externalEffects = false;
  const pixel = lanes.createPixelLease();
  let windowsBranch: Promise<void> | undefined;

  let target: MacTarget | undefined;
  let macCleanupContext: Pick<MacContext, "target" | "environment"> | undefined;
  let macContext: MacContext | undefined;
  let ompProcess: ManagedProcess | undefined;
  let tunnelProcess: ManagedProcess | undefined;
  let primaryError: unknown;
  let cleanupRequired = receiptNeedsMacCleanup(receipt);
  const requireMacCleanup = async (): Promise<void> => {
    cleanupRequired = true;
    if (markMacCleanupRequired(receipt)) await persist();
  };
  try {
    if (cleanupRequired) {
      if (receipt.candidate === undefined) throw new Error("receipt records Mac effects without a candidate identity");
      target = await prerequisite("retained Mac cleanup access is unavailable", () => runtime.recoverMac(options));
      macCleanupContext = {
        target,
        environment: macEnvironment(options, target, receipt.candidate),
      };
    }

    // A passed lane is otherwise skipped on resume. Reject inadequate proof without reopening it
    // or dispatching work, but only after recovering any recorded Mac effects for finally cleanup.
    try {
      assertPassedRelayEvidence(receipt, options.relaySeconds);
    } catch (error) {
      receipt.status = "failed";
      receipt.error = "qualification relay evidence rejected; inspect the qualification process output";
      await persist();
      throw error;
    }

    const admission = await preflightStableQualification(options, runtime, lanes);
    if (admission.orchestratorCommit !== orchestratorCommit) throw new Error("qualification source changed during preflight");
    const { ghToken, qualificationRef } = admission;
    target = admission.target;
    admitted = true;
    await persist();
    const candidate = await executeReceiptLane(receipt, "artifacts", persist, async checkpoint => {
      const verified = await verifyRelease(options.tag, candidateAssetDirectory(options), false, ghToken);
      const predecessor = await verifyRelease(options.previousTag, predecessorAssetDirectory(options), true, ghToken);
      assertSameRelease(receipt.candidate, verified, "candidate");
      assertSameRelease(receipt.predecessor, predecessor, "predecessor");
      receipt.candidate = { tag: verified.tag, sourceCommit: verified.sourceCommit, archiveSha256: verified.archiveSha256 };
      receipt.predecessor = {
        tag: predecessor.tag,
        sourceCommit: predecessor.sourceCommit,
        archiveSha256: predecessor.archiveSha256,
      };
      const evidence = {
        sourceCommit: verified.sourceCommit,
        archiveSha256: verified.archiveSha256,
        releaseUrl: verified.releaseUrl,
        signedTag: true,
        checksums: "passed",
        githubAttestations: "3/3",
        sigstoreBundles: "3/3",
        predecessor: {
          tag: predecessor.tag,
          sourceCommit: predecessor.sourceCommit,
          archiveSha256: predecessor.archiveSha256,
          signedTag: true,
          checksums: "passed",
          githubAttestations: "3/3",
          sigstoreBundles: "3/3",
        },
      };
      await checkpoint(evidence);
      return evidence;
    }, true);
    const candidateVerification: CandidateVerification = {
      tag: options.tag,
      sourceCommit: String(candidate.sourceCommit),
      archiveSha256: String(candidate.archiveSha256),
      releaseUrl: String(candidate.releaseUrl),
      assetDirectory: candidateAssetDirectory(options),
    };
    const identity = externalLaneIdentity(options, receipt, orchestratorCommit, ompPins);
    // Windows owns a billed VM and waits for the Pixel only at its physical-client step, so it runs
    // beside the Debian and Mac lanes and settles, with its own cleanup lane, before the verdict.
    windowsBranch = runExternalLane(receipt, "windows", persist, lanes.windows, { identity, pixel });
    windowsBranch.catch(() => {});

    await executeReceiptLane(receipt, "debian", persist, checkpoint =>
      qualifyDebian(options, receipt, checkpoint, qualificationRef),
    );
    macCleanupContext ??= {
      target,
      environment: macEnvironment(options, target, candidateVerification),
    };
    const macWasPassed = receipt.lanes.macos.status === "passed";
    if (!macWasPassed) {
      await requireMacCleanup();
      await executeReceiptLane(receipt, "macos", persist, async () =>
        qualifyMacLifecycle(options, target!, candidateVerification, ompPins),
      );
      macContext = {
        ...macCleanupContext,
        publicOrigin: await readMacPublicOrigin(target),
      };
    }

    const pushCurrent = receipt.lanes.androidPush.status === "passed" && externalCleanupCurrent(receipt, "androidPush");
    const liveEvidenceNeeded = !pushCurrent || (["ompPublication", "android", "relay"] as const).some(
      name => receipt.lanes[name].status !== "passed",
    );
    if (liveEvidenceNeeded) {
      await requireMacCleanup();
      if (macWasPassed) {
        macContext = await prepareMacFixture(options, target, candidateVerification, ompPins);
        macCleanupContext = macContext;
      }
      if (macContext === undefined) throw new Error("Mac live fixture was not prepared");
      const publicationLane = receipt.lanes.ompPublication;
      publicationLane.status = "running";
      publicationLane.attempts += 1;
      publicationLane.startedAt = now();
      delete publicationLane.error;
      await persist();

      ompProcess = startOmpSession(options, target, ompPins);
      const session = await waitForPublishedSession(macContext.publicOrigin, options.sessionLabel);
      const launchEvidence = await verifyLaunchContracts(macContext.publicOrigin, session);
      publicationLane.evidence = { ...launchEvidence, published: true };
      await persist();
      const instanceId = launchEvidence.instanceId;
      if (typeof instanceId !== "string") throw new Error("published OMP instance id is missing");

      const tunnelPort = chooseTunnelPort();
      tunnelProcess = await startTunnel(target, tunnelPort);
      const pending: Promise<unknown>[] = [];
      if (receipt.lanes.android.status !== "passed") {
        pending.push(
          executeReceiptLane(receipt, "android", persist, async () =>
            pixel("android", () => runAndroidAcceptance(options, macContext!)),
          ),
        );
      }
      if (!pushCurrent) {
        // Push drives its own OMP fixture: replacing a generation on the shared one would break relay.
        pending.push(
          runExternalLane(receipt, "androidPush", persist, lanes.androidPush, {
            identity,
            pixel,
            origin: macContext.publicOrigin,
            mac: remoteExecutor(target),
          }),
        );
      }
      if (receipt.lanes.relay.status !== "passed") {
        pending.push(
          executeReceiptLane(receipt, "relay", persist, async () =>
            runRelaySmoke(options, macContext!, tunnelPort, instanceId),
          ),
        );
      }
      const settled = await Promise.allSettled(pending);
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(failures.map(result => result.reason), "physical-client, background Push or relay qualification failed");
      }
      await stopSubprocess(tunnelProcess);
      tunnelProcess = undefined;
      await stopSubprocess(ompProcess);
      ompProcess = undefined;
      await waitForRevocation(macContext.publicOrigin, options.sessionLabel);
      publicationLane.status = "passed";
      publicationLane.completedAt = now();
      publicationLane.evidence = { ...(publicationLane.evidence ?? {}), revoked: true };
      await persist();
    }
    await assertProtectedFilesUnchanged(protectedFiles);
  } catch (error) {
    primaryError = error;
  } finally {
    await stopSubprocess(tunnelProcess).catch(() => {});
    await stopSubprocess(ompProcess).catch(() => {});
    if (cleanupRequired && macCleanupContext !== undefined) {
      try {
        await executeReceiptLane(receipt, "cleanup", persist, async () => cleanupMac(macCleanupContext!), true);
      } catch (cleanupError) {
        primaryError = primaryError === undefined
          ? cleanupError
          : new AggregateError([primaryError, cleanupError], "qualification and cleanup failed");
      }
    }
    if (windowsBranch !== undefined) {
      if (primaryError !== undefined) console.error("stable qualification: waiting for the Windows lane to finish and clean up");
      try {
        await windowsBranch;
      } catch (windowsError) {
        primaryError = primaryError === undefined
          ? windowsError
          : new AggregateError([primaryError, windowsError], "qualification and the Windows lane failed");
      }
    } else if (lanes.windows.needsCleanup(laneProgress(receipt.lanes.windows))) {
      // Admission failed before the Windows lane could resume, but a recorded VM must never outlive it.
      externalEffects = true;
      try {
        await cleanExternalLane(receipt, "windows", persist, lanes.windows, {
          identity: externalLaneIdentity(options, receipt, orchestratorCommit, ompPins),
          pixel,
        });
      } catch (cleanupError) {
        primaryError = primaryError === undefined
          ? cleanupError
          : new AggregateError([primaryError, cleanupError], "qualification and Windows cleanup failed");
      }
    }
    try {
      await assertProtectedFilesUnchanged(protectedFiles);
    } catch (guardError) {
      primaryError = primaryError === undefined
        ? guardError
        : new AggregateError([primaryError, guardError], "qualification modified protected state");
    }
  }

  if (primaryError === undefined) {
    const incomplete = incompleteQualification(receipt);
    if (incomplete !== undefined) primaryError = new Error(incomplete);
  }
  if (primaryError !== undefined) {
    if (!admitted && !cleanupRequired && !externalEffects) throw primaryError;
    receipt.status = "failed";
    receipt.error = "qualification failed; inspect the qualification process output";
    await persist();
    throw primaryError;
  }
  receipt.status = "passed";
  receipt.completedAt = now();
  delete receipt.error;
  await persist();
  return { status: receipt.status, tag: receipt.tag, receipt: receiptPath };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runStableQualification(Bun.argv.slice(2))));
  } catch (error) {
    console.error(`stable qualification failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
