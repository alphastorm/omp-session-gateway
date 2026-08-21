import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  type ConfigOverrides,
  type GatewayConfig,
  assertPublisherTokenPrivate,
  assertSocketPrivate,
  captureGatewayConfigFile,
  defaultGatewayPaths,
  ensureRuntimeDirectories,
  loadGatewayConfig,
  loadOrCreatePublisherToken,
  loadPublisherToken,
  publisherTokenMatches,
  publicOriginHttpsPort,
  readPrivateTextFile,
  removeRuntimeSocket,
  restoreGatewayConfigFile,
  rotatePublisherToken,
  writeGatewayConfigFile,
  writePrivateTextFile,
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

type ConfigPatch = {
  readonly http?: Record<string, unknown>;
  readonly auth?: Record<string, unknown>;
  readonly registry?: Record<string, unknown>;
};

async function configFixture(text: string): Promise<string> {
  const path = join(await privateRoot(), "config.json");
  await writeFile(path, text, { mode: 0o600 });
  await secureWindowsFixture(path);
  return path;
}

async function loadDocument(document: unknown, overrides: ConfigOverrides = {}): Promise<GatewayConfig> {
  return loadGatewayConfig({ ...overrides, configPath: await configFixture(JSON.stringify(document)) });
}

function serveDocument(patch: ConfigPatch = {}): Record<string, unknown> {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net", ...patch.http },
    auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"], ...patch.auth },
  };
}

function devDocument(patch: ConfigPatch = {}): Record<string, unknown> {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317", ...patch.http },
    auth: { mode: "dev-localhost", allowedLogins: [], ...patch.auth },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 10, maxSessions: 10, ...patch.registry },
  };
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

describe("auth mode admission", () => {
  test("serve mode accepts an external origin whose port is not the listener port", async () => {
    const loaded = await loadDocument(serveDocument({ http: { publicOrigin: "https://gateway.example.ts.net:8443" } }));
    expect(loaded.http.publicOrigin).toBe("https://gateway.example.ts.net:8443");
    expect(loaded.http.port).toBe(4317);
    expect(publicOriginHttpsPort(loaded.http.publicOrigin)).toBe(8443);
  });

  test("serve mode refuses an origin carrying a path, a trailing slash, or a redundant default port", async () => {
    for (const publicOrigin of [
      "https://gateway.example.ts.net/gw",
      "https://gateway.example.ts.net/",
      "https://gateway.example.ts.net:443",
    ]) {
      await expect(loadDocument(serveDocument({ http: { publicOrigin } }))).rejects.toThrow(
        "http.publicOrigin must be an exact HTTP(S) origin",
      );
    }
  }, 20_000);

  test("an inexact public origin override is refused after the file itself parses", async () => {
    await expect(loadDocument(serveDocument(), { publicOrigin: "https://gateway.example.ts.net/gw" })).rejects.toThrow(
      "http.publicOrigin must be an exact URL origin",
    );
  });

  test("serve mode refuses an empty allowlist from the file and from a mode override", async () => {
    await expect(loadDocument(serveDocument({ auth: { allowedLogins: [] } }))).rejects.toThrow(
      "tailscale-serve mode requires at least one allowed login",
    );
    await expect(
      loadDocument(devDocument(), { mode: "tailscale-serve", publicOrigin: "https://gateway.example.ts.net" }),
    ).rejects.toThrow("tailscale-serve mode requires at least one allowed login");
    const promoted = await loadDocument(devDocument({ auth: { allowedLogins: ["user@example.com"] } }), {
      mode: "tailscale-serve",
      publicOrigin: "https://gateway.example.ts.net",
    });
    expect(promoted.auth.mode).toBe("tailscale-serve");
    expect(promoted.http.publicOrigin).toBe("https://gateway.example.ts.net");
  }, 20_000);

  test("dev mode refuses an origin whose port or host disagrees with the listener", async () => {
    await expect(loadDocument(devDocument({ http: { publicOrigin: "http://127.0.0.1:4318" } }))).rejects.toThrow(
      "dev-localhost mode requires the configured loopback HTTP origin",
    );
    await expect(
      loadDocument(devDocument({ http: { hostname: "::1", publicOrigin: "http://127.0.0.1:4317" } })),
    ).rejects.toThrow("dev-localhost mode requires the configured loopback HTTP origin");
    const loaded = await loadDocument(devDocument({ http: { port: 4319, publicOrigin: "http://127.0.0.1:4319" } }));
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:4319");
    expect(loaded.http.port).toBe(4319);
  }, 20_000);

  test("a dev-mode port override moves the public origin, and an explicit origin must agree with it", async () => {
    const configPath = await configFixture(JSON.stringify(devDocument()));
    const moved = await loadGatewayConfig({ configPath, port: 4321 });
    expect(moved.http.port).toBe(4321);
    expect(moved.http.publicOrigin).toBe("http://127.0.0.1:4321");
    await expect(
      loadGatewayConfig({ configPath, port: 4321, publicOrigin: "http://127.0.0.1:4317" }),
    ).rejects.toThrow("dev-localhost mode requires the configured loopback HTTP origin");
  });

  test("an override port stays inside the port range", async () => {
    const configPath = await configFixture(JSON.stringify(devDocument()));
    expect((await loadGatewayConfig({ configPath, port: 65_535 })).http.port).toBe(65_535);
    for (const port of [0, 65_536]) {
      await expect(loadGatewayConfig({ configPath, port })).rejects.toThrow(
        "http.port must be an integer from 1 to 65535",
      );
    }
  });

  test("refuses an unrecognized auth mode instead of falling back to a default", async () => {
    await expect(loadDocument(devDocument({ auth: { mode: "dev" } }))).rejects.toThrow("invalid auth.mode");
  });

  test("an absent config file yields dev defaults but never a serve-mode gateway", async () => {
    const configPath = join(await privateRoot(), "absent.json");
    const loaded = await loadGatewayConfig({ configPath, mode: "dev-localhost" });
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:4317");
    expect(loaded.auth.allowedLogins).toEqual([]);
    expect(await Bun.file(configPath).exists()).toBe(false);
    await expect(loadGatewayConfig({ configPath })).rejects.toThrow(
      "tailscale-serve mode requires an exact HTTPS public origin",
    );
  });

  test("a malformed config file fails the load instead of falling back to defaults", async () => {
    const configPath = await configFixture("{ not json");
    await expect(loadGatewayConfig({ configPath, mode: "dev-localhost" })).rejects.toThrow(SyntaxError);
  });
});

