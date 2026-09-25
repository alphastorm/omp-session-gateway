import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedLabel } from "./acceptance-target.ts";
import { parseAndroidCollabSmokeArgs } from "./android-collab-smoke.ts";
import { ANDROID_COLLAB_STAGES } from "./android-stages.ts";
import {
  assertFixtureOwnership,
  assertWebApkActiveTask,
  assertReleaseArchiveIdentity,
  createSmokeLabel,
  enableOmpAutoStart,
  findWebApkForHost,
  isStockOmpBinary,
  type OmpInstall,
  preferStockOmp,
  isWebApkAppTarget,
  formatCommandFailure,
  parseJsonRecord,
  parsePostReleaseSmokeArgs,
  releaseAssetNames,
  unrelatedServeSnapshot,
  selectAdbDevice,
} from "./post-release-smoke.ts";

const SOURCE_COMMIT = "07ba8be884c268375890d50b1a6af51f22bdb16a";
const ARCHIVE_SHA256 = "a".repeat(64);

test.skipIf(process.platform === "win32")("recognizes bare and prefixed OMP banners without admitting older versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-smoke-version-"));
  try {
    await writeFile(join(directory, "omp"), `#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\n' "$OMP_SMOKE_TEST_VERSION"
elif [ "$*" = 'config get collab.autoStart --json' ]; then
  printf '%s\n' '{"value":"control"}'
else
  exit 1
fi
`, { mode: 0o700 });
    const script = `import { inspectOmpInstall } from ${JSON.stringify(new URL("./post-release-smoke.ts", import.meta.url).href)}; console.log(JSON.stringify(await inspectOmpInstall()));`;
    for (const [banner, compatible] of [["18.1.21", true], ["omp/18.1.20", true], ["18.1.19", false]] as const) {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, PATH: directory, OMP_SMOKE_TEST_VERSION: banner },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr);
      expect(JSON.parse(stdout).compatible, banner).toBe(compatible);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("refuses an auto-start write that exits cleanly without persisting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-smoke-autostart-"));
  try {
    // `config set` always exits 0; it persists only when the `writes` marker exists, as a
    // compiled OMP over WinRM once did not.
    const binary = join(directory, "omp");
    await writeFile(binary, `#!/bin/sh
state="$(dirname "$0")/autostart"
if [ "$*" = 'config set collab.autoStart control' ]; then
  if [ -e "$(dirname "$0")/writes" ]; then printf control > "$state"; fi
elif [ "$*" = 'config get collab.autoStart --json' ]; then
  printf '{"value":"%s"}\\n' "$(cat "$state" 2>/dev/null || printf off)"
else
  exit 1
fi
`, { mode: 0o700 });
    await expect(enableOmpAutoStart(binary)).rejects.toThrow("collab.autoStart does not read back as control");
    await writeFile(join(directory, "writes"), "");
    await expect(enableOmpAutoStart(binary)).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("distinguishes stock mainline omp from another product wearing the name", () => {
  // A bun global install resolves the shim to the mainline package entrypoint.
  expect(isStockOmpBinary("/Users/x/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
  expect(isStockOmpBinary("/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
  // The real regression: a Code Mode launcher reports a compatible version banner, so only the
  // resolved path shows it is a different product. Accepting it qualified a release against an
  // agent carrying trusted extensions and a routed config.
  expect(isStockOmpBinary("/Users/x/.local/lib/omp-code-mode/releases/18.2.8-abc/omp-code-mode-launcher")).toBe(false);
  // Near misses must not pass: a lookalike package name or a path merely mentioning the vendor.
  expect(isStockOmpBinary("/Users/x/node_modules/@oh-my-pi/pi-coding-agent-fork/dist/cli.js")).toBe(false);
  expect(isStockOmpBinary("/Users/x/oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(false);
});

describe("stock OMP selection", () => {
  const launcher: OmpInstall = { compatible: true, binary: "/Users/x/.local/bin/omp", version: "18.3.0", binarySha256: "a", stock: false };
  const bunGlobal: OmpInstall = { compatible: true, binary: "/Users/x/.bun/bin/omp", version: "18.1.20", binarySha256: "b", stock: true };

  test("keeps a stock omp on PATH even when Bun's global install is also stock", () => {
    const onPath: OmpInstall = { ...bunGlobal, binary: "/opt/bin/omp", version: "18.3.0", binarySha256: "c" };
    expect(preferStockOmp(onPath, bunGlobal)).toBe(onPath);
  });

  test("uses Bun's global stock install in place of a same-named launcher on PATH", () => {
    // The v0.5.2 smoke's first attempt stopped here: a Code Mode launcher owned `omp` on PATH
    // while stock OMP was already installed globally.
    expect(preferStockOmp(launcher, bunGlobal)).toBe(bunGlobal);
  });

  test("keeps the launcher when no stock alternative exists, so the refusal names it", () => {
    expect(preferStockOmp(launcher, { compatible: false, binary: "/Users/x/.bun/bin/omp" })).toBe(launcher);
  });

  test("uses Bun's global stock install when PATH has no omp at all", () => {
    expect(preferStockOmp({ compatible: false }, bunGlobal)).toBe(bunGlobal);
  });
});

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

  test("surfaces only the last announced vocabulary stage of a withheld lane", () => {
    const syntheticSecret = "qualification-capability-never-log-this";
    const lane = ["android-stage: directory", "android-stage: View", syntheticSecret].join("\n");
    expect(formatCommandFailure("Android smoke", 1, syntheticSecret, lane, false, ANDROID_COLLAB_STAGES)).toBe(
      'Android smoke failed with exit 1 at stage "View"',
    );
    const forged = formatCommandFailure(
      "Android smoke",
      1,
      "",
      `android-stage: View\nandroid-stage: ${syntheticSecret}\n`,
      false,
      ANDROID_COLLAB_STAGES,
    );
    expect(forged).toBe("Android smoke failed with exit 1");
    expect(forged).not.toContain(syntheticSecret);
  });

  test("never quotes a withheld lane's malformed stdout in its parse error", () => {
    const syntheticSecret = "qualificationcapabilityneverlogthis";
    for (const stdout of [syntheticSecret, `{"appAsset": ${syntheticSecret}}`, `${syntheticSecret}\n{}`]) {
      let message = "";
      try {
        parseJsonRecord(stdout, "Android View and Control smoke");
      } catch (error) {
        message = String(error);
      }
      expect(message).toBe("Error: Android View and Control smoke did not return JSON");
    }
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
  test("accepts a WebAPK resuming collaboration rather than the directory title", () => {
    expect(isWebApkAppTarget(
      { type: "page", title: "Ongoing session · omp collab", url: "https://gateway.example.ts.net/client/" },
      "https://gateway.example.ts.net",
    )).toBe(true);
    expect(isWebApkAppTarget(
      { type: "page", title: "OMP Sessions", url: "https://gateway.example.ts.net/" },
      "https://gateway.example.ts.net",
    )).toBe(true);
  });

  test("rejects non-app targets and URLs outside the capability-free application routes", () => {
    const origin = "https://gateway.example.ts.net";
    for (const url of ["not a URL", "https://other.example.ts.net/", `${origin}/api/v1/sessions`, `${origin}/client/?unexpected=1`, `${origin}/client/#unexpected`]) {
      expect(isWebApkAppTarget({ type: "page", title: "OMP Sessions", url }, origin)).toBe(false);
    }
    expect(isWebApkAppTarget({ type: "service_worker", url: `${origin}/` }, origin)).toBe(false);
  });
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
