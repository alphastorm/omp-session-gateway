import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const POSIX = process.platform !== "win32";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts/qualify-macos-host.sh");
const sudoPassword = "mac-sudo-'argv-canary";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function environment(archiveSha256: string): Record<string, string | undefined> {
  return {
    ...process.env,
    OMP_MAC_HOST: "synthetic@example.invalid",
    OMP_MAC_TAG: "v0.1.0-prealpha.21",
    OMP_MAC_PREVIOUS_TAG: "v0.1.0-beta.1",
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