describe("config key admission", () => {
  test("rejects an unknown key in every section with a section-specific message", async () => {
    await expect(loadDocument({ ...devDocument(), htp: {} })).rejects.toThrow("unknown config key: htp");
    await expect(loadDocument(devDocument({ http: { portt: 4317 } }))).rejects.toThrow(
      "unknown http config key: portt",
    );
    await expect(loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevices: true } }))).rejects.toThrow(
      "unknown auth config key: trustIdentityWithoutTailnetDevices",
    );
    await expect(loadDocument(devDocument({ registry: { heartbeatSecond: 10 } }))).rejects.toThrow(
      "unknown registry config key: heartbeatSecond",
    );
  }, 20_000);

  test("rejects a document or a section that is not an object", async () => {
    await expect(loadDocument([])).rejects.toThrow("config must be an object");
    await expect(loadGatewayConfig({ configPath: await configFixture("null"), mode: "dev-localhost" })).rejects.toThrow(
      "config must be an object",
    );
    await expect(loadDocument({ http: [] })).rejects.toThrow("config sections must be objects");
    await expect(loadDocument({ registry: 3 })).rejects.toThrow("config sections must be objects");
  }, 20_000);

  test("accepts the tailnet trust assertion only as a boolean and records it only when asserted", async () => {
    const asserted = await loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevice: true } }));
    expect(asserted.auth.trustIdentityWithoutTailnetDevice).toBe(true);
    const declined = await loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevice: false } }));
    expect("trustIdentityWithoutTailnetDevice" in declined.auth).toBe(false);
    const absent = await loadDocument(devDocument());
    expect("trustIdentityWithoutTailnetDevice" in absent.auth).toBe(false);
    await expect(loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevice: "true" } }))).rejects.toThrow(
      "auth.trustIdentityWithoutTailnetDevice must be a boolean",
    );
  }, 20_000);

  test("requires a loopback listener hostname", async () => {
    for (const hostname of ["0.0.0.0", "localhost", "10.0.0.1"]) {
      await expect(loadDocument(devDocument({ http: { hostname } }))).rejects.toThrow("http.hostname must be loopback");
    }
    expect((await loadDocument(devDocument())).http.hostname).toBe("127.0.0.1");
    const sixed = await loadDocument(devDocument({ http: { hostname: "::1", publicOrigin: "http://[::1]:4317" } }));
    expect(sixed.http.hostname).toBe("::1");
    expect(sixed.http.publicOrigin).toBe("http://[::1]:4317");
  }, 20_000);
});

