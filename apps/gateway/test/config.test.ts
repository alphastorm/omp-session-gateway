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
  windowsAclSpawnCostMs,
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

const FAKE_CURRENT_SID = "S-1-5-21-2000000000-2000000001-2000000002-1001";
const FULL_CONTROL_MASK = 2_032_127;

type FakeAclOutcome = "private" | "foreign-principal" | "missing";

const fakeAcl = {
  spawns: 0,
  requests: [] as string[],
  outcomes: new Map<string, FakeAclOutcome>(),
  desynchronise: false,
  stderr: "",
  exitBeforeReply: false,
};

function answerFakeAclRequest(line: string): string {
  const request = JSON.parse(line) as { readonly i: number; readonly op: string; readonly p: string; readonly dir: number };
  fakeAcl.requests.push(`${request.op} ${request.p}`);
  const identifier = fakeAcl.desynchronise ? request.i + 1 : request.i;
  const outcome = fakeAcl.outcomes.get(request.p) ?? "private";
  if (outcome === "missing") {
    return JSON.stringify({ i: identifier, ok: false, e: `Cannot find path '${request.p}' because it does not exist.` });
  }
  if (request.op === "apply") return JSON.stringify({ i: identifier, ok: true });
  const flags = request.dir === 1 ? 3 : 0;
  const rules = [
    { Sid: "S-1-5-18", Type: "AccessAllowed", Mask: FULL_CONTROL_MASK, Flags: flags },
    { Sid: FAKE_CURRENT_SID, Type: "AccessAllowed", Mask: FULL_CONTROL_MASK, Flags: flags },
  ];
  // Mirrors `icacls /grant *S-1-1-0:F`, which is how the real fixtures above are loosened.
  if (outcome === "foreign-principal") {
    rules.push({ Sid: "S-1-1-0", Type: "AccessAllowed", Mask: FULL_CONTROL_MASK, Flags: flags });
  }
  return JSON.stringify({
    i: identifier,
    ok: true,
    acl: { Protected: true, Current: FAKE_CURRENT_SID, Owner: FAKE_CURRENT_SID, Rules: rules },
  });
}

/**
 * Stands in for `powershell.exe` speaking the ACL helper's newline-delimited JSON protocol, so the
 * Windows-only contract can be exercised on every platform. Spawns of anything else pass through.
 * Returns the restore function; call it in a `finally` so a failure cannot leak the fake platform.
 */
function installFakePowerShell(): () => void {
  const realSpawn = Bun.spawn;
  const realPlatform = process.platform;
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", { value, writable: true, configurable: true, enumerable: true });
  };
  const fakeSpawn = (command: readonly string[], options?: unknown): unknown => {
    if (command[0] !== "powershell.exe") {
      return (realSpawn as unknown as (used: readonly string[], rest?: unknown) => unknown)(command, options);
    }
    fakeAcl.spawns += 1;
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    let waiting: ((result: { value?: Uint8Array; done: boolean }) => void) | undefined;
    let stdin = "";
    return {
      stdin: {
        write: (chunk: string): number => {
          stdin += chunk;
          return chunk.length;
        },
        flush: (): number => {
          for (;;) {
            const newline = stdin.indexOf("\n");
            if (newline < 0) return 0;
            const line = stdin.slice(0, newline);
            stdin = stdin.slice(newline + 1);
            // A helper that died during start-up consumes the request and answers nothing; its
            // stdout closes instead, which the reader below reports as EOF.
            if (fakeAcl.exitBeforeReply) {
              const closed = waiting;
              waiting = undefined;
              closed?.({ done: true });
              continue;
            }
            const reply = encoder.encode(`${answerFakeAclRequest(line)}\n`);
            const resolve = waiting;
            waiting = undefined;
            if (resolve === undefined) pending.push(reply);
            else resolve({ value: reply, done: false });
          }
        },
      },
      stdout: {
        getReader: () => ({
          read: async (): Promise<{ value?: Uint8Array; done: boolean }> => {
            const next = pending.shift();
            if (next !== undefined) return { value: next, done: false };
            // A helper that dies without answering closes its stdout, which the reader sees as EOF.
            if (fakeAcl.exitBeforeReply) return { done: true };
            const gate = Promise.withResolvers<{ value?: Uint8Array; done: boolean }>();
            waiting = gate.resolve;
            return await gate.promise;
          },
        }),
      },
      // The real helper writes start-up and parse failures only to stderr, so the fake has to offer
      // the same channel or a test can never observe that they reach the caller.
      stderr: (async function* (): AsyncGenerator<Uint8Array> {
        if (fakeAcl.stderr.length > 0) yield new TextEncoder().encode(fakeAcl.stderr);
      })(),
      unref: (): undefined => undefined,
      kill: (): undefined => undefined,
    };
  };
  Bun.spawn = fakeSpawn as unknown as typeof Bun.spawn;
  setPlatform("win32");
  return () => {
    Bun.spawn = realSpawn;
    setPlatform(realPlatform);
    fakeAcl.outcomes.clear();
    fakeAcl.desynchronise = false;
    fakeAcl.stderr = "";
    fakeAcl.exitBeforeReply = false;
  };
}

