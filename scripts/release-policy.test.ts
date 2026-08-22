import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { assertStableReleaseQualification, releasePolicy } from "./release-policy.ts";

const VERSION = "0.1.0";
const qualifiedManifest = () => ({
  $schema: "./schemas/stable-release.schema.json",
  schemaVersion: 1,
  version: VERSION,
  releaseTag: "v0.1.0",
  status: "qualified",
  candidateTag: "v0.1.0-prealpha.21",
  candidateSourceCommit: "b".repeat(40),
  candidateArchiveSha256: "c".repeat(64),
  runtimeByteComparison: "passed",
  evidence: {
    debian: "passed",
    macos: "passed",
    android: "passed",
    ompPublication: "passed",
    provenance: "passed",
    secretSinks: "passed",
  },
  approvedAt: "2026-08-22T00:00:00.000Z",
});

describe("release tag policy", () => {
  test("publishes only the bare version as stable and latest", () => {
    expect(releasePolicy("v0.1.0", VERSION)).toEqual({
      channel: "stable",
      prerelease: false,
      latest: true,
    });
  });

  test("keeps every engineering, alpha, and beta shape out of Latest", () => {
    const expected = [
      ["v0.1.0-prealpha.1", "pre-alpha"],
      ["v0.1.0-prealpha.23", "pre-alpha"],
      ["v0.1.0-alpha", "alpha"],
      ["v0.1.0-alpha.2", "alpha"],
      ["v0.1.0-beta", "beta"],
      ["v0.1.0-beta.7", "beta"],
      ["provenance-test-v0.1.0.12", "pre-alpha"],
    ] as const;
    for (const [tag, channel] of expected) {
      expect(releasePolicy(tag, VERSION)).toEqual({ channel, prerelease: true, latest: false });
    }
  });

  test("rejects unknown, ambiguous, zero-indexed, and cross-version tags", () => {
    for (const tag of [
      "",
      "v0.1.0-rc.1",
      "v0.1.0-prealpha.0",
      "v0.1.0-prealpha.01",
      "v0.1.0-alpha.0",
      "v0.1.0-beta.0",
      "v0.1.0-stable",
      "v0.1.1",
      "V0.1.0",
      "v0.1.0 ",
    ]) {
      expect(() => releasePolicy(tag, VERSION)).toThrow(/^tag must be /);
    }
  });

  test("rejects a package version whose dots could widen tag matching", () => {
    for (const version of ["0.1", "0.1.0-beta", "0x1x0", "", " 0.1.0"]) {
      expect(() => releasePolicy("v0.1.0", version)).toThrow(/^package version must be numeric major\.minor\.patch/);
    }
  });

  test("refuses stable publication until every commit-bound qualification field passes", () => {
    const pending = qualifiedManifest();
    pending.status = "pending";
    expect(() => assertStableReleaseQualification(pending, "v0.1.0", VERSION)).toThrow(
      "stable release qualification is pending",
    );
    const incomplete = qualifiedManifest();
    incomplete.evidence.android = "pending";
    expect(() => assertStableReleaseQualification(incomplete, "v0.1.0", VERSION)).toThrow(
      "stable release evidence is incomplete",
    );
  });

  test("repository manifest enables only the exact qualified stable candidate", async () => {
    const manifest: unknown = await Bun.file(new URL("../STABLE_RELEASE.lock.json", import.meta.url)).json();
    expect(() => assertStableReleaseQualification(manifest, "v0.1.0", VERSION)).not.toThrow();
    expect(manifest).toMatchObject({
      status: "qualified",
      candidateTag: "v0.1.0-prealpha.23",
      candidateSourceCommit: "434cddc443335d6da6476b43564db8230365e6fc",
      candidateArchiveSha256: "f98bad0ce2ae20d3892e560069b2fbfc4ab6d084a403b6aa57e41c628c25ce98",
      runtimeByteComparison: "passed",
    });
  });

  test("CLI emits stable GitHub environment values only with a qualified manifest", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stable-release-policy-"));
    try {
      const manifestPath = join(temporaryRoot, "qualification.json");
      await writeFile(manifestPath, JSON.stringify(qualifiedManifest()));
      const subprocess = Bun.spawn(
        [process.execPath, "scripts/release-policy.ts", "v0.1.0", VERSION, manifestPath],
        {
          cwd: new URL("..", import.meta.url).pathname,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(subprocess.stdout).text();
      expect(await subprocess.exited).toBe(0);
      expect(output).toBe("OMP_RELEASE_CHANNEL=stable\nRELEASE_IS_PRERELEASE=false\nRELEASE_IS_LATEST=true\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
