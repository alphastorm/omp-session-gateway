import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type AuthMode = "tailscale-serve" | "dev-localhost";

export interface GatewayConfig {
  readonly http: {
    readonly hostname: "127.0.0.1" | "::1";
    readonly port: number;
    readonly publicOrigin: string;
  };
  readonly auth: {
    readonly mode: AuthMode;
    readonly allowedLogins: readonly string[];
  };
  readonly registry: {
    readonly heartbeatSeconds: number;
    readonly ttlSeconds: number;
    readonly maxPublishers: number;
    readonly maxSessions: number;
  };
  readonly paths: {
    readonly configDir: string;
    readonly stateDir: string;
    readonly runtimeDir: string;
    readonly socketPath: string;
    readonly tokenPath: string;
    readonly configPath: string;
  };
}

export interface ConfigOverrides {
  readonly mode?: AuthMode;
  readonly configPath?: string;
  readonly publicOrigin?: string;
  readonly port?: number;
}

const MIN_HEARTBEAT_SECONDS = 2;
const MAX_HEARTBEAT_SECONDS = 60;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function currentUserId(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("current user ID is unavailable");
  return uid;
}

function windowsPowerShellEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return { ...environment, ...overrides };
}

async function applyWindowsAcl(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const script =
    "$Path=$env:OMP_GATEWAY_ACL_PATH; $Directory=$env:OMP_GATEWAY_ACL_DIRECTORY; " +
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$flags=if($Directory -eq '1'){'OICI'}else{''}; " +
    "$sddl='D:P(A;'+$flags+';FA;;;SY)(A;'+$flags+';FA;;;'+$sid+')'; " +
    "$acl=Get-Acl -LiteralPath $Path; $acl.SetSecurityDescriptorSddlForm($sddl); " +
    "Set-Acl -LiteralPath $Path -AclObject $acl";
  const subprocess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: windowsPowerShellEnvironment({
      OMP_GATEWAY_ACL_PATH: path,
      OMP_GATEWAY_ACL_DIRECTORY: directory ? "1" : "0",
    }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(subprocess.stderr).text();
  if ((await subprocess.exited) !== 0) throw new Error(`failed to secure private Windows path: ${stderr.trim()}`);
}

async function assertWindowsAclPrivate(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const script =
    "$Path=$env:OMP_GATEWAY_ACL_PATH; $acl=Get-Acl -LiteralPath $Path; " +
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl); " +
    "$rules=@($descriptor.DiscretionaryAcl | ForEach-Object { [pscustomobject]@{ " +
    "Sid=$_.SecurityIdentifier.Value; Type=$_.AceType.ToString(); Mask=$_.AccessMask; Flags=[int]$_.AceFlags } }); " +
    "[pscustomobject]@{ Protected=$acl.AreAccessRulesProtected; Current=$sid; Rules=@($rules) } " +
    "| ConvertTo-Json -Compress -Depth 3";
  const subprocess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: windowsPowerShellEnvironment({ OMP_GATEWAY_ACL_PATH: path }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(subprocess.stdout).text();
  if ((await subprocess.exited) !== 0) throw new Error("failed to inspect private Windows ACL");
  const value: unknown = JSON.parse(text);
  const protectedAcl = typeof value === "object" && value !== null ? Reflect.get(value, "Protected") : undefined;
  const current = typeof value === "object" && value !== null ? Reflect.get(value, "Current") : undefined;
  const rules = typeof value === "object" && value !== null ? Reflect.get(value, "Rules") : undefined;
  const expectedSids = new Set([current, "S-1-5-18"]);
  const expectedFlags = directory ? 3 : 0;
  if (
    protectedAcl !== true ||
    typeof current !== "string" ||
    !Array.isArray(rules) ||
    rules.length !== 2 ||
    rules.some(rule => {
      if (typeof rule !== "object" || rule === null) return true;
      const sid = Reflect.get(rule, "Sid");
      return (
        typeof sid !== "string" ||
        !expectedSids.delete(sid) ||
        Reflect.get(rule, "Type") !== "AccessAllowed" ||
        Reflect.get(rule, "Mask") !== 2_032_127 ||
        Reflect.get(rule, "Flags") !== expectedFlags
      );
    }) ||
    expectedSids.size !== 0
  ) {
    throw new Error("unsafe private Windows ACL");
  }
}

function privateRuntimeDir(): string {
  if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, "omp-session-gateway");
  }
  if (process.platform === "darwin") {
    return join(process.env.TMPDIR ?? tmpdir(), `omp-session-gateway-${process.getuid?.() ?? "user"}`);
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-session-gateway", "run");
}

