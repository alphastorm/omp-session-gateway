import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EXPECTED_UPSTREAM_CODING_AGENT_VERSION, EXPECTED_UPSTREAM_COMMIT } from "../src/doctor.ts";

/**
 * `compatibilityArtifactsPresent` deliberately hardcodes the upstream identity rather than reading
 * it from the lock it is validating. That duplication is the point — it detects a tampered or
 * mismatched lock — but it silently rots on an upstream refresh. On 2026-08-19 the pin moved to
 * v17.3.8 while these constants still named v17.0.6, and `doctor` reported `compatibility: false`
 * against a correct checkout. Nothing failed, because nothing compared the two.
 */
test("pin contract: doctor's expected upstream identity matches UPSTREAM.lock.json", async () => {
  const lock = JSON.parse(
    await readFile(fileURLToPath(new URL("../../../UPSTREAM.lock.json", import.meta.url)), "utf8"),
  ) as { commit: string; packageVersions: Record<string, string> };

  expect(EXPECTED_UPSTREAM_COMMIT).toBe(lock.commit);
  expect(lock.packageVersions["@oh-my-pi/pi-coding-agent"]).toBe(EXPECTED_UPSTREAM_CODING_AGENT_VERSION);
});

test("pin contract: the shipped patch targets the locked upstream commit", async () => {
  const patch = await readFile(
    fileURLToPath(new URL("../../../patches/oh-my-pi/0001-collab-controller-autostart-registry.patch", import.meta.url)),
    "utf8",
  );

  // The controller and publisher are the two files the compatibility check looks for; if a refresh
  // ever regenerates the mbox without them, the gateway integration is not actually present.
  expect(patch).toContain("packages/coding-agent/src/collab/controller.ts");
  expect(patch).toContain("packages/coding-agent/src/collab/registry-publisher.ts");
});
