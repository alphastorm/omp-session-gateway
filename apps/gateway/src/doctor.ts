import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { parseSessionListResponse, type SessionListResponse } from "@omp-session-gateway/protocol";
import {
  assertSocketPrivate,
  type GatewayConfig,
  loadGatewayConfig,
  loadPublisherToken,
  loopbackHttpOrigin,
} from "./config.ts";
import type { DoctorReport } from "./diagnostics.ts";
import { userServiceStatus } from "./service.ts";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_READINESS_BODY_BYTES = 512;
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
    const timeout = setTimeout(() => subprocess.kill(9), 5_000);
    try {
      const reader = subprocess.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_COMMAND_OUTPUT_BYTES) {
          subprocess.kill(9);
          await reader.cancel().catch(() => undefined);
          await subprocess.exited;
          return undefined;
        }
        chunks.push(result.value);
      }
      if ((await subprocess.exited) !== 0) return undefined;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}

async function boundedResponseJson(response: Response, limit: number): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) return undefined;
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
}

function normalizedServeAuthority(value: string): string | undefined {
  try {
    const url = new URL(`https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    return `${hostname}:${url.port === "" ? "443" : url.port}`;
  } catch {
    return undefined;
  }
}

export function serveConfigurationMatches(value: unknown, config: GatewayConfig): boolean {
  const web = property(value, "Web");
  if (typeof web !== "object" || web === null || Array.isArray(web)) return false;
  const publicOrigin = new URL(config.http.publicOrigin);
  const expectedAuthority = `${publicOrigin.hostname.toLowerCase().replace(/\.$/u, "")}:${publicOrigin.port === "" ? "443" : publicOrigin.port}`;
  const expectedProxy = loopbackHttpOrigin(config.http.hostname, config.http.port);
  for (const [hostAndPort, server] of Object.entries(web)) {
    if (normalizedServeAuthority(hostAndPort) !== expectedAuthority) continue;
    const handlers = property(server, "Handlers");
    if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) continue;
    for (const handler of Object.values(handlers)) {
      if (property(handler, "Proxy") === expectedProxy) return true;
    }
  }
  return false;
}

export function funnelConfigurationDisabled(value: unknown): boolean {
  return !hasMeaningfulValue(property(value, "AllowFunnel"));
}

export function tailscaleSelfIp(value: unknown): string | undefined {
  const addresses = property(property(value, "Self"), "TailscaleIPs");
  if (!Array.isArray(addresses)) return undefined;
  return (
    addresses.find(address => typeof address === "string" && isIP(address) === 4) ??
    addresses.find(address => typeof address === "string" && isIP(address) === 6)
  );
}
export async function gatewayReady(
  config: GatewayConfig,
  readinessToken: string,
  expectedInstance?: string,
): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString("base64url");
    const response = await fetch(`${loopbackHttpOrigin(config.http.hostname, config.http.port)}/api/v1/health`, {
      headers: { "X-OMP-Readiness-Challenge": challenge },
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await boundedResponseJson(response, MAX_READINESS_BODY_BYTES);
    if (property(body, "status") !== "ready") return false;
    const instanceValue = property(body, "instance");
    if (instanceValue !== undefined && (typeof instanceValue !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(instanceValue))) {
      return false;
    }
    const instance = typeof instanceValue === "string" ? instanceValue : "";
    if (expectedInstance !== undefined && instance !== expectedInstance) return false;
    const proof = property(body, "proof");
    if (typeof proof !== "string") return false;
    const supplied = Buffer.from(proof);
    const current = Buffer.from(
      createHmac("sha256", readinessToken).update(challenge).update("\0").update(instance).digest("base64url"),
    );
    if (current.length === supplied.length && timingSafeEqual(current, supplied)) return true;
    if (instance !== "" || expectedInstance !== undefined) return false;
    const legacy = Buffer.from(createHmac("sha256", readinessToken).update(challenge).digest("base64url"));
    return legacy.length === supplied.length && timingSafeEqual(legacy, supplied);
  } catch {
    return false;
  }
}

export async function loopbackHttpResponds(config: GatewayConfig): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString("base64url");
    const response = await fetch(`${loopbackHttpOrigin(config.http.hostname, config.http.port)}/api/v1/health`, {
      headers: { "X-OMP-Readiness-Challenge": challenge },
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function publicResponse(
  config: GatewayConfig,
  path: string,
  tailscaleIp?: string,
): Promise<Response | undefined> {
  const intended = new URL(path, config.http.publicOrigin);
  try {
    return await fetch(intended, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    if (tailscaleIp === undefined) return undefined;
  }

  const direct = new URL(intended);
  direct.hostname = isIP(tailscaleIp) === 6 ? `[${tailscaleIp}]` : tailscaleIp;
  try {
    return await fetch(direct, {
      headers: { Host: intended.host },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      cache: "no-store",
      tls: { serverName: intended.hostname },
    });
  } catch {
    return undefined;
  }
}

async function publicSessions(config: GatewayConfig, tailscaleIp?: string): Promise<SessionListResponse | undefined> {
  const response = await publicResponse(config, "/api/v1/sessions", tailscaleIp);
  if (response === undefined) return undefined;
  try {
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

async function publicAsset(config: GatewayConfig, path: string, tailscaleIp?: string): Promise<Response | undefined> {
  return await publicResponse(config, path, tailscaleIp);
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

async function compatibilityArtifactsPresent(): Promise<boolean> {
  try {
    const [lockText, patch] = await Promise.all([
      readFile(fileURLToPath(new URL("../../../UPSTREAM.lock.json", import.meta.url)), "utf8"),
      readFile(
        fileURLToPath(new URL("../../../patches/oh-my-pi/0001-collab-controller-autostart-registry.patch", import.meta.url)),
        "utf8",
      ),
    ]);
    const lock = JSON.parse(lockText) as unknown;
    return (
      property(lock, "repository") === "https://github.com/can1357/oh-my-pi" &&
      property(lock, "commit") === "89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6" &&
      property(property(lock, "packageVersions"), "@oh-my-pi/pi-coding-agent") === "17.0.6" &&
      patch.includes("packages/coding-agent/src/collab/controller.ts") &&
      patch.includes("packages/coding-agent/src/collab/registry-publisher.ts")
    );
  } catch {
    return false;
  }
}

async function relayReachable(): Promise<boolean> {
  try {
    const response = await fetch(DEFAULT_RELAY_HEALTH_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      redirect: "manual",
      cache: "no-store",
    });
    return response.ok;
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
  checks.compatibility = await compatibilityArtifactsPresent();
  let readinessToken: string | undefined;
  try {
    readinessToken = await loadPublisherToken(config);
    checks.permissions = true;
  } catch {
    checks.permissions = false;
  }
  checks.daemon = readinessToken !== undefined && (await gatewayReady(config, readinessToken));
  checks.listenerLoopbackOnly = checks.daemon && ["127.0.0.1", "::1"].includes(config.http.hostname);
  if (checks.daemon) {
    try {
      await assertSocketPrivate(config);
    } catch {
      checks.permissions = false;
    }
  }

  const service = await userServiceStatus(config);
  checks.serviceInstalled = service.installed;
  checks.serviceActive = service.active;
  checks.relay = await relayReachable();
  const funnel = await commandJson(["tailscale", "funnel", "status", "--json"]);
  checks.funnelDisabled = funnel !== undefined && funnelConfigurationDisabled(funnel);

  if (config.auth.mode === "dev-localhost") {
    checks.tailscaleConnected = true;
    checks.serveMapping = true;
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

  const [status, serve] = await Promise.all([
    commandJson(["tailscale", "status", "--json"]),
    commandJson(["tailscale", "serve", "status", "--json"]),
  ]);
  const tailscaleIp = tailscaleSelfIp(status);
  const [sessions, root, manifest, worker] = await Promise.all([
    publicSessions(config, tailscaleIp),
    publicAsset(config, "/", tailscaleIp),
    publicAsset(config, "/manifest.webmanifest", tailscaleIp),
    publicAsset(config, "/service-worker.js", tailscaleIp),
  ]);
  checks.tailscaleConnected = property(status, "BackendState") === "Running";
  checks.serveMapping = serveConfigurationMatches(serve, config);
  checks.identityAllowed = sessions !== undefined;
  checks.publisherHealth =
    sessions !== undefined && sessions.sessions.every(session => Number.isFinite(Date.parse(session.lastSeenAt)));
  checks.pwa = root?.ok === true && manifest?.ok === true && worker?.ok === true;
  checks.securityHeaders = root?.headers.get("Content-Security-Policy")?.includes("default-src 'self'") === true;
  return { service: "omp-session-gateway", checks };
}
