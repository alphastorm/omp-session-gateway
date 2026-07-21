import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PublishedSessionInput } from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { createHttpHandler } from "../src/http.ts";
import { SafeLogger } from "../src/logger.ts";
import { SessionRegistry } from "../src/registry.ts";
import { StaticAssetStore } from "../src/static.ts";

const viewCapability = ["HTTP", "VIEW", "CANARY", "00000000000000000000"].join("__");
const controlCapability = ["HTTP", "CONTROL", "CANARY", "00000000000000000000"].join("__");
const origin = "https://gateway.example.ts.net";
const peer = { address: "127.0.0.1" } as const;
let assetRoot = "";
let assets: StaticAssetStore;

function config(mode: GatewayConfig["auth"]["mode"] = "tailscale-serve"): GatewayConfig {
  return {
    http: {
      hostname: "127.0.0.1",
      port: 4317,
      publicOrigin: mode === "dev-localhost" ? "http://127.0.0.1:4317" : origin,
    },
    auth: { mode, allowedLogins: mode === "tailscale-serve" ? ["allowed@example.com"] : [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 10, maxSessions: 10 },
    paths: {
      configDir: "/private/config",
      stateDir: "/private/state",
      runtimeDir: "/private/run",
      socketPath: "/private/run/registry.sock",
      tokenPath: "/private/config/publisher-token",
      configPath: "/private/config/config.json",
    },
  };
}

function request(path: string, init: RequestInit = {}, identity = "allowed@example.com"): Request {
  const headers = new Headers(init.headers);
  if (identity.length > 0) headers.set("Tailscale-User-Login", identity);
  return new Request(`${origin}${path}`, { ...init, headers });
}

function publishedSession(instanceId = "http-instance-000001", inputRequired = false): PublishedSessionInput {
  return {
    instanceId,
    generation: 3,
    pid: 1234,
    sessionId: "session-three",
    title: "Safe session",
    cwdLabel: "repository",
    model: "fixture/model",
    startedAt: "2026-07-19T00:00:00.000Z",
    inputRequired,
    viewLink: viewCapability,
    controlLink: controlCapability,
  };
}

function populatedRegistry(instanceId = "http-instance-000001"): SessionRegistry {
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
  registry.upsert("owner", publishedSession(instanceId));
  return registry;
}

function launchRequest(
  generation = 3,
  mode: "view" | "control" = "view",
  instanceId = "http-instance-000001",
): Request {
  return request(`/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`, {
    method: "POST",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ mode, generation }),
  });
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("SSE stream ended before an event");
    text += decoder.decode(next.value, { stream: true });
  }
  return text.slice(0, text.indexOf("\n\n") + 2);
}

beforeAll(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "gateway-http-assets-"));
  await writeFile(join(assetRoot, "index.html"), "<!doctype html><title>OMP Sessions</title>");
  await mkdir(join(assetRoot, "client"));
  await mkdir(join(assetRoot, "assets"));
  await writeFile(join(assetRoot, "client", "index.html"), "<!doctype html><title>OMP client</title>");
  await writeFile(join(assetRoot, "assets", "app.0123456789ab.js"), "export {};");
  assets = await StaticAssetStore.load(assetRoot);
});

afterAll(async () => {
  await rm(assetRoot, { recursive: true, force: true });
});

