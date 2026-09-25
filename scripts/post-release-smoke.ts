import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { defaultGatewayPaths, loadGatewayConfig } from "../apps/gateway/src/config.ts";
import {
  ANDROID_ACCEPTANCE_STAGES,
  ANDROID_COLLAB_STAGES,
  ANDROID_LEAK_SWEEP_STAGES,
  lastAndroidStage,
} from "./android-stages.ts";
import { downloadReleaseAssets } from "./release-download.ts";
import { releaseVersion } from "./release-policy.ts";
import { fixtureModelError, OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY = "alphastorm/omp-session-gateway";
const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
const STABLE_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

interface PackageManifest {
  readonly version: string;
  readonly packageManager: string;
}

export interface PostReleaseSmokeOptions {
  readonly tag: string;
  readonly repository: string;
  readonly expectedArchiveSha256?: string;
  readonly forceReinstall: boolean;
  readonly rebuildOmp: boolean;
  readonly planOnly: boolean;
}

export interface ReleaseAssetNames {
  readonly archive: string;
  readonly sbom: string;
  readonly checksums: "SHA256SUMS";
  readonly all: readonly string[];
  readonly attested: readonly string[];
}

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly allowedExitCodes?: readonly number[];
  readonly safeFailureOutput?: boolean;
  /** Closed stage vocabulary a withheld lane announces; the last announced stage is surfaced. */
  readonly stages?: readonly string[];
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface VerifiedRelease {
  readonly version: string;
  readonly sourceCommit: string;
  readonly archiveSha256: string;
  readonly archiveRoot: string;
  readonly appAsset: string;
  readonly ompVersion: string;
  readonly bunVersion: string;
}

interface ServeStatus {
  readonly TCP?: Readonly<Record<string, unknown>>;
  readonly Web?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface OmpInstall {
  readonly compatible: boolean;
  readonly binary?: string;
  readonly version?: string;
  readonly binarySha256?: string;
  /** False when the resolved binary is some other product wearing the `omp` name. */
  readonly stock?: boolean;
}

interface PublishedSession {
  readonly cwdLabel?: string;
  readonly instanceId?: string;
  readonly generation?: number;
  readonly canView?: boolean;
  readonly canControl?: boolean;
  readonly model?: string;
}

interface FixtureHandle {
  readonly label: string;
  readonly runId: string;
  readonly directory: string;
  readonly marker: string;
  published: boolean;
  tmuxStarted: boolean;
}

export function releaseAssetNames(version: string): ReleaseAssetNames {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error("release version must be bare SemVer");
  }
  const archive = `omp-session-gateway-${version}-bun.tar`;
  const sbom = `omp-session-gateway-${version}.spdx.json`;
  const checksums = "SHA256SUMS" as const;
  const attested = [archive, sbom, checksums];
  return {
    archive,
    sbom,
    checksums,
    attested,
    all: [...attested, ...attested.map(name => `${name}.sigstore.json`)].sort(),
  };
}

export function parsePostReleaseSmokeArgs(
  argv: readonly string[],
  packageVersion: string,
): PostReleaseSmokeOptions {
  let tag = `v${packageVersion}`;
  let repository = DEFAULT_REPOSITORY;
  let expectedArchiveSha256: string | undefined;
  let forceReinstall = false;
  let rebuildOmp = false;
  let planOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--tag") {
      tag = argv[++index] ?? "";
    } else if (value === "--repo") {
      repository = argv[++index] ?? "";
    } else if (value === "--archive-sha256") {
      expectedArchiveSha256 = argv[++index] ?? "";
    } else if (value === "--force-reinstall") {
      forceReinstall = true;
    } else if (value === "--rebuild-omp") {
      rebuildOmp = true;
    } else if (value === "--plan") {
      planOnly = true;
    } else {
      throw new Error(`unknown option: ${value}`);
    }
  }

  const match = STABLE_TAG_PATTERN.exec(tag);
  if (!match) throw new Error("post-release smoke accepts only a bare stable tag such as v0.1.0");
  if (tag !== `v${packageVersion}`) throw new Error("tag must match package.json version");
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("repository must be owner/name");
  if (expectedArchiveSha256 !== undefined && !SHA256_PATTERN.test(expectedArchiveSha256)) {
    throw new Error("--archive-sha256 must be 64 lowercase hexadecimal characters");
  }

  return {
    tag,
    repository,
    ...(expectedArchiveSha256 === undefined ? {} : { expectedArchiveSha256 }),
    forceReinstall,
    rebuildOmp,
    planOnly,
  };
}

export function createSmokeLabel(version: string, nonce: string): string {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error("smoke label version must be bare SemVer");
  }
  if (!/^[a-z0-9]{8}$/u.test(nonce)) throw new Error("smoke label nonce must be eight lowercase alphanumeric characters");
  return `omp-post-release-${version.replaceAll(".", "-")}-${nonce}`;
}

export function formatCommandFailure(
  name: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  includeSafeOutput: boolean,
  stages: readonly string[] = [],
): string {
  if (includeSafeOutput) return `${name} failed with exit ${exitCode}: ${(stderr || stdout).trim().slice(-2_000)}`;
  return `${name} failed with exit ${exitCode}${stageSuffix(stderr, stages)}`;
}