describe("registry bounds admission", () => {
  test("refuses a heartbeat outside its bounds or of the wrong shape", async () => {
    for (const heartbeatSeconds of [1, 61, 10.5, "10", true]) {
      await expect(loadDocument(devDocument({ registry: { heartbeatSeconds } }))).rejects.toThrow(
        "registry.heartbeatSeconds must be an integer from 2 to 60",
      );
    }
  }, 20_000);

  test("refuses a TTL outside its bounds or of the wrong shape", async () => {
    for (const ttlSeconds of [4, 301, 35.5, "35", true]) {
      await expect(loadDocument(devDocument({ registry: { ttlSeconds } }))).rejects.toThrow(
        "registry.ttlSeconds must be an integer from 5 to 300",
      );
    }
  }, 20_000);

  test("accepts both ends of the heartbeat and TTL ranges", async () => {
    const minimal = (await loadDocument(devDocument({ registry: { heartbeatSeconds: 2, ttlSeconds: 5 } }))).registry;
    expect([minimal.heartbeatSeconds, minimal.ttlSeconds]).toEqual([2, 5]);
    const maximal = (await loadDocument(devDocument({ registry: { heartbeatSeconds: 60, ttlSeconds: 300 } }))).registry;
    expect([maximal.heartbeatSeconds, maximal.ttlSeconds]).toEqual([60, 300]);
  }, 20_000);

  test("requires the TTL to exceed two heartbeat intervals at the exact boundary", async () => {
    await expect(loadDocument(devDocument({ registry: { heartbeatSeconds: 10, ttlSeconds: 20 } }))).rejects.toThrow(
      "registry.ttlSeconds must exceed two heartbeat intervals",
    );
    const short = await loadDocument(devDocument({ registry: { heartbeatSeconds: 10, ttlSeconds: 21 } }));
    expect(short.registry.ttlSeconds).toBe(21);
    await expect(loadDocument(devDocument({ registry: { heartbeatSeconds: 60, ttlSeconds: 120 } }))).rejects.toThrow(
      "registry.ttlSeconds must exceed two heartbeat intervals",
    );
    const long = await loadDocument(devDocument({ registry: { heartbeatSeconds: 60, ttlSeconds: 121 } }));
    expect(long.registry.ttlSeconds).toBe(121);
    // A TTL below its own floor is a range failure, not a heartbeat-relation failure: the operator is
    // told which number is wrong rather than being pointed at the pair.
    await expect(loadDocument(devDocument({ registry: { heartbeatSeconds: 2, ttlSeconds: 4 } }))).rejects.toThrow(
      "registry.ttlSeconds must be an integer from 5 to 300",
    );
  }, 20_000);

  test("bounds the publisher and session ceilings", async () => {
    const wide = (await loadDocument(devDocument({ registry: { maxPublishers: 1_000, maxSessions: 1 } }))).registry;
    expect([wide.maxPublishers, wide.maxSessions]).toEqual([1_000, 1]);
    await expect(loadDocument(devDocument({ registry: { maxPublishers: 0 } }))).rejects.toThrow(
      "registry.maxPublishers must be an integer from 1 to 1000",
    );
    await expect(loadDocument(devDocument({ registry: { maxSessions: 1_001 } }))).rejects.toThrow(
      "registry.maxSessions must be an integer from 1 to 1000",
    );
  }, 20_000);
});

describe("allowlist admission", () => {
  test("folds case, trims, and collapses duplicates while preserving first-seen order", async () => {
    const loaded = await loadDocument(
      serveDocument({
        auth: {
          allowedLogins: [" User@Example.COM ", "user@example.com", "OTHER@Example.com", "USER@EXAMPLE.COM "],
        },
      }),
    );
    expect(loaded.auth.allowedLogins).toEqual(["user@example.com", "other@example.com"]);
  });

  test("collapses logins that differ only by Unicode composition", async () => {
    const loaded = await loadDocument(
      serveDocument({ auth: { allowedLogins: ["u\u0301ser@example.com", "\u00faser@example.com"] } }),
    );
    expect(loaded.auth.allowedLogins).toEqual(["\u00faser@example.com"]);
  });

  test("refuses an entry that cannot name exactly one login", async () => {
    for (const login of [
      "*",
      "*@example.com",
      "",
      "   ",
      "first@example.com,second@example.com",
      "first\nsecond@example.com",
      `${"a".repeat(309)}@example.com`,
    ]) {
      await expect(loadDocument(serveDocument({ auth: { allowedLogins: [login] } }))).rejects.toThrow(
        "invalid Tailscale login allowlist entry",
      );
    }
    const longest = await loadDocument(serveDocument({ auth: { allowedLogins: [`${"a".repeat(308)}@example.com`] } }));
    expect(longest.auth.allowedLogins[0]?.length).toBe(320);
  }, 30_000);

  test("refuses an allowlist that is not an array of strings", async () => {
    await expect(loadDocument(serveDocument({ auth: { allowedLogins: "user@example.com" } }))).rejects.toThrow(
      "auth.allowedLogins must be an array of login strings",
    );
    await expect(loadDocument(serveDocument({ auth: { allowedLogins: ["user@example.com", 42] } }))).rejects.toThrow(
      "auth.allowedLogins must be an array of login strings",
    );
  });
});

