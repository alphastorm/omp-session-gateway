import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { GatewayConfig } from "../src/config.ts";
import { activateRuntime, currentInstalledRuntime, stageRuntimePayload } from "../src/installation.ts";

function config(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317" },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 10, maxSessions: 10 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "registry.sock"),
      tokenPath: join(root, "config", "publisher-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

async function sourceFixture(root: string): Promise<{ sourceRoot: string; cliSource: string }> {
  const sourceRoot = join(root, "source");
  const cliSource = join(sourceRoot, "cli.js");
  for (const directory of [
    "apps/web/dist",
    "patches/oh-my-pi",
    "licenses/runtime/example",
    "packages/collab-client/upstream",
  ]) {
    await mkdir(join(sourceRoot, directory), { recursive: true });
  }
  await Promise.all([
    writeFile(cliSource, "console.log('installed gateway');\n"),
    writeFile(join(sourceRoot, "apps/web/dist/index.html"), "<!doctype html>"),
    writeFile(join(sourceRoot, "apps/web/dist/manifest.webmanifest"), "{}"),
    writeFile(join(sourceRoot, "apps/web/dist/service-worker.js"), "// worker"),
    writeFile(join(sourceRoot, "patches/oh-my-pi/0001.patch"), "synthetic patch"),
    writeFile(join(sourceRoot, "licenses/runtime/example/LICENSE"), "synthetic runtime license"),
    writeFile(join(sourceRoot, "packages/collab-client/upstream/LICENSE"), "synthetic collab license"),
    writeFile(join(sourceRoot, "LICENSE"), "gateway license"),
    writeFile(join(sourceRoot, "NOTICE.md"), "gateway notice"),
    writeFile(join(sourceRoot, "THIRD_PARTY_NOTICES.md"), "third-party notice"),
    writeFile(join(sourceRoot, "UPSTREAM.lock.json"), "{}"),
    writeFile(join(sourceRoot, "bun.lock"), "{ workspaces: {} }\n"),
    writeFile(join(sourceRoot, "package.json"), "{}\n"),
    writeFile(join(sourceRoot, "release-info.json"), '{"bunLockSha256":"synthetic"}\n'),
    writeFile(join(sourceRoot, "SBOM.spdx.json"), '{"spdxVersion":"SPDX-2.3"}\n'),
  ]);
  return { sourceRoot, cliSource };
}

test("stages immutable content-addressed runtimes and atomically advances the current pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-installation-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const first = await stageRuntimePayload(gatewayConfig, source);
    expect(first.previous).toBeUndefined();
    expect(first.directory).toMatch(/0\.1\.0-[0-9a-f]{12}$/u);
    expect(first.readinessProtocol).toBe("instance-v1");
    expect((await lstat(first.cliPath)).isFile()).toBe(true);
    expect((await lstat(join(first.directory, "bun.lock"))).isFile()).toBe(true);
    expect((await lstat(join(first.directory, "SBOM.spdx.json"))).isFile()).toBe(true);
    expect((await lstat(join(first.directory, "release-info.json"))).isFile()).toBe(true);
    expect(await currentInstalledRuntime(gatewayConfig)).toBeUndefined();

    await activateRuntime(gatewayConfig, first);
    expect(await currentInstalledRuntime(gatewayConfig)).toEqual({
      directory: first.directory,
      cliPath: first.cliPath,
      readinessProtocol: "instance-v1",
    });

    const duplicate = await stageRuntimePayload(gatewayConfig, source);
    expect(duplicate.directory).toBe(first.directory);
    expect(duplicate.previous?.directory).toBe(first.directory);

    await writeFile(source.cliSource, "console.log('replacement gateway');\n");
    const second = await stageRuntimePayload(gatewayConfig, source);
    expect(second.directory).not.toBe(first.directory);
    expect(second.previous?.directory).toBe(first.directory);
    await activateRuntime(gatewayConfig, second);
    expect((await currentInstalledRuntime(gatewayConfig))?.directory).toBe(second.directory);
    expect((await lstat(first.cliPath)).isFile()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a content-verified runtime installed by an older gateway version", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-installation-upgrade-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    const manifest = JSON.parse(await readFile(join(staged.directory, "installation.json"), "utf8")) as {
      sha256: string;
    };
    const priorDirectory = join(dirname(staged.directory), `0.0.9-${manifest.sha256.slice(0, 12)}`);
    await rename(staged.directory, priorDirectory);
    await writeFile(
      join(priorDirectory, "installation.json"),
      `${JSON.stringify({ version: "0.0.9", sha256: manifest.sha256 })}\n`,
    );
    const priorRuntime = {
      directory: priorDirectory,
      cliPath: join(priorDirectory, "apps", "gateway", "src", "cli.js"),
      readinessProtocol: "legacy" as const,
    };

    await activateRuntime(gatewayConfig, priorRuntime);
    expect(await currentInstalledRuntime(gatewayConfig)).toEqual(priorRuntime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
