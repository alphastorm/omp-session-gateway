import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { PRODUCT_VERSION } from "./build-release.ts";
import {
  assertMacBuildOutput,
  assertMacLifecycleOutput,
  assertProtectedFilesUnchanged,
  createReceiptPersister,
  createStableQualificationReceipt,
  executeReceiptLane,
  markMacCleanupRequired,
  parseQualificationPins,
  parseStableQualificationArgs,
  qualifyDebian,
  runStableQualification,
  receiptNeedsMacCleanup,
  validateStableQualificationReceipt,
  type DebianQualificationRuntime,
  type ProtectedFileSnapshot,
  type StablePreflightRuntime,
} from "./stable-qualification.ts";

const TAG = `v${PRODUCT_VERSION}-prealpha.21`;
const PREVIOUS_TAG = "v0.4.0";
const COMMIT = "a".repeat(40);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}

describe("stable qualification arguments", () => {
  test("rejects stable, rc, zero-indexed, and prior-version candidate tags", () => {
    for (const tag of [`v${PRODUCT_VERSION}`, `v${PRODUCT_VERSION}-rc.1`, `v${PRODUCT_VERSION}-prealpha.0`, "v0.3.0-prealpha.25"]) {
      expect(() => parseStableQualificationArgs(["--tag", tag], {})).toThrow("--tag must match");
    }
  });

  test("accepts only the published stable as the rollback predecessor", () => {
    expect(parseStableQualificationArgs(["--tag", TAG, "--previous-tag", PREVIOUS_TAG], {}).previousTag).toBe(
      PREVIOUS_TAG,
    );
    // `v0.3.0` matters here: it was the predecessor for the 0.4.0 campaign, so accepting it now
    // would silently qualify the upgrade and rollback pair against a superseded stable.
    for (const previous of ["v0.1.0", "v0.2.0", "v0.3.0", "v0.2.1-prealpha.1", "v0.4.0-prealpha.1", "v0.2.1", ""]) {
      expect(() => parseStableQualificationArgs(["--tag", TAG, "--previous-tag", previous], {})).toThrow(
        "--previous-tag",
      );
    }
  });

  test("rejects an unbounded relay duration before any external effect", () => {
    expect(() => parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_RELAY_SECONDS: "3601" })).toThrow(
      "must not exceed 3600",
    );
  });

  test("requires the campaign floor while allowing longer bounded relay checks", () => {
    expect(parseStableQualificationArgs(["--tag", TAG], {}).relaySeconds).toBe(1_800);
    for (const duration of ["60", "1799"]) {
      expect(() => parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_RELAY_SECONDS: duration })).toThrow("at least 1800");
    }
    for (const duration of ["1800", "2400", "3600"]) {
      expect(parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_RELAY_SECONDS: duration }).relaySeconds).toBe(Number(duration));
    }
  });

  test("rejects path-special and overlong session labels before host access", () => {
    for (const sessionLabel of [".", "..", "a".repeat(129)]) {
      expect(() =>
        parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_SESSION_LABEL: sessionLabel }),
      ).toThrow("safe single path component");
    }
  });
});

function passedRelayReceipt(durationSeconds = 1_800) {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  const base = Date.now() - 2 * 60 * 60 * 1_000;
  const at = (seconds: number) => new Date(base + seconds * 1_000).toISOString();
  receipt.startedAt = at(0);
  receipt.status = "passed";
  receipt.completedAt = at(3_700);
  receipt.candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  for (const lane of Object.values(receipt.lanes)) {
    Object.assign(lane, { status: "passed", attempts: 1, startedAt: at(1), completedAt: at(3_700) });
  }
  receipt.lanes.relay = {
    status: "passed", attempts: 1, startedAt: at(10), completedAt: at(durationSeconds + 12),
    evidence: {
      startedAt: at(11), completedAt: at(durationSeconds + 11), durationSeconds, transitions: 2, finalPhase: "live",
    },
  };
  receipt.lanes.cleanup.evidence = { gatewayProcesses: 0, gatewayListeners: 0, liveOmpHosts: 0 };
  return receipt;
}