describe("HTTP boundary", () => {
  test("proves loopback readiness with a publisher-token HMAC challenge", async () => {
    const readinessToken = "T".repeat(43);
    const challenge = "C".repeat(43);
    const readinessInstance = "I".repeat(43);
    const handler = createHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
      readinessToken,
      readinessInstance,
    });
    const healthRequest = new Request("http://127.0.0.1:4317/api/v1/health", {
      headers: { "X-OMP-Readiness-Challenge": challenge },
    });
    const response = await handler(healthRequest, peer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      instance: readinessInstance,
      proof: createHmac("sha256", readinessToken)
        .update(challenge)
        .update("\0")
        .update(readinessInstance)
        .digest("base64url"),
    });
    expect((await handler(healthRequest, { address: "192.168.1.20" })).status).toBe(403);
  });

  test("fails closed for missing, disallowed, forged remote, and tagged-style identities", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, "other@example.com"), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/sessions"), { address: "192.168.1.20" })).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, "tag:phone"), peer)).status).toBe(403);
  });

  test("dev mode requires both a loopback peer and the configured loopback origin", async () => {
    const handler = createHttpHandler({ config: config("dev-localhost"), registry: populatedRegistry(), staticAssets: assets });
    const localRequest = new Request("http://127.0.0.1:4317/api/v1/sessions");
    expect((await handler(localRequest, { address: "10.0.0.8" })).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(403);
    expect((await handler(localRequest, peer)).status).toBe(200);
  });

  test("does not expose an HTTP shutdown control endpoint", async () => {
    const handler = createHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
    });
    const response = await handler(
      request("/_internal/v1/shutdown", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"S".repeat(43)}`,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      peer,
    );
    expect(response.status).toBe(404);
  });

  test("returns ordered metadata-only no-store list and SSE transitions", async () => {
    const registry = populatedRegistry();
    const handler = createHttpHandler({ config: config(), registry, staticAssets: assets });
    const list = await handler(request("/api/v1/sessions"), peer);
    const text = await list.text();
    expect(list.headers.get("Cache-Control")).toContain("no-store");
    expect(text).not.toContain(viewCapability);
    expect(text).not.toContain(controlCapability);
    expect(text).not.toContain("PROMPT_CONTENT_CANARY");
    expect(text).toContain("Safe session");
    expect(text).toContain('"inputRequired":false');

    const sse = await handler(request("/api/v1/events"), peer);
    const reader = sse.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE body");
    const snapshot = await readSseEvent(reader);
    expect(snapshot).toContain("event: snapshot");
    expect(snapshot).not.toContain(viewCapability);
    expect(snapshot).not.toContain("PROMPT_CONTENT_CANARY");
    expect(snapshot).toContain('"inputRequired":false');

    registry.upsert("owner", publishedSession("http-instance-000001", true));
    const required = await readSseEvent(reader);
    expect(required).toContain("event: session_upsert");
    expect(required).toContain('"revision":2');
    expect(required).toContain('"inputRequired":true');
    expect(required).not.toContain(viewCapability);

    registry.upsert("owner", publishedSession("http-instance-000001", false));
    const cleared = await readSseEvent(reader);
    expect(cleared).toContain('"revision":3');
    expect(cleared).toContain('"inputRequired":false');
    expect((await handler(launchRequest(), peer)).status).toBe(200);
    await reader.cancel();
  });

  test("releases exactly one requested capability with no-store", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const response = await handler(launchRequest(), peer);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(payload.capability).toBe(viewCapability);
    expect(JSON.stringify(payload)).not.toContain(controlCapability);
  });

  test("launches a valid encoded colon-bearing instance ID", async () => {
    const instanceId = "http:instance:000001";
    const handler = createHttpHandler({
      config: config(),
      registry: populatedRegistry(instanceId),
      staticAssets: assets,
    });
    const response = await handler(launchRequest(3, "view", instanceId), peer);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).capability).toBe(viewCapability);
  });

  test("rejects malformed and encoded-separator instance IDs", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(launchRequest(3, "view", "http%instance00001"), peer)).status).toBe(400);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance%2F000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3 }),
          }),
          peer,
        )
      ).status,
    ).toBe(400);
  });

  test("enforces generation, origin, fetch metadata, media type, and body shape", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(launchRequest(2), peer)).status).toBe(409);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3 }),
          }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3 }),
          }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "text/plain" },
            body: "{}",
          }),
          peer,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3, extra: true }),
          }),
          peer,
        )
      ).status,
    ).toBe(400);
  });

  test("applies security headers to static and API responses", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    for (const response of [await handler(request("/"), peer), await handler(request("/api/v1/sessions"), peer)]) {
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
      expect(response.headers.has("Access-Control-Allow-Origin")).toBeFalse();
    }
  });

  test("rejects query-bearing assets and no-stores the validated client bootstrap", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const rejected = await handler(request(`/assets/app.0123456789ab.js?token=${viewCapability}`), peer);
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("Cache-Control")).toContain("no-store");

    const bootstrap = await handler(request("/client/?handoff=7a2cadc8-c634-4a4e-9045-bc7001a034a7"), peer);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("Cache-Control")).toContain("no-store");
    expect((await handler(request("/client/?handoff=not-a-uuid"), peer)).status).toBe(400);
  });

  test("never writes capability-bearing data to structured logs", async () => {
    const lines: string[] = [];
    const logger = new SafeLogger({ write: line => lines.push(line) });
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets, logger });
    await handler(launchRequest(), peer);
    await handler(request("/api/v1/sessions", {}, "denied@example.com"), peer);
    expect(lines.join("\n")).not.toContain(viewCapability);
    expect(lines.join("\n")).not.toContain(controlCapability);
    expect(lines.join("\n")).not.toContain("denied@example.com");
  });
});
