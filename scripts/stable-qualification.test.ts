import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  assertProtectedFilesUnchanged,
  createReceiptPersister,
  createStableQualificationReceipt,
  executeReceiptLane,
  markMacCleanupRequired,
  parseQualificationPins,
  parseStableQualificationArgs,
  qualifyDebian,
  receiptNeedsMacCleanup,
  validateStableQualificationReceipt,
  type DebianQualificationRuntime,
  type ProtectedFileSnapshot,
} from "./stable-qualification.ts";

const TAG = "v0.3.0-prealpha.21";
const PREVIOUS_TAG = "v0.2.1";
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
  test("accepts the one-command stable candidate shape with bounded defaults", () => {
    const options = parseStableQualificationArgs(["--tag", TAG], {});
    expect(options.tag).toBe(TAG);
    expect(options.previousTag).toBe(PREVIOUS_TAG);
    expect(options.macName).toBe("omp-macqual-01");
    expect(options.relaySeconds).toBe(60);
  });

  test("rejects stable, rc, zero-indexed, and prior-version candidate tags", () => {
    for (const tag of ["v0.3.0", "v0.3.0-rc.1", "v0.3.0-prealpha.0", "v0.2.1-prealpha.25"]) {
      expect(() => parseStableQualificationArgs(["--tag", tag], {})).toThrow("--tag must match");
    }
  });

  test("accepts only the published stable as the rollback predecessor", () => {
    expect(parseStableQualificationArgs(["--tag", TAG, "--previous-tag", PREVIOUS_TAG], {}).previousTag).toBe(
      PREVIOUS_TAG,
    );
    for (const previous of ["v0.1.0", "v0.2.0", "v0.2.1-prealpha.1", "v0.3.0-prealpha.1", "v0.3.0", ""]) {
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

  test("rejects path-special and overlong session labels before host access", () => {
    for (const sessionLabel of [".", "..", "a".repeat(129)]) {
      expect(() =>
        parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_SESSION_LABEL: sessionLabel }),
      ).toThrow("safe single path component");
    }
  });
});

describe("shared OMP qualification pin", () => {
  test("parses the exact source, tree, runtime, Bun, and native-byte contract", () => {
    expect(
      parseQualificationPins(`
# comment
OMP_PIN_BUN_VERSION=1.3.14
OMP_PIN_SOURCE_COMMIT=${"1".repeat(40)}
OMP_PIN_PATCHED_TREE=${"2".repeat(40)}
OMP_PIN_VERSION=17.4.1
OMP_PIN_NATIVE_TARBALL_SHA256=${"3".repeat(64)}
OMP_PIN_NATIVE_BINARY_SHA256=${"4".repeat(64)}
`),
    ).toEqual({
      bunVersion: "1.3.14",
      sourceCommit: "1".repeat(40),
      patchedTree: "2".repeat(40),
      version: "17.4.1",
      nativeTarballSha256: "3".repeat(64),
      nativeBinarySha256: "4".repeat(64),
    });
  });

  test("fails closed when any pin is absent or malformed", () => {
    expect(() => parseQualificationPins("OMP_PIN_BUN_VERSION=1.3.14\n")).toThrow("pin is invalid");
  });
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

test.skipIf(process.platform === "win32")("patched OMP helper refuses missing pins before host mutation", async () => {
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

test.skipIf(process.platform === "win32")("patched OMP helper rejects path-special labels before cleanup", async () => {
  for (const sessionLabel of ["..", ".ssh"]) {
    const child = Bun.spawn(["/bin/bash", "scripts/qualify-macos-omp.sh", "clean"], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp/omp-path-guard-never-used",
        OMP_QUAL_GATEWAY_ROOT: "/tmp/omp-candidate-never-used",
        OMP_PIN_SOURCE_COMMIT: "1".repeat(40),
        OMP_PIN_PATCHED_TREE: "2".repeat(40),
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
