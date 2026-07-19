import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseAuthenticatedPublisherFrame,
  parseHelloFrame,
  parseJsonFrame,
} from "@omp-session-gateway/protocol";
import {
  assertSocketPrivate,
  type GatewayConfig,
  publisherTokenMatches,
  removeRuntimeSocket,
} from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";

interface ConnectionState {
  readonly ownerId: string;
  buffer: Buffer;
  authenticated: boolean;
  instanceId?: string;
  pid?: number;
  closed: boolean;
}

export interface RegistryIpcServer {
  readonly endpoint: string;
  readonly publishers: number;
  stop(): Promise<void>;
}

function isSafeHelloCandidate(frame: Uint8Array): boolean {
  if (frame.byteLength > 1_024) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    return false;
  }
  if (/"(?:viewLink|controlLink|session)"\s*:/u.test(text)) return false;
  return /"op"\s*:\s*"hello"/u.test(text);
}

export async function startRegistryIpcServer(options: {
  readonly config: GatewayConfig;
  readonly token: string;
  readonly registry: SessionRegistry;
  readonly logger?: SafeLogger;
}): Promise<RegistryIpcServer> {
  const { config, token, registry } = options;
  const logger = options.logger ?? new SafeLogger();
  await removeRuntimeSocket(config);
  let publisherCount = 0;
  const connections = new Set<Bun.Socket<ConnectionState>>();

  const closeWithProtocolError = (socket: Bun.Socket<ConnectionState>): void => {
    if (socket.data.closed) return;
    socket.data.closed = true;
    logger.event("warn", "ipc.protocol_rejected");
    socket.end('{"v":1,"op":"error","code":"protocol_error"}\n');
  };

  const processFrame = (socket: Bun.Socket<ConnectionState>, frameBytes: Uint8Array): void => {
    const state = socket.data;
    if (!state.authenticated) {
      if (!isSafeHelloCandidate(frameBytes)) {
        closeWithProtocolError(socket);
        return;
      }
      const hello = parseHelloFrame(parseJsonFrame(frameBytes));
      if (!publisherTokenMatches(token, hello.token)) {
        logger.event("warn", "ipc.authentication_denied");
        closeWithProtocolError(socket);
        return;
      }
      state.authenticated = true;
      state.instanceId = hello.instanceId;
      state.pid = hello.pid;
      socket.write(
        `${JSON.stringify({
          v: PROTOCOL_VERSION,
          op: "hello_ok",
          heartbeatSeconds: config.registry.heartbeatSeconds,
          ttlSeconds: config.registry.ttlSeconds,
        })}\n`,
      );
      logger.event("info", "ipc.publisher_authenticated", { publishers: publisherCount });
      return;
    }

    const message = parseAuthenticatedPublisherFrame(parseJsonFrame(frameBytes));
    if (message.op === "upsert") {
      if (message.session.instanceId !== state.instanceId || message.session.pid !== state.pid) {
        throw new ProtocolValidationError();
      }
      registry.upsert(state.ownerId, message.session);
      return;
    }
    if (message.instanceId !== state.instanceId) throw new ProtocolValidationError();
    if (message.op === "heartbeat") {
      registry.heartbeat(state.ownerId, message.instanceId, message.generation);
      return;
    }
    registry.remove(state.ownerId, message.instanceId, message.generation);
  };

  const server = Bun.listen<ConnectionState>({
    unix: config.paths.socketPath,
    socket: {
      open(socket) {
        socket.data = {
          ownerId: randomUUID(),
          buffer: Buffer.alloc(0),
          authenticated: false,
          closed: false,
        };
        if (publisherCount >= config.registry.maxPublishers) {
          socket.end('{"v":1,"op":"error","code":"capacity"}\n');
          return;
        }
        publisherCount += 1;
        connections.add(socket);
      },
      data(socket, chunk) {
        if (socket.data.closed) return;
        socket.data.buffer = Buffer.concat([socket.data.buffer, Buffer.from(chunk)]);
        while (!socket.data.closed) {
          const newline = socket.data.buffer.indexOf(0x0a);
          if (newline < 0) {
            if (socket.data.buffer.byteLength > MAX_FRAME_BYTES) closeWithProtocolError(socket);
            return;
          }
          if (newline > MAX_FRAME_BYTES) {
            closeWithProtocolError(socket);
            return;
          }
          const frame = socket.data.buffer.subarray(0, newline);
          socket.data.buffer = socket.data.buffer.subarray(newline + 1);
          if (frame.byteLength === 0) {
            closeWithProtocolError(socket);
            return;
          }
          try {
            processFrame(socket, frame);
          } catch {
            closeWithProtocolError(socket);
          }
        }
      },
      close(socket) {
        if (connections.delete(socket)) publisherCount -= 1;
        registry.removeOwner(socket.data.ownerId);
      },
      error(socket) {
        if (!socket.data.closed) logger.event("warn", "ipc.connection_error");
      },
    },
  });

  if (process.platform !== "win32") {
    await chmod(config.paths.socketPath, 0o600);
    await assertSocketPrivate(config);
  }
  logger.event("info", "ipc.listening");

  return {
    endpoint: config.paths.socketPath,
    get publishers() {
      return publisherCount;
    },
    async stop() {
      for (const socket of connections) socket.end();
      server.stop(true);
      registry.clear();
      await removeRuntimeSocket(config);
      logger.event("info", "ipc.stopped");
    },
  };
}
