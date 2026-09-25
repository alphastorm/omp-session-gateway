import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarArchive } from "./build-release.ts";
import type { ArchiveFile } from "./build-release.ts";
import { compareReleaseArchives, compareReleaseRuntime } from "./release-runtime-compare.ts";

const ROOT = "omp-session-gateway-9.9.9-bun";
const member = (path: string, content: string, executable = false): ArchiveFile => ({
  path: `${ROOT}/${path}`,
  content: Buffer.from(content),
  executable,
});
const cli = member("apps/gateway/src/cli.js", "#!/usr/bin/env bun\nsynthetic cli\n", true);
const shell = member("apps/web/dist/index.html", "<!doctype html>synthetic shell\n");
const metadata = ["release-info.json", "SBOM.spdx.json", "STABLE_RELEASE.lock.json", "schemas/stable-release.schema.json"].map(
  path => member(path, `{"channel":"prealpha","path":"${path}"}\n`),
);
const candidate = [cli, shell, ...metadata];
const differing = (stable: readonly ArchiveFile[]) =>
  compareReleaseRuntime(createTarArchive(candidate), createTarArchive(stable)).differing;

test("a stable build that rewrites only promotion metadata matches its candidate", () => {
  const promoted = metadata.map(entry => ({ ...entry, content: Buffer.from('{"channel":"stable"}\n') }));
  expect(compareReleaseRuntime(createTarArchive(candidate), createTarArchive([cli, shell, ...promoted]))).toEqual({
    compared: 2,
    differing: [],
  });
});

test("changed bytes, a lost executable mode, and a missing or extra member are each reported", () => {
  expect(differing([{ ...cli, content: Buffer.from("#!/usr/bin/env bun\nchanged\n") }, shell, ...metadata])).toEqual([cli.path]);
  expect(differing([{ ...cli, executable: false }, shell, ...metadata])).toEqual([cli.path]);
  expect(differing([cli, ...metadata])).toEqual([shell.path]);
  const extra = member("apps/web/dist/extra.js", "synthetic\n");
  expect(differing([...candidate, extra])).toEqual([extra.path]);
  // Promotion metadata may change content but never disappear.
  expect(differing(candidate.filter(entry => entry !== metadata[1]))).toEqual([metadata[1]!.path]);
});

test("an archive holding an entry the release writer never produces is refused", () => {
  const directoryEntry = createTarArchive([shell]);
  directoryEntry[156] = "5".charCodeAt(0);
  expect(() => compareReleaseRuntime(createTarArchive(candidate), directoryEntry)).toThrow("never produces");
});

test("a candidate archive that is not the qualified digest is refused before comparison", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-gw-runtime-compare-"));
  try {
    const candidateBytes = createTarArchive(candidate);
    const candidatePath = join(directory, "candidate.tar");
    const stablePath = join(directory, "stable.tar");
    await writeFile(candidatePath, candidateBytes);
    await writeFile(stablePath, createTarArchive(candidate));
    const qualified = createHash("sha256").update(candidateBytes).digest("hex");
    expect(await compareReleaseArchives(candidatePath, qualified, stablePath)).toEqual({ compared: 2, differing: [] });
    await expect(compareReleaseArchives(candidatePath, "0".repeat(64), stablePath)).rejects.toThrow("is not the qualified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
