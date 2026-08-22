import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  assertProtectedFilesUnchanged,
  createStableQualificationReceipt,
  executeReceiptLane,
  parseQualificationPins,
  parseStableQualificationArgs,
  type ProtectedFileSnapshot,
} from "./stable-qualification.ts";

const TAG = "v0.1.0-prealpha.21";
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
    expect(options.previousTag).toBe("v0.1.0-beta.1");
    expect(options.macName).toBe("omp-macqual-01");
    expect(options.relaySeconds).toBe(60);
  });

  test("rejects stable, rc, and zero-indexed candidate tags", () => {
    for (const tag of ["v0.1.0", "v0.1.0-rc.1", "v0.1.0-prealpha.0"]) {
      expect(() => parseStableQualificationArgs(["--tag", tag], {})).toThrow("--tag must match");
    }
  });

  test("rejects an unbounded relay duration before any external effect", () => {
    expect(() => parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_RELAY_SECONDS: "3601" })).toThrow(
      "must not exceed 3600",
    );
  });
});

describe("shared OMP qualification pin", () => {
  test("parses the exact source, tree, runtime, and Bun contract", () => {
    expect(
      parseQualificationPins(`
# comment
OMP_PIN_BUN_VERSION=1.3.14
OMP_PIN_SOURCE_COMMIT=${"1".repeat(40)}
OMP_PIN_PATCHED_TREE=${"2".repeat(40)}
OMP_PIN_VERSION=17.4.1
`),
    ).toEqual({
      bunVersion: "1.3.14",
      sourceCommit: "1".repeat(40),
      patchedTree: "2".repeat(40),
      version: "17.4.1",
    });
  });

  test("fails closed when any pin is absent or malformed", () => {
    expect(() => parseQualificationPins("OMP_PIN_BUN_VERSION=1.3.14\n")).toThrow("pin is invalid");
  });
});

describe("resumable receipt lanes", () => {
  test("checkpoints running evidence, persists a pass, and skips an already passed lane", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT);
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
    const receipt = createStableQualificationReceipt(TAG, COMMIT);
    const message = await rejectionMessage(
      executeReceiptLane(receipt, "debian", async () => {}, async () => {
        throw new Error("host lane failed");
      }),
    );
    expect(message).toContain("host lane failed");
    expect(receipt.lanes.debian).toMatchObject({ status: "failed", attempts: 1, error: "host lane failed" });
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
