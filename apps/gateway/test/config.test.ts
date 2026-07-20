import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type GatewayConfig,
  loadGatewayConfig,
  loadOrCreatePublisherToken,
  publisherTokenMatches,
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
    "$acl=Get-Acl -LiteralPath $Path; $acl.SetSecurityDescriptorSddlForm($sddl); " +
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

async function makeWindowsFixtureUnsafe(path: string): Promise<void> {
  if (process.platform !== "win32") return;
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

  test("rejects permissive and symlinked config files", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await makeWindowsFixtureUnsafe(path);
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
    await rotatePublisherToken(config);
    const second = await loadOrCreatePublisherToken(config);
    expect(second).not.toBe(first);
    expect(publisherTokenMatches(second, second)).toBeTrue();
    expect(publisherTokenMatches(second, `${second}x`)).toBeFalse();
    expect(publisherTokenMatches(second, first)).toBeFalse();
  }, 20_000);

  test("rejects unsafe token permissions", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(config.paths.tokenPath, `${"A".repeat(43)}\n`, { mode: 0o644 });
    await makeWindowsFixtureUnsafe(config.paths.tokenPath);
    await expect(loadOrCreatePublisherToken(config)).rejects.toThrow("unsafe");
  });
});
