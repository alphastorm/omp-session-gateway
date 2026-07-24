import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SessionMetadata } from "@omp-session-gateway/protocol";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
const distRoot = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));

export interface DashboardFixture {
  readonly origin: string;
  readonly requests: readonly string[];
  disconnectEvents(): void;
  remove(instanceId: string, generation: number): void;
  setSnapshot(sessions: readonly SessionMetadata[], revision?: number): void;
  stop(): Promise<void>;
  upsert(session: SessionMetadata): void;
}

export async function startDashboardFixture(
  initialSessions: readonly SessionMetadata[],
): Promise<DashboardFixture> {
  const sessions = new Map(initialSessions.map(session => [session.instanceId, session]));
  const streams = new Set<ServerResponse>();
  const requests: string[] = [];
  let revision = 1;
  const roomId = randomBytes(16).toString("base64url");
  const roomKey = randomBytes(32);
  const viewCapability = `${roomId}.${roomKey.toString("base64url")}`;
  const controlCapability = `${roomId}.${Buffer.concat([roomKey, randomBytes(16)]).toString("base64url")}`;

  const snapshotEvent = (): SessionEvent => ({
    type: "snapshot",
    revision,
    sessions: [...sessions.values()],
  });
  const frame = (event: SessionEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const broadcast = (event: SessionEvent): void => {
    const encoded = frame(event);
    for (const stream of streams) stream.write(encoded);
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      if (method === "GET" && url.pathname === "/api/v1/sessions") {
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({ revision, sessions: [...sessions.values()] }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/push/config") {
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({ version: 1, applicationServerKey: "V".repeat(87) }));
        return;
      }
      if (
        (method === "POST" || method === "DELETE") &&
        url.pathname === "/api/v1/push/subscription"
      ) {
        for await (const _chunk of request) {
          // Consume the request so the browser can reuse the connection.
        }
        response.writeHead(204, {
          "Cache-Control": "no-store, max-age=0",
          Pragma: "no-cache",
        });
        response.end();
        return;
      }
      const launchMatch = /^\/api\/v1\/sessions\/([^/]+)\/launch$/u.exec(url.pathname);
      if (method === "POST" && launchMatch !== null) {
        let requestBody = "";
        for await (const chunk of request) {
          requestBody += String(chunk);
          if (requestBody.length > 4_096) {
            response.writeHead(413).end("Too large");
            return;
          }
        }
        const instanceId = decodeURIComponent(launchMatch[1] ?? "");
        const session = sessions.get(instanceId);
        const parsed = JSON.parse(requestBody) as { generation?: unknown; mode?: unknown };
        if (
          session === undefined ||
          parsed.generation !== session.generation ||
          (parsed.mode !== "view" && parsed.mode !== "control")
        ) {
          response.writeHead(409).end("Expired");
          return;
        }
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({
          generation: session.generation,
          mode: parsed.mode,
          capability: parsed.mode === "view" ? viewCapability : controlCapability,
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/events") {
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
        });
        streams.add(response);
        response.write(frame(snapshotEvent()));
        request.once("close", () => streams.delete(response));
        return;
      }
      if (method !== "GET") {
        response.writeHead(404).end("Not found");
        return;
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(404).end("Not found");
        return;
      }
      const relative = pathname === "/"
        ? "index.html"
        : pathname.endsWith("/")
          ? `${pathname.slice(1)}index.html`
          : pathname.slice(1);
      const candidate = resolve(distRoot, relative);
      if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
        response.writeHead(404).end("Not found");
        return;
      }
      try {
        const body = await readFile(candidate);
        response.writeHead(200, { "Content-Type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream" });
        response.end(body);
      } catch {
        response.writeHead(404).end("Not found");
      }
    } catch {
      response.writeHead(500).end("Fixture failure");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    disconnectEvents(): void {
      for (const stream of streams) stream.end();
      streams.clear();
    },
    remove(instanceId, generation): void {
      const current = sessions.get(instanceId);
      if (current?.generation !== generation) return;
      sessions.delete(instanceId);
      revision += 1;
      broadcast({ type: "session_remove", revision, instanceId, generation });
    },
    setSnapshot(nextSessions, nextRevision = revision + 1): void {
      sessions.clear();
      for (const session of nextSessions) sessions.set(session.instanceId, session);
      revision = nextRevision;
      broadcast(snapshotEvent());
    },
    async stop(): Promise<void> {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      });
    },
    upsert(session): void {
      sessions.set(session.instanceId, session);
      revision += 1;
      broadcast({ type: "session_upsert", revision, session });
    },
  };
}
