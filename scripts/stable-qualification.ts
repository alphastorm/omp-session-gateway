import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "alphastorm/omp-session-gateway";
const VERSION = "0.1.0";
const PREVIOUS_TAG = "v0.1.0-beta.1";
const SIGNED_WORKFLOW = "signed-release.yml";
const DEBIAN_WORKFLOW = "droplet-qualification.yml";
const DEFAULT_MAC_ZONE = "fr-par-1";
const DEFAULT_MAC_NAME = "omp-macqual-01";
const DEFAULT_MAC_LOGIN = "alphastorm@github";
const DEFAULT_SESSION_LABEL = "omp-stable-pixel-qualification";
const DEFAULT_RELAY_SECONDS = 60;
const PROTECTED_REPOSITORY_FILES = ["STABLE_RELEASE.lock.json", "docs/RELEASE_STATUS.md"] as const;
const ASSET_NAMES = [
  "SHA256SUMS",
  "SHA256SUMS.sigstore.json",
  `omp-session-gateway-${VERSION}-bun.tar`,
  `omp-session-gateway-${VERSION}-bun.tar.sigstore.json`,
  `omp-session-gateway-${VERSION}.spdx.json`,
  `omp-session-gateway-${VERSION}.spdx.json.sigstore.json`,
] as const;
const ATTESTED_ASSETS = [
  `omp-session-gateway-${VERSION}-bun.tar`,
  `omp-session-gateway-${VERSION}.spdx.json`,
  "SHA256SUMS",
] as const;
const LANE_NAMES = ["artifacts", "debian", "macos", "ompPublication", "android", "relay", "cleanup"] as const;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

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
  schemaVersion: 1;
  tag: string;
  status: "running" | "passed" | "failed";
  orchestratorCommit: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  candidate?: CandidateIdentity;
  lanes: Record<StableQualificationLane, LaneReceipt>;
  error?: string;
}