describe("private file admission", () => {
  test("refuses a config file that any other account could read", async () => {
    if (process.platform === "win32") return;
    const configPath = await configFixture(JSON.stringify(devDocument()));
    expect((await loadGatewayConfig({ configPath })).http.port).toBe(4317);
    for (const mode of [0o640, 0o604, 0o666]) {
      await chmod(configPath, mode);
      await expect(loadGatewayConfig({ configPath })).rejects.toThrow(
        `unsafe private file permissions: ${configPath}`,
      );
    }
    await chmod(configPath, 0o600);
    expect((await loadGatewayConfig({ configPath })).http.port).toBe(4317);
  });

  test("refuses a readable publisher token and never mints one on a plain load", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    await expect(loadPublisherToken(config)).rejects.toThrow("ENOENT");
    expect(await Bun.file(config.paths.tokenPath).exists()).toBe(false);
    const token = await loadOrCreatePublisherToken(config);
    await assertPublisherTokenPrivate(config);
    await chmod(config.paths.tokenPath, 0o640);
    await expect(assertPublisherTokenPrivate(config)).rejects.toThrow(
      `unsafe private file permissions: ${config.paths.tokenPath}`,
    );
    await chmod(config.paths.tokenPath, 0o600);
    expect(await loadPublisherToken(config)).toBe(token);
    const target = join(root, "external-token");
    await writeFile(target, `${"A".repeat(43)}\n`, { mode: 0o600 });
    await rm(config.paths.tokenPath);
    await symlink(target, config.paths.tokenPath);
    await expect(loadPublisherToken(config)).rejects.toThrow(`unsafe private file: ${config.paths.tokenPath}`);
  }, 20_000);

  test("refuses to use a token directory that any other account could enter", async () => {
    if (process.platform === "win32") return;
    const config = configForRoot(await privateRoot());
    const token = await loadOrCreatePublisherToken(config);
    for (const mode of [0o750, 0o701, 0o777]) {
      await chmod(config.paths.configDir, mode);
      await expect(loadPublisherToken(config)).rejects.toThrow(
        `unsafe private directory: ${config.paths.configDir}`,
      );
    }
    await chmod(config.paths.configDir, 0o700);
    expect(await loadPublisherToken(config)).toBe(token);
  }, 20_000);

  test("accepts a config file at exactly the size limit", async () => {
    const document = JSON.stringify(devDocument());
    const padded = `${document}${" ".repeat(64 * 1_024 - Buffer.byteLength(document))}`;
    expect(Buffer.byteLength(padded)).toBe(64 * 1_024);
    const configPath = await configFixture(padded);
    expect((await loadGatewayConfig({ configPath })).http.port).toBe(4317);
  }, 20_000);
});

describe("public origin admission", () => {
  test("refuses an origin that is not a string or cannot be parsed", async () => {
    await expect(loadDocument(devDocument({ http: { publicOrigin: 42 } }))).rejects.toThrow(
      "http.publicOrigin must be a URL origin",
    );
    await expect(loadDocument(devDocument({ http: { publicOrigin: "127.0.0.1:4317" } }))).rejects.toThrow(TypeError);
  });

  test("refuses a scheme the gateway cannot serve", async () => {
    for (const publicOrigin of ["ftp://gateway.example.ts.net", "wss://gateway.example.ts.net", "file:///etc"]) {
      await expect(loadDocument(serveDocument({ http: { publicOrigin } }))).rejects.toThrow(
        "http.publicOrigin must be an exact HTTP(S) origin",
      );
    }
  }, 20_000);

  test("refuses an origin that URL normalization would rewrite", async () => {
    // The stored origin is compared byte-for-byte against a request `Origin`, so anything the parser
    // would silently canonicalize has to be refused at load rather than accepted in a rewritten form
    // the operator never wrote.
    for (const publicOrigin of [
      "https://operator:hunter2@gateway.example.ts.net",
      "HTTPS://GATEWAY.EXAMPLE.TS.NET",
      "https://gateway.example.ts.net?probe=1",
      "https://gateway.example.ts.net#fragment",
    ]) {
      await expect(loadDocument(serveDocument({ http: { publicOrigin } }))).rejects.toThrow(
        "http.publicOrigin must be an exact HTTP(S) origin",
      );
    }
  }, 20_000);

  test("refuses a listener port from the file that is not an integer in range", async () => {
    for (const port of ["4317", 4317.5, true, 1e10, 0]) {
      await expect(loadDocument(devDocument({ http: { port } }))).rejects.toThrow(
        "http.port must be an integer from 1 to 65535",
      );
    }
  }, 20_000);
});

