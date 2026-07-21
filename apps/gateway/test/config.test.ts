import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type GatewayConfig,
  captureGatewayConfigFile,
  loadGatewayConfig,
  loadOrCreatePublisherToken,
  publisherTokenMatches,
  publicOriginHttpsPort,
  restoreGatewayConfigFile,
  rotatePublisherToken,
} from "../src/config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

function configForRoot(root: string): GatewayConfig {
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

function windowsPowerShellEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return { ...environment, ...overrides };
}

async function secureWindowsFixture(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const script =
    "$Path=$env:OMP_GATEWAY_ACL_PATH; " +
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$sddl='D:P(A;;FA;;;SY)(A;;FA;;;'+$sid+')'; " +
    "$acl=Get-Acl -LiteralPath $Path; $acl.SetSecurityDescriptorSddlForm($sddl); $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid)); " +
    "Set-Acl -LiteralPath $Path -AclObject $acl";
  const subprocess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: windowsPowerShellEnvironment({ OMP_GATEWAY_ACL_PATH: path }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(subprocess.stderr).text();
  if ((await subprocess.exited) !== 0) throw new Error(`failed to secure test fixture: ${stderr.trim()}`);
}

async function makeFixtureUnsafe(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    return;
  }
  const subprocess = Bun.spawn(["icacls.exe", path, "/grant", "*S-1-1-0:F"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(subprocess.stderr).text();
  if ((await subprocess.exited) !== 0) throw new Error(`failed to loosen test fixture ACL: ${stderr.trim()}`);
}

describe("secure config", () => {
  test("loads strict production config and normalizes exact allowlist logins", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: [" User@Example.COM "] },
        registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 25, maxSessions: 25 },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    const loaded = await loadGatewayConfig({ configPath: path });
    expect(loaded.auth.allowedLogins).toEqual(["user@example.com"]);
    expect(loaded.http.hostname).toBe("127.0.0.1");
  });

  test("rejects an HTTP public origin in production mode", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    await expect(loadGatewayConfig({ configPath: path })).rejects.toThrow("HTTPS");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    await expect(
      loadGatewayConfig({ configPath: path, publicOrigin: "http://gateway.example.ts.net" }),
    ).rejects.toThrow("HTTPS");
  });

  test("requires an exact configured loopback origin in development mode", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "::1", port: 4318, publicOrigin: "http://[::1]:4318" },
        auth: { mode: "dev-localhost", allowedLogins: [] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    const loaded = await loadGatewayConfig({ configPath: path });
    expect(loaded.http.publicOrigin).toBe("http://[::1]:4318");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "dev-localhost", allowedLogins: [] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    await expect(loadGatewayConfig({ configPath: path })).rejects.toThrow("loopback HTTP origin");
  });

  test("synthesizes a matching local origin for development mode and port overrides", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["allowed@example.com"] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    const loaded = await loadGatewayConfig({ configPath: path, mode: "dev-localhost", port: 4319 });
    expect(loaded.http.port).toBe(4319);
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:4319");
    expect(loaded.auth.mode).toBe("dev-localhost");
  });

  test("derives the configured external HTTPS port", () => {
    expect(publicOriginHttpsPort("https://gateway.example.ts.net")).toBe(443);
    expect(publicOriginHttpsPort("https://gateway.example.ts.net:8443")).toBe(8443);
  });

  test("restores existing and absent config snapshots", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(path, "original\n", { mode: 0o600 });
    await secureWindowsFixture(path);
    const existing = await captureGatewayConfigFile(path);
    await writeFile(path, "replacement\n", { mode: 0o600 });
    await restoreGatewayConfigFile(existing);
    expect(await readFile(path, "utf8")).toBe("original\n");
    await rm(path);
    const absent = await captureGatewayConfigFile(path);
    await writeFile(path, "created\n", { mode: 0o600 });
    await restoreGatewayConfigFile(absent);
    expect(await Bun.file(path).exists()).toBe(false);
  }, 20_000);

  test("rejects permissive and symlinked config files", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await makeFixtureUnsafe(path);
    await expect(loadGatewayConfig({ configPath: path, mode: "dev-localhost" })).rejects.toThrow("unsafe");
    await rm(path);
    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path);
    await expect(loadGatewayConfig({ configPath: path, mode: "dev-localhost" })).rejects.toThrow("unsafe");
  });

  test("creates and rotates a private 256-bit publisher token without printing it", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const first = await loadOrCreatePublisherToken(config);
    const file = await lstat(config.paths.tokenPath);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(file.isFile()).toBeTrue();
    if (process.platform !== "win32") expect(file.mode & 0o077).toBe(0);
    expect(await loadOrCreatePublisherToken(config)).toBe(first);
    const second = await rotatePublisherToken(config);
    expect(await loadOrCreatePublisherToken(config)).toBe(second);
    expect(second).not.toBe(first);
    expect(publisherTokenMatches(second, second)).toBeTrue();
    expect(publisherTokenMatches(second, `${second}x`)).toBeFalse();
    expect(publisherTokenMatches(second, first)).toBeFalse();
  }, 20_000);

  test("rotation remediates an unsafe token leaf without following it", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(config.paths.tokenPath, `${"A".repeat(43)}\n`, { mode: 0o644 });
    await makeFixtureUnsafe(config.paths.tokenPath);
    await expect(loadOrCreatePublisherToken(config)).rejects.toThrow("unsafe");
    const rotated = await rotatePublisherToken(config);
    expect(await loadOrCreatePublisherToken(config)).toBe(rotated);
    const file = await lstat(config.paths.tokenPath);
    expect(file.isFile()).toBeTrue();
    if (process.platform !== "win32") expect(file.mode & 0o077).toBe(0);
  }, 20_000);

  test("rotation replaces a token symlink without modifying its target", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    const target = join(root, "external-token");
    const original = `${"A".repeat(43)}\n`;
    await writeFile(target, original, { mode: 0o600 });
    await symlink(target, config.paths.tokenPath);
    const rotated = await rotatePublisherToken(config);
    expect(await loadOrCreatePublisherToken(config)).toBe(rotated);
    expect(await Bun.file(target).text()).toBe(original);
    expect((await lstat(config.paths.tokenPath)).isSymbolicLink()).toBeFalse();
  });

  test("rejects oversized private config and publisher-token files before parsing", async () => {
    const root = await privateRoot();
    const configPath = join(root, "oversized-config.json");
    await writeFile(configPath, " ".repeat(64 * 1_024 + 1), { mode: 0o600 });
    await secureWindowsFixture(configPath);
    await expect(loadGatewayConfig({ configPath, mode: "dev-localhost" })).rejects.toThrow("size limit");

    const config = configForRoot(root);
    await loadOrCreatePublisherToken(config);
    await writeFile(config.paths.tokenPath, "A".repeat(46), { mode: 0o600 });
    await secureWindowsFixture(config.paths.tokenPath);
    await expect(loadOrCreatePublisherToken(config)).rejects.toThrow("invalid encoding or length");
  }, 20_000);
});