function stageSuffix(stderr: string, stages: readonly string[]): string {
  const stage = lastAndroidStage(stderr, stages);
  return stage === undefined ? "" : ` at stage "${stage}"`;
}

export function assertReleaseArchiveIdentity(
  releaseInfo: Readonly<Record<string, unknown>>,
  version: string,
  sourceCommit: string,
  bunVersion: string,
): void {
  if (
    releaseInfo.version !== version ||
    releaseInfo.sourceCommit !== sourceCommit ||
    releaseInfo.product !== "OMP Session Gateway" ||
    releaseInfo.runtime !== `Bun >=${bunVersion}` ||
    typeof releaseInfo.qualification !== "string" ||
    !releaseInfo.qualification.startsWith("qualified stable")
  ) {
    throw new Error("release archive identity does not match the stable tag");
  }
}

export function assertFixtureOwnership(actualMarker: string, runId: string): void {
  if (actualMarker !== `${runId}\n`) {
    throw new Error("smoke fixture ownership marker changed; refusing directory cleanup");
  }
}

export function selectAdbDevice(devicesOutput: string, requestedSerial?: string): string {
  const devices = devicesOutput
    .split(/\r?\n/u)
    .slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter((fields): fields is [string, string, ...string[]] => fields.length >= 2 && fields[1] === "device");
  if (requestedSerial !== undefined) {
    if (!devices.some(([serial]) => serial === requestedSerial)) {
      throw new Error("configured Android device is not attached and authorized");
    }
    return requestedSerial;
  }
  if (devices.length !== 1) throw new Error("post-release smoke requires exactly one attached and authorized Android device");
  return devices[0]![0];
}

export function assertWebApkActiveTask(activities: string, packageName: string): void {
  const activityLines = activities.split(/\r?\n/u);
  const focusedTask = activityLines.some(
    line => line.includes("topDisplayFocusedRootTask=") && line.includes(`:${packageName}`),
  );
  const resumedWebApk = activityLines.some(
    line => line.includes("topResumedActivity=") && line.includes("SameTaskWebApkActivity"),
  );
  if (!focusedTask || !resumedWebApk) throw new Error("installed WebAPK did not become the active standalone task");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}


async function runCommand(name: string, command: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const [executable, ...arguments_] = command;
  if (executable === undefined) throw new Error(`${name} command was empty`);
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const child = spawn(executable, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let outputExceeded = false;
  const append = (chunks: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.length;
    if (outputBytes > COMMAND_OUTPUT_LIMIT) {
      outputExceeded = true;
      child.kill("SIGTERM");
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));

  const timeoutMs = options.timeoutMs ?? 120_000;
  let timedOut = false;
  let forceTimeout: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, timeoutMs);
  try {
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", code => resolveExit(code ?? 1));
    });
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (outputExceeded) throw new Error(`${name} output exceeded the safety limit`);
    if (timedOut) throw new Error(`${name} timed out${stageSuffix(stderr, options.stages ?? [])}`);
    if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
      throw new Error(
        formatCommandFailure(name, exitCode, stdout, stderr, options.safeFailureOutput === true, options.stages),
      );
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
    if (forceTimeout !== undefined) clearTimeout(forceTimeout);
  }
}

async function commandOutput(name: string, command: readonly string[], options: CommandOptions = {}): Promise<string> {
  return (await runCommand(name, command, options)).stdout.trim();
}
async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>(resolveSleep => setTimeout(resolveSleep, milliseconds));
}


async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Bun's parse error quotes the first unexpected token, so a withheld lane's text must not reach it. */
export function parseJsonRecord(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} did not return JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${name} was not a JSON object`);
  return parsed as Record<string, unknown>;
}

function assertExactNames(actual: readonly string[], expected: readonly string[], name: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${name} did not contain the exact expected files`);
  }
}

