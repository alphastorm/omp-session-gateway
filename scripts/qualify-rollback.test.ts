import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test.skipIf(!POSIX)("rollback consumes preloaded verified assets without GitHub authentication", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-rollback-preload-test-"));
  const tag = "v0.2.0-prealpha.21";
  const artifactRoot = join(temporaryRoot, "artifacts");
  const tagRoot = join(artifactRoot, tag);
  const destination = join(temporaryRoot, "destination");
  const bin = join(temporaryRoot, "bin");
  const archiveName = "omp-session-gateway-0.2.0-bun.tar";
  const archive = Buffer.alloc(1024);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const ghMarker = join(temporaryRoot, "gh-called");
  await Promise.all([mkdir(tagRoot, { recursive: true }), mkdir(bin)]);
  await Promise.all([
    writeFile(join(tagRoot, archiveName), archive),
    writeFile(join(tagRoot, `${archiveName}.sigstore.json`), "synthetic bundle"),
    writeFile(join(tagRoot, "SHA256SUMS"), `${archiveDigest}  ${archiveName}\n`),
    writeFile(join(tagRoot, "SHA256SUMS.sigstore.json"), "synthetic bundle"),
    writeFile(join(bin, "cosign"), "#!/bin/bash\nexit 0\n"),
    writeFile(join(bin, "gh"), `#!/bin/bash\ntouch "${ghMarker}"\nexit 99\n`),
  ]);
  await Promise.all([chmod(join(bin, "cosign"), 0o700), chmod(join(bin, "gh"), 0o700)]);

  try {
    const child = Bun.spawn(
      ["/bin/bash", "-c", 'source "$1"; fetch_tag "$2" "$3"', "test", join(repositoryRoot, "scripts/qualify-rollback.sh"), tag, destination],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          OMP_ROLLBACK_ARTIFACT_ROOT: artifactRoot,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(await Bun.file(ghMarker).exists()).toBe(false);
    expect(await Bun.file(join(destination, archiveName)).exists()).toBe(true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
