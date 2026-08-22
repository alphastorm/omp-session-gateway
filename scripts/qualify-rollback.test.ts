import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const POSIX = process.platform !== "win32";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test.skipIf(!POSIX)("rollback cleanup succeeds when no LaunchAgent is loaded", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-rollback-clean-test-"));
  const qualificationRoot = join(temporaryRoot, "qualification");
  await mkdir(join(qualificationRoot, "stale-run"), { recursive: true });

  try {
    const child = Bun.spawn(["/bin/bash", "scripts/qualify-rollback.sh", "clean"], {
      cwd: repositoryRoot,
      env: { ...process.env, OMP_ROLLBACK_QUAL_BASE: qualificationRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`${qualificationRoot} removed`);
    expect(await Bun.file(qualificationRoot).exists()).toBe(false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