export interface StableQualificationOptions {
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
  readonly patchedTree: string;
  readonly version: string;
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
  let previousTag = environment.OMP_STABLE_PREVIOUS_TAG ?? PREVIOUS_TAG;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tag") tag = argv[++index];
    else if (argument === "--previous-tag") previousTag = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${argument ?? ""}`);
  }
  if (tag === undefined) throw new Error("usage: bun run qualify:stable --tag v0.1.0-prealpha.<n>");
  if (!/^v0\.1\.0-prealpha\.[1-9][0-9]*$/u.test(tag)) {
    throw new Error("--tag must match v0.1.0-prealpha.<positive integer>");
  }
  if (!/^v0\.1\.0-(?:alpha(?:\.[1-9][0-9]*)?|beta(?:\.[1-9][0-9]*)?|prealpha\.[1-9][0-9]*)$/u.test(previousTag)) {
    throw new Error("--previous-tag must name an exact published 0.1 prerelease");
  }
  const receiptRoot = resolve(
    environment.OMP_STABLE_QUALIFICATION_DIR ??
      join(homedir(), ".local", "share", "omp-session-gateway", "qualification", tag),
  );
  const sessionLabel = environment.OMP_STABLE_SESSION_LABEL ?? DEFAULT_SESSION_LABEL;
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionLabel)) {
    throw new Error("OMP_STABLE_SESSION_LABEL contains unsupported characters");
  }
  return {
    tag,
    previousTag,
    receiptRoot,
    macZone: environment.OMP_STABLE_MAC_ZONE ?? DEFAULT_MAC_ZONE,
    macName: environment.OMP_STABLE_MAC_NAME ?? DEFAULT_MAC_NAME,
    macLogin: (environment.OMP_STABLE_MAC_LOGIN ?? DEFAULT_MAC_LOGIN).trim().toLowerCase(),
    sessionLabel,
    relaySeconds: parsePositiveInteger(
      environment.OMP_STABLE_RELAY_SECONDS ?? String(DEFAULT_RELAY_SECONDS),
      "OMP_STABLE_RELAY_SECONDS",
      3_600,
    ),
  };
}

function emptyLanes(): Record<StableQualificationLane, LaneReceipt> {
  return Object.fromEntries(LANE_NAMES.map(name => [name, { status: "pending", attempts: 0 }])) as Record<
    StableQualificationLane,
    LaneReceipt
  >;
}

export function createStableQualificationReceipt(tag: string, orchestratorCommit: string): StableQualificationReceipt {
  const startedAt = now();
  return {
    schemaVersion: 1,
    tag,
    status: "running",
    orchestratorCommit,
    startedAt,
    updatedAt: startedAt,
    lanes: emptyLanes(),
  };
}

function validateReceipt(value: unknown, expectedTag: string): StableQualificationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("qualification receipt is invalid");
  const receipt = value as Partial<StableQualificationReceipt>;
  if (receipt.schemaVersion !== 1 || receipt.tag !== expectedTag || typeof receipt.orchestratorCommit !== "string") {
    throw new Error("qualification receipt identity is invalid");
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
    if (/^(?:capability|password|sudoPassword|secret|secretKey|authKey|token)$/iu.test(key)) {
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

async function loadReceipt(path: string, tag: string, commit: string): Promise<StableQualificationReceipt> {
  if (!(await Bun.file(path).exists())) return createStableQualificationReceipt(tag, commit);
  return validateReceipt(JSON.parse(await readFile(path, "utf8")), tag);
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
    lane.error = errorMessage(error);
    await persist();
    throw error;
  }
}

async function runCommand(command: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd ?? repositoryRoot,
    env: environment,
    stdin: "ignore",
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

async function verifyCandidate(
  options: StableQualificationOptions,
  ghToken: string,
): Promise<CandidateVerification> {
  const assetDirectory = join(options.receiptRoot, "assets");
  await rm(assetDirectory, { recursive: true, force: true });
  await mkdir(assetDirectory, { recursive: true, mode: 0o700 });
  await runCommand(["git", "fetch", "origin", `refs/tags/${options.tag}:refs/tags/${options.tag}`], { timeoutMs: 120_000 });
  await runCommand(["git", "tag", "-v", options.tag], { timeoutMs: 120_000 });
  const sourceCommit = await commandOutput(["git", "rev-list", "-n1", options.tag]);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("candidate tag did not resolve to a commit");

  await runCommand(["gh", "release", "download", options.tag, "--repo", REPOSITORY, "--dir", assetDirectory], {
    timeoutMs: 300_000,
  });
  const downloaded = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: assetDirectory }))).sort();
  if (JSON.stringify(downloaded) !== JSON.stringify([...ASSET_NAMES].sort())) {
    throw new Error(`candidate release assets differ: ${downloaded.join(", ")}`);
  }
  const ghEnvironment = { GH_TOKEN: ghToken };
  await runCommand([process.execPath, "scripts/release-tag-state.ts", REPOSITORY, options.tag, sourceCommit], {
    env: ghEnvironment,
  });
  await runCommand(
    [process.execPath, "scripts/release-state.ts", REPOSITORY, options.tag, "false", "true", "false", assetDirectory],
    { env: ghEnvironment },
  );
  await runCommand(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: assetDirectory });

  const signerWorkflow = `${REPOSITORY}/.github/workflows/${SIGNED_WORKFLOW}`;
  const certificateIdentity = `https://github.com/${REPOSITORY}/.github/workflows/${SIGNED_WORKFLOW}@refs/tags/${options.tag}`;
  for (const asset of ATTESTED_ASSETS) {
    await runCommand(
      ["gh", "attestation", "verify", join(assetDirectory, asset), "--repo", REPOSITORY, "--signer-workflow", signerWorkflow, "--source-ref", `refs/tags/${options.tag}`],
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
  const archivePath = join(assetDirectory, `omp-session-gateway-${VERSION}-bun.tar`);
  const archiveSha256 = sha256(await readFile(archivePath));
  const release = JSON.parse(
    await commandOutput(["gh", "release", "view", options.tag, "--repo", REPOSITORY, "--json", "url"]),
  ) as { url?: unknown };
  if (typeof release.url !== "string") throw new Error("candidate release URL is missing");
  return { tag: options.tag, sourceCommit, archiveSha256, assetDirectory, releaseUrl: release.url };
}

async function gitQualificationRef(commit: string): Promise<string> {
  const status = await commandOutput(["git", "status", "--porcelain"]);
  if (status !== "") throw new Error("stable qualification requires a clean working tree");
  const branch = await commandOutput(["git", "branch", "--show-current"]);
  if (branch === "") throw new Error("stable qualification requires a published branch, not detached HEAD");
  await runCommand(["git", "fetch", "origin", branch], { timeoutMs: 120_000 });
  const remoteCommit = await commandOutput(["git", "rev-parse", `origin/${branch}`]);
  if (remoteCommit !== commit) throw new Error(`origin/${branch} does not match HEAD`);
  return branch;
}

async function qualifyDebian(
  options: StableQualificationOptions,
  receipt: StableQualificationReceipt,
  checkpoint: Checkpoint,
  qualificationRef: string,
): Promise<Record<string, unknown>> {
  let runId = typeof receipt.lanes.debian.evidence?.runId === "number" ? receipt.lanes.debian.evidence.runId : undefined;
  if (runId !== undefined) {
    const prior = JSON.parse(await commandOutput(["gh", "run", "view", String(runId), "--json", "status,conclusion,url"])) as {
      status?: string;
      conclusion?: string;
      url?: string;
    };
    if (prior.status === "completed" && prior.conclusion !== "success") runId = undefined;
  }
  if (runId === undefined) {
    const dispatched = await commandOutput([
      "gh",
      "workflow",
      "run",
      DEBIAN_WORKFLOW,
      "--ref",
      qualificationRef,
      "-f",
      `release_tag=${options.tag}`,
      "-f",
      `previous_tag=${options.previousTag}`,
      "-f",
      "lanes=",
      "-f",
      "droplet_size=s-2vcpu-4gb",
    ]);
    const match = dispatched.match(/\/runs\/(\d+)/u);
    if (!match) throw new Error(`could not read Debian workflow run id: ${dispatched}`);
    runId = Number(match[1]);
    await checkpoint({ runId, url: match[0] });
  }
  await runCommand(["gh", "run", "watch", String(runId), "--exit-status"], {
    timeoutMs: 55 * 60 * 1_000,
    allowFailure: true,
    echo: true,
  });
  const result = JSON.parse(
    await commandOutput(["gh", "run", "view", String(runId), "--json", "status,conclusion,headSha,url,jobs"]),
  ) as { status?: string; conclusion?: string; headSha?: string; url?: string; jobs?: unknown[] };
  if (result.status !== "completed" || result.conclusion !== "success") {
    throw new Error(`Debian qualification run ${runId} concluded ${result.conclusion ?? result.status ?? "unknown"}`);
  }
  if (result.headSha !== receipt.orchestratorCommit) throw new Error("Debian qualification ran different orchestration source");
  return { runId, url: result.url, headSha: result.headSha, conclusion: result.conclusion };
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
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("OMP qualification pin contains an unsupported line");
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const pins: OmpPins = {
    bunVersion: values.OMP_PIN_BUN_VERSION ?? "",
    sourceCommit: values.OMP_PIN_SOURCE_COMMIT ?? "",
    patchedTree: values.OMP_PIN_PATCHED_TREE ?? "",
    version: values.OMP_PIN_VERSION ?? "",
  };
  if (!/^\d+\.\d+\.\d+$/u.test(pins.bunVersion) || !/^[0-9a-f]{40}$/u.test(pins.sourceCommit) || !/^[0-9a-f]{40}$/u.test(pins.patchedTree) || !/^\d+\.\d+\.\d+$/u.test(pins.version)) {
    throw new Error("OMP qualification pin is invalid");
  }
  return pins;
}

async function loadQualificationPins(): Promise<OmpPins> {
  const pins = parseQualificationPins(await readFile(join(repositoryRoot, "patches/oh-my-pi/qualification.env"), "utf8"));
  const upstream = JSON.parse(await readFile(join(repositoryRoot, "UPSTREAM.lock.json"), "utf8")) as { commit?: unknown; packageVersion?: unknown; bunVersion?: unknown };
  if (pins.sourceCommit !== upstream.commit || pins.version !== upstream.packageVersion || pins.bunVersion !== upstream.bunVersion) {
    throw new Error("OMP qualification pin does not match UPSTREAM.lock.json");
  }
  return pins;
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
  });
  if (!listResponse.ok) throw new Error(`Scaleway server list failed with status ${listResponse.status}`);
  const list = (await listResponse.json()) as { servers?: unknown[] };
  const matches = (list.servers ?? []).filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === options.macName,
  );
  if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
    throw new Error(`expected exactly one retained Scaleway Mac named ${options.macName}`);
  }
  const detailResponse = await fetch(`${endpoint}/${encodeURIComponent(matches[0].id)}`, {
    headers: { "X-Auth-Token": secretKey },
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

function macEnvironment(options: StableQualificationOptions, target: MacTarget): Record<string, string> {
  return {
    OMP_MAC_HOST: target.sshDestination,
    OMP_MAC_TAG: options.tag,
    OMP_MAC_PREVIOUS_TAG: options.previousTag,
    OMP_MAC_LOGIN: options.macLogin,
    OMP_MAC_SUDO_PW: target.sudoPassword,
  };
}

function assertMacLifecycleOutput(output: string, candidateCommit: string): void {
  for (const expected of [
    `release-info commit:                   ${candidateCommit}`,
    "hardware:                              Mac14,3",
    "doctor                                 17/17 true",
    "doctor false checks                    (none)",
    "backend at tailnet address:            refused",
    "backend at ssh address:                refused",
    "gateway returned after:",
    "20/20 invariants PASS",
    '"version":"17.4.1"',
  ]) {
    if (!output.includes(expected)) throw new Error(`Mac lifecycle output missed required evidence: ${expected}`);
  }
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
  lanes: readonly string[],
  timeoutMs: number,
): Promise<StagedMacRun> {
  const environment = macEnvironment(options, target);
  const artifactOutput = await runMacScript(environment, ["artifact"], 10 * 60 * 1_000);
  const context: MacContext = { target, environment, publicOrigin: await readMacPublicOrigin(target) };
  try {
    const laneOutput = await runMacScript(environment, lanes, timeoutMs);
    return { context, output: `${artifactOutput}${laneOutput}` };
  } catch (error) {
    try {
      await cleanupMac(context);
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
): Promise<Record<string, unknown>> {
  const run = await runStagedMac(
    options,
    target,
    ["omp-clean", "uninstall", "install", "identity", "persistence", "rollback", "omp-build"],
    50 * 60 * 1_000,
  );
  assertMacLifecycleOutput(run.output, candidate.sourceCommit);
  return {
    hardware: "Mac14,3",
    os: "macOS 26.6.1 arm64",
    doctor: "17/17",
    rollbackInvariants: "20/20",
    outputSha256: sha256(run.output),
  };
}

async function prepareMacFixture(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
): Promise<MacContext> {
  const run = await runStagedMac(
    options,
    target,
    ["omp-clean", "uninstall", "install", "omp-build"],
    45 * 60 * 1_000,
  );
  for (const expected of [`release-info commit:                   ${candidate.sourceCommit}`, "doctor                                 17/17 true", '"version":"17.4.1"']) {
    if (!run.output.includes(expected)) throw new Error(`Mac fixture preparation missed required evidence: ${expected}`);
  }
  return run.context;
}

function ompRemoteCommand(options: StableQualificationOptions, pins: OmpPins): string {
  return [
    'export PATH="$HOME/.bun/bin:$PATH"',
    'root="$HOME/qual/$(cd "$HOME/qual" && ls -d omp-session-gateway-*-bun)"',
    `OMP_QUAL_GATEWAY_ROOT="$root" OMP_PIN_SOURCE_COMMIT=${shellQuote(pins.sourceCommit)} OMP_PIN_PATCHED_TREE=${shellQuote(pins.patchedTree)} OMP_PIN_VERSION=${shellQuote(pins.version)} OMP_PIN_BUN_VERSION=${shellQuote(pins.bunVersion)} OMP_QUAL_SESSION_LABEL=${shellQuote(options.sessionLabel)} exec bash "$HOME/qual-tools/qualify-macos-omp.sh" run`,
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

async function waitForPublishedSession(origin: string, label: string): Promise<Record<string, unknown>> {
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
          throw new Error("patched OMP metadata did not publish View and Control at generation 1");
        }
        return session;
      }
    }
    await Bun.sleep(1_000);
  }
  throw new Error("patched OMP session did not publish within 90 seconds");
}

async function verifyLaunchContracts(origin: string, session: Record<string, unknown>): Promise<Record<string, unknown>> {
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

async function waitForRevocation(origin: string, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/sessions`, { cache: "no-store" });
    const payload = (await response.json()) as { sessions?: Array<{ cwdLabel?: string }> };
    if (!(payload.sessions ?? []).some(session => session.cwdLabel === label)) return;
    await Bun.sleep(1_000);
  }
  throw new Error("patched OMP session did not revoke within 45 seconds");
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
  const androidEnvironment = {
    OMP_ANDROID_BROWSER_PACKAGE: process.env.OMP_ANDROID_BROWSER_PACKAGE ?? "com.android.chrome",
    OMP_ANDROID_BROWSER_ACTIVITY:
      process.env.OMP_ANDROID_BROWSER_ACTIVITY ?? "com.android.chrome/com.google.android.apps.chrome.Main",
    OMP_ANDROID_DEVTOOLS_SOCKET: process.env.OMP_ANDROID_DEVTOOLS_SOCKET ?? "localabstract:chrome_devtools_remote",
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
    leakSweepOutputSha256: sha256(leakOutput),
    secretSinks: "7/7 detectable; clean",
  };
}

async function runRelaySmoke(
  options: StableQualificationOptions,
  context: MacContext,
  tunnelPort: number,
  instanceId: string,
): Promise<Record<string, unknown>> {
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
  const summary = JSON.parse(result.stdout) as Record<string, unknown>;
  if (summary.finalPhase !== "live" || summary.durationSeconds !== options.relaySeconds) {
    throw new Error("bounded relay smoke did not remain live for its exact duration");
  }
  return summary;
}

async function cleanupMac(context: MacContext): Promise<Record<string, unknown>> {
  const output = await runMacScript(context.environment, ["omp-clean", "uninstall"], 10 * 60 * 1_000);
  for (const expected of [
    '"patchedOmpProcessCount":0,"symlinkPresent":false,"sourcePresent":false',
    "plist present:                         no",
    "gui job:                               absent",
    "gateway pids:                          0",
  ]) {
    if (!output.includes(expected)) throw new Error(`Mac cleanup missed required evidence: ${expected}`);
  }
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
    'TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"; "$TS" serve reset >/dev/null 2>&1 || true; rm -rf "$HOME/qual" "$HOME/qual-tools"',
  ]);
  return { gatewayProcesses: 0, gatewayListeners: 0, patchedOmpProcesses: 0, outputSha256: sha256(output) };
}

async function main(): Promise<void> {
  const options = parseStableQualificationArgs(Bun.argv.slice(2));
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("stable qualification orchestration currently requires a Darwin-arm64 workstation");
  }
  const receiptPath = join(options.receiptRoot, "stable-qualification.json");
  const orchestratorCommit = await commandOutput(["git", "rev-parse", "HEAD"]);
  const qualificationRef = await gitQualificationRef(orchestratorCommit);
  const receipt = await loadReceipt(receiptPath, options.tag, orchestratorCommit);
  receipt.status = "running";
  receipt.orchestratorCommit = orchestratorCommit;
  delete receipt.completedAt;
  delete receipt.error;
  const ompPins = await loadQualificationPins();
  const protectedFiles = await captureProtectedFiles();
  const persist = () => saveReceipt(receiptPath, receipt);
  await persist();

  let macContext: MacContext | undefined;
  let ompProcess: ManagedProcess | undefined;
  let tunnelProcess: ManagedProcess | undefined;
  let primaryError: unknown;
  let macEffects = false;
  try {
    const ghToken = await commandOutput(["gh", "auth", "token"]);
    if (ghToken === "") throw new Error("GitHub CLI is not authenticated");
    const candidate = await executeReceiptLane(receipt, "artifacts", persist, async checkpoint => {
      const verified = await verifyCandidate(options, ghToken);
      if (
        receipt.candidate &&
        (receipt.candidate.tag !== verified.tag ||
          receipt.candidate.sourceCommit !== verified.sourceCommit ||
          receipt.candidate.archiveSha256 !== verified.archiveSha256)
      ) {
        throw new Error("candidate identity changed since the resumable receipt was created");
      }
      receipt.candidate = {
        tag: verified.tag,
        sourceCommit: verified.sourceCommit,
        archiveSha256: verified.archiveSha256,
      };
      await checkpoint({
        sourceCommit: verified.sourceCommit,
        archiveSha256: verified.archiveSha256,
        releaseUrl: verified.releaseUrl,
        signedTag: true,
        checksums: "passed",
        githubAttestations: "3/3",
        sigstoreBundles: "3/3",
      });
      return {
        sourceCommit: verified.sourceCommit,
        archiveSha256: verified.archiveSha256,
        releaseUrl: verified.releaseUrl,
        signedTag: true,
        checksums: "passed",
        githubAttestations: "3/3",
        sigstoreBundles: "3/3",
      };
    }, true);
    const candidateVerification: CandidateVerification = {
      tag: options.tag,
      sourceCommit: String(candidate.sourceCommit),
      archiveSha256: String(candidate.archiveSha256),
      releaseUrl: String(candidate.releaseUrl),
      assetDirectory: join(options.receiptRoot, "assets"),
    };

    await executeReceiptLane(receipt, "debian", persist, checkpoint => qualifyDebian(options, receipt, checkpoint, qualificationRef));
    const target = await recoverRetainedMac(options);
    const macWasPassed = receipt.lanes.macos.status === "passed";
    if (!macWasPassed) {
      await executeReceiptLane(receipt, "macos", persist, async () => qualifyMacLifecycle(options, target, candidateVerification));
      macContext = { target, environment: macEnvironment(options, target), publicOrigin: await readMacPublicOrigin(target) };
      macEffects = true;
    }

    const liveEvidenceNeeded = ["ompPublication", "android", "relay"].some(name =>
      receipt.lanes[name as StableQualificationLane].status !== "passed",
    );
    if (liveEvidenceNeeded) {
      if (macWasPassed) {
        macContext = await prepareMacFixture(options, target, candidateVerification);
        macEffects = true;
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
        pending.push(executeReceiptLane(receipt, "android", persist, async () => runAndroidAcceptance(options, macContext!)));
      }
      if (receipt.lanes.relay.status !== "passed") {
        pending.push(executeReceiptLane(receipt, "relay", persist, async () => runRelaySmoke(options, macContext!, tunnelPort, instanceId)));
      }
      const settled = await Promise.allSettled(pending);
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), "physical-client or relay qualification failed");
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
    if (macEffects && macContext !== undefined) {
      try {
        await executeReceiptLane(receipt, "cleanup", persist, async () => cleanupMac(macContext!), true);
      } catch (cleanupError) {
        primaryError = primaryError === undefined ? cleanupError : new AggregateError([primaryError, cleanupError], "qualification and cleanup failed");
      }
    }
    try {
      await assertProtectedFilesUnchanged(protectedFiles);
    } catch (guardError) {
      primaryError = primaryError === undefined ? guardError : new AggregateError([primaryError, guardError], "qualification modified protected state");
    }
  }

  if (primaryError !== undefined) {
    receipt.status = "failed";
    receipt.error = errorMessage(primaryError);
    await persist();
    throw primaryError;
  }
  for (const name of LANE_NAMES) {
    if (receipt.lanes[name].status !== "passed") throw new Error(`qualification lane ${name} did not pass`);
  }
  receipt.status = "passed";
  receipt.completedAt = now();
  delete receipt.error;
  await persist();
  console.log(JSON.stringify({ status: receipt.status, tag: receipt.tag, receipt: receiptPath }));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`stable qualification failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
