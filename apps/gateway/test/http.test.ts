import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: origin },
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

function populatedRegistry(): SessionRegistry {
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
  registry.upsert("owner", {
    instanceId: "http-instance-000001",
    generation: 3,
    pid: 1234,
    sessionId: "session-three",
    title: "Safe session",
    cwdLabel: "repository",
    model: "fixture/model",
    startedAt: "2026-07-19T00:00:00.000Z",
    viewLink: viewCapability,
    controlLink: controlCapability,
  });
  return registry;
}

function launchRequest(generation = 3, mode: "view" | "control" = "view"): Request {
  return request("/api/v1/sessions/http-instance-000001/launch", {
    method: "POST",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ mode, generation }),
  });
}

beforeAll(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "gateway-http-assets-"));
  await writeFile(join(assetRoot, "index.html"), "<!doctype html><title>OMP Sessions</title>");
  assets = await StaticAssetStore.load(assetRoot);
});

afterAll(async () => {
  await rm(assetRoot, { recursive: true, force: true });
});

describe("HTTP boundary", () => {
  test("fails closed for missing, disallowed, forged remote, and tagged-style identities", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, "other@example.com"), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/sessions"), { address: "192.168.1.20" })).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, "tag:phone"), peer)).status).toBe(403);
  });

  test("dev mode still refuses non-loopback callers", async () => {
    const handler = createHttpHandler({ config: config("dev-localhost"), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(request("/api/v1/sessions", {}, ""), { address: "10.0.0.8" })).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(200);
  });

  test("accepts shutdown only from loopback with the publisher token", async () => {
    const token = "S".repeat(43);
    let requests = 0;
    const handler = createHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
      shutdown: { token, request: () => requests++ },
    });
    const shutdownRequest = (supplied: string): Request =>
      request("/_internal/v1/shutdown", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supplied}`,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
    expect((await handler(shutdownRequest("X".repeat(43)), peer)).status).toBe(403);
    expect(
      (
        await handler(
          request("/_internal/v1/shutdown", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
          }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect((await handler(shutdownRequest(token), { address: "10.0.0.8" })).status).toBe(403);
    expect(requests).toBe(0);
    const response = await handler(shutdownRequest(token), peer);
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await Bun.sleep(60);
    expect(requests).toBe(1);
  });

  test("returns metadata-only no-store list and SSE", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const list = await handler(request("/api/v1/sessions"), peer);
    const text = await list.text();
    expect(list.headers.get("Cache-Control")).toContain("no-store");
    expect(text).not.toContain(viewCapability);
    expect(text).not.toContain(controlCapability);
    expect(text).toContain("Safe session");

    const sse = await handler(request("/api/v1/events"), peer);
    const reader = sse.body?.getReader();
    const first = await reader?.read();
    const eventText = first?.value === undefined ? "" : new TextDecoder().decode(first.value);
    expect(eventText).toContain("event: snapshot");
    expect(eventText).not.toContain(viewCapability);
    await reader?.cancel();
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
