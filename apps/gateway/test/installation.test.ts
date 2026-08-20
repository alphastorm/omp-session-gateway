import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { GatewayConfig } from "../src/config.ts";
import {
  type InstalledRuntime,
  activateRuntime,
  activationHistory,
  activationState,
  currentInstalledRuntime,
  resolveRollbackTarget,
  stageRuntimePayload,
} from "../src/installation.ts";
import { serviceDefinition } from "../src/service.ts";

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

/**
 * Two distinct runtimes staged from one fixture. The payload digest names the directory, so the CLI
 * body has to change for a second version to exist at all.
 */
async function stageTwo(
  gatewayConfig: GatewayConfig,
  source: { sourceRoot: string; cliSource: string },
): Promise<{ first: InstalledRuntime; second: InstalledRuntime }> {
  const first = await stageRuntimePayload(gatewayConfig, source);
  await writeFile(source.cliSource, "console.log('replacement gateway');\n");
  const second = await stageRuntimePayload(gatewayConfig, source);
  return { first, second };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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

test("rollback selects the activation recorded before the active one", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-select-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    // An idempotent re-install must not displace the predecessor with a duplicate entry.
    await activateRuntime(gatewayConfig, second);
    expect(await activationHistory(gatewayConfig)).toEqual([basename(first.directory), basename(second.directory)]);

    const automatic = await resolveRollbackTarget(gatewayConfig);
    expect(automatic.runtime.directory).toBe(first.directory);
    expect(automatic.from).toBe(basename(second.directory));
    expect(automatic.selection).toBe("recorded-predecessor");

    const explicit = await resolveRollbackTarget(gatewayConfig, basename(first.directory));
    expect(explicit.runtime).toEqual(automatic.runtime);
    expect(explicit.selection).toBe("requested");

    // "Previous" is the recorded order, so a second rollback returns to where the first started.
    await activateRuntime(gatewayConfig, automatic.runtime);
    expect((await resolveRollbackTarget(gatewayConfig)).runtime.directory).toBe(second.directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback refuses rather than guesses when the target is unusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-refuse-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);

    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(/without an active installed runtime/u);

    await activateRuntime(gatewayConfig, first);
    await rm(second.directory, { recursive: true });
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(/only installed version/u);

    const restaged = await stageRuntimePayload(gatewayConfig, source);
    expect(restaged.directory).toBe(second.directory);
    await activateRuntime(gatewayConfig, restaged);

    await expect(resolveRollbackTarget(gatewayConfig, "0.1.0-000000000000")).rejects.toThrow(/is not installed/u);
    await expect(resolveRollbackTarget(gatewayConfig, basename(second.directory))).rejects.toThrow(
      /to the active version/u,
    );
    await expect(resolveRollbackTarget(gatewayConfig, "../../etc")).rejects.toThrow(/malformed version directory/u);

    // An install predating the activation history has no recorded predecessor. Falling back to
    // directory mtime would answer here; refusing and naming `--to` is the whole point.
    await rm(join(gatewayConfig.paths.stateDir, "installation", "history.json"));
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(/--to <version-directory>/u);
    expect((await resolveRollbackTarget(gatewayConfig, basename(first.directory))).runtime.directory).toBe(
      first.directory,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback leaves configuration and the publisher token untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-preserve-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    await mkdir(gatewayConfig.paths.configDir, { recursive: true, mode: 0o700 });
    // Synthetic and distinctive so a leak into the new installation metadata fails the assertion.
    const syntheticToken = "omp-synthetic-publisher-token-DO-NOT-SHIP-8f21c4";
    await writeFile(gatewayConfig.paths.configPath, '{"http":{"port":4317}}\n', { mode: 0o600 });
    await writeFile(gatewayConfig.paths.tokenPath, `${syntheticToken}\n`, { mode: 0o600 });
    const configDigest = await sha256(gatewayConfig.paths.configPath);
    const tokenDigest = await sha256(gatewayConfig.paths.tokenPath);
    const tokenMode = (await lstat(gatewayConfig.paths.tokenPath)).mode & 0o777;

    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    const target = await resolveRollbackTarget(gatewayConfig);
    await activateRuntime(gatewayConfig, target.runtime);
    expect((await currentInstalledRuntime(gatewayConfig))?.directory).toBe(first.directory);

    expect(await sha256(gatewayConfig.paths.configPath)).toBe(configDigest);
    expect(await sha256(gatewayConfig.paths.tokenPath)).toBe(tokenDigest);
    expect((await lstat(gatewayConfig.paths.tokenPath)).mode & 0o777).toBe(tokenMode);

    const installationRoot = join(gatewayConfig.paths.stateDir, "installation");
    for (const name of ["current.json", "history.json"]) {
      expect(await readFile(join(installationRoot, name), "utf8")).not.toContain(syntheticToken);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service-definition divergence from current.json is detected and repaired from the pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-diverge-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    const definitionPath = join(root, "service", "omp-session-gateway.plist");
    await mkdir(dirname(definitionPath), { recursive: true });

    await activateRuntime(gatewayConfig, second);
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(second.directory),
      serviceVersion: basename(second.directory),
      serviceDefinitionPresent: true,
      diverged: false,
    });

    // The one reachable divergence: a crash between the definition write and the pointer write
    // leaves the definition naming the newer version while the pointer still names the proven one.
    await activateRuntime(gatewayConfig, first);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(first.directory),
      serviceVersion: basename(second.directory),
      serviceDefinitionPresent: true,
      diverged: true,
    });

    // Repair rewrites the definition from the runtime the pointer names, never the reverse.
    // `install` and `rollback` do this through `installUserService`, which drives the real service
    // manager; the rendered content it would write is identical to what is written here.
    expect((await currentInstalledRuntime(gatewayConfig))?.cliPath).toBe(first.cliPath);
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", first.cliPath).content);
    expect((await activationState(gatewayConfig, definitionPath)).diverged).toBe(false);

    // A definition naming a program outside this install's versions root is nobody's version.
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", join(root, "elsewhere", "cli.js")).content);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(first.directory),
      serviceVersion: undefined,
      serviceDefinitionPresent: true,
      diverged: true,
    });

    // Uninstall removes the definition and preserves the pointer; that is not divergence.
    await rm(definitionPath);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(first.directory),
      serviceVersion: undefined,
      serviceDefinitionPresent: false,
      diverged: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("divergence detection reads every platform's service-definition encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-encoding-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const definitionPath = join(root, "service", "definition");
    await mkdir(dirname(definitionPath), { recursive: true });

    // systemd quotes ExecStart argv with JSON string syntax; launchd XML-escapes plist strings.
    for (const platform of ["linux", "darwin"] as const) {
      await writeFile(definitionPath, serviceDefinition(gatewayConfig, platform, staged.cliPath).content);
      expect((await activationState(gatewayConfig, definitionPath)).serviceVersion).toBe(basename(staged.directory));
    }

    // Windows task XML is written as UTF-16LE with a BOM, exactly as `installUserService` encodes it.
    const taskXml = serviceDefinition(gatewayConfig, "win32", staged.cliPath).content;
    await writeFile(
      definitionPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, "utf16le")]),
    );
    expect((await activationState(gatewayConfig, definitionPath)).serviceVersion).toBe(basename(staged.directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
