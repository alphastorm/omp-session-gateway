import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflowPath = join(import.meta.dir, "../../../.github/workflows/ci.yml");
const validEnvironment = {
  ROUTING_LABEL: "gateway-ci-linux-x64-12345678-1234-1234-1234-123456789abc",
  TARGET_SHA: "a".repeat(40),
  RUNNER_NAME: "gateway-ci-nyc-2",
};

function validationScripts(source: string): string[] {
  return [...source.matchAll(/      - name: Validate bounded gateway dispatch[\s\S]*?        run: \|\n((?:          .*\n)+)/g)].map(
    (match) => match[1] ?? "",
  );
}

function runValidation(
  script: string,
  updates: Record<string, string> = {},
  socketPath = join(tmpdir(), "gateway-ci-absent-docker.sock"),
): number | null {
  return spawnSync(
    "bash",
    ["-Eeuo", "pipefail", "-c", script.replace("/var/run/docker.sock", socketPath)],
    {
      encoding: "utf8",
      env: { ...process.env, ...validEnvironment, ...updates },
    },
  ).status;
}

async function withUnixSocket(check: (socketPath: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ci-workflow-"));
  const socketPath = join(directory, "docker.sock");
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  try {
    check(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
}

test("every fleet lane fails closed and admits either qualified site", async () => {
  const source = await readFile(workflowPath, "utf8");
  const fleetRunsOn =
    source.match(/^    runs-on: .*inputs\.routing_label \|\| 'ubuntu-24\.04' \}\}$/gm) ?? [];
  const scripts = validationScripts(source);

  expect(fleetRunsOn).toHaveLength(3);
  expect(scripts).toHaveLength(fleetRunsOn.length);
  expect(source).not.toContain("^gateway-ci-nyc-[1-3]$");
  for (const script of scripts) {
    const predicates = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("[["));
    expect(predicates).toHaveLength(4);
    expect(predicates.every((line) => /\]\] \|\| fail [a-z_]+$/.test(line))).toBe(true);
    expect(script).toContain("^gateway-ci-(nyc|sf)-[1-3]$");

    expect(runValidation(script)).toBe(0);
    expect(runValidation(script, { RUNNER_NAME: "gateway-ci-sf-2" })).toBe(0);
    expect(runValidation(script, { ROUTING_LABEL: "gateway-ci-linux-x64-shared" })).toBe(2);
    expect(runValidation(script, { TARGET_SHA: "A".repeat(40) })).toBe(2);
    expect(runValidation(script, { RUNNER_NAME: "unknown-runner" })).toBe(2);
    await withUnixSocket((socketPath) => {
      expect(runValidation(script, {}, socketPath)).toBe(2);
    });
  }
});
