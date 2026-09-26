import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { assertStableReleaseQualification, releasePolicy, releaseVersion } from "./release-policy.ts";

const VERSION = "0.2.1";
const qualifiedManifest = () => ({
  $schema: "./schemas/stable-release.schema.json",
  schemaVersion: 1,
  version: VERSION,
  releaseTag: "v0.2.1",
  previousTag: "v0.2.0",
  status: "qualified",
  candidateTag: "v0.2.1-prealpha.21",
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
    expect(releasePolicy("v0.2.1", VERSION)).toEqual({
      channel: "stable",
      prerelease: false,
      latest: true,
    });
  });

  test("keeps every engineering, alpha, and beta shape out of Latest", () => {
    const expected = [
      ["v0.2.1-prealpha.1", "pre-alpha"],
      ["v0.2.1-prealpha.23", "pre-alpha"],
      ["v0.2.1-alpha", "alpha"],
      ["v0.2.1-alpha.2", "alpha"],
      ["v0.2.1-beta", "beta"],
      ["v0.2.1-beta.7", "beta"],
      ["provenance-test-v0.2.1.12", "pre-alpha"],
    ] as const;
    for (const [tag, channel] of expected) {
      expect(releasePolicy(tag, VERSION)).toEqual({ channel, prerelease: true, latest: false });
    }
  });

  test("rejects unknown, ambiguous, zero-indexed, and cross-version tags", () => {
    for (const tag of [
      "",
      "v0.2.1-rc.1",
      "v0.2.1-prealpha.0",
      "v0.2.1-prealpha.01",
      "v0.2.1-alpha.0",
      "v0.2.1-beta.0",
      "v0.2.1-stable",
      "v0.2.2",
      "V0.2.1",
      "v0.2.1 ",
    ]) {
      expect(() => releasePolicy(tag, VERSION)).toThrow(/^tag must be /);
    }
  });

  test("rejects a package version whose dots could widen tag matching", () => {
    for (const version of ["0.1", "0.1.0-beta", "0x1x0", "", " 0.1.0"]) {
      expect(() => releasePolicy("v0.1.0", version)).toThrow(/^package version must be numeric major\.minor\.patch/);
    }
  });

  test("a tag installs as its bare package version, whatever its channel", () => {
    // The Windows lane once expected v0.6.0-prealpha.1 to install as "0.6.0-prealpha.1".
    for (const tag of ["v0.2.1", "v0.2.1-prealpha.1", "v0.2.1-alpha", "v0.2.1-beta.7", "provenance-test-v0.2.1.12"]) {
      expect(releaseVersion(tag)).toBe(VERSION);
    }
    for (const tag of ["", "0.2.1", "v0.2", "v0.2.1-rc.1", "v0.2.1-prealpha.0", "V0.2.1"]) {
      expect(() => releaseVersion(tag)).toThrow();
    }
  });

  test("refuses stable publication until every commit-bound qualification field passes", () => {
    const pending = qualifiedManifest();
    pending.status = "pending";
    expect(() => assertStableReleaseQualification(pending, "v0.2.1", VERSION)).toThrow(
      "stable release qualification is pending",
    );
    const incomplete = qualifiedManifest();
    incomplete.evidence.android = "pending";
    expect(() => assertStableReleaseQualification(incomplete, "v0.2.1", VERSION)).toThrow(
      "stable release evidence is incomplete",
    );
    const missingPredecessor = qualifiedManifest();
    Reflect.deleteProperty(missingPredecessor, "previousTag");
    expect(() => assertStableReleaseQualification(missingPredecessor, "v0.2.1", VERSION)).toThrow(
      "unexpected fields",
    );
  });

  test("a complete historical approval cannot authorize a different release", () => {
    expect(() => assertStableReleaseQualification(qualifiedManifest(), "v0.3.0", "0.3.0")).toThrow();
    const wrongCandidate = qualifiedManifest();
    wrongCandidate.candidateTag = "v0.3.0-prealpha.1";
    expect(() => assertStableReleaseQualification(wrongCandidate, "v0.2.1", VERSION)).toThrow();
  });

  test("from 0.6.0 stable approval also requires passed Windows and background Push evidence", () => {
    const campaign = () => {
      const manifest = {
        ...qualifiedManifest(),
        version: "0.6.0",
        releaseTag: "v0.6.0",
        previousTag: "v0.5.3",
        candidateTag: "v0.6.0-prealpha.1",
      };
      return { ...manifest, evidence: { ...manifest.evidence, windows: "passed", androidPush: "passed" } };
    };
    expect(() => assertStableReleaseQualification(campaign(), "v0.6.0", "0.6.0")).not.toThrow();
    const sixLanes = { ...campaign(), evidence: qualifiedManifest().evidence };
    expect(() => assertStableReleaseQualification(sixLanes, "v0.6.0", "0.6.0")).toThrow("unexpected fields");
    const pendingPush = campaign();
    pendingPush.evidence.androidPush = "pending";
    expect(() => assertStableReleaseQualification(pendingPush, "v0.6.0", "0.6.0")).toThrow(
      "stable release evidence is incomplete",
    );
    // An earlier release keeps the six lanes it was actually qualified with.
    const earlier = { ...qualifiedManifest(), evidence: campaign().evidence };
    expect(() => assertStableReleaseQualification(earlier, "v0.2.1", VERSION)).toThrow("unexpected fields");
  });

  test("from 0.6.2 stable approval also requires passed real-device cloud evidence", () => {
    const campaign = () => {
      const manifest = {
        ...qualifiedManifest(),
        version: "0.6.2",
        releaseTag: "v0.6.2",
        previousTag: "v0.6.1",
        candidateTag: "v0.6.2-prealpha.1",
      };
      return { ...manifest, evidence: { ...manifest.evidence, windows: "passed", androidPush: "passed", deviceCloud: "passed" } };
    };
    expect(() => assertStableReleaseQualification(campaign(), "v0.6.2", "0.6.2")).not.toThrow();
    const withoutCloud = campaign();
    Reflect.deleteProperty(withoutCloud.evidence, "deviceCloud");
    expect(() => assertStableReleaseQualification(withoutCloud, "v0.6.2", "0.6.2")).toThrow("unexpected fields");
    const pendingCloud = campaign();
    pendingCloud.evidence.deviceCloud = "pending";
    expect(() => assertStableReleaseQualification(pendingCloud, "v0.6.2", "0.6.2")).toThrow(
      "stable release evidence is incomplete",
    );
    // v0.6.1 was qualified before the lane existed and keeps the eight lanes it actually passed.
    const v061 = { ...campaign(), version: "0.6.1", releaseTag: "v0.6.1", previousTag: "v0.6.0", candidateTag: "v0.6.1-prealpha.1" };
    expect(() => assertStableReleaseQualification(v061, "v0.6.1", "0.6.1")).toThrow("unexpected fields");
  });

  test("CLI emits stable GitHub environment values only with a qualified manifest", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stable-release-policy-"));
    try {
      const manifestPath = join(temporaryRoot, "qualification.json");
      await writeFile(manifestPath, JSON.stringify(qualifiedManifest()));
      const subprocess = Bun.spawn(
        [process.execPath, "scripts/release-policy.ts", "v0.2.1", VERSION, manifestPath],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
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