/**
 * Discards whatever helper process an earlier test left cached inside `config.ts`, by answering one
 * request with the wrong id. The product treats that desynchronisation as fatal and drops the
 * helper, which both pins that guard and makes the following spawn count exact.
 */
async function dropCachedAclHelper(config: GatewayConfig): Promise<void> {
  fakeAcl.desynchronise = true;
  try {
    await expect(loadOrCreatePublisherToken(config)).rejects.toThrow("answered out of order");
  } finally {
    fakeAcl.desynchronise = false;
  }
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

describe("Windows private-path ACL enforcement", () => {
  test("secures every private path of a run from a single PowerShell process", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      await dropCachedAclHelper(config);
      const spawnsBefore = fakeAcl.spawns;
      fakeAcl.requests.length = 0;
      await loadOrCreatePublisherToken(config);
      await loadOrCreatePublisherToken(config);
      await rotatePublisherToken(config);
      // Each call applies and inspects the config and state directories and touches the token once:
      // fifteen ACL operations that used to cost fifteen `powershell.exe` starts.
      expect(fakeAcl.requests).toHaveLength(15);
      expect(fakeAcl.spawns - spawnsBefore).toBe(1);
      // `install` derives its readiness budget from this, so losing the measurement matters.
      expect(windowsAclSpawnCostMs()).toBeGreaterThanOrEqual(0);
    } finally {
      restore();
    }
  });

  test("rejects an ACL that admits a foreign principal and blames the offending path", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      await loadOrCreatePublisherToken(config);
      fakeAcl.outcomes.set(config.paths.stateDir, "foreign-principal");
      fakeAcl.requests.length = 0;
      const failure = await loadOrCreatePublisherToken(config).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("unsafe private Windows ACL");
      expect((failure as Error).message).toContain(config.paths.stateDir);
      expect((failure as Error).message).not.toContain(config.paths.configDir);
      // The safe directory ahead of it was verified, and the run stopped at the unsafe one.
      expect(fakeAcl.requests).toEqual([
        `apply ${config.paths.configDir}`,
        `inspect ${config.paths.configDir}`,
        `apply ${config.paths.stateDir}`,
        `inspect ${config.paths.stateDir}`,
      ]);
    } finally {
      restore();
    }
  });

  test("rejects a directory the ACL helper cannot resolve, naming the one that failed", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      fakeAcl.outcomes.set(config.paths.stateDir, "missing");
      await expect(loadOrCreatePublisherToken(config)).rejects.toThrow(
        `failed to secure private Windows path ${config.paths.stateDir}`,
      );
      fakeAcl.outcomes.set(config.paths.configDir, "missing");
      await expect(loadOrCreatePublisherToken(config)).rejects.toThrow(
        `failed to secure private Windows path ${config.paths.configDir}`,
      );
    } finally {
      restore();
    }
  });

  test("treats an unreadable token ACL as fatal instead of a missing token", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      await loadOrCreatePublisherToken(config);
      const stored = await readFile(config.paths.tokenPath, "utf8");
      fakeAcl.outcomes.set(config.paths.tokenPath, "missing");
      await expect(loadOrCreatePublisherToken(config)).rejects.toThrow(
        `failed to inspect private Windows ACL for ${config.paths.tokenPath}`,
      );
      // A helper failure must never be mistaken for ENOENT and remediated by minting a new token.
      expect(await readFile(config.paths.tokenPath, "utf8")).toBe(stored);
    } finally {
      restore();
    }
  });

  test("surfaces the helper's own stderr when it dies before replying", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      // The realistic failure of this design is a helper that never gets as far as its reply loop:
      // a bad script, a missing powershell.exe, a blocked execution policy. That cause reaches only
      // stderr, so discarding it would reduce every such case to "exited before replying" and leave
      // the operator with nothing to act on.
      // A helper cached by an earlier assertion would answer from its own queue and never reach the
      // start-up path this test is about.
      await dropCachedAclHelper(config);
      fakeAcl.stderr = "ParserError: unexpected token in expression";
      fakeAcl.exitBeforeReply = true;
      await expect(loadOrCreatePublisherToken(config)).rejects.toThrow("ParserError: unexpected token in expression");
    } finally {
      restore();
    }
  });
});
