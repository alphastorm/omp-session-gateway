import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const POSIX = process.platform !== "win32";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts/qualify-macos-host.sh");
const ompScriptPath = join(repositoryRoot, "scripts/qualify-macos-omp.sh");
const sudoPassword = "mac-sudo-'argv-canary";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function environment(archiveSha256: string): Record<string, string | undefined> {
  return {
    ...process.env,
    OMP_MAC_HOST: "synthetic@example.invalid",
    OMP_MAC_TAG: "v0.4.0-prealpha.1",
    OMP_MAC_PREVIOUS_TAG: "v0.3.0",
    OMP_MAC_LOGIN: "synthetic@example.invalid",
    OMP_MAC_ARCHIVE_SHA256: archiveSha256,
    OMP_MAC_SUDO_PW: sudoPassword,
  };
}

async function runHarness(
  harness: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["/bin/bash", "-c", harness, "test", scriptPath, ...args], {
    cwd: repositoryRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const cleanupVersion = "18.1.20";
const cleanupSourceTree = "12345678deadbeef";

function cleanupPaths(home: string) {
  const source = join(home, "src", `oh-my-pi-gateway-v${cleanupVersion}`);
  const versionDirectory = join(
    home,
    ".local",
    "lib",
    "omp-session-gateway",
    "omp",
    `v${cleanupVersion}-${cleanupSourceTree.slice(0, 8)}`,
  );
  return {
    source,
    sourceMarker: join(source, "owned-source"),
    binary: join(versionDirectory, "omp"),
    symlink: join(home, ".local", "bin", "omp"),
  };
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function runOmpCleanup(
  home: string,
  sessionLabel = "synthetic-clean",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fakeBin = join(home, "test-bin");
  const fakePgrep = join(fakeBin, "pgrep");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakePgrep, "#!/bin/sh\nexit 1\n");
  await chmod(fakePgrep, 0o755);

  const cleanup = Bun.spawn(["/bin/bash", ompScriptPath, "clean"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      OMP_QUAL_GATEWAY_ROOT: join(home, "gateway"),
      OMP_QUAL_SESSION_LABEL: sessionLabel,
      OMP_PIN_SOURCE_COMMIT: "source",
      OMP_PIN_SOURCE_TREE: cleanupSourceTree,
      OMP_PIN_VERSION: cleanupVersion,
      OMP_PIN_BUN_VERSION: "1.4.0",
      OMP_PIN_NATIVE_TARBALL_SHA256: "tarball",
      OMP_PIN_NATIVE_BINARY_SHA256: "binary",
      OMP_QUAL_NATIVE_FIXTURE: join(home, "native-fixture"),
      OMP_QUAL_BUILD_LOG: join(home, "build.log"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    cleanup.exited,
    new Response(cleanup.stdout).text(),
    new Response(cleanup.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test.skipIf(!POSIX)("Mac preflight rejects a stale Bun before staging any lane", async () => {
  const result = await runHarness(`
set -euo pipefail
source "$1"
need_command() { :; }
remote() { eval "$(cat)"; }
bun() { printf '0.0.0\\n'; }
PW=""
preflight
printf 'LANE_REACHED\\n'
`, [], environment("a".repeat(64)));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Mac qualification requires Bun");
  expect(result.stderr).toContain("found 0.0.0");
  expect(result.stdout).not.toContain("LANE_REACHED");
});

test.skipIf(!POSIX)("Mac reboot keeps the sudo password in NUL-framed SSH stdin", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-reboot-secret-"));
  const argvPath = join(temporaryRoot, "argv");
  const stdinPath = join(temporaryRoot, "stdin");
  const harness = `
set -euo pipefail
source "$1"
ssh() {
  printf '%s\n' "$*" >"$ARGV_CAPTURE"
  cat >"$STDIN_CAPTURE"
}
issue_reboot
`;
  try {
    const result = await runHarness(harness, [], {
      ...environment("a".repeat(64)),
      ARGV_CAPTURE: argvPath,
      STDIN_CAPTURE: stdinPath,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const argv = await readFile(argvPath, "utf8");
    const stdin = await readFile(stdinPath);
    expect(argv).not.toContain(sudoPassword);
    expect(argv).not.toContain("shutdown -r now");
    expect(stdin.indexOf(Buffer.from(sudoPassword))).toBeGreaterThanOrEqual(0);
    expect(stdin.indexOf(Buffer.from("shutdown -r now"))).toBeGreaterThanOrEqual(0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
test.skipIf(!POSIX)("bundle scan keeps readiness token bytes out of subprocess argv", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-bundle-argv-"));
  const fakeBin = join(temporaryRoot, "bin");
  const fakePython = join(fakeBin, "python3");
  const tokenPath = join(temporaryRoot, "readiness-token");
  const bundlePath = join(temporaryRoot, "doctor.tar");
  const argvPath = join(temporaryRoot, "python-argv");
  const token = "readiness-token-'quote-argv-canary";
  const resolution = Bun.spawnSync(["python3", "-c", "import sys; print(sys.executable)"], { stdout: "pipe" });
  if (resolution.exitCode !== 0) throw new Error("python3 is required for this regression");
  const realPython = Buffer.from(resolution.stdout).toString("utf8").trim();
  await mkdir(fakeBin, { recursive: true });
  await writeFile(tokenPath, token);
  await writeFile(bundlePath, `prefix:${token}:suffix`);
  await writeFile(
    fakePython,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >\"$ARGV_CAPTURE\"\nexec \"$REAL_PYTHON\" \"$@\"\n",
  );
  await chmod(fakePython, 0o755);
  try {
    const result = await runHarness('source "$1"; count_file_occurrences "$2" "$3"', [tokenPath, bundlePath], {
      ...environment("a".repeat(64)),
      ARGV_CAPTURE: argvPath,
      REAL_PYTHON: realPython,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "1\n", stderr: "" });
    const argv = await readFile(argvPath, "utf8");
    expect(argv).not.toContain(token);
    expect(argv).toContain(tokenPath);
    expect(argv).toContain(bundlePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
test.skipIf(!POSIX)("Mac OMP cleanup removes a custom safe session directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-custom-session-"));
  const sessionLabel = "stable-custom-session.21";
  const customSession = join(temporaryRoot, sessionLabel);
  await mkdir(customSession, { recursive: true });
  await writeFile(join(customSession, "session-state"), "synthetic");
  try {
    const cleanup = await runOmpCleanup(temporaryRoot, sessionLabel);
    expect({ exitCode: cleanup.exitCode, stderr: cleanup.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(cleanup.stdout).toContain('"liveOmpHosts":0');
    expect(await Bun.file(join(customSession, "session-state")).exists()).toBe(false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac OMP cleanup removes its private runtime without touching an unrelated OMP link", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-runtime-cleanup-"));
  const paths = cleanupPaths(temporaryRoot);
  const replacementTarget = join(temporaryRoot, "unrelated", "omp");
  try {
    await Promise.all([
      mkdir(paths.source, { recursive: true }),
      mkdir(dirname(paths.binary), { recursive: true }),
      mkdir(dirname(paths.symlink), { recursive: true }),
    ]);
    await writeFile(paths.sourceMarker, "owned source");
    await writeFile(paths.binary, "owned binary");
    await symlink(replacementTarget, paths.symlink);
    const cleanup = await runOmpCleanup(temporaryRoot);
    expect(cleanup.exitCode).toBe(0);
    expect(JSON.parse(cleanup.stdout)).toEqual({ liveOmpHosts: 0, binaryPresent: false, sourcePresent: false });
    expect(await Bun.file(paths.binary).exists()).toBe(false);
    expect(await Bun.file(paths.sourceMarker).exists()).toBe(false);
    expect(await pathEntryExists(paths.symlink)).toBe(true);
    expect(await readlink(paths.symlink)).toBe(replacementTarget);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac OMP cleanup refuses to claim success while discovery still names a live host", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-live-host-cleanup-"));
  const discovery = join(temporaryRoot, ".omp", "run", "collab-hosts");
  try {
    await mkdir(discovery, { recursive: true });
    const entry = join(discovery, "qualification.json");
    await writeFile(entry, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const cleanup = await runOmpCleanup(temporaryRoot);
    expect(cleanup.exitCode).toBe(1);
    expect(JSON.parse(cleanup.stdout).liveOmpHosts).toBe(1);
    expect(await Bun.file(entry).exists()).toBe(true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac artifact verification rejects bytes outside the orchestrator digest", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-artifact-digest-"));
  const archive = join(temporaryRoot, "candidate.tar");
  const bytes = "candidate-runtime-bytes";
  const expected = sha256(bytes);
  await writeFile(archive, bytes);
  const harness = 'source "$1"; verified_archive_sha256 "$2"';
  try {
    const accepted = await runHarness(harness, [archive], environment(expected));
    expect(accepted).toEqual({ exitCode: 0, stdout: expected, stderr: "" });

    const rejected = await runHarness(harness, [archive], environment("0".repeat(64)));
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("differs from the orchestrator-verified candidate");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