describe("publisher token admission", () => {
  async function tokenFixture(content: string): Promise<GatewayConfig> {
    const config = configForRoot(await privateRoot());
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(config.paths.tokenPath, content, { mode: 0o600 });
    await secureWindowsFixture(config.paths.tokenPath);
    return config;
  }

  test("accepts exactly 43 base64url characters, with or without a line ending", async () => {
    const token = `-_azAZ09${"x".repeat(35)}`;
    expect(token.length).toBe(43);
    for (const content of [token, `${token}\n`, `${token}\r\n`]) {
      const config = await tokenFixture(content);
      expect(await loadPublisherToken(config)).toBe(token);
      await assertPublisherTokenPrivate(config);
    }
  }, 20_000);

  test("refuses a token of the wrong length or alphabet instead of minting a replacement", async () => {
    for (const content of [
      "A".repeat(42),
      `${"A".repeat(42)}\n`,
      `${"A".repeat(44)}\n`,
      `${"A".repeat(42)}+\n`,
      `${"A".repeat(42)}=\n`,
      // A valid token padded out to a larger file: the read is bounded by the token's own size, so
      // trailing content is a malformed token file rather than something to be trimmed away.
      `${"A".repeat(43)}${" ".repeat(64)}`,
    ]) {
      const config = await tokenFixture(content);
      await expect(loadPublisherToken(config)).rejects.toThrow("publisher token has invalid encoding or length");
      // A corrupt token must fail loudly. Minting over it would revoke every publisher's capability
      // while reporting success, and the operator would have no way to tell that from a clean start.
      await expect(loadOrCreatePublisherToken(config)).rejects.toThrow(
        "publisher token has invalid encoding or length",
      );
      expect(await readFile(config.paths.tokenPath, "utf8")).toBe(content);
    }
  }, 30_000);

  test("rotation refuses a token path that is not a file and leaves its contents alone", async () => {
    const config = configForRoot(await privateRoot());
    await mkdir(config.paths.tokenPath, { recursive: true, mode: 0o700 });
    await writeFile(join(config.paths.tokenPath, "occupant"), "not a token\n", { mode: 0o600 });
    await expect(rotatePublisherToken(config)).rejects.toThrow("refusing to replace a non-file publisher token path");
    expect(await readdir(config.paths.tokenPath)).toEqual(["occupant"]);
  }, 20_000);
});

describe("private directory admission", () => {
  test("refuses a symlinked configuration directory instead of writing the token through it", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, config.paths.configDir);
    await expect(ensureRuntimeDirectories(config)).rejects.toThrow(
      `unsafe private directory: ${config.paths.configDir}`,
    );
    await expect(loadOrCreatePublisherToken(config)).rejects.toThrow(
      `unsafe private directory: ${config.paths.configDir}`,
    );
    // The refusal has to happen before anything is written: a token minted through the link would
    // live outside the tree whose privacy every other assertion here measures.
    expect(await readdir(outside)).toEqual([]);
  }, 20_000);

  test("refuses a runtime directory any other account could enter", async () => {
    if (process.platform === "win32") return;
    const config = configForRoot(await privateRoot());
    await ensureRuntimeDirectories(config);
    for (const mode of [0o755, 0o701, 0o770]) {
      await chmod(config.paths.runtimeDir, mode);
      await expect(ensureRuntimeDirectories(config)).rejects.toThrow(
        `unsafe private directory: ${config.paths.runtimeDir}`,
      );
    }
    await chmod(config.paths.runtimeDir, 0o700);
    await ensureRuntimeDirectories(config);
  }, 20_000);
});

