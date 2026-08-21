import { createHmac } from "node:crypto";
import {
  MAX_FRAME_BYTES,
  MAX_PUSH_SUBSCRIPTION_BYTES,
  PUSH_API_VERSION,
  ProtocolValidationError,
  type SessionEvent,
  parseJsonFrame,
  parseLaunchRequest,
  parsePushSubscriptionRequest,
  parsePushUnsubscribeRequest,
} from "@omp-session-gateway/protocol";
import { authorizeHttpRequest, isLoopbackAddress, requestHasValidMutationContext, type RequestPeer } from "./auth.ts";
import { createTailnetPresenceProbe } from "./tailnet.ts";
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
function isValidRequestBootstrap(url: URL): boolean {
  const match = /^\/collab\/([^/]{1,384})$/u.exec(url.pathname);
  if (match === null) return false;
  const encodedInstanceId = match[1];
  const entries = [...url.searchParams.entries()];
  if (
    encodedInstanceId === undefined ||
    entries.length !== 1 ||
    entries[0]?.[0] !== "request" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(entries[0][1])
  ) {
    return false;
  }
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

const SSE_KEEPALIVE_MS = 5_000;

/**
 * @param stillAuthorized re-read on every keepalive. Authorization for this endpoint would otherwise
 * be evaluated once and never again, so a stream admitted while identity trust was sound would keep
 * delivering the session directory after the topology stopped justifying it. The keepalive is
 * already the stream's liveness tick, so this adds a predicate read rather than a timer.
 *
 * Admission goes through `subscribeWithSnapshot` so the snapshot and the live subscription are one
 * step: a revision landing mid-handshake is replayed in order rather than lost, and teardown is
 * reachable from the first frame onward instead of only after the subscription is assigned.
 */
function eventStream(
  registry: SessionRegistry,
  keepaliveMs = SSE_KEEPALIVE_MS,
  stillAuthorized: () => boolean = () => true,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const release = (): void => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(keepalive);
    keepalive = undefined;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const close = (): void => {
          release();
          try {
            controller.close();
          } catch {
            // The peer may have errored the stream before Bun delivered cancel().
          }
        };
        const send = (event: SessionEvent): void => {
          if (closed) return;
          if ((controller.desiredSize ?? 1) < -32) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            release();
          }
        };
        const dispose = registry.subscribeWithSnapshot(send);
        // A stream abandoned during admission has no subscription handle to revoke yet, so revoke the
        // one admission just returned instead of leaving the listener attached to the registry.
        if (closed) {
          dispose();
          return;
        }
        unsubscribe = dispose;
        keepalive = setInterval(() => {
          if (closed) return;
          if (!stillAuthorized()) {
            close();
            return;
          }
          if ((controller.desiredSize ?? 1) >= -32) {
            try {
              controller.enqueue(encoder.encode("event: keepalive\ndata: {}\n\n"));
            } catch {
              release();
            }
          }
        }, keepaliveMs);
      },
      cancel() {
        release();
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
  /** Supplies wall-clock time for deterministic rate-window enforcement. */
  readonly now?: () => number;
  /**
   * Reports whether the registry rendezvous point is still reachable by publishers. A daemon whose
   * socket path was removed underneath it keeps serving HTTP while no session can ever register, so
   * readiness must reflect the IPC endpoint rather than process liveness alone.
   */
  readonly endpointHealthy?: () => boolean;
  /**
   * Whether Tailscale Serve is still the only path to this loopback listener, i.e. tailscaled owns a
   * TUN device. Injectable so tests can drive both topologies; the default measures the host.
   */
  readonly tailnetPresent?: () => boolean;
}): (request: Request, peer?: RequestPeer) => Promise<Response> {
  const { config, registry, staticAssets } = options;
  const logger = options.logger ?? new SafeLogger();
  const limiter = new LaunchRateLimiter();
  const now = options.now ?? Date.now;
  const tailnetPresent = options.tailnetPresent ?? createTailnetPresenceProbe();
  // `tailscale-serve` mode trusts an identity header from any loopback peer, which is only sound
  // while Serve is the sole way in. Configuration may declare that no tailnet reaches this host at
  // all, which is how a loopback-only harness exercises the production identity path with no
  // Tailscale installed; on a host running userspace-mode tailscaled that declaration is false and
  // re-opens #98, so `doctor` reports it rather than letting it pass silently.
  const identityTrustDeclared = config.auth.trustIdentityWithoutTailnetDevice === true;
  if (identityTrustDeclared && config.auth.mode === "tailscale-serve") {
    // Declared trust disables the measurement, so without this the daemon's logs would be
    // byte-identical to a healthy host's. Emitted once at construction so the assertion is always on
    // the record, whether or not it happens to be true.
    logger.event("warn", "http.identity_trust_declared");
  }
  // Seeded sound so a healthy daemon says nothing at startup and only a change is reported. This
  // governs logging only; authorization always uses the measured value.
  let identityTrustLogged = true;
  return async (request, peer): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return problem(400, "bad_request", "Invalid request");
    }
    const clientRoute = request.method === "GET" && url.pathname === "/client/";
    const clientBootstrap = clientRoute && isValidClientBootstrap(url);
    const requestBootstrap = request.method === "GET" && isValidRequestBootstrap(url);
    const updateBootstrap = request.method === "GET" && url.pathname === "/update/";
    if (url.search !== "" && !clientBootstrap && !requestBootstrap) {
      return problem(400, "bad_request", "Query parameters are not accepted");
    }


    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      if (peer === undefined || !isLoopbackAddress(peer.address)) {
        return problem(403, "forbidden", "Forbidden");
      }
      const status = options.endpointHealthy?.() === false ? "degraded" : "ready";
      const challenge = request.headers.get("X-OMP-Readiness-Challenge");
      if (challenge === null) return withSecurityHeaders(Response.json({ status }), true);
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
        Response.json({ status, proof, ...(instance === "" ? {} : { instance }) }),
        true,
      );
    }

    // Only `tailscale-serve` mode believes an identity header, so only it pays for the measurement.
    let serveOwnsIdentityHeaders = true;
    if (config.auth.mode === "tailscale-serve") {
      serveOwnsIdentityHeaders = identityTrustDeclared || tailnetPresent();
      if (serveOwnsIdentityHeaders !== identityTrustLogged) {
        identityTrustLogged = serveOwnsIdentityHeaders;
        // Logged on transition, not per request: this is one property of the host, and a per-request
        // line would be unbounded noise for a single operator-visible fact.
        logger.event(
          serveOwnsIdentityHeaders ? "info" : "error",
          serveOwnsIdentityHeaders ? "http.identity_trust_restored" : "http.identity_trust_unsound",
        );
      }
    }
    const authorization = authorizeHttpRequest(request, peer, config, serveOwnsIdentityHeaders);
    if (!authorization.allowed) {
      logger.event("warn", "http.authorization_denied", {
        identity_untrustworthy: authorization.reason === "identity_untrustworthy",
      });
      return problem(403, "forbidden", "Forbidden");
    }
    if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
      return withSecurityHeaders(Response.json(registry.snapshot()), true);
    }
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      // Re-read per keepalive: an admitted stream must not outlive the topology that justified it.
      return eventStream(registry, options.sseKeepaliveMs, () =>
        config.auth.mode !== "tailscale-serve" || identityTrustDeclared || tailnetPresent(),
      );
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
      if (!limiter.allow(`${authorization.identityKey}\0push`, now())) {
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
          const detailLevel = await options.pushService.subscribe(authorization.identityKey, subscriptionRequest);
          return withSecurityHeaders(
            Response.json({ version: PUSH_API_VERSION, detailLevel }),
            true,
          );
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
      if (!limiter.allow(`${authorization.identityKey}\0launch`, now())) {
        return problem(429, "rate_limited", "Too many requests");
      }
      const lookup = registry.lookupCapability(
        instanceId,
        launchRequest.generation,
        launchRequest.mode,
        launchRequest.requestId,
      );
      if (lookup.status === "generation_mismatch") {
        return problem(409, "generation_mismatch", "Session changed; refresh and try again");
      }
      if (lookup.status === "request_mismatch") {
        return problem(409, "request_mismatch", "Request changed; refresh and try again");
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
    const staticResponse = staticAssets.response(
      clientRoute || requestBootstrap || updateBootstrap ? "/" : url.pathname,
    );
    return withSecurityHeaders(
      staticResponse ?? new Response("Not found", { status: 404 }),
      clientRoute || requestBootstrap || updateBootstrap,
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
  readonly endpointHealthy?: () => boolean;
}): Bun.Server<undefined> {
  const handler = createHttpHandler(options);
  const server = Bun.serve({
    hostname: options.config.http.hostname,
    port: options.config.http.port,
    // Must exceed the five-second SSE keepalive interval or Bun repeatedly closes event streams.
    idleTimeout: 30,
    fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address;
      return handler(request, address === undefined ? undefined : { address });
    },
  });
  options.logger?.event("info", "http.listening", { port: server.port ?? options.config.http.port });
  return server;
}
