import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

export function loopbackHttpOrigin(hostname: GatewayConfig["http"]["hostname"], port: number): string {
  const host = hostname === "::1" ? "[::1]" : hostname;
  return `http://${host}:${port}`;
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

/**
 * Environment for the ACL helper. `PSModulePath` is dropped so a writable module directory inherited
 * from the caller cannot inject code into the helper; every other variable is inherited because
 * `powershell.exe` needs `SystemRoot` and friends to start at all.
 */
function windowsPowerShellEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return environment;
}

/**
 * Newline-delimited JSON request loop over `Get-Acl`/`Set-Acl`.
 *
 * Starting `powershell.exe` measured 1.8-2.1 s on a 2-vCPU Windows Server 2025 host, and the daemon
 * secures or verifies five private paths before it can bind its loopback listener, so one process per
 * path consumed more than the whole `install` readiness budget and every install was torn back down
 * (#90). One process answers every request of a run instead.
 *
 * Paths arrive as JSON data and are never spliced into the script, so a hostile path cannot become
 * code. Each reply carries its request id back, so a failure can only be attributed to the path that
 * produced it. Reply text is squeezed to printable ASCII because a redirected PowerShell writes
 * stdout in the console code page, which would otherwise corrupt the framing.
 */
const WINDOWS_ACL_HELPER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$out=[Console]::Out",
  "while($true){ $line=[Console]::In.ReadLine(); if($null -eq $line){break}; if($line.Length -eq 0){continue}; " +
    "$id=0; try{ $request=$line|ConvertFrom-Json; $id=[int]$request.i; $path=[string]$request.p; " +
    "if($request.dir -eq 1){$flags='OICI'}else{$flags=''}; " +
    "if($request.op -eq 'apply'){ " +
    "$sddl='D:P(A;'+$flags+';FA;;;SY)(A;'+$flags+';FA;;;'+$sid+')'; " +
    "$acl=Get-Acl -LiteralPath $path; $acl.SetSecurityDescriptorSddlForm($sddl); " +
    "$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid)); " +
    "Set-Acl -LiteralPath $path -AclObject $acl; $reply=[pscustomobject]@{i=$id;ok=$true} " +
    "}elseif($request.op -eq 'inspect'){ " +
    "$acl=Get-Acl -LiteralPath $path; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; " +
    "$descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl); " +
    "$rules=@($descriptor.DiscretionaryAcl | ForEach-Object { [pscustomobject]@{ " +
    "Sid=$_.SecurityIdentifier.Value; Type=$_.AceType.ToString(); Mask=$_.AccessMask; Flags=[int]$_.AceFlags } }); " +
    "$reply=[pscustomobject]@{i=$id;ok=$true;acl=[pscustomobject]@{ " +
    "Protected=$acl.AreAccessRulesProtected; Current=$sid; Owner=$owner; Rules=@($rules) }} " +
    "}else{ throw 'unsupported private ACL operation' } " +
    "}catch{ $reply=[pscustomobject]@{i=$id;ok=$false;e=([string]$_.Exception.Message -replace '[^\\x20-\\x7E]','?')} }; " +
    "$out.WriteLine(($reply|ConvertTo-Json -Compress -Depth 6)); $out.Flush() }",
].join("; ");

interface WindowsAclHelper {
  readonly send: (line: string) => Promise<void>;
  readonly receive: () => Promise<Uint8Array | undefined>;
  readonly kill: () => void;
  readonly decoder: TextDecoder;
  buffer: string;
  nextRequestId: number;
  spawnCostMs: number | undefined;
}

let windowsAclHelper: WindowsAclHelper | undefined;
let windowsAclHelperSpawnCostMs: number | undefined;
let windowsAclRequestTail: Promise<unknown> = Promise.resolve();