async function verifyPublishedRelease(
  options: PostReleaseSmokeOptions,
  staging: string,
  packageManifest: PackageManifest,
): Promise<VerifiedRelease> {
  const version = releaseVersion(options.tag);
  const names = releaseAssetNames(version);
  const downloadDirectory = join(staging, "release");
  await downloadReleaseAssets(downloadDirectory, () =>
    runCommand(
      "release download",
      ["gh", "release", "download", options.tag, "--repo", options.repository, "--dir", downloadDirectory],
      { timeoutMs: 300_000, safeFailureOutput: true },
    ),
  );
  assertExactNames(await readdir(downloadDirectory), names.all, "published release");

  await runCommand("release checksums", ["shasum", "-a", "256", "-c", names.checksums], {
    cwd: downloadDirectory,
    safeFailureOutput: true,
  });

  const release = parseJsonRecord(
    await commandOutput("release metadata", ["gh", "api", `repos/${options.repository}/releases/tags/${options.tag}`], {
      safeFailureOutput: true,
    }),
    "release metadata",
  );
  if (release.tag_name !== options.tag || release.draft !== false || release.prerelease !== false) {
    throw new Error("published release is not the requested stable release");
  }
  const latest = parseJsonRecord(
    await commandOutput("latest release metadata", ["gh", "api", `repos/${options.repository}/releases/latest`], {
      safeFailureOutput: true,
    }),
    "latest release metadata",
  );
  if (latest.tag_name !== options.tag) throw new Error("published stable tag is not GitHub Latest");

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetDigests = new Map<string, string>();
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null || Array.isArray(asset)) continue;
    const record = asset as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.digest === "string") assetDigests.set(record.name, record.digest);
  }
  assertExactNames([...assetDigests.keys()], names.all, "release asset metadata");
  for (const name of names.all) {
    const localDigest = await sha256File(join(downloadDirectory, name));
    if (assetDigests.get(name) !== `sha256:${localDigest}`) throw new Error(`GitHub asset digest mismatch for ${name}`);
  }

  const workflow = `${options.repository}/.github/workflows/signed-release.yml`;
  const certificateIdentity = `https://github.com/${workflow}@refs/tags/${options.tag}`;
  for (const name of names.attested) {
    await runCommand(
      `GitHub attestation for ${name}`,
      [
        "gh",
        "attestation",
        "verify",
        join(downloadDirectory, name),
        "--repo",
        options.repository,
        "--signer-workflow",
        workflow,
        "--source-ref",
        `refs/tags/${options.tag}`,
      ],
      { timeoutMs: 180_000, safeFailureOutput: true },
    );
    await runCommand(
      `Sigstore bundle for ${name}`,
      [
        "cosign",
        "verify-blob",
        "--bundle",
        join(downloadDirectory, `${name}.sigstore.json`),
        "--certificate-identity",
        certificateIdentity,
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        join(downloadDirectory, name),
      ],
      { timeoutMs: 180_000, safeFailureOutput: true },
    );
  }

  const localTagObject = await commandOutput("local stable tag", ["git", "rev-parse", `refs/tags/${options.tag}`]);
  const remoteRef = parseJsonRecord(
    await commandOutput("remote stable tag", ["gh", "api", `repos/${options.repository}/git/ref/tags/${options.tag}`], {
      safeFailureOutput: true,
    }),
    "remote stable tag",
  );
  const remoteObject =
    typeof remoteRef.object === "object" && remoteRef.object !== null && !Array.isArray(remoteRef.object)
      ? (remoteRef.object as Record<string, unknown>)
      : undefined;
  if (remoteObject?.sha !== localTagObject || remoteObject.type !== "tag") {
    throw new Error("local and GitHub annotated tag objects differ");
  }
  await runCommand("signed stable tag", ["git", "tag", "-v", options.tag], { safeFailureOutput: true });
  const sourceCommit = await commandOutput("stable tag source", ["git", "rev-parse", `${options.tag}^{commit}`]);
  await runCommand("stable tag ancestry", ["git", "merge-base", "--is-ancestor", sourceCommit, "origin/main"]);
  const remoteTag = parseJsonRecord(
    await commandOutput("remote annotated tag", ["gh", "api", `repos/${options.repository}/git/tags/${localTagObject}`], {
      safeFailureOutput: true,
    }),
    "remote annotated tag",
  );
  const remoteTagTarget =
    typeof remoteTag.object === "object" && remoteTag.object !== null && !Array.isArray(remoteTag.object)
      ? (remoteTag.object as Record<string, unknown>)
      : undefined;
  const verification =
    typeof remoteTag.verification === "object" && remoteTag.verification !== null && !Array.isArray(remoteTag.verification)
      ? (remoteTag.verification as Record<string, unknown>)
      : undefined;
  if (remoteTagTarget?.sha !== sourceCommit || verification?.verified !== true) {
    throw new Error("GitHub does not report the annotated stable tag as verified for the expected source");
  }

  const archivePath = join(downloadDirectory, names.archive);
  const archiveSha256 = await sha256File(archivePath);
  if (options.expectedArchiveSha256 !== undefined && archiveSha256 !== options.expectedArchiveSha256) {
    throw new Error("archive digest does not match --archive-sha256");
  }
  const extractedDirectory = join(staging, "extracted");
  await mkdir(extractedDirectory, { mode: 0o700 });
  await runCommand("release extraction", ["tar", "-xf", archivePath, "-C", extractedDirectory], {
    timeoutMs: 120_000,
    safeFailureOutput: true,
  });
  const roots = await readdir(extractedDirectory);
  if (roots.length !== 1) throw new Error("release archive did not contain exactly one root directory");
  const archiveRoot = join(extractedDirectory, roots[0]!);
  if (!(await stat(archiveRoot)).isDirectory()) throw new Error("release archive root is not a directory");

  const releaseInfo = parseJsonRecord(await readFile(join(archiveRoot, "release-info.json"), "utf8"), "release-info.json");
  assertReleaseArchiveIdentity(releaseInfo, version, sourceCommit, packageManifest.packageManager.replace(/^bun@/u, ""));
  const assetFiles = await readdir(join(archiveRoot, "apps/web/dist/assets"));
  const appAssets = assetFiles.filter(name => /^app\.[0-9a-f]+\.js$/u.test(name));
  if (appAssets.length !== 1) throw new Error("release archive did not contain exactly one hashed app asset");
  const appAsset = `/assets/${appAssets[0]!}`;
  const upstream = parseJsonRecord(await readFile(join(archiveRoot, "UPSTREAM.lock.json"), "utf8"), "UPSTREAM.lock.json");
  if (
    typeof upstream.packageVersion !== "string" ||
    !Bun.semver.satisfies(upstream.packageVersion, ">=18.1.20") ||
    upstream.bunVersion !== packageManifest.packageManager.replace(/^bun@/u, "")
  ) {
    throw new Error("release archive must name a mainline OMP prerequisite and the repository Bun pin");
  }

  return { version, sourceCommit, archiveSha256, archiveRoot, appAsset, ompVersion: upstream.packageVersion, bunVersion: upstream.bunVersion as string };
}

