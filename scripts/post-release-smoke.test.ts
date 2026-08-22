import { describe, expect, test } from "bun:test";
import { isProtectedLabel } from "./acceptance-target.ts";
import { parseAndroidCollabSmokeArgs } from "./android-collab-smoke.ts";
import {
  assertFixtureOwnership,
  assertWebApkActiveTask,
  assertReleaseArchiveIdentity,
  createSmokeLabel,
  findWebApkForHost,
  formatCommandFailure,
  parsePostReleaseSmokeArgs,
  releaseAssetNames,
  unrelatedServeSnapshot,
  selectAdbDevice,
} from "./post-release-smoke.ts";

const SOURCE_COMMIT = "07ba8be884c268375890d50b1a6af51f22bdb16a";
const ARCHIVE_SHA256 = "a".repeat(64);

describe("post-release smoke arguments", () => {
  test("defaults to the package's bare stable tag and accepts bounded rerun controls", () => {
    expect(parsePostReleaseSmokeArgs([], "0.1.0")).toEqual({
      tag: "v0.1.0",
      repository: "alphastorm/omp-session-gateway",
      forceReinstall: false,
      rebuildOmp: false,
      planOnly: false,
    });
    expect(
      parsePostReleaseSmokeArgs(
        [
          "--tag",
          "v0.1.0",
          "--repo",
          "alphastorm/omp-session-gateway",
          "--archive-sha256",
          ARCHIVE_SHA256,
          "--force-reinstall",
          "--rebuild-omp",
          "--plan",
        ],
        "0.1.0",
      ),
    ).toEqual({
      tag: "v0.1.0",
      repository: "alphastorm/omp-session-gateway",
      expectedArchiveSha256: ARCHIVE_SHA256,
      forceReinstall: true,
      rebuildOmp: true,
      planOnly: true,
    });
  });

  test("rejects prereleases, mismatched versions, malformed digests, and unknown options", () => {
    expect(() => parsePostReleaseSmokeArgs(["--tag", "v0.1.0-beta.1"], "0.1.0")).toThrow("bare stable tag");
    expect(() => parsePostReleaseSmokeArgs(["--tag", "v0.2.0"], "0.1.0")).toThrow("package.json version");
    expect(() => parsePostReleaseSmokeArgs(["--archive-sha256", "A".repeat(64)], "0.1.0")).toThrow(
      "lowercase hexadecimal",
    );
    expect(() => parsePostReleaseSmokeArgs(["--skip-android"], "0.1.0")).toThrow("unknown option");
  });
});

describe("published release binding", () => {
  test("requires the exact six stable assets", () => {
    const names = releaseAssetNames("0.1.0");
    expect(names.archive).toBe("omp-session-gateway-0.1.0-bun.tar");
    expect(names.sbom).toBe("omp-session-gateway-0.1.0.spdx.json");
    expect(names.attested).toEqual([names.archive, names.sbom, "SHA256SUMS"]);
    expect(names.all).toHaveLength(6);
    expect(names.all).toContain("SHA256SUMS.sigstore.json");
  });

  test("binds archive identity to stable source, runtime, and qualification", () => {
    const identity = {
      product: "OMP Session Gateway",
      version: "0.1.0",
      sourceCommit: SOURCE_COMMIT,
      runtime: "Bun >=1.3.14",
      qualification: "qualified stable 0.1",
    };
    expect(() => assertReleaseArchiveIdentity(identity, "0.1.0", SOURCE_COMMIT, "1.3.14")).not.toThrow();
    expect(() => assertReleaseArchiveIdentity({ ...identity, sourceCommit: "0".repeat(40) }, "0.1.0", SOURCE_COMMIT, "1.3.14")).toThrow(
      "does not match",
    );
    expect(() => assertReleaseArchiveIdentity({ ...identity, runtime: "Bun >=1.4.0" }, "0.1.0", SOURCE_COMMIT, "1.3.14")).toThrow(
      "does not match",
    );
  });

  test("redacts command output unless the caller explicitly marks it safe", () => {
    const syntheticSecret = "qualification-capability-never-log-this";
    const redacted = formatCommandFailure("Android smoke", 1, syntheticSecret, "", false);
    expect(redacted).toBe("Android smoke failed with exit 1");
    expect(redacted).not.toContain(syntheticSecret);
    expect(formatCommandFailure("artifact verification", 1, "", "signature mismatch", true)).toContain(
      "signature mismatch",
    );
  });
});