describe("private text files", () => {
  test("refuses a size limit that cannot bound a read", async () => {
    const path = join(await privateRoot(), "push-state.json");
    await writeFile(path, "x", { mode: 0o600 });
    await secureWindowsFixture(path);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readPrivateTextFile(path, limit)).rejects.toThrow("invalid private file size limit");
    }
    expect(await readPrivateTextFile(path, 1)).toBe("x");
  }, 20_000);

  test("reads at the size limit, refuses past it, and reports an absent file as absent", async () => {
    const root = await privateRoot();
    const path = join(root, "push-state.json");
    await writeFile(path, "0123456789", { mode: 0o600 });
    await secureWindowsFixture(path);
    expect(await readPrivateTextFile(path, 10)).toBe("0123456789");
    await expect(readPrivateTextFile(path, 9)).rejects.toThrow(`private file exceeds size limit: ${path}`);
    expect(await readPrivateTextFile(join(root, "absent.json"), 10)).toBeUndefined();
  }, 20_000);

  test("refuses a private read of a permissive file or through a symlink", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const path = join(root, "push-state.json");
    await writeFile(path, "{}", { mode: 0o600 });
    expect(await readPrivateTextFile(path, 64)).toBe("{}");
    await chmod(path, 0o644);
    await expect(readPrivateTextFile(path, 64)).rejects.toThrow(`unsafe private file permissions: ${path}`);
    await chmod(path, 0o600);
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(readPrivateTextFile(link, 64)).rejects.toThrow(`unsafe private file: ${link}`);
  });

  test("replaces content, tightens the mode, and leaves no temporary file behind", async () => {
    const root = await privateRoot();
    const path = join(root, "push-state.json");
    await writeFile(path, "world-readable original\n", { mode: 0o644 });
    await writePrivateTextFile(path, "replacement\n");
    expect(await readFile(path, "utf8")).toBe("replacement\n");
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
    // The write lands through a uniquely named temporary; a leftover sibling would be a second copy
    // of the same private content with nobody responsible for removing it.
    expect(await readdir(root)).toEqual(["push-state.json"]);
  }, 20_000);

  test("replaces a symlinked destination instead of writing through it", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const target = join(root, "outside.json");
    const path = join(root, "push-state.json");
    await writeFile(target, "untouched\n", { mode: 0o600 });
    await symlink(target, path);
    await writePrivateTextFile(path, "replacement\n");
    expect(await readFile(target, "utf8")).toBe("untouched\n");
    expect((await lstat(path)).isSymbolicLink()).toBeFalse();
    expect(await readFile(path, "utf8")).toBe("replacement\n");
  });
});