describe("resumed relay qualification proof", () => {
  test.each([
    ["historical sixty-second pass", (receipt: ReturnType<typeof passedRelayReceipt>) => {
      receipt.lanes.relay = passedRelayReceipt(60).lanes.relay;
    }],
    ["missing summary", (receipt: ReturnType<typeof passedRelayReceipt>) => { delete receipt.lanes.relay.evidence; }],
    ["invalid duration", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.durationSeconds = "1800"; }],
    ["incomplete relay", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.finalPhase = "ended"; }],
    ["invalid transitions", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.transitions = -1; }],
    ["invalid timestamp", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.startedAt = "not-a-date"; }],
    ["missing attempt boundary", (receipt: ReturnType<typeof passedRelayReceipt>) => { delete receipt.lanes.relay.completedAt; }],
    ["stale attempt", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.startedAt = receipt.lanes.relay.completedAt!; }],
    ["stale campaign", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.startedAt = receipt.lanes.relay.completedAt!; }],
    ["invented elapsed duration", (receipt: ReturnType<typeof passedRelayReceipt>) => {
      receipt.lanes.relay = passedRelayReceipt(60).lanes.relay;
      receipt.lanes.relay.evidence!.durationSeconds = 1_800;
    }],
  ] as const)("rejects %s before admission without reopening completed cleanup", async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), "stable-relay-resume-"));
    try {
      const receipt = passedRelayReceipt();
      mutate(receipt);
      const path = join(root, "stable-qualification.json");
      await writeFile(path, JSON.stringify(receipt));
      const runtime = await preflightFixture(root);
      let externalProbe = false;
      const guarded = {
        ...runtime,
        output: async (command: readonly string[]) => {
          if (command.join(" ") === "git rev-parse HEAD") return COMMIT;
          externalProbe = true;
          throw new Error("unexpected admission");
        },
        recoverMac: async () => { throw new Error("completed cleanup must not reopen"); },
      };
      await expect(runStableQualification(["--tag", TAG], guarded)).rejects.toThrow("relay evidence");
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.status).toBe("failed");
      expect(persisted.completedAt).toBeUndefined();
      expect(persisted.lanes.relay).toEqual(receipt.lanes.relay);
      expect(persisted.lanes.cleanup).toEqual(receipt.lanes.cleanup);
      expect(externalProbe).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds resume to the requested duration without rejecting longer valid evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-relay-duration-"));
    try {
      const path = join(root, "stable-qualification.json");
      const runtime = await preflightFixture(root, "absent");
      const guarded = { ...runtime, environment: { ...runtime.environment, OMP_STABLE_RELAY_SECONDS: "2400" } };
      await writeFile(path, JSON.stringify(passedRelayReceipt(1_800)));
      await expect(runStableQualification(["--tag", TAG], guarded)).rejects.toThrow("relay evidence");
      for (const duration of [2_400, 3_600]) {
        await writeFile(path, JSON.stringify(passedRelayReceipt(duration)));
        // Valid proof reaches read-only admission, which deliberately stops before any effects.
        await expect(runStableQualification(["--tag", TAG], guarded)).rejects.toThrow("authorized Android");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform === "win32")("rejected resumed relay proof still cleans recorded Mac effects without admission or dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-relay-cleanup-"));
  try {
    const receipt = passedRelayReceipt(60);
    receipt.status = "failed";
    receipt.lanes.cleanup = { status: "pending", attempts: 1 };
    const path = join(root, "stable-qualification.json");
    const bin = join(root, "bin");
    const effects = join(root, "effects");
    await mkdir(bin);
    await mkdir(effects);
    await writeFile(path, JSON.stringify(receipt));
    for (const effect of ["gateway", "serve", "omp", "artifacts"]) await writeFile(join(effects, effect), "recorded effect");
    await writeFile(join(bin, "bash"), [
      "#!/bin/sh",
      '[ "$1" = scripts/qualify-macos-host.sh ] || exit 91',
      'case "$2" in',
      'uninstall) /bin/rm "$FIXTURE_ROOT/effects/gateway"; printf "%s\n" "plist present:                         no" "gui job:                               absent" "gateway pids:                          0" "listeners:                             0";;',
      `omp-clean) /bin/rm "$FIXTURE_ROOT/effects/omp"; echo '{"liveOmpHosts":0,"binaryPresent":false,"sourcePresent":false}';;`,
      '*) exit 92;;',
      "esac",
    ].join("\n"), { mode: 0o700 });
    await writeFile(join(bin, "ssh"), [
      "#!/bin/sh",
      'case "$*" in',
      '*"serve reset"*) /bin/rm "$FIXTURE_ROOT/effects/serve";;',
      '*"rm -rf"*) /bin/rm "$FIXTURE_ROOT/effects/artifacts";;',
      '*) exit 93;;',
      "esac",
    ].join("\n"), { mode: 0o700 });
    const script = `
      import { writeFile } from "node:fs/promises";
      import { runStableQualification } from ${JSON.stringify(join(REPOSITORY_ROOT, "scripts/stable-qualification.ts"))};
      const root = process.env.FIXTURE_ROOT;
      try {
        await runStableQualification(["--tag", ${JSON.stringify(TAG)}], {
          platform: "darwin", arch: "arm64", bunVersion: Bun.version,
          environment: { OMP_STABLE_QUALIFICATION_DIR: root, OMP_STABLE_RELAY_SECONDS: "1800" },
          executable: name => process.env.PATH + "/" + name,
          output: async command => {
            if (command.join(" ") === "git rev-parse HEAD") return ${JSON.stringify(COMMIT)};
            await writeFile(root + "/unexpected-admission", command[0]);
            throw new Error("unexpected admission");
          },
          recoverMac: async () => {
            await writeFile(root + "/recovered", "yes");
            return { sshDestination: "fixture.invalid", sudoPassword: "fixture" };
          },
        });
        process.exitCode = 2;
      } catch (error) {
        console.log(JSON.stringify({ rejected: error.message }));
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, PATH: bin, FIXTURE_ROOT: root },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("relay evidence");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.status).toBe("failed");
    expect(persisted.lanes.relay).toEqual(receipt.lanes.relay);
    expect(persisted.lanes.cleanup).toMatchObject({ status: "passed", attempts: 2, evidence: { gatewayProcesses: 0, gatewayListeners: 0, liveOmpHosts: 0 } });
    expect(await readdir(effects)).toEqual([]);
    expect(await readFile(join(root, "recovered"), "utf8")).toBe("yes");
    expect(await Bun.file(join(root, "unexpected-admission")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type PreflightFailure = "absent" | "unauthorized" | "ambiguous" | "bun" | "executable" | "pin" | "github" | "mac" | "ssh";

async function preflightFixture(root: string, failure?: PreflightFailure): Promise<StablePreflightRuntime> {
  const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
  return {
    platform: "darwin",
    arch: "arm64",
    bunVersion: failure === "bun" ? "0.0.0" : pins.bunVersion,
    environment: { OMP_STABLE_QUALIFICATION_DIR: root },
    executable: name => failure === "executable" && name === "cosign" ? null : "/fixture/" + name,
    recoverMac: async () => {
      if (failure === "mac") throw new Error("private-host private-credential");
      return { sshDestination: "private-host", sudoPassword: "private-credential" };
    },
    output: async command => {
      const invocation = command.join(" ");
      if (invocation === "adb devices") {
        const devices = failure === "absent" ? "" : failure === "unauthorized" ? "private-device unauthorized" :
          failure === "ambiguous" ? "private-device device\nother-private-device device" : "private-device device";
        return "List of devices attached\n" + devices + "\n";
      }
      if (invocation === "adb -s private-device shell getprop ro.product.model") return "Pixel 10";
      if (invocation === "adb -s private-device shell getprop ro.build.version.release") return "16";
      if (invocation === "adb -s private-device shell getprop ro.build.id") return "fixture-build";
      if (invocation === "adb -s private-device shell dumpsys package com.android.chrome") return "versionName=150.0.1";
      if (command[0] === "security" && command[1] === "find-generic-password") {
        if (failure === "pin") throw new Error("private-device private-credential");
        return "123456";
      }
      if (invocation === "gh auth token") return failure === "github" ? "" : "private-credential";
      if (invocation === "gh api repos/alphastorm/omp-session-gateway") return JSON.stringify({ permissions: { push: true } });
      if (command[0] === "gh" && command[1] === "release" && command[2] === "view") {
        return JSON.stringify({ tagName: command[3], isDraft: false, isPrerelease: command[3] === TAG });
      }
      if (invocation === "git rev-parse HEAD") return COMMIT;
      if (invocation === "git --no-optional-locks status --porcelain") return "";
      if (invocation === "git branch --show-current") return "fixture";
      if (invocation === "git ls-remote --exit-code origin refs/heads/fixture") return COMMIT + "\trefs/heads/fixture";
      if (command[0] === "ssh") {
        if (failure === "ssh") throw new Error("private-host private-credential");
        return "";
      }
      throw new Error("fixture refuses a non-prerequisite command: " + invocation);
    },
  };
}

describe("stable qualification read-only admission", () => {
  test.each([
    ["absent", "authorized Android"],
    ["unauthorized", "authorized Android"],
    ["ambiguous", "authorized Android"],
    ["bun", "local Bun"],
    ["executable", "cosign"],
    ["pin", "Keychain"],
    ["github", "GitHub CLI"],
    ["mac", "retained Mac lookup"],
    ["ssh", "retained Mac SSH"],
  ] as const)("%s prerequisite failure stops normal qualification before receipts or dispatch", async (failure, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-failure-"));
    try {
      const runtime = await preflightFixture(root, failure);
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime));
      expect(error).toContain(diagnostic);
      expect(error).not.toMatch(/private-(?:device|host|credential)/u);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--preflight accepts exact candidate arguments but never creates qualification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-pass-"));
    try {
      const runtime = await preflightFixture(root);
      const report = await runStableQualification(["--preflight", "--tag", TAG, "--previous-tag", PREVIOUS_TAG], runtime);
      expect(report.status).toBe("preflight-passed");
      expect(report.notProven).toEqual(expect.arrayContaining([
        expect.stringContaining("signatures"),
        expect.stringContaining("dispatch"),
      ]));
      expect(JSON.stringify(report)).not.toMatch(/private-(?:device|host|credential)/u);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retained Mac probe uses the pinned home Bun without requiring a staged qualification directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-host-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    try {
      await mkdir(join(home, ".bun", "bin"), { recursive: true });
      await mkdir(bin);
      const runtime = await preflightFixture(join(root, "receipts"));
      const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
      const fixtureCommand = async (path: string, body: string) => writeFile(path, "#!/bin/sh\n" + body + "\n", { mode: 0o700 });
      await fixtureCommand(join(home, ".bun", "bin", "bun"), "[ \"$1\" = --version ] || exit 1; echo " + pins.bunVersion);
      await fixtureCommand(join(bin, "uname"), "case \"$1\" in -s) echo Darwin;; -m) echo arm64;; *) exit 1;; esac");
      await fixtureCommand(join(bin, "tailscale"), "[ \"$*\" = 'status --json' ] || exit 1; echo '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"fixture.invalid.\"}}'");
      await fixtureCommand(join(bin, "ifconfig"), "echo 'inet6 fd7a:115c:a1e0::1'");
      for (const name of ["curl", "git", "shasum", "tar", "lsof", "launchctl", "sudo"]) {
        await fixtureCommand(join(bin, name), "exit 1");
      }
      const hostRuntime = {
        ...runtime,
        output: async (command: readonly string[]) => {
          if (command[0] !== "ssh") return runtime.output(command);
          const child = Bun.spawn(["/bin/bash", "-c", command.at(-1)!], {
            env: { HOME: home, PATH: bin + ":/usr/bin:/bin" },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code !== 0) throw new Error(stderr);
          return stdout.trim();
        },
      };
      expect((await runStableQualification(["--preflight", "--tag", TAG], hostRuntime)).status).toBe("preflight-passed");
      await expect(stat(join(home, "qual"))).rejects.toMatchObject({ code: "ENOENT" });
      await fixtureCommand(join(home, ".bun", "bin", "bun"), "echo 0.0.0");
      await expect(runStableQualification(["--preflight", "--tag", TAG], hostRuntime)).rejects.toThrow("retained Mac SSH");
      expect(await Bun.file(join(root, "receipts", "stable-qualification.json")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflight still rejects missing values, unknown flags and a different predecessor before probing", async () => {
    let probes = 0;
    const runtime = await preflightFixture("/unused-fixture");
    const guarded = { ...runtime, output: async () => { probes += 1; throw new Error("unexpected probe"); } };
    for (const argv of [
      ["--preflight"],
      ["--preflight", "--tag"],
      ["--preflight", "--tag", TAG, "--previous-tag"],
      ["--preflight", "--tag", TAG, "--previous-tag", "v0.2.1"],
      ["--preflight", "--tag", TAG, "--dispatch"],
    ]) {
      await expect(runStableQualification(argv, guarded)).rejects.toThrow();
    }
    expect(probes).toBe(0);
  });
});

describe("shared OMP qualification pin", () => {
  test("rejects missing pins, malformed native hashes, and a pre-mainline runtime", async () => {
    const lock = JSON.parse(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
    for (const value of [
      {},
      { ...lock, tree: "not-a-tree" },
      { ...lock, packageVersion: "18.1.19" },
      { ...lock, darwinArm64Native: { ...lock.darwinArm64Native, binarySha256: "not-a-digest" } },
    ]) {
      expect(() => parseQualificationPins(JSON.stringify(value))).toThrow("pin is invalid");
    }
  });
});

test("Mac evidence follows the exact OMP pin and rejects a stale build", async () => {
  const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
  const candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  const output = [
    `release-info commit:                   ${candidate.sourceCommit}`,
    candidate.archiveSha256,
    "doctor                                 17/17 true",
    JSON.stringify({ version: pins.version, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, nativeSha256: pins.nativeBinarySha256 }),
  ].join("\n");
  assertMacBuildOutput(output, candidate, pins);
  expect(() => assertMacBuildOutput(output.replace(pins.version, "17.4.1"), candidate, pins)).toThrow("version");
  expect(() => assertMacBuildOutput(output.replace(pins.nativeBinarySha256, "c".repeat(64)), candidate, pins)).toThrow("nativeSha256");
  expect(() => assertMacBuildOutput(output.replace(pins.sourceTree, "d".repeat(40)), candidate, pins)).toThrow("sourceTree");
  expect(() => assertMacBuildOutput(output.replace("17/17 true", "16/17 true"), candidate, pins)).toThrow("doctor");
});

test("Mac lifecycle evidence records measured pass counts and refuses an incomplete rollback", async () => {
  const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
  const candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  const output = [
    "host:                                 macOS 26.6.1 arm64",
    "hardware:                              Mac14,3",
    "release-info commit:                   " + candidate.sourceCommit,
    candidate.archiveSha256,
    "doctor                                 18/18 true",
    "doctor false checks                    (none)",
    "token bytes in bundle:                 0",
    "login in bundle:                       0",
    "forged header, real login allowed:     200",
    "backend at tailnet address:            refused",
    "backend at ssh address:                refused",
    "gateway returned after: 1 second",
    "23/23 invariants PASS",
    JSON.stringify({ version: pins.version, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, nativeSha256: pins.nativeBinarySha256 }),
  ].join("\n");
  expect(assertMacLifecycleOutput(output, candidate, pins)).toEqual({ doctor: "18/18", rollbackInvariants: "23/23", os: "macOS 26.6.1 arm64" });
  expect(() => assertMacLifecycleOutput(output.replace("23/23", "22/23"), candidate, pins)).toThrow("rollback");
});

describe("resumable receipt lanes", () => {
  test("checkpoints running evidence, persists a pass, and skips an already passed lane", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const states: string[] = [];
    const persist = async () => {
      states.push(receipt.lanes.artifacts.status);
    };
    let calls = 0;
    const first = await executeReceiptLane(receipt, "artifacts", persist, async checkpoint => {
      calls += 1;
      await checkpoint({ runId: 7 });
      return { verified: true };
    });
    const second = await executeReceiptLane<{ verified: boolean }>(receipt, "artifacts", persist, async () => {
      calls += 1;
      throw new Error("must not run");
    });

    expect(first).toEqual({ verified: true });
    expect(second).toEqual({ verified: true });
    expect(calls).toBe(1);
    expect(receipt.lanes.artifacts).toMatchObject({ status: "passed", attempts: 1, evidence: { verified: true } });
    expect(states).toEqual(["running", "running", "passed"]);
  });

  test("records a failure and never converts it into a pass", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const message = await rejectionMessage(
      executeReceiptLane(receipt, "debian", async () => {}, async () => {
        throw new Error("host lane failed");
      }),
    );
    expect(message).toContain("host lane failed");
    expect(receipt.lanes.debian).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "lane execution failed; inspect the qualification process output",
    });
  });
  test("serializes concurrent Android and relay receipt checkpoints", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-stable-receipt-concurrency-"));
    const receiptPath = join(temporaryRoot, "stable-qualification.json");
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const persist = createReceiptPersister(receiptPath, receipt);
    try {
      await Promise.all(Array.from({ length: 32 }, () => persist()));
      const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(validateStableQualificationReceipt(persisted, TAG, COMMIT, PREVIOUS_TAG)).toEqual(persisted);
      expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(temporaryRoot)).toEqual(["stable-qualification.json"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

test("receipt identity cannot mix passed lanes across orchestrator commits", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  receipt.lanes.debian.status = "passed";
  expect(validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toBe(receipt);
  expect(() => validateStableQualificationReceipt(receipt, TAG, "b".repeat(40), PREVIOUS_TAG)).toThrow(
    "do not resume evidence across orchestrator commits",
  );
  expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, "v0.2.0")).toThrow(
    "rollback predecessors",
  );
});

test("receipt-driven Mac cleanup survives restarts and reopens before renewed effects", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  expect(receiptNeedsMacCleanup(receipt)).toBe(false);
  receipt.lanes.macos.attempts = 1;
  receipt.lanes.macos.status = "failed";
  expect(receiptNeedsMacCleanup(receipt)).toBe(true);
  receipt.lanes.cleanup.attempts = 1;
  receipt.lanes.cleanup.status = "failed";
  expect(receiptNeedsMacCleanup(receipt)).toBe(true);
  receipt.lanes.cleanup.status = "passed";
  receipt.lanes.cleanup.completedAt = "2026-08-22T00:00:00.000Z";
  receipt.lanes.cleanup.evidence = { gatewayProcesses: 0 };
  expect(receiptNeedsMacCleanup(receipt)).toBe(false);
  expect(markMacCleanupRequired(receipt)).toBe(true);
  expect(receipt.lanes.cleanup).toMatchObject({ status: "pending", attempts: 1 });
  expect(receipt.lanes.cleanup.completedAt).toBeUndefined();
  expect(receipt.lanes.cleanup.evidence).toBeUndefined();
  expect(receiptNeedsMacCleanup(receipt)).toBe(true);
});

describe("Debian workflow dispatch resume", () => {
  const dispatchId = "11111111-1111-4111-8111-111111111111";
  const options = parseStableQualificationArgs(["--tag", TAG], {});

  test("persists dispatch intent before creating one discoverable run", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const commands: string[][] = [];
    let dispatched = false;
    const checkpoint = async (evidence: Record<string, unknown>) => {
      receipt.lanes.debian.evidence = { ...(receipt.lanes.debian.evidence ?? {}), ...evidence };
    };
    const runtime: DebianQualificationRuntime = {
      output: async command => {
        commands.push([...command]);
        if (command[1] === "api") {
          return JSON.stringify({
            workflow_runs: dispatched
              ? [{ id: 77, display_title: `Stable qualification ${dispatchId}`, head_sha: COMMIT, status: "queued", conclusion: null, html_url: "https://example.invalid/runs/77" }]
              : [],
          });
        }
        return JSON.stringify({
          status: "completed",
          conclusion: "success",
          headSha: COMMIT,
          url: "https://example.invalid/runs/77",
          jobs: [{ name: "Qualify on disposable droplet", conclusion: "success" }],
        });
      },
      execute: async command => {
        commands.push([...command]);
        if (command[1] === "workflow") {
          expect(receipt.lanes.debian.evidence).toMatchObject({
            dispatchId,
            dispatchRequestedAt: expect.any(String),
            runId: null,
          });
          dispatched = true;
        }
      },
      sleep: async () => {},
      createDispatchId: () => dispatchId,
    };

    const evidence = await qualifyDebian(options, receipt, checkpoint, "feat/stable", runtime);
    expect(commands.filter(command => command[1] === "workflow")).toHaveLength(1);
    expect(evidence).toMatchObject({
      dispatchId,
      dispatchRequestedAt: expect.any(String),
      runId: 77,
      url: "https://example.invalid/runs/77",
    });
  });

  test("never redispatches after a durable request whose run is not yet visible", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    receipt.lanes.debian.evidence = { dispatchId, dispatchRequestedAt: "2026-08-22T00:00:00.000Z" };
    let dispatches = 0;
    const runtime: DebianQualificationRuntime = {
      output: async () => JSON.stringify({ workflow_runs: [] }),
      execute: async command => {
        if (command[1] === "workflow") dispatches += 1;
      },
      sleep: async () => {},
      createDispatchId: () => { throw new Error("must reuse durable id"); },
    };
    const message = await rejectionMessage(
      qualifyDebian(
        options,
        receipt,
        async evidence => { receipt.lanes.debian.evidence = { ...(receipt.lanes.debian.evidence ?? {}), ...evidence }; },
        "feat/stable",
        runtime,
      ),
    );
    expect(message).toContain("refusing to dispatch again");
    expect(dispatches).toBe(0);
  });
});

test.skipIf(process.platform === "win32")("mainline OMP helper refuses missing pins before host mutation", async () => {
  const child = Bun.spawn(["/bin/bash", "scripts/qualify-macos-omp.sh", "build"], {
    cwd: REPOSITORY_ROOT,
    env: { PATH: process.env.PATH },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("OMP_QUAL_GATEWAY_ROOT is required");
});

test.skipIf(process.platform === "win32")("mainline OMP helper rejects path-special labels before cleanup", async () => {
  for (const sessionLabel of ["..", ".ssh"]) {
    const child = Bun.spawn(["/bin/bash", "scripts/qualify-macos-omp.sh", "clean"], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp/omp-path-guard-never-used",
        OMP_QUAL_GATEWAY_ROOT: "/tmp/omp-candidate-never-used",
        OMP_PIN_SOURCE_COMMIT: "1".repeat(40),
        OMP_PIN_SOURCE_TREE: "2".repeat(40),
        OMP_PIN_VERSION: "17.4.1",
        OMP_PIN_BUN_VERSION: "1.3.14",
        OMP_PIN_NATIVE_TARBALL_SHA256: "3".repeat(64),
        OMP_PIN_NATIVE_BINARY_SHA256: "4".repeat(64),
        OMP_QUAL_SESSION_LABEL: sessionLabel,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("safe single path component");
  }
});

test("protected release state guard detects implicit ledger promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-qualification-guard-"));
  const stable = "pending\n";
  const ledger = "not promoted\n";
  const snapshots: ProtectedFileSnapshot[] = [
    { path: "STABLE_RELEASE.lock.json", sha256: digest(stable) },
    { path: "docs/RELEASE_STATUS.md", sha256: digest(ledger) },
  ];
  try {
    await writeFile(join(root, "STABLE_RELEASE.lock.json"), stable);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/RELEASE_STATUS.md"), ledger);
    await assertProtectedFilesUnchanged(snapshots, root);

    await writeFile(join(root, "STABLE_RELEASE.lock.json"), "qualified\n");
    const message = await rejectionMessage(assertProtectedFilesUnchanged(snapshots, root));
    expect(message).toContain("qualification modified protected release state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