describe("disposable fixture safety", () => {
  test("generates an unprotected owned label", () => {
    const label = createSmokeLabel("0.1.0", "deadbeef");
    expect(label).toBe("omp-post-release-0-1-0-deadbeef");
    expect(isProtectedLabel(label)).toBe(false);
    expect(() => createSmokeLabel("0.1.0", "../unsafe")).toThrow("nonce");
  });

  test("requires the exact per-run marker before recursive cleanup", () => {
    expect(() => assertFixtureOwnership("run-id\n", "run-id")).not.toThrow();
    expect(() => assertFixtureOwnership("somebody-else\n", "run-id")).toThrow("refusing directory cleanup");
  });

  test("preserves every unrelated Tailscale Serve mapping", () => {
    const baseline = {
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } },
        "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:14317" } } },
      },
    };
    const replacedTarget = {
      ...baseline,
      TCP: { ...baseline.TCP, "443": { HTTPS: false } },
      Web: {
        ...baseline.Web,
        "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
      },
    };
    expect(unrelatedServeSnapshot(replacedTarget, "gateway.example.ts.net", 443)).toBe(
      unrelatedServeSnapshot(baseline, "gateway.example.ts.net", 443),
    );
    const changedUnrelated = {
      ...baseline,
      Web: {
        ...baseline.Web,
        "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
      },
    };
    expect(unrelatedServeSnapshot(changedUnrelated, "gateway.example.ts.net", 443)).not.toBe(
      unrelatedServeSnapshot(baseline, "gateway.example.ts.net", 443),
    );
  });
});

describe("physical Android release target", () => {
  test("parses exact app binding and explicit old-fixture acknowledgement", () => {
    expect(
      parseAndroidCollabSmokeArgs([
        "https://gateway.example.ts.net",
        "omp-post-release-0-1-0-deadbeef",
        "--expected-app-asset",
        "/assets/app.abc123.js",
        "--disposable-target",
      ]),
    ).toEqual({
      origin: "https://gateway.example.ts.net",
      label: "omp-post-release-0-1-0-deadbeef",
      expectedAppAsset: "/assets/app.abc123.js",
      allowDisposableTarget: true,
    });
  });

  test("rejects protected targets and non-origin URLs before touching the device", () => {
    expect(() => parseAndroidCollabSmokeArgs(["https://gateway.example.ts.net", "relay-soak", "--disposable-target"])).toThrow(
      "protected",
    );
    expect(() => parseAndroidCollabSmokeArgs(["http://gateway.example.ts.net", "omp-disposable"])).toThrow("HTTPS origin");
    expect(() => parseAndroidCollabSmokeArgs(["https://gateway.example.ts.net/path", "omp-disposable"])).toThrow(
      "without a path",
    );
  });

  test("finds one WebAPK bound to the exact gateway authority", () => {
    const packages = ["package:org.chromium.webapk.owned_v2", "package:org.chromium.webapk.other_v2"].join("\n");
    const dumps = {
      "org.chromium.webapk.owned_v2": 'Authority: "gateway.example.ts.net": -1',
      "org.chromium.webapk.other_v2": 'Authority: "other.example.ts.net": -1',
    };
    expect(findWebApkForHost(packages, dumps, "gateway.example.ts.net")).toBe("org.chromium.webapk.owned_v2");
    expect(findWebApkForHost(packages, dumps, "missing.example.ts.net")).toBeUndefined();
    expect(() =>
      findWebApkForHost(
        packages,
        {
          ...dumps,
          "org.chromium.webapk.other_v2": 'Authority: "gateway.example.ts.net": -1',
        },
        "gateway.example.ts.net",
      ),
    ).toThrow("multiple installed WebAPKs");
  });

  test("refuses a missing or ambiguous adb device before release effects", () => {
    const oneDevice = "List of devices attached\nPIXEL_SERIAL\tdevice product:pixel model:Pixel transport_id:1\n";
    expect(selectAdbDevice(oneDevice)).toBe("PIXEL_SERIAL");
    expect(selectAdbDevice(oneDevice, "PIXEL_SERIAL")).toBe("PIXEL_SERIAL");
    expect(() => selectAdbDevice("List of devices attached\n\n")).toThrow("exactly one attached");
    expect(() =>
      selectAdbDevice("List of devices attached\nFIRST\tdevice\nSECOND\tdevice\n"),
    ).toThrow("exactly one attached");
    expect(() => selectAdbDevice(oneDevice, "OTHER_SERIAL")).toThrow("configured Android device");
  });

  test("requires the exact WebAPK to own the focused standalone task", () => {
    const packageName = "org.chromium.webapk.owned_v2";
    const active = [
      "topResumedActivity=ActivityRecord{abc u0 com.android.chrome/SameTaskWebApkActivity t1}",
      "topDisplayFocusedRootTask=Task{abc A=10466:" + packageName + "}",
    ].join("\n");
    expect(() => assertWebApkActiveTask(active, packageName)).not.toThrow();
    expect(() => assertWebApkActiveTask("topResumedActivity=com.android.chrome/Main", packageName)).toThrow(
      "active standalone task",
    );
  });
});