async function ensurePersistentBun(version: string): Promise<string> {
  if (process.versions.bun !== version) {
    throw new Error(`post-release smoke must run under Bun ${version}; received ${process.versions.bun}`);
  }
  const directory = join(homedir(), ".local", "lib", "omp-session-gateway", "bun", `v${version}`);
  const executable = join(directory, "bun");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await pathExists(executable))) {
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
  }
  if ((await commandOutput("pinned Bun", [executable, "--version"])) !== version) {
    throw new Error("persistent Bun executable does not match the release pin");
  }
  return executable;
}

async function capturePrivateFile(path: string, name: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} is not a private current-user regular file`);
  }
  return readFile(path);
}

function equalPrivateBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function installedReleaseMatches(version: string, sourceCommit: string): Promise<boolean> {
  const installationRoot = join(defaultGatewayPaths().stateDir, "installation");
  try {
    const pointer = parseJsonRecord(await readFile(join(installationRoot, "current.json"), "utf8"), "current.json");
    if (typeof pointer.versionDirectory !== "string") return false;
    const releaseInfo = parseJsonRecord(
      await readFile(join(installationRoot, "versions", pointer.versionDirectory, "release-info.json"), "utf8"),
      "installed release-info.json",
    );
    return releaseInfo.version === version && releaseInfo.sourceCommit === sourceCommit;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function serviceUsesBun(executable: string): Promise<boolean> {
  const plist = join(homedir(), "Library", "LaunchAgents", "omp-session-gateway.plist");
  if (!(await pathExists(plist))) return false;
  try {
    return (
      (await commandOutput("LaunchAgent runtime", ["plutil", "-extract", "ProgramArguments.0", "raw", plist])) === executable
    );
  } catch {
    return false;
  }
}

async function installOrVerifyGateway(
  options: PostReleaseSmokeOptions,
  release: VerifiedRelease,
  bunExecutable: string,
): Promise<{ installed: boolean }> {
  const config = await loadGatewayConfig();
  if (config.auth.mode !== "tailscale-serve" || config.auth.allowedLogins.length === 0) {
    throw new Error("post-release smoke requires an existing Tailscale Serve config with an exact login allowlist");
  }
  const paths = defaultGatewayPaths();
  const configBefore = await capturePrivateFile(paths.configPath, "gateway config");
  const tokenBefore = await capturePrivateFile(paths.tokenPath, "readiness token");
  let installed = false;
  try {
    const currentMatches = await installedReleaseMatches(release.version, release.sourceCommit);
    const runtimeMatches = await serviceUsesBun(bunExecutable);
    if (options.forceReinstall || !currentMatches || !runtimeMatches) {
      const command = [
        bunExecutable,
        join(release.archiveRoot, "apps/gateway/src/cli.js"),
        "install",
        "--origin",
        config.http.publicOrigin,
        "--port",
        String(config.http.port),
      ];
      for (const login of config.auth.allowedLogins) command.push("--allow", login);
      await runCommand("gateway install", command, { timeoutMs: 180_000 });
      installed = true;
    }

    const configAfter = await capturePrivateFile(paths.configPath, "gateway config");
    const tokenAfter = await capturePrivateFile(paths.tokenPath, "readiness token");
    try {
      if (!equalPrivateBytes(configBefore, configAfter)) throw new Error("gateway install changed the existing config bytes");
      if (!equalPrivateBytes(tokenBefore, tokenAfter)) throw new Error("gateway install changed the readiness token bytes");
    } finally {
      configAfter.fill(0);
      tokenAfter.fill(0);
    }

    const cli = join(release.archiveRoot, "apps/gateway/src/cli.js");
    const status = parseJsonRecord(await commandOutput("gateway status", [bunExecutable, cli, "status"]), "gateway status");
    if (status.installed !== true || status.active !== true || status.ready !== true || status.diverged !== false) {
      throw new Error("installed gateway is not active, ready, and non-diverged");
    }
    if (!(await installedReleaseMatches(release.version, release.sourceCommit))) {
      throw new Error("active gateway runtime does not match the stable release source");
    }
    if (!(await serviceUsesBun(bunExecutable))) throw new Error("LaunchAgent does not use the pinned persistent Bun executable");
    return { installed };
  } finally {
    configBefore.fill(0);
    tokenBefore.fill(0);
  }
}
async function verifyGatewayDoctor(release: VerifiedRelease, bunExecutable: string): Promise<number> {
  const cli = join(release.archiveRoot, "apps/gateway/src/cli.js");
  const doctor = parseJsonRecord(
    await commandOutput("gateway doctor", [bunExecutable, cli, "doctor"], { timeoutMs: 180_000 }),
    "gateway doctor",
  );
  const checks =
    typeof doctor.checks === "object" && doctor.checks !== null && !Array.isArray(doctor.checks)
      ? Object.values(doctor.checks as Record<string, unknown>)
      : [];
  if (checks.length === 0 || checks.some(value => value !== true)) throw new Error("gateway doctor did not pass every check");
  return checks.length;
}


function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function unrelatedServeSnapshot(status: ServeStatus, host: string, port: number): string {
  const copy = structuredClone(status) as Record<string, unknown>;
  const tcp = typeof copy.TCP === "object" && copy.TCP !== null && !Array.isArray(copy.TCP) ? (copy.TCP as Record<string, unknown>) : undefined;
  const web = typeof copy.Web === "object" && copy.Web !== null && !Array.isArray(copy.Web) ? (copy.Web as Record<string, unknown>) : undefined;
  delete tcp?.[String(port)];
  delete web?.[`${host}:${port}`];
  return JSON.stringify(sortJson(copy));
}

function serveMappingMatches(status: ServeStatus, host: string, publicPort: number, target: string): boolean {
  const tcp = status.TCP?.[String(publicPort)];
  const web = status.Web?.[`${host}:${publicPort}`];
  if (typeof tcp !== "object" || tcp === null || Array.isArray(tcp) || (tcp as Record<string, unknown>).HTTPS !== true) return false;
  if (typeof web !== "object" || web === null || Array.isArray(web)) return false;
  const handlers = (web as Record<string, unknown>).Handlers;
  if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) return false;
  const root = (handlers as Record<string, unknown>)["/"];
  return typeof root === "object" && root !== null && !Array.isArray(root) && (root as Record<string, unknown>).Proxy === target;
}

async function ensureServeMapping(): Promise<{ changed: boolean }> {
  const config = await loadGatewayConfig();
  const origin = new URL(config.http.publicOrigin);
  const publicPort = origin.port === "" ? 443 : Number(origin.port);
  const host = origin.hostname;
  const target = `http://${config.http.hostname}:${config.http.port}`;
  const before = JSON.parse(await commandOutput("Tailscale Serve status", ["tailscale", "serve", "status", "--json"])) as ServeStatus;
  const unrelatedBefore = unrelatedServeSnapshot(before, host, publicPort);
  let changed = false;
  if (!serveMappingMatches(before, host, publicPort, target)) {
    await runCommand("Tailscale Serve mapping", ["tailscale", "serve", "--bg", `--https=${publicPort}`, target], {
      timeoutMs: 120_000,
      safeFailureOutput: true,
    });
    changed = true;
  }
  const after = JSON.parse(await commandOutput("updated Tailscale Serve status", ["tailscale", "serve", "status", "--json"])) as ServeStatus;
  if (!serveMappingMatches(after, host, publicPort, target)) throw new Error("Tailscale Serve mapping does not match the gateway config");
  if (unrelatedServeSnapshot(after, host, publicPort) !== unrelatedBefore) {
    throw new Error("Tailscale Serve changed an unrelated mapping");
  }
  return { changed };
}