describe("config snapshot restore", () => {
  test("captures an unsafe or oversized config as an error rather than as an absent snapshot", async () => {
    // A snapshot that reads "no config existed" is a licence to delete on restore, so a config the
    // capture could not safely read must stop the operation instead of becoming that snapshot.
    const root = await privateRoot();
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, " ".repeat(64 * 1_024 + 1), { mode: 0o600 });
    await secureWindowsFixture(oversized);
    await expect(captureGatewayConfigFile(oversized)).rejects.toThrow("config file exceeds size limit");
    if (process.platform === "win32") return;
    const permissive = join(root, "permissive.json");
    await writeFile(permissive, "{}\n", { mode: 0o644 });
    await expect(captureGatewayConfigFile(permissive)).rejects.toThrow(
      `unsafe private file permissions: ${permissive}`,
    );
  }, 20_000);

  test("restoring an absent snapshot over a symlink refuses instead of removing its target", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const path = join(root, "config.json");
    const target = join(root, "outside.json");
    await writeFile(target, "another account's file\n", { mode: 0o600 });
    await symlink(target, path);
    await expect(restoreGatewayConfigFile({ path, content: undefined })).rejects.toThrow(
      "refusing to remove an unsafe config path",
    );
    expect(await readFile(target, "utf8")).toBe("another account's file\n");
    expect((await lstat(path)).isSymbolicLink()).toBeTrue();
  });

  test("restoring an absent snapshot succeeds when the config is already gone", async () => {
    // The revert path of a failed install runs this against a config that may never have existed;
    // turning that into an ENOENT would report a failed rollback of a rollback.
    const path = join(await privateRoot(), "config.json");
    await restoreGatewayConfigFile({ path, content: undefined });
    expect(await Bun.file(path).exists()).toBe(false);
    await restoreGatewayConfigFile({ path, content: undefined });
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("refuses to restore a config into a directory another account could enter", async () => {
    if (process.platform === "win32") return;
    const directory = join(await privateRoot(), "config");
    await mkdir(directory, { mode: 0o755 });
    const path = join(directory, "config.json");
    await expect(restoreGatewayConfigFile({ path, content: "{}\n" })).rejects.toThrow(
      `unsafe private directory: ${directory}`,
    );
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("registry socket admission", () => {
  test("accepts only a private socket at the derived runtime path", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    await ensureRuntimeDirectories(config);
    const server = Bun.listen({ unix: config.paths.socketPath, socket: { data() {} } });
    try {
      await chmod(config.paths.socketPath, 0o600);
      await assertSocketPrivate(config);
      for (const mode of [0o660, 0o606, 0o666]) {
        await chmod(config.paths.socketPath, mode);
        await expect(assertSocketPrivate(config)).rejects.toThrow("registry socket permissions are unsafe");
      }
      await chmod(config.paths.socketPath, 0o600);
      await assertSocketPrivate(config);
      // The location is part of the guarantee, not decoration: a socket whose parent is not the
      // runtime directory has not been covered by that directory's privacy assertion.
      await expect(
        assertSocketPrivate({ ...config, paths: { ...config.paths, runtimeDir: join(root, "elsewhere") } }),
      ).rejects.toThrow("unexpected registry socket path");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("refuses a regular file standing in for the registry socket", async () => {
    if (process.platform === "win32") return;
    const config = configForRoot(await privateRoot());
    await ensureRuntimeDirectories(config);
    await writeFile(config.paths.socketPath, "not a socket", { mode: 0o600 });
    await expect(assertSocketPrivate(config)).rejects.toThrow("registry socket permissions are unsafe");
    await expect(removeRuntimeSocket(config)).rejects.toThrow("refusing to replace unsafe registry endpoint");
    expect(await readFile(config.paths.socketPath, "utf8")).toBe("not a socket");
  }, 20_000);

  test("removes our own socket, tolerates an absent one, and refuses a symlinked one", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    await ensureRuntimeDirectories(config);
    // The ordinary first start: nothing to remove is not an error.
    await removeRuntimeSocket(config);

    const external = join(root, "external.sock");
    const foreign = Bun.listen({ unix: external, socket: { data() {} } });
    try {
      await symlink(external, config.paths.socketPath);
      await expect(removeRuntimeSocket(config)).rejects.toThrow("refusing to replace unsafe registry endpoint");
      expect((await lstat(external)).isSocket()).toBeTrue();
      await rm(config.paths.socketPath);
    } finally {
      foreign.stop(true);
    }

    const own = Bun.listen({ unix: config.paths.socketPath, socket: { data() {} } });
    try {
      expect((await lstat(config.paths.socketPath)).isSocket()).toBeTrue();
      await removeRuntimeSocket(config);
      expect(await Bun.file(config.paths.socketPath).exists()).toBe(false);
    } finally {
      own.stop(true);
    }
  }, 20_000);
});

describe("private path derivation", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  test("derives every private path from the XDG overrides", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    const paths = defaultGatewayPaths();
    expect(paths.configDir).toBe(join(root, "config", "omp-session-gateway"));
    expect(paths.stateDir).toBe(join(root, "state", "omp-session-gateway"));
    expect(paths.configPath).toBe(join(paths.configDir, "config.json"));
    expect(paths.tokenPath).toBe(join(paths.configDir, "publisher-token"));
    // `assertSocketPrivate` refuses a socket whose parent is not the runtime directory, so these two
    // derivations have to agree or no gateway starts at all.
    expect(dirname(paths.socketPath)).toBe(paths.runtimeDir);
    expect(basename(paths.socketPath)).toBe("registry.sock");
  });

  test("falls back to the per-user home locations when no XDG override is set", () => {
    if (process.platform === "win32") return;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;
    const paths = defaultGatewayPaths();
    expect(paths.configDir).toBe(join(homedir(), ".config", "omp-session-gateway"));
    expect(paths.stateDir).toBe(join(homedir(), ".local", "state", "omp-session-gateway"));
  });

  test("keeps the runtime directory scoped to this account on every platform", async () => {
    const root = await privateRoot();
    process.env.XDG_RUNTIME_DIR = join(root, "run");
    if (process.platform === "darwin") {
      process.env.TMPDIR = join(root, "tmp");
      // macOS has no XDG runtime directory. Honouring the Linux variable here would put the socket
      // where a foreign `XDG_RUNTIME_DIR` says rather than in this account's own temporary tree.
      expect(defaultGatewayPaths().runtimeDir).toBe(join(root, "tmp", `omp-session-gateway-${process.getuid?.()}`));
    } else if (process.platform === "linux") {
      expect(defaultGatewayPaths().runtimeDir).toBe(join(root, "run", "omp-session-gateway"));
    } else {
      const paths = defaultGatewayPaths();
      expect(paths.runtimeDir).toBe(paths.stateDir);
    }
  });
});

describe("production config authoring", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  /**
   * The only group here that writes through the real path derivation rather than an injected path.
   * The sandbox is therefore asserted rather than assumed: if `defaultGatewayPaths` ever stops
   * reading the environment, these tests have to fail on this assertion instead of writing into the
   * operator's own configuration directory.
   */
  async function isolatedHome(): Promise<GatewayConfig["paths"]> {
    const root = await privateRoot();
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.LOCALAPPDATA = join(root, "local");
    const paths = defaultGatewayPaths();
    expect(paths.configPath.startsWith(root)).toBe(true);
    expect(paths.stateDir.startsWith(root)).toBe(true);
    return paths;
  }

  test("writes a private serve-mode config that reloads to the same gateway", async () => {
    const paths = await isolatedHome();
    const written = await writeGatewayConfigFile({
      publicOrigin: "https://gateway.example.ts.net",
      allowedLogins: [" User@Example.COM ", "user@example.com", "Other@example.com"],
      port: 4319,
    });
    expect(written.http).toEqual({
      hostname: "127.0.0.1",
      port: 4319,
      publicOrigin: "https://gateway.example.ts.net",
    });
    expect(written.auth.mode).toBe("tailscale-serve");
    expect(written.auth.allowedLogins).toEqual(["user@example.com", "other@example.com"]);
    expect(written.paths.configPath).toBe(paths.configPath);
    if (process.platform !== "win32") {
      expect((await lstat(paths.configPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(paths.configDir)).mode & 0o077).toBe(0);
      expect((await lstat(paths.stateDir)).mode & 0o077).toBe(0);
    }
    // Only the three admitted sections may reach the file, because an unknown key written here would
    // fail every subsequent load rather than being ignored.
    expect(Object.keys(JSON.parse(await readFile(paths.configPath, "utf8")) as object)).toEqual([
      "http",
      "auth",
      "registry",
    ]);
    expect(await loadGatewayConfig({ configPath: paths.configPath })).toEqual(written);
  }, 20_000);

  test("refuses an origin or an allowlist it must not persist, and writes nothing when it refuses", async () => {
    const paths = await isolatedHome();
    for (const publicOrigin of [
      "http://gateway.example.ts.net",
      "https://gateway.example.ts.net/gw",
      "https://gateway.example.ts.net/",
    ]) {
      await expect(writeGatewayConfigFile({ publicOrigin, allowedLogins: ["user@example.com"] })).rejects.toThrow(
        "production public origin must be an exact HTTPS origin",
      );
    }
    await expect(
      writeGatewayConfigFile({ publicOrigin: "https://gateway.example.ts.net", allowedLogins: [] }),
    ).rejects.toThrow("at least one allowed Tailscale login is required");
    await expect(
      writeGatewayConfigFile({ publicOrigin: "https://gateway.example.ts.net", allowedLogins: ["*"] }),
    ).rejects.toThrow("invalid Tailscale login allowlist entry");
    // Every refusal above precedes the write, so a rejected `install` leaves no config the daemon
    // would later refuse to load.
    expect(await Bun.file(paths.configPath).exists()).toBe(false);
  }, 20_000);

  test("writes a development config whose HTTP origin serve mode would refuse", async () => {
    const paths = await isolatedHome();
    const written = await writeGatewayConfigFile({
      publicOrigin: "http://127.0.0.1:4319",
      allowedLogins: [],
      port: 4319,
      mode: "dev-localhost",
    });
    expect(written.auth.mode).toBe("dev-localhost");
    expect(written.http.publicOrigin).toBe("http://127.0.0.1:4319");
    expect(written.auth.allowedLogins).toEqual([]);
    await expect(
      writeGatewayConfigFile({
        publicOrigin: "http://127.0.0.1:4319",
        allowedLogins: ["user@example.com"],
        port: 4319,
      }),
    ).rejects.toThrow("production public origin must be an exact HTTPS origin");
    // The refused serve-mode write must not have replaced the config that is there.
    expect((await loadGatewayConfig({ configPath: paths.configPath })).auth.mode).toBe("dev-localhost");
  }, 20_000);
});
