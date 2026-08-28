import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    OMP_MAC_TAG: "v0.2.0-prealpha.21",
    OMP_MAC_PREVIOUS_TAG: "v0.1.0",
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
test.skipIf(!POSIX)("bundle scan keeps publisher token bytes out of subprocess argv", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-bundle-argv-"));
  const fakeBin = join(temporaryRoot, "bin");
  const fakePython = join(fakeBin, "python3");
  const tokenPath = join(temporaryRoot, "publisher-token");
  const bundlePath = join(temporaryRoot, "doctor.tar");
  const argvPath = join(temporaryRoot, "python-argv");
  const token = "publisher-token-'quote-argv-canary";
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
test.skipIf(!POSIX)("Mac doctor bundle helper passes an explicit output option", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-doctor-bundle-"));
  const fakeBin = join(temporaryRoot, "bin");
  const fakeBun = join(fakeBin, "bun");
  const argvPath = join(temporaryRoot, "bun-argv");
  const bundlePath = join(temporaryRoot, "doctor.tar");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    fakeBun,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$ARGV_CAPTURE"
[ "$1" = synthetic-cli ]
[ "$2" = doctor ]
[ "$3" = --bundle ]
[ "$4" = --output ]
printf synthetic-bundle >"$5"
`,
  );
  await chmod(fakeBun, 0o755);
  try {
    const result = await runHarness('source "$1"; create_doctor_bundle "$2" "$3"', ["synthetic-cli", bundlePath], {
      ...environment("a".repeat(64)),
      ARGV_CAPTURE: argvPath,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await readFile(argvPath, "utf8")).trim().split("\n")).toEqual([
      "synthetic-cli",
      "doctor",
      "--bundle",
      "--output",
      bundlePath,
    ]);
    expect(await Bun.file(bundlePath).text()).toBe("synthetic-bundle");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac OMP cleanup forwards and removes a custom safe session directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-custom-session-"));
  const stdinPath = join(temporaryRoot, "stdin");
  const sessionLabel = "stable-custom-session.21";
  const customSession = join(temporaryRoot, sessionLabel);
  await mkdir(customSession, { recursive: true });
  await writeFile(join(customSession, "session-state"), "synthetic");
  const forwardingHarness = `
set -euo pipefail
source "$1"
scp() { :; }
ssh() { cat >"$STDIN_CAPTURE"; }
lane_omp_clean
`;
  try {
    const forwarded = await runHarness(forwardingHarness, [], {
      ...environment("a".repeat(64)),
      OMP_MAC_SESSION_LABEL: sessionLabel,
      STDIN_CAPTURE: stdinPath,
    });
    expect(forwarded.exitCode).toBe(0);
    const framed = (await readFile(stdinPath)).toString("utf8").split("\0");
    expect(framed[11]).toBe(sessionLabel);
    expect(framed[12]).toContain('OMP_QUAL_SESSION_LABEL="$SESSION_LABEL"');
    expect(framed[12]).toContain('qualify-macos-omp.sh" clean');

    const cleanup = Bun.spawn(["/bin/bash", ompScriptPath, "clean"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: temporaryRoot,
        OMP_QUAL_GATEWAY_ROOT: join(temporaryRoot, "gateway"),
        OMP_QUAL_SESSION_LABEL: sessionLabel,
        OMP_PIN_SOURCE_COMMIT: "source",
        OMP_PIN_PATCHED_TREE: "tree",
        OMP_PIN_VERSION: "17.4.1",
        OMP_PIN_BUN_VERSION: "1.3.14",
        OMP_PIN_NATIVE_TARBALL_SHA256: "tarball",
        OMP_PIN_NATIVE_BINARY_SHA256: "binary",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      cleanup.exited,
      new Response(cleanup.stdout).text(),
      new Response(cleanup.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain('\"patchedOmpProcessCount\":0');
    expect(await Bun.file(join(customSession, "session-state")).exists()).toBe(false);
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
