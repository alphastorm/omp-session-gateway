import { createHmac } from "node:crypto";
import {
  MAX_FRAME_BYTES,
  MAX_PUSH_SUBSCRIPTION_BYTES,
  ProtocolValidationError,
  type SessionEvent,
  parseJsonFrame,
  parseLaunchRequest,
  parsePushSubscriptionRequest,
  parsePushUnsubscribeRequest,
} from "@omp-session-gateway/protocol";
import { authorizeHttpRequest, isLoopbackAddress, requestHasValidMutationContext, type RequestPeer } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";
import type { PushService } from "./push.ts";

import { StaticAssetStore } from "./static.ts";

const API_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh; manifest-src 'self'; worker-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
};

interface RateBucket {
  count: number;
  resetAt: number;
}

class LaunchRateLimiter {
  readonly #buckets = new Map<string, RateBucket>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxBuckets: number;

  constructor(limit = 20, windowMs = 60_000, maxBuckets = 2_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxBuckets = maxBuckets;
  }

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.#buckets.size >= this.#maxBuckets) {
        for (const [candidate, value] of this.#buckets) {
          if (value.resetAt <= now) this.#buckets.delete(candidate);
        }
        if (this.#buckets.size >= this.#maxBuckets) return false;
      }
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (bucket.count >= this.#limit) return false;
    bucket.count += 1;
    return true;
  }
}

function withSecurityHeaders(response: Response, api: boolean): Response {
  const headers = api ? { ...SECURITY_HEADERS, ...API_HEADERS } : SECURITY_HEADERS;
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function problem(status: number, code: string, message: string): Response {
  return withSecurityHeaders(
    Response.json({ code, message }, { status, headers: { "Content-Type": "application/problem+json" } }),
    true,
  );
}
function isValidClientBootstrap(url: URL): boolean {
  if (url.pathname !== "/client/") return false;
  const entries = [...url.searchParams.entries()];
  return (
    entries.length === 1 &&
    entries[0]?.[0] === "handoff" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(entries[0][1])
  );
}
function isValidAttentionBootstrap(url: URL): boolean {
  const match = /^\/attention\/([^/]{1,384})\/([1-9]\d*)$/u.exec(url.pathname);
  if (match === null) return false;
  const encodedInstanceId = match[1];
  const generation = Number(match[2]);
  if (encodedInstanceId === undefined || !Number.isSafeInteger(generation) || generation < 1) return false;
  try {
    return /^[A-Za-z0-9._:-]{16,128}$/u.test(decodeURIComponent(encodedInstanceId));
  } catch {
    return false;
  }
}



async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new ProtocolValidationError();
  }
  if (request.body === null) throw new ProtocolValidationError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new ProtocolValidationError();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const SSE_KEEPALIVE_MS = 15_000;