/**
 * Whether a resolved `omp` is stock mainline rather than another product installed under the same
 * name. The version banner cannot answer this: a derivative build reports a compatible-looking
 * version, so a version-only check accepted a Code Mode launcher and ran the entire physical-client
 * acceptance against an agent carrying trusted extensions and a routed config. Requiring the
 * mainline npm package that `UPSTREAM.lock.json` names, in the symlink-resolved path, is what
 * separates them; `--rebuild-omp` installs exactly that package.
 */
export function isStockOmpBinary(realPath: string): boolean {
  return realPath.split(sep).join("/").includes("/@oh-my-pi/pi-coding-agent/");
}

export async function inspectOmpInstall(): Promise<OmpInstall> {
  const binary = Bun.which("omp", { PATH: process.env.PATH ?? "" });
  return binary === null ? { compatible: false } : inspectOmpBinary(binary);
}

/** Inspects one candidate binary; a missing or unreadable one reports incompatible, not stock. */
export async function inspectOmpBinary(binary: string): Promise<OmpInstall> {
  try {
    const stock = isStockOmpBinary(await realpath(binary));
    const output = await commandOutput("OMP version", [binary, "--version"]);
    const version = /^(?:omp[ /])?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(output)?.[1];
    if (version === undefined || !Bun.semver.satisfies(version, ">=18.1.20")) return { compatible: false, binary, stock };
    // `compatible` stays a statement about version and settings only; product identity is a
    // separate fact that `resolveOmp` refuses on, so the two never mask each other.
    const autoStart = parseJsonRecord(
      await commandOutput("OMP auto-start", [binary, "config", "get", "collab.autoStart", "--json"]),
      "OMP auto-start",
    );
    return {
      compatible: autoStart.value === "off" || autoStart.value === "view" || autoStart.value === "control",
      binary,
      version,
      binarySha256: await sha256File(binary),
      stock,
    };
  } catch {
    return { compatible: false, binary };
  }
}