export function defaultGatewayPaths(): GatewayConfig["paths"] {
  const windowsBase = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const configDir =
    process.platform === "win32"
      ? join(windowsBase, "OMP Session Gateway")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-session-gateway");
  const stateDir =
    process.platform === "win32"
      ? join(windowsBase, "OMP Session Gateway", "state")
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-session-gateway");
  const runtimeDir = process.platform === "win32" ? stateDir : privateRuntimeDir();
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-session-gateway-${Buffer.from(process.env.USERNAME ?? "user").toString("base64url").slice(0, 20)}`
      : join(runtimeDir, "registry.sock");
  return {
    configDir,
    stateDir,
    runtimeDir,
    socketPath,
    tokenPath: join(configDir, "publisher-token"),
    configPath: join(configDir, "config.json"),
  };
}

async function assertPrivateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe private directory: ${path}`);
  if (process.platform === "win32") {
    if (create) await applyWindowsAcl(path, true);
    await assertWindowsAclPrivate(path, true);
    return;
  }
  if (info.uid !== currentUserId() || (info.mode & 0o077) !== 0) {
    throw new Error(`unsafe private directory: ${path}`);
  }
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe private file: ${path}`);
  if (process.platform === "win32") {
    await assertWindowsAclPrivate(path, false);
    return;
  }
  if (info.uid !== currentUserId() || (info.mode & 0o077) !== 0) {
    throw new Error(`unsafe private file permissions: ${path}`);
  }
}

function validatePort(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error("http.port must be an integer from 1 to 65535");
  }
  return value as number;
}

function validateBoundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function normalizeLogin(value: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\0\r\n,]/u.test(normalized) || normalized.includes("*")) {
    throw new Error("invalid Tailscale login allowlist entry");
  }
  return normalized;
}

function parseConfigObject(raw: unknown, defaults: GatewayConfig): GatewayConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config must be an object");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["http", "auth", "registry"].includes(key)) throw new Error(`unknown config key: ${key}`);
  }
  const http = (record.http ?? {}) as Record<string, unknown>;
  const auth = (record.auth ?? {}) as Record<string, unknown>;
  const registry = (record.registry ?? {}) as Record<string, unknown>;
  if ([http, auth, registry].some(value => typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new Error("config sections must be objects");
  }
  for (const key of Object.keys(http)) {
    if (!["hostname", "port", "publicOrigin"].includes(key)) throw new Error(`unknown http config key: ${key}`);
  }
  for (const key of Object.keys(auth)) {
    if (!["mode", "allowedLogins"].includes(key)) throw new Error(`unknown auth config key: ${key}`);
  }
  for (const key of Object.keys(registry)) {
    if (!["heartbeatSeconds", "ttlSeconds", "maxPublishers", "maxSessions"].includes(key)) {
      throw new Error(`unknown registry config key: ${key}`);
    }
  }
  const hostname = http.hostname ?? defaults.http.hostname;
  if (hostname !== "127.0.0.1" && hostname !== "::1") throw new Error("http.hostname must be loopback");
  const port = validatePort(http.port ?? defaults.http.port);
  const publicOriginValue = http.publicOrigin ?? defaults.http.publicOrigin;
  if (typeof publicOriginValue !== "string") throw new Error("http.publicOrigin must be a URL origin");
  const publicOrigin = new URL(publicOriginValue);
  if (publicOrigin.origin !== publicOriginValue || !["http:", "https:"].includes(publicOrigin.protocol)) {
    throw new Error("http.publicOrigin must be an exact HTTP(S) origin");
  }
  const mode = auth.mode ?? defaults.auth.mode;
  if (mode !== "tailscale-serve" && mode !== "dev-localhost") throw new Error("invalid auth.mode");
  if (mode === "tailscale-serve" && publicOrigin.protocol !== "https:") {
    throw new Error("tailscale-serve mode requires an exact HTTPS public origin");
  }
  const allowedRaw = auth.allowedLogins ?? defaults.auth.allowedLogins;
  if (!Array.isArray(allowedRaw) || allowedRaw.some(value => typeof value !== "string")) {
    throw new Error("auth.allowedLogins must be an array of login strings");
  }
  const allowedLogins = [...new Set((allowedRaw as string[]).map(normalizeLogin))];
  if (mode === "tailscale-serve" && allowedLogins.length === 0) {
    throw new Error("tailscale-serve mode requires at least one allowed login");
  }
  const heartbeatSeconds = validateBoundedInteger(
    registry.heartbeatSeconds ?? defaults.registry.heartbeatSeconds,
    MIN_HEARTBEAT_SECONDS,
    MAX_HEARTBEAT_SECONDS,
    "registry.heartbeatSeconds",
  );
  const ttlSeconds = validateBoundedInteger(
    registry.ttlSeconds ?? defaults.registry.ttlSeconds,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
    "registry.ttlSeconds",
  );
  if (ttlSeconds <= heartbeatSeconds * 2) throw new Error("registry.ttlSeconds must exceed two heartbeat intervals");
  return {
    http: { hostname, port, publicOrigin: publicOrigin.origin },
    auth: { mode, allowedLogins },
    registry: {
      heartbeatSeconds,
      ttlSeconds,
      maxPublishers: validateBoundedInteger(
        registry.maxPublishers ?? defaults.registry.maxPublishers,
        1,
        1_000,
        "registry.maxPublishers",
      ),
      maxSessions: validateBoundedInteger(
        registry.maxSessions ?? defaults.registry.maxSessions,
        1,
        1_000,
        "registry.maxSessions",
      ),
    },
    paths: defaults.paths,
  };
}

export async function loadGatewayConfig(overrides: ConfigOverrides = {}): Promise<GatewayConfig> {
  const paths = defaultGatewayPaths();
  const defaults: GatewayConfig = {
    http: {
      hostname: "127.0.0.1",
      port: overrides.port ?? 4317,
      publicOrigin: overrides.publicOrigin ?? `http://127.0.0.1:${overrides.port ?? 4317}`,
    },
    auth: { mode: overrides.mode ?? "tailscale-serve", allowedLogins: [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 100, maxSessions: 100 },
    paths: { ...paths, configPath: overrides.configPath ?? paths.configPath },
  };
  const configPath = overrides.configPath ?? paths.configPath;
  let loaded: unknown = {};
  try {
    await assertPrivateRegularFile(configPath);
    loaded = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = parseConfigObject(loaded, defaults);
  const mode = overrides.mode ?? config.auth.mode;
  const publicOriginValue = overrides.publicOrigin ?? config.http.publicOrigin;
  const publicOrigin = new URL(publicOriginValue);
  if (publicOrigin.origin !== publicOriginValue) throw new Error("http.publicOrigin must be an exact URL origin");
  if (mode === "tailscale-serve" && publicOrigin.protocol !== "https:") {
    throw new Error("tailscale-serve mode requires an exact HTTPS public origin");
  }
  if (mode === "tailscale-serve" && config.auth.allowedLogins.length === 0) {
    throw new Error("tailscale-serve mode requires at least one allowed login");
  }
  return {
    ...config,
    auth: { ...config.auth, mode },
    http: {
      ...config.http,
      ...(overrides.port === undefined ? {} : { port: validatePort(overrides.port) }),
      publicOrigin: publicOrigin.origin,
    },
    paths: { ...paths, configPath },
  };
}