/**
 * JSON restricted to printable ASCII, so the helper's stdin code page cannot mangle a path. Matching
 * per UTF-16 code unit is deliberate: each surrogate half becomes its own escape, which
 * `ConvertFrom-Json` recombines into the original code point.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7E]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function startWindowsAclHelper(): WindowsAclHelper {
  const subprocess = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_HELPER_SCRIPT],
    { env: windowsPowerShellEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  // The helper must never hold the daemon's event loop open. It ends by itself: closing our stdin at
  // exit makes its `ReadLine` return null and the loop break.
  subprocess.unref();
  const stdout = subprocess.stdout.getReader();
  return {
    send: async line => {
      subprocess.stdin.write(line);
      await subprocess.stdin.flush();
    },
    receive: async () => (await stdout.read()).value,
    kill: () => subprocess.kill(),
    decoder: new TextDecoder(),
    buffer: "",
    nextRequestId: 1,
    spawnCostMs: undefined,
  };
}

function stopWindowsAclHelper(): void {
  const helper = windowsAclHelper;
  windowsAclHelper = undefined;
  if (helper === undefined) return;
  try {
    helper.kill();
  } catch {
    // Already gone; there is nothing left to reclaim.
  }
}

async function readWindowsAclReply(helper: WindowsAclHelper): Promise<string> {
  for (;;) {
    const newline = helper.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = helper.buffer.slice(0, newline).trim();
      helper.buffer = helper.buffer.slice(newline + 1);
      if (line.length > 0) return line;
      continue;
    }
    const chunk = await helper.receive();
    if (chunk === undefined) throw new Error("the private Windows ACL helper exited before replying");
    helper.buffer += helper.decoder.decode(chunk, { stream: true });
  }
}

async function performWindowsAclRequest(
  operation: "apply" | "inspect",
  path: string,
  directory: boolean,
): Promise<unknown> {
  const started = performance.now();
  let requestId = 0;
  let reply: unknown;
  try {
    const helper = (windowsAclHelper ??= startWindowsAclHelper());
    requestId = helper.nextRequestId;
    helper.nextRequestId += 1;
    await helper.send(`${asciiJson({ i: requestId, op: operation, p: path, dir: directory ? 1 : 0 })}\n`);
    reply = JSON.parse(await readWindowsAclReply(helper));
    if (helper.spawnCostMs === undefined) {
      // Only the first round trip pays for `powershell.exe` starting; the rest are pipe writes.
      helper.spawnCostMs = performance.now() - started;
      windowsAclHelperSpawnCostMs = Math.max(windowsAclHelperSpawnCostMs ?? 0, helper.spawnCostMs);
    }
  } catch (error) {
    stopWindowsAclHelper();
    throw new Error(`the private Windows ACL helper failed for ${path}`, { cause: error });
  }
  const envelope = typeof reply === "object" && reply !== null ? reply : undefined;
  if (envelope === undefined || Reflect.get(envelope, "i") !== requestId) {
    // Answering the wrong request would clear the wrong path, so a desynchronised helper is fatal.
    stopWindowsAclHelper();
    throw new Error(`the private Windows ACL helper answered out of order for ${path}`);
  }
  if (Reflect.get(envelope, "ok") !== true) {
    const failure = Reflect.get(envelope, "e");
    const detail = typeof failure === "string" && failure.length > 0 ? failure : "unknown helper failure";
    throw new Error(
      operation === "apply"
        ? `failed to secure private Windows path ${path}: ${detail}`
        : `failed to inspect private Windows ACL for ${path}: ${detail}`,
    );
  }
  return Reflect.get(envelope, "acl");
}

/**
 * Requests are strictly serialised: the helper answers one line per line it reads, so overlapping
 * writers would race for each other's replies.
 */
function windowsAclRequest(operation: "apply" | "inspect", path: string, directory: boolean): Promise<unknown> {
  const attempt = windowsAclRequestTail
    .catch(() => undefined)
    .then(() => performWindowsAclRequest(operation, path, directory));
  windowsAclRequestTail = attempt.catch(() => undefined);
  return attempt;
}