/**
 * The `omp` on PATH wins when it is stock mainline. On a workstation where that name belongs to
 * another product, such as a Code Mode launcher, a stock alternative replaces it; otherwise the PATH
 * result stands so the refusal names the binary the operator would run.
 */
export function preferStockOmp(onPath: OmpInstall, alternative: OmpInstall): OmpInstall {
  return onPath.stock !== true && alternative.stock === true ? alternative : onPath;
}

interface ResolvedOmp {
  readonly installed: boolean;
  readonly version: string;
  readonly binary: string;
  readonly binarySha256: string;
}

/**
 * Selects the single OMP the smoke exercises, before any gateway change, so an unusable OMP fails
 * while the installed gateway is still untouched. Bun's global stock install is used in place of a
 * same-named launcher on PATH without reinstalling it; `--rebuild-omp` reinstalls the pinned package.
 */
async function resolveOmp(
  options: PostReleaseSmokeOptions,
  release: VerifiedRelease,
  bunExecutable: string,
): Promise<ResolvedOmp> {
  const bunGlobalBin = () => commandOutput("Bun global bin", [bunExecutable, "pm", "bin", "--global"]);
  let inspection = await inspectOmpInstall();
  if (!options.rebuildOmp && inspection.stock !== true) {
    inspection = preferStockOmp(inspection, await inspectOmpBinary(join(await bunGlobalBin(), "omp")));
  }
  let installed = false;
  if (options.rebuildOmp || inspection.binary === undefined) {
    await runCommand("mainline OMP install", [bunExecutable, "add", "--global", "--exact", "@oh-my-pi/pi-coding-agent@" + release.ompVersion], {
      timeoutMs: 1_800_000,
      safeFailureOutput: true,
    });
    process.env.PATH = (await bunGlobalBin()) + ":" + (process.env.PATH ?? "");
    installed = true;
    inspection = await inspectOmpInstall();
  }
  if (inspection.stock === false) {
    throw new Error(
      "the omp on PATH is not stock mainline and Bun's global install has no stock omp: it resolves outside @oh-my-pi/pi-coding-agent, so it is a different product wearing the same name. " +
        "Qualifying a release against it would prove nothing about the advertised prerequisite. Use --rebuild-omp to install and use the pinned mainline package.",
    );
  }
  if (!inspection.compatible || inspection.binary === undefined || inspection.binarySha256 === undefined || inspection.version === undefined) {
    throw new Error("the selected omp must be mainline >=18.1.20 with readable collab.autoStart; use --rebuild-omp to reinstall it");
  }
  return { installed, version: inspection.version, binary: inspection.binary, binarySha256: inspection.binarySha256 };
}

/** A settings write can exit 0 without persisting, so the host's own read-back is the proof. */
export async function enableOmpAutoStart(binary: string): Promise<void> {
  await runCommand("OMP auto-start setup", [binary, "config", "set", "collab.autoStart", "control"]);
  const autoStart = parseJsonRecord(
    await commandOutput("OMP auto-start", [binary, "config", "get", "collab.autoStart", "--json"]),
    "OMP auto-start",
  );
  if (autoStart.value !== "control") throw new Error("OMP auto-start setup exited cleanly, but collab.autoStart does not read back as control");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function createFixture(version: string): Promise<FixtureHandle> {
  const runId = randomBytes(16).toString("hex");
  const label = createSmokeLabel(version, randomBytes(4).toString("hex"));
  const directory = join(homedir(), label);
  const marker = join(directory, ".omp-session-gateway-post-release-smoke");
  if (await pathExists(directory)) throw new Error("generated smoke fixture directory already exists");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(marker, `${runId}\n`, { mode: 0o600, flag: "wx" });
  return { label, runId, directory, marker, published: false, tmuxStarted: false };
}

async function startFixture(
  handle: FixtureHandle,
  binary: string,
  staging: string,
): Promise<void> {
  const launcher = join(staging, "launch-omp-smoke.sh");
  await writeFile(
    launcher,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ...Object.entries(OMP_FIXTURE_ENV).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      `exec ${[binary, ...OMP_FIXTURE_ARGS].map(shellQuote).join(" ")} >/dev/null 2>&1`,
      "",
    ].join("\n"),
    { mode: 0o700, flag: "wx" },
  );
  await runCommand("tmux smoke fixture", [
    "tmux",
    "new-session",
    "-d",
    "-s",
    handle.label,
    "-c",
    handle.directory,
    `exec ${shellQuote(launcher)}`,
  ]);
  handle.tmuxStarted = true;

  const config = await loadGatewayConfig();
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`${config.http.publicOrigin}/api/v1/sessions`, { cache: "no-store", credentials: "omit" });
    if (response.ok) {
      const payload = (await response.json()) as { sessions?: PublishedSession[] };
      const matches = (payload.sessions ?? []).filter(session => session.cwdLabel === handle.label);
      if (matches.length === 1) {
        const session = matches[0]!;
        if (
          session.canView !== true ||
          session.canControl !== true ||
          typeof session.instanceId !== "string" ||
          typeof session.generation !== "number"
        ) {
          throw new Error("published smoke fixture metadata is incomplete");
        }
        const modelError = fixtureModelError(session);
        if (modelError !== undefined) throw new Error(modelError);
        handle.published = true;
        return;
      }
      if (matches.length > 1) throw new Error("generated smoke fixture label was not unique");
    }
    await sleep(1_000);
  }
  throw new Error("mainline OMP smoke fixture did not publish within 90 seconds");
}

