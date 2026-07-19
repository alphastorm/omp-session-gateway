import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseSessionListResponse, type SessionListResponse } from "@omp-session-gateway/protocol";
import { assertPublisherTokenPrivate, assertSocketPrivate, type GatewayConfig, loadGatewayConfig } from "./config.ts";
import type { DoctorReport } from "./diagnostics.ts";
import { userServiceStatus } from "./service.ts";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const NETWORK_TIMEOUT_MS = 3_000;
const DEFAULT_RELAY_HEALTH_URL = "https://my.omp.sh";

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return true;
}

async function commandJson(command: readonly string[]): Promise<unknown> {
  try {
    const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await new Response(subprocess.stdout).text();
    if ((await subprocess.exited) !== 0 || Buffer.byteLength(text) > MAX_COMMAND_OUTPUT_BYTES) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizedServeHost(value: string): string | undefined {
  try {
    return new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return undefined;
  }
}

export function serveConfigurationMatches(value: unknown, config: GatewayConfig): boolean {
  const web = property(value, "Web");
  if (typeof web !== "object" || web === null || Array.isArray(web)) return false;
  const expectedHost = new URL(config.http.publicOrigin).hostname.toLowerCase().replace(/\.$/u, "");
  const expectedProxy = `http://127.0.0.1:${config.http.port}`;
  for (const [hostAndPort, server] of Object.entries(web)) {
    if (normalizedServeHost(hostAndPort) !== expectedHost) continue;
    const handlers = property(server, "Handlers");
    if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) continue;
    for (const handler of Object.values(handlers)) {
      if (property(handler, "Proxy") === expectedProxy) return true;
    }
  }
  return false;
}

export function funnelConfigurationDisabled(value: unknown): boolean {
  return !hasMeaningfulValue(value);
}

export async function gatewayReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    return response.ok && property(await response.json(), "status") === "ready";
  } catch {
    return false;
  }
}

async function publicSessions(config: GatewayConfig): Promise<SessionListResponse | undefined> {
  try {
    const response = await fetch(`${config.http.publicOrigin}/api/v1/sessions`, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      cache: "no-store",
    });
    const cacheDirectives = response.headers
      .get("Cache-Control")
      ?.split(",")
      .map(value => value.trim().toLowerCase());
    if (!response.ok || cacheDirectives?.includes("no-store") !== true) return undefined;
    return parseSessionListResponse(await response.json());
  } catch {
    return undefined;
  }
}

async function publicAsset(config: GatewayConfig, path: string): Promise<Response | undefined> {
  try {
    return await fetch(new URL(path, config.http.publicOrigin), {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return undefined;
  }
}

async function localAssetsPresent(): Promise<boolean> {
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  try {
    await Promise.all([
      access(`${webRoot}index.html`),
      access(`${webRoot}manifest.webmanifest`),
      access(`${webRoot}service-worker.js`),
    ]);
    const index = await readFile(`${webRoot}index.html`, "utf8");
    return index.includes("manifest.webmanifest");
  } catch {
    return false;
  }
}

async function relayReachable(): Promise<boolean> {
  try {
    await fetch(DEFAULT_RELAY_HEALTH_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      redirect: "manual",
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctorChecks(): Promise<DoctorReport> {
  const checks: Record<string, boolean> = {
    config: false,
    permissions: false,
    daemon: false,
    listenerLoopbackOnly: false,
    serviceInstalled: false,
    serviceActive: false,
    tailscaleConnected: false,
    serveMapping: false,
    funnelDisabled: false,
    identityAllowed: false,
    assets: false,
    pwa: false,
    securityHeaders: false,
    relay: false,
    publisherHealth: false,
    compatibility: false,
  };

  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig();
    checks.config = true;
  } catch {
    return { service: "omp-session-gateway", checks };
  }

  checks.assets = await localAssetsPresent();
  checks.compatibility = checks.assets;
  checks.daemon = await gatewayReady(config.http.port);
  checks.listenerLoopbackOnly = checks.daemon && ["127.0.0.1", "::1"].includes(config.http.hostname);
  try {
    await assertPublisherTokenPrivate(config);
    if (checks.daemon) await assertSocketPrivate(config);
    checks.permissions = true;
  } catch {
    checks.permissions = false;
  }

  const service = await userServiceStatus(config);
  checks.serviceInstalled = service.installed;
  checks.serviceActive = service.active;
  checks.relay = await relayReachable();

  if (config.auth.mode === "dev-localhost") {
    checks.tailscaleConnected = true;
    checks.serveMapping = true;
    checks.funnelDisabled = true;
    checks.identityAllowed = true;
    const [sessions, root, manifest, worker] = await Promise.all([
      publicSessions(config),
      publicAsset(config, "/"),
      publicAsset(config, "/manifest.webmanifest"),
      publicAsset(config, "/service-worker.js"),
    ]);
    checks.publisherHealth =
      sessions !== undefined && sessions.sessions.every(session => Number.isFinite(Date.parse(session.lastSeenAt)));
    checks.pwa = root?.ok === true && manifest?.ok === true && worker?.ok === true;
    checks.securityHeaders = root?.headers.get("Content-Security-Policy")?.includes("default-src 'self'") === true;
    return { service: "omp-session-gateway", checks };
  }

  const [status, serve, funnel, sessions, root, manifest, worker] = await Promise.all([
    commandJson(["tailscale", "status", "--json"]),
    commandJson(["tailscale", "serve", "status", "--json"]),
    commandJson(["tailscale", "funnel", "status", "--json"]),
    publicSessions(config),
    publicAsset(config, "/"),
    publicAsset(config, "/manifest.webmanifest"),
    publicAsset(config, "/service-worker.js"),
  ]);
  checks.tailscaleConnected = property(status, "BackendState") === "Running";
  checks.serveMapping = serveConfigurationMatches(serve, config);
  checks.funnelDisabled = funnel !== undefined && funnelConfigurationDisabled(funnel);
  checks.identityAllowed = sessions !== undefined;
  checks.publisherHealth =
    sessions !== undefined && sessions.sessions.every(session => Number.isFinite(Date.parse(session.lastSeenAt)));
  checks.pwa = root?.ok === true && manifest?.ok === true && worker?.ok === true;
  checks.securityHeaders = root?.headers.get("Content-Security-Policy")?.includes("default-src 'self'") === true;
  return { service: "omp-session-gateway", checks };
}