/**
 * Cost of the single `powershell.exe` start this process paid for ACL enforcement, or `undefined`
 * when no ACL work happened (every non-Windows platform). `install` derives its readiness budget
 * from it, because the daemon it starts must pay the same start before it can bind.
 */
export function windowsAclSpawnCostMs(): number | undefined {
  return windowsAclHelperSpawnCostMs;
}

async function applyWindowsAcl(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  await windowsAclRequest("apply", path, directory);
}

async function assertWindowsAclPrivate(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const value = await windowsAclRequest("inspect", path, directory);
  const protectedAcl = typeof value === "object" && value !== null ? Reflect.get(value, "Protected") : undefined;
  const current = typeof value === "object" && value !== null ? Reflect.get(value, "Current") : undefined;
  const owner = typeof value === "object" && value !== null ? Reflect.get(value, "Owner") : undefined;
  const rules = typeof value === "object" && value !== null ? Reflect.get(value, "Rules") : undefined;
  const allowedSids = new Set([current, "S-1-5-18"]);
  const seenSids = new Set<string>();
  const expectedFlags = directory ? 3 : 0;
  const rulesValid =
    Array.isArray(rules) &&
    rules.length >= allowedSids.size &&
    rules.length <= 2 &&
    rules.every(rule => {
      if (typeof rule !== "object" || rule === null) return false;
      const sid = Reflect.get(rule, "Sid");
      if (typeof sid !== "string" || !allowedSids.has(sid)) return false;
      seenSids.add(sid);
      return (
        Reflect.get(rule, "Type") === "AccessAllowed" &&
        Reflect.get(rule, "Mask") === 2_032_127 &&
        Reflect.get(rule, "Flags") === expectedFlags
      );
    }) &&
    seenSids.size === allowedSids.size;
  if (protectedAcl !== true || typeof current !== "string" || owner !== current || !rulesValid) {
    const ruleDiagnostics = Array.isArray(rules)
      ? rules.map(rule => {
          const sid = typeof rule === "object" && rule !== null ? Reflect.get(rule, "Sid") : undefined;
          return {
            sid: sid === current ? "current" : sid === "S-1-5-18" ? "system" : "other",
            type: typeof rule === "object" && rule !== null ? Reflect.get(rule, "Type") : undefined,
            mask: typeof rule === "object" && rule !== null ? Reflect.get(rule, "Mask") : undefined,
            flags: typeof rule === "object" && rule !== null ? Reflect.get(rule, "Flags") : undefined,
          };
        })
      : "not-array";
    throw new Error(
      `unsafe private Windows ACL for ${path} (protected=${String(protectedAcl)}, ownerMatches=${String(owner === current)}, currentIsSystem=${String(current === "S-1-5-18")}, rules=${JSON.stringify(ruleDiagnostics)})`,
    );
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
      ? `\\\\.\\pipe\\omp-session-gateway-${createHash("sha256")
          .update(`${process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? "local"}\\${process.env.USERNAME ?? "user"}`.toLowerCase())
          .digest("hex")
          .slice(0, 20)}`
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

async function assertPrivateRegularFile(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe private file: ${path}`);
  if (process.platform === "win32") {
    await assertWindowsAclPrivate(path, false);
    return info.size;
  }
  if (info.uid !== currentUserId() || (info.mode & 0o077) !== 0) {
    throw new Error(`unsafe private file permissions: ${path}`);
  }
  return info.size;
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
  if (mode === "dev-localhost" && publicOrigin.origin !== loopbackHttpOrigin(hostname, port)) {
    throw new Error("dev-localhost mode requires the configured loopback HTTP origin");
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
    const configBytes = await assertPrivateRegularFile(configPath);
    if (configBytes > 64 * 1_024) throw new Error("config file exceeds size limit");
    loaded = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = parseConfigObject(loaded, defaults);
  const mode = overrides.mode ?? config.auth.mode;
  const port = overrides.port === undefined ? config.http.port : validatePort(overrides.port);
  const publicOriginValue =
    overrides.publicOrigin ??
    (mode === "dev-localhost" && (overrides.mode !== undefined || overrides.port !== undefined)
      ? loopbackHttpOrigin(config.http.hostname, port)
      : config.http.publicOrigin);
  const publicOrigin = new URL(publicOriginValue);
  if (publicOrigin.origin !== publicOriginValue) throw new Error("http.publicOrigin must be an exact URL origin");
  if (mode === "tailscale-serve" && publicOrigin.protocol !== "https:") {
    throw new Error("tailscale-serve mode requires an exact HTTPS public origin");
  }
  if (mode === "dev-localhost" && publicOrigin.origin !== loopbackHttpOrigin(config.http.hostname, port)) {
    throw new Error("dev-localhost mode requires the configured loopback HTTP origin");
  }
  if (mode === "tailscale-serve" && config.auth.allowedLogins.length === 0) {
    throw new Error("tailscale-serve mode requires at least one allowed login");
  }
  return {
    ...config,
    auth: { ...config.auth, mode },
    http: {
      ...config.http,
      port,
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

export interface GatewayConfigFileSnapshot {
  readonly path: string;
  readonly content: string | undefined;
}

export async function readPrivateTextFile(path: string, maximumBytes: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid private file size limit");
  try {
    const bytes = await assertPrivateRegularFile(path);
    if (bytes > maximumBytes) throw new Error(`private file exceeds size limit: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writePrivateTextFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    if (process.platform === "win32") await applyWindowsAcl(path, false);
    else await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function captureGatewayConfigFile(
  path = defaultGatewayPaths().configPath,
): Promise<GatewayConfigFileSnapshot> {
  try {
    const bytes = await assertPrivateRegularFile(path);
    if (bytes > 64 * 1_024) throw new Error("config file exceeds size limit");
    return { path, content: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: undefined };
    throw error;
  }
}

export async function restoreGatewayConfigFile(snapshot: GatewayConfigFileSnapshot): Promise<void> {
  await assertPrivateDirectory(dirname(snapshot.path), true);
  if (snapshot.content !== undefined) {
    await writePrivateTextFile(snapshot.path, snapshot.content);
    return;
  }
  try {
    const info = await lstat(snapshot.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("refusing to remove an unsafe config path");
    await rm(snapshot.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function publicOriginHttpsPort(publicOrigin: string): number {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:") throw new Error("public origin must use HTTPS");
  return origin.port === "" ? 443 : Number.parseInt(origin.port, 10);
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
  const configDocument = {
    http: { hostname: "127.0.0.1", port: validatePort(options.port ?? 4317), publicOrigin: origin.origin },
    auth: { mode, allowedLogins },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 100, maxSessions: 100 },
  };
  await writePrivateTextFile(paths.configPath, `${JSON.stringify(configDocument, null, 2)}\n`);
  return loadGatewayConfig({ configPath: paths.configPath });
}

async function writePublisherToken(path: string, token: string): Promise<string> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("publisher token has invalid encoding or length");
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

async function writeFreshToken(path: string): Promise<string> {
  return writePublisherToken(path, randomBytes(32).toString("base64url"));
}

async function readExistingPublisherToken(config: GatewayConfig): Promise<string> {
  const tokenBytes = await assertPrivateRegularFile(config.paths.tokenPath);
  if (tokenBytes < 43 || tokenBytes > 45) throw new Error("publisher token has invalid encoding or length");
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
export async function loadPublisherToken(config: GatewayConfig): Promise<string> {
  await ensureRuntimeDirectories(config);
  return readExistingPublisherToken(config);
}


export async function rotatePublisherToken(config: GatewayConfig): Promise<string> {
  await ensureRuntimeDirectories(config);
  try {
    const existing = await lstat(config.paths.tokenPath);
    if (!existing.isFile() && !existing.isSymbolicLink()) {
      throw new Error("refusing to replace a non-file publisher token path");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return writeFreshToken(config.paths.tokenPath);
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