async function stopFixture(handle: FixtureHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  const errors: unknown[] = [];
  if (handle.tmuxStarted) {
    try {
      const before = await runCommand("tmux smoke status", ["tmux", "has-session", "-t", handle.label], {
        allowedExitCodes: [0, 1],
      });
      if (before.exitCode === 0) await runCommand("tmux smoke cleanup", ["tmux", "kill-session", "-t", handle.label]);
      const after = await runCommand("tmux smoke cleanup status", ["tmux", "has-session", "-t", handle.label], {
        allowedExitCodes: [0, 1],
      });
      if (after.exitCode === 0) throw new Error("tmux smoke session remained active after cleanup");
    } catch (error) {
      errors.push(error);
    }
  }
  if (handle.published) {
    try {
      const config = await loadGatewayConfig();
      let revoked = false;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const response = await fetch(`${config.http.publicOrigin}/api/v1/sessions`, { cache: "no-store", credentials: "omit" });
        const payload = (await response.json()) as { sessions?: PublishedSession[] };
        if (!(payload.sessions ?? []).some(session => session.cwdLabel === handle.label)) {
          revoked = true;
          break;
        }
        await sleep(500);
      }
      if (!revoked) throw new Error("smoke fixture capability was not revoked");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const marker = await readFile(handle.marker, "utf8");
    assertFixtureOwnership(marker, handle.runId);
    await rm(handle.directory, { recursive: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "post-release fixture cleanup failed");
}

export function findWebApkForHost(
  packageList: string,
  packageDumps: Readonly<Record<string, string>>,
  host: string,
): string | undefined {
  const packages = packageList
    .split(/\r?\n/u)
    .map(line => line.trim().replace(/^package:/u, ""))
    .filter(name => /^org[.]chromium[.]webapk[.][A-Za-z0-9_.-]+$/u.test(name));
  const needle = `Authority: "${host}"`;
  const matches = packages.filter(name => packageDumps[name]?.includes(needle));
  if (matches.length > 1) throw new Error("multiple installed WebAPKs claim the gateway origin");
  return matches[0];
}

async function chooseLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("could not reserve a loopback port"));
        return;
      }
      server.close(error => (error === undefined ? resolvePort(address.port) : rejectPort(error)));
    });
  });
}

export function isWebApkAppTarget(
  target: { readonly type?: string; readonly title?: string; readonly url?: string },
  origin: string,
): boolean {
  if (target.type !== "page" || target.url === undefined || !URL.canParse(target.url)) return false;
  const url = new URL(target.url);
  // Android resumes the existing app route; a collaboration page has a session-specific title.
  return url.origin === origin &&
    (url.pathname === "/" || url.pathname === "/client/") &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

async function verifyInstalledWebApk(origin: string): Promise<void> {
  const host = new URL(origin).hostname;
  const packageList = await commandOutput("installed WebAPK list", ["adb", "shell", "cmd", "package", "list", "packages", "org.chromium.webapk"]);
  const packages = packageList
    .split(/\r?\n/u)
    .map(line => line.trim().replace(/^package:/u, ""))
    .filter(Boolean);
  const packageDumps: Record<string, string> = {};
  for (const packageName of packages) {
    packageDumps[packageName] = await commandOutput("installed WebAPK metadata", ["adb", "shell", "dumpsys", "package", packageName]);
  }
  const packageName = findWebApkForHost(packageList, packageDumps, host);
  if (packageName === undefined) throw new Error("OMP Sessions WebAPK is not installed for the gateway origin");

  await runCommand(
    "installed WebAPK launch",
    ["adb", "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
    { timeoutMs: 30_000 },
  );
  await sleep(2_000);
  const activities = await commandOutput("installed WebAPK activity", ["adb", "shell", "dumpsys", "activity", "activities"]);
  assertWebApkActiveTask(activities, packageName);

  const port = await chooseLoopbackPort();
  await runCommand("WebAPK DevTools forward", ["adb", "forward", `tcp:${port}`, "localabstract:chrome_devtools_remote"]);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) throw new Error("WebAPK DevTools target list was unavailable");
    const targets = (await response.json()) as Array<{ type?: string; title?: string; url?: string }>;
    if (!targets.some(target => isWebApkAppTarget(target, origin))) {
      throw new Error("installed WebAPK did not render the OMP Sessions origin");
    }
  } finally {
    await runCommand("WebAPK DevTools cleanup", ["adb", "forward", "--remove", `tcp:${port}`]);
  }
}