function eventStream(registry: SessionRegistry, keepaliveMs = SSE_KEEPALIVE_MS): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (event: SessionEvent): void => {
          if ((controller.desiredSize ?? 1) < -32) {
            controller.close();
            unsubscribe?.();
            if (keepalive !== undefined) clearInterval(keepalive);
            return;
          }
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };
        const snapshot = registry.snapshot();
        send({ type: "snapshot", revision: snapshot.revision, sessions: snapshot.sessions });
        unsubscribe = registry.subscribe(send);
        keepalive = setInterval(() => {
          if ((controller.desiredSize ?? 1) >= -32) {
            controller.enqueue(encoder.encode("event: keepalive\ndata: {}\n\n"));
          }
        }, keepaliveMs);
      },
      cancel() {
        unsubscribe?.();
        if (keepalive !== undefined) clearInterval(keepalive);
      },
    },
    { highWaterMark: 32 },
  );
  return withSecurityHeaders(
    new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
    true,
  );
}
export function createHttpHandler(options: {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  readonly staticAssets: StaticAssetStore;
  readonly pushService?: PushService;
  readonly logger?: SafeLogger;
  readonly readinessToken?: string;
  readonly readinessInstance?: string;
  readonly sseKeepaliveMs?: number;
}): (request: Request, peer?: RequestPeer) => Promise<Response> {
  const { config, registry, staticAssets } = options;
  const logger = options.logger ?? new SafeLogger();
  const limiter = new LaunchRateLimiter();
  return async (request, peer): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return problem(400, "bad_request", "Invalid request");
    }
    const clientBootstrap = isValidClientBootstrap(url);
    const attentionBootstrap = request.method === "GET" && isValidAttentionBootstrap(url);
    if (url.search !== "" && !clientBootstrap) {
      return problem(400, "bad_request", "Query parameters are not accepted");
    }


    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      if (peer === undefined || !isLoopbackAddress(peer.address)) {
        return problem(403, "forbidden", "Forbidden");
      }
      const challenge = request.headers.get("X-OMP-Readiness-Challenge");
      if (challenge === null) return withSecurityHeaders(Response.json({ status: "ready" }), true);
      if (options.readinessToken === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
        return problem(400, "bad_request", "Invalid readiness challenge");
      }
      const instance = options.readinessInstance ?? "";
      const proof = createHmac("sha256", options.readinessToken)
        .update(challenge)
        .update("\0")
        .update(instance)
        .digest("base64url");
      return withSecurityHeaders(
        Response.json({ status: "ready", proof, ...(instance === "" ? {} : { instance }) }),
        true,
      );
    }

    const authorization = authorizeHttpRequest(request, peer, config);
    if (!authorization.allowed) {
      logger.event("warn", "http.authorization_denied");
      return problem(403, "forbidden", "Forbidden");
    }
    if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
      return withSecurityHeaders(Response.json(registry.snapshot()), true);
    }
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      return eventStream(registry, options.sseKeepaliveMs);
    }
    if (url.pathname === "/api/v1/push/config" && request.method === "GET" && options.pushService !== undefined) {
      return withSecurityHeaders(Response.json(options.pushService.configResponse()), true);
    }
    if (
      url.pathname === "/api/v1/push/subscription" &&
      (request.method === "POST" || request.method === "DELETE") &&
      options.pushService !== undefined
    ) {
      if (!requestHasValidMutationContext(request, config.http.publicOrigin)) {
        return problem(403, "forbidden", "Forbidden");
      }
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      if (!limiter.allow(`${authorization.identityKey}\0push`)) {
        return problem(429, "rate_limited", "Too many requests");
      }
      let body: unknown;
      try {
        body = parseJsonFrame(await readBoundedBody(request, MAX_PUSH_SUBSCRIPTION_BYTES));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (request.method === "POST") {
        let subscriptionRequest;
        try {
          subscriptionRequest = parsePushSubscriptionRequest(body);
        } catch {
          return problem(400, "bad_request", "Invalid request");
        }
        try {
          await options.pushService.subscribe(authorization.identityKey, subscriptionRequest);
        } catch {
          return problem(409, "subscription_rejected", "Push subscription could not be saved");
        }
      } else {
        let unsubscribeRequest;
        try {
          unsubscribeRequest = parsePushUnsubscribeRequest(body);
        } catch {
          return problem(400, "bad_request", "Invalid request");
        }
        await options.pushService.unsubscribe(authorization.identityKey, unsubscribeRequest);
      }
      return withSecurityHeaders(new Response(null, { status: 204 }), true);
    }


    const launchMatch = /^\/api\/v1\/sessions\/([^/]{1,384})\/launch$/u.exec(url.pathname);
    if (launchMatch !== null && request.method === "POST") {
      const encodedInstanceId = launchMatch[1];
      if (encodedInstanceId === undefined) return problem(400, "bad_request", "Invalid request");
      let instanceId: string;
      try {
        instanceId = decodeURIComponent(encodedInstanceId);
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(instanceId)) {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!requestHasValidMutationContext(request, config.http.publicOrigin)) {
        return problem(403, "forbidden", "Forbidden");
      }
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      let launchRequest;
      try {
        const body = await readBoundedBody(request, Math.min(MAX_FRAME_BYTES, 4_096));
        launchRequest = parseLaunchRequest(parseJsonFrame(body));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!limiter.allow(`${authorization.identityKey}\0${instanceId}`)) {
        return problem(429, "rate_limited", "Too many requests");
      }
      const lookup = registry.lookupCapability(instanceId, launchRequest.generation, launchRequest.mode);
      if (lookup.status === "generation_mismatch") {
        return problem(409, "generation_mismatch", "Session changed; refresh and try again");
      }
      if (lookup.status === "missing") return problem(404, "not_found", "Session unavailable");
      const response = Response.json({
        mode: launchRequest.mode,
        generation: launchRequest.generation,
        capability: lookup.capability.reveal(),
      });
      return withSecurityHeaders(response, true);
    }

    if (url.pathname.startsWith("/api/")) return problem(404, "not_found", "Not found");
    const staticResponse = staticAssets.response(attentionBootstrap ? "/" : url.pathname);
    return withSecurityHeaders(
      staticResponse ?? new Response("Not found", { status: 404 }),
      clientBootstrap || attentionBootstrap,
    );
  };
}

export function startHttpServer(options: {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  readonly staticAssets: StaticAssetStore;
  readonly pushService?: PushService;
  readonly logger?: SafeLogger;
  readonly readinessToken: string;
  readonly readinessInstance?: string;
}): Bun.Server<undefined> {
  const handler = createHttpHandler(options);
  const server = Bun.serve({
    hostname: options.config.http.hostname,
    port: options.config.http.port,
    // Must exceed the 15-second SSE keepalive interval or Bun repeatedly closes event streams.
    idleTimeout: 30,
    fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address;
      return handler(request, address === undefined ? undefined : { address });
    },
  });
  options.logger?.event("info", "http.listening", { port: server.port ?? options.config.http.port });
  return server;
}