export async function ensureRuntimeDirectories(config: GatewayConfig): Promise<void> {
  await assertPrivateDirectory(config.paths.configDir, true);
  await assertPrivateDirectory(config.paths.stateDir, true);
  if (process.platform !== "win32") await assertPrivateDirectory(config.paths.runtimeDir, true);
}

export async function writeGatewayConfigFile(options: {
  readonly publicOrigin: string;
  readonly allowedLogins: readonly string[];
  readonly port?: number;
  readonly mode?: AuthMode;
}): Promise<GatewayConfig> {
  const mode = options.mode ?? "tailscale-serve";
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || (mode === "tailscale-serve" && origin.protocol !== "https:")) {
    throw new Error("production public origin must be an exact HTTPS origin");
  }
  const allowedLogins = [...new Set(options.allowedLogins.map(normalizeLogin))];
  if (mode === "tailscale-serve" && allowedLogins.length === 0) {
    throw new Error("at least one allowed Tailscale login is required");
  }
  const paths = defaultGatewayPaths();
  await assertPrivateDirectory(paths.configDir, true);
  await assertPrivateDirectory(paths.stateDir, true);
  const temporaryPath = `${paths.configPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const configDocument = {
    http: { hostname: "127.0.0.1", port: validatePort(options.port ?? 4317), publicOrigin: origin.origin },
    auth: { mode, allowedLogins },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 100, maxSessions: 100 },
  };
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(configDocument, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, paths.configPath);
  if (process.platform === "win32") await applyWindowsAcl(paths.configPath, false);
  else await chmod(paths.configPath, 0o600);
  return loadGatewayConfig({ configPath: paths.configPath });
}

async function writeFreshToken(path: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  if (process.platform === "win32") await applyWindowsAcl(path, false);
  else await chmod(path, 0o600);
  return token;
}

async function readExistingPublisherToken(config: GatewayConfig): Promise<string> {
  await assertPrivateRegularFile(config.paths.tokenPath);
  const token = (await readFile(config.paths.tokenPath, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("publisher token has invalid encoding or length");
  return token;
}

export async function assertPublisherTokenPrivate(config: GatewayConfig): Promise<void> {
  await readExistingPublisherToken(config);
}

export async function loadOrCreatePublisherToken(config: GatewayConfig): Promise<string> {
  await ensureRuntimeDirectories(config);
  try {
    return await readExistingPublisherToken(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return writeFreshToken(config.paths.tokenPath);
  }
}

export async function rotatePublisherToken(config: GatewayConfig): Promise<void> {
  await ensureRuntimeDirectories(config);
  try {
    await assertPrivateRegularFile(config.paths.tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFreshToken(config.paths.tokenPath);
}

export function publisherTokenMatches(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const padded = Buffer.alloc(expectedBytes.length);
  suppliedBytes.copy(padded, 0, 0, expectedBytes.length);
  return timingSafeEqual(expectedBytes, padded) && suppliedBytes.length === expectedBytes.length;
}

export async function removeRuntimeSocket(config: GatewayConfig): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const info = await lstat(config.paths.socketPath);
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== currentUserId()) {
      throw new Error("refusing to replace unsafe registry endpoint");
    }
    await rm(config.paths.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function assertSocketPrivate(config: GatewayConfig): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(config.paths.socketPath);
  if (!info.isSocket() || info.uid !== currentUserId() || (info.mode & 0o077) !== 0) {
    throw new Error("registry socket permissions are unsafe");
  }
  if (dirname(config.paths.socketPath) !== config.paths.runtimeDir) throw new Error("unexpected registry socket path");
}