async function runAndroidLanes(
  release: VerifiedRelease,
  bunExecutable: string,
  label: string,
): Promise<void> {
  const config = await loadGatewayConfig();
  const collab = parseJsonRecord(
    await commandOutput(
      "Android View and Control smoke",
      [
        bunExecutable,
        join(repositoryRoot, "scripts/android-collab-smoke.ts"),
        config.http.publicOrigin,
        label,
        "--expected-app-asset",
        release.appAsset,
      ],
      { timeoutMs: 300_000, stages: ANDROID_COLLAB_STAGES },
    ),
    "Android View and Control smoke",
  );
  if (
    collab.appAsset !== release.appAsset ||
    collab.viewReadOnly !== true ||
    collab.controlWritable !== true ||
    collab.promptAccepted !== true ||
    collab.returnedToDirectory !== true
  ) {
    throw new Error("Android View and Control smoke returned an incomplete result");
  }
  await runCommand(
    "Android capability sink sweep",
    [bunExecutable, join(repositoryRoot, "scripts/android-leak-sweep.ts"), config.http.publicOrigin, label],
    { timeoutMs: 300_000, stages: ANDROID_LEAK_SWEEP_STAGES },
  );
  await runCommand(
    "Android same-page recovery",
    [bunExecutable, join(repositoryRoot, "scripts/android-acceptance.ts"), config.http.publicOrigin, label],
    { timeoutMs: 900_000, stages: ANDROID_ACCEPTANCE_STAGES },
  );
  await verifyInstalledWebApk(config.http.publicOrigin);
}

async function assertRequiredTools(): Promise<void> {
  for (const tool of ["gh", "cosign", "git", "shasum", "tar", "plutil", "tailscale", "tmux", "adb"]) {
    await runCommand(`${tool} prerequisite`, ["sh", "-c", `command -v ${tool} >/dev/null`]);
  }
  const devices = await commandOutput("Android device preflight", ["adb", "devices", "-l"]);
  selectAdbDevice(devices, process.env.OMP_ANDROID_SERIAL);
}

export async function runPostReleaseSmoke(options: PostReleaseSmokeOptions): Promise<Record<string, unknown>> {
  const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as PackageManifest;
  const bunVersion = packageManifest.packageManager.replace(/^bun@/u, "");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("post-release smoke currently supports the qualified Darwin-arm64 host only");
  }
  if (process.versions.bun !== bunVersion) {
    throw new Error(`run post-release smoke with Bun ${bunVersion}`);
  }
  if (options.planOnly) {
    return {
      tag: options.tag,
      repository: options.repository,
      effects: [
        "verify published release provenance",
        "select stock mainline OMP >=18.1.20 from PATH or Bun's global install before any gateway change",
        "install or verify the stable gateway without changing config or readiness token",
        "preserve unrelated Tailscale Serve mappings",
        "exercise an owned disposable tmux session on the physical Android client",
        "remove only the owned session and private staging",
        "leave the stable gateway, mainline OMP, and installed PWA in place",
      ],
    };
  }

  await assertRequiredTools();
  const staging = await mkdtemp(join(tmpdir(), "omp-gateway-post-release-"));
  await chmod(staging, 0o700);
  let fixture: FixtureHandle | undefined;
  let primaryError: unknown;
  try {
    const release = await verifyPublishedRelease(options, staging, packageManifest);
    const bunExecutable = await ensurePersistentBun(release.bunVersion);
    // An unusable OMP fails the run before the installed gateway changes.
    const omp = await resolveOmp(options, release, bunExecutable);
    const gateway = await installOrVerifyGateway(options, release, bunExecutable);
    const serve = await ensureServeMapping();
    const doctorChecks = await verifyGatewayDoctor(release, bunExecutable);
    await enableOmpAutoStart(omp.binary);
    fixture = await createFixture(release.version);
    await startFixture(fixture, omp.binary, staging);
    await runAndroidLanes(release, bunExecutable, fixture.label);
    return {
      tag: options.tag,
      sourceCommit: release.sourceCommit,
      archiveSha256: release.archiveSha256,
      appAsset: release.appAsset,
      gateway: {
        installed: gateway.installed,
        configPreserved: true,
        readinessTokenPreserved: true,
        doctorChecks,
      },
      tailscaleServe: { changed: serve.changed, unrelatedMappingsPreserved: true },
      omp: { version: omp.version, installed: omp.installed, binarySha256: omp.binarySha256 },
      android: {
        viewReadOnly: true,
        controlWritable: true,
        capabilitySinksClean: true,
        samePageRecovery: true,
        installedWebApk: true,
      },
      leaveInstalled: { gateway: true, mainlineOmp: true, webApk: true },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await stopFixture(fixture);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(staging, { recursive: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (primaryError !== undefined) throw new AggregateError([primaryError, ...cleanupErrors], "post-release smoke and cleanup failed");
      throw new AggregateError(cleanupErrors, "post-release smoke cleanup failed");
    }
  }
}

if (import.meta.main) {
  const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as PackageManifest;
  const options = parsePostReleaseSmokeArgs(process.argv.slice(2), packageManifest.version);
  const result = await runPostReleaseSmoke(options);
  console.log(JSON.stringify(result, null, 2));
}
