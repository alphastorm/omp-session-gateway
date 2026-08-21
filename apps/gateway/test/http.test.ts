import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PublishedSessionInput } from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { createHttpHandler } from "../src/http.ts";
import { SafeLogger } from "../src/logger.ts";
import { PushService } from "../src/push.ts";
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
    // Declared rather than measured so this suite does not depend on whether the machine running it
    // has Tailscale in TUN mode. The measured path is covered by "loopback identity trust" below,
    // which builds a config without this field.
    auth: {
      mode,
      allowedLogins: mode === "tailscale-serve" ? ["allowed@example.com"] : [],
      ...(mode === "tailscale-serve" ? { trustIdentityWithoutTailnetDevice: true } : {}),
    },
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
  requestId?: string,
): Request {
  return request(`/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`, {
    method: "POST",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ mode, generation, ...(requestId === undefined ? {} : { requestId }) }),
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

  test("reports degraded readiness when the registry endpoint is unreachable", async () => {
    const readinessToken = "T".repeat(43);
    const challenge = "C".repeat(43);
    const handler = createHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
      readinessToken,
      endpointHealthy: () => false,
    });

    const proven = await handler(
      new Request("http://127.0.0.1:4317/api/v1/health", { headers: { "X-OMP-Readiness-Challenge": challenge } }),
      peer,
    );
    expect(proven.status).toBe(200);
    expect(await proven.json()).toEqual({
      status: "degraded",
      proof: createHmac("sha256", readinessToken).update(challenge).update("\0").update("").digest("base64url"),
    });

    const plain = await handler(new Request("http://127.0.0.1:4317/api/v1/health"), peer);
    expect(await plain.json()).toEqual({ status: "degraded" });
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

  /**
   * The bypass in #98, as a test. A tailnet peer reaching a userspace-mode host arrives on the
   * loopback listener indistinguishable from a local client, so these cases drive the topology
   * signal rather than the peer address: `tailnetPresent: () => false` is exactly what the exposed
   * macOS qualification host looked like, where a forged header returned `200` with session data.
   */
  describe("loopback identity trust", () => {
    function measured(): GatewayConfig {
      const base = config();
      return { ...base, auth: { mode: base.auth.mode, allowedLogins: base.auth.allowedLogins } };
    }

    test("refuses an allowlisted identity when no tailnet interface vouches for Serve", async () => {
      const handler = createHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => false,
      });

      // Same request that returned 200 on the exposed host.
      const denied = await handler(request("/api/v1/sessions"), peer);
      expect(denied.status).toBe(403);
      // The launch surface is the one that mints capabilities, so it must fail on the same signal.
      expect((await handler(launchRequest(), peer)).status).toBe(403);
    });

    test("serves the same identity once a TUN device owns a tailnet address", async () => {
      const handler = createHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => true,
      });

      expect((await handler(request("/api/v1/sessions"), peer)).status).toBe(200);
      expect((await handler(launchRequest(), peer)).status).toBe(200);
    });

    test("a declared tailnet-less host trusts the header without measuring", async () => {
      let measurements = 0;
      const handler = createHttpHandler({
        config: config(),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => {
          measurements += 1;
          return false;
        },
      });

      expect((await handler(request("/api/v1/sessions"), peer)).status).toBe(200);
      expect(measurements).toBe(0);
    });

    test("dev mode neither consults nor is blocked by the topology", async () => {
      let measurements = 0;
      const handler = createHttpHandler({
        config: config("dev-localhost"),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => {
          measurements += 1;
          return false;
        },
      });

      expect((await handler(new Request("http://127.0.0.1:4317/api/v1/sessions"), peer)).status).toBe(200);
      expect(measurements).toBe(0);
    });

    test("records the unsound topology once and marks the denial reason", async () => {
      const lines: string[] = [];
      const handler = createHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        logger: new SafeLogger({ write: line => lines.push(line) }),
        tailnetPresent: () => false,
      });

      await handler(request("/api/v1/sessions"), peer);
      await handler(request("/api/v1/sessions"), peer);
      const events = lines.map(line => JSON.parse(line) as { event: string; identity_untrustworthy?: boolean });
      // One host-level fact, not one line per request.
      expect(events.filter(entry => entry.event === "http.identity_trust_unsound")).toHaveLength(1);
      expect(events.filter(entry => entry.event === "http.authorization_denied")).toHaveLength(1);
      expect(events.find(entry => entry.event === "http.authorization_denied")?.identity_untrustworthy).toBe(true);
      expect(lines.join("\n")).not.toContain("allowed@example.com");
    });
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
    const handler = createHttpHandler({ config: config(), registry, staticAssets: assets, sseKeepaliveMs: 1 });
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
    const keepalive = await readSseEvent(reader);
    expect(keepalive).toBe("event: keepalive\ndata: {}\n\n");
    expect(keepalive).not.toContain(viewCapability);
    expect(keepalive).not.toContain(controlCapability);

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

  test("revalidates request-bound control launches at capability release", async () => {
    const requestIds = ["http-request-id-000001", "http-request-id-000002"];
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      requestIdFactory: () => requestIds.shift() ?? "http-request-id-fallback",
    });
    registry.upsert("owner", publishedSession("http-instance-000001", true));
    const handler = createHttpHandler({ config: config(), registry, staticAssets: assets });

    expect((await handler(launchRequest(3, "control", "http-instance-000001", "http-request-id-000001"), peer)).status).toBe(200);
    registry.upsert("owner", publishedSession("http-instance-000001", false));
    registry.upsert("owner", publishedSession("http-instance-000001", true));
    const stale = await handler(
      launchRequest(3, "control", "http-instance-000001", "http-request-id-000001"),
      peer,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "request_mismatch" });
    expect((await handler(launchRequest(3, "control", "http-instance-000001", "http-request-id-000002"), peer)).status).toBe(200);
    expect((await handler(launchRequest(3, "view", "http-instance-000001", "http-request-id-000002"), peer)).status).toBe(400);
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

  test("authenticates and strictly validates persistent browser push subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-http-push-"));
    const base = config();
    const gatewayConfig: GatewayConfig = {
      ...base,
      paths: {
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        socketPath: join(root, "run", "registry.sock"),
        tokenPath: join(root, "config", "publisher-token"),
        configPath: join(root, "config", "config.json"),
      },
    };
    const registry = populatedRegistry();
    const pushService = await PushService.open({
      config: gatewayConfig,
      registry,
      transport: { async send(): Promise<void> {} },
    });
    const handler = createHttpHandler({ config: gatewayConfig, registry, staticAssets: assets, pushService });
    const configResponse = await handler(request("/api/v1/push/config"), peer);
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("Cache-Control")).toContain("no-store");
    expect((await configResponse.json()) as Record<string, unknown>).toMatchObject({
      version: 2,
      applicationServerKey: expect.any(String),
    });

    const body = {
      version: 2,
      detailLevel: "preview",
      subscription: {
        endpoint: "https://push.example.test/send/http-device",
        expirationTime: null,
        keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      },
    };
    const mutation = (value: unknown, requestOrigin = origin): Request =>
      request("/api/v1/push/subscription", {
        method: "POST",
        headers: {
          Origin: requestOrigin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      });
    expect((await handler(mutation(body, "https://evil.example"), peer)).status).toBe(403);
    expect((await handler(mutation({ ...body, prompt: "PROMPT_CONTENT_CANARY" }), peer)).status).toBe(400);
    const subscriptionResponse = await handler(mutation(body), peer);
    expect(subscriptionResponse.status).toBe(200);
    expect(await subscriptionResponse.json()).toEqual({ version: 2, detailLevel: "preview" });
    const state = await Bun.file(join(root, "state", "push-state.json")).text();
    expect(state).toContain(body.subscription.endpoint);
    expect(state).not.toContain("PROMPT_CONTENT_CANARY");
    await pushService.stop();
    await rm(root, { recursive: true, force: true });
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

  test("rejects query-bearing assets and maps every client route to the PWA shell", async () => {
    const handler = createHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const rejected = await handler(request(`/assets/app.0123456789ab.js?token=${viewCapability}`), peer);
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("Cache-Control")).toContain("no-store");

    for (const clientPath of [
      "/client/",
      "/client/?handoff=7a2cadc8-c634-4a4e-9045-bc7001a034a7",
    ]) {
      const client = await handler(request(clientPath), peer);
      expect(client.status).toBe(200);
      expect(client.headers.get("Cache-Control")).toContain("no-store");
      expect(await client.text()).toContain("OMP Sessions");
    }
    expect((await handler(request("/client/?handoff=not-a-uuid"), peer)).status).toBe(400);
    const update = await handler(request("/update/"), peer);
    expect(update.status).toBe(200);
    expect(update.headers.get("Cache-Control")).toContain("no-store");
    expect(await update.text()).toContain("OMP Sessions");
    const attention = await handler(
      request("/collab/http-instance-000001?request=http-request-identity-0001"),
      peer,
    );
    expect(attention.status).toBe(200);
    expect(attention.headers.get("Cache-Control")).toContain("no-store");
    expect(await attention.text()).toContain("OMP Sessions");
    expect((await handler(request("/collab/short?request=http-request-identity-0001"), peer)).status).toBe(400);
    expect((await handler(request("/collab/http-instance-000001?request=short"), peer)).status).toBe(400);
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
