import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
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

const MAX_HELLO_FRAME_BYTES = 1_024;
const HELLO_TIMEOUT_MILLISECONDS = 5_000;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface ConnectionState {
  readonly ownerId: string;
  buffer: Buffer;
  bufferedBytes: number;
  deadline?: RegistryIpcDeadline;
  authenticated: boolean;
  instanceId?: string;
  pid?: number;
  closed: boolean;
}

export interface RegistryIpcDeadline {
  cancel(): void;
}

export interface RegistryIpcDeadlineScheduler {
  schedule(callback: () => void, timeoutMilliseconds: number): RegistryIpcDeadline;
}

const runtimeDeadlineScheduler: RegistryIpcDeadlineScheduler = {
  schedule(callback, timeoutMilliseconds) {
    const timer = setTimeout(callback, timeoutMilliseconds);
    let active = true;
    return {
      cancel() {
        if (!active) return;
        active = false;
        clearTimeout(timer);
      },
    };
  },
};

export interface RegistryIpcServer {
  readonly endpoint: string;
  readonly publishers: number;
  stop(): Promise<void>;
}

function isSafeHelloCandidate(frame: Uint8Array): boolean {
  if (frame.byteLength > MAX_HELLO_FRAME_BYTES) return false;
  let text: string;
  try {
    text = fatalUtf8Decoder.decode(frame);
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
  readonly deadlineScheduler?: RegistryIpcDeadlineScheduler;
}): Promise<RegistryIpcServer> {
  const { config, token, registry } = options;
  const logger = options.logger ?? new SafeLogger();
  const deadlineScheduler = options.deadlineScheduler ?? runtimeDeadlineScheduler;
  const idleTimeoutMilliseconds = config.registry.ttlSeconds * 1_000;
  await removeRuntimeSocket(config);
  let publisherCount = 0;
  const connections = new Set<Bun.Socket<ConnectionState>>();

  const clearDeadline = (state: ConnectionState): void => {
    if (state.deadline === undefined) return;
    state.deadline.cancel();
    delete state.deadline;
  };

  const scrubBuffer = (state: ConnectionState): void => {
    state.buffer.fill(0);
    state.bufferedBytes = 0;
  };

  const releaseConnection = (socket: Bun.Socket<ConnectionState>): void => {
    const state = socket.data;
    clearDeadline(state);
    scrubBuffer(state);
    state.closed = true;
    if (!connections.delete(socket)) return;
    publisherCount -= 1;
    registry.removeOwner(state.ownerId);
  };

  const closeWithProtocolError = (socket: Bun.Socket<ConnectionState>): void => {
    if (socket.data.closed) return;
    logger.event("warn", "ipc.protocol_rejected");
    releaseConnection(socket);
    socket.end('{"v":1,"op":"error","code":"protocol_error"}\n');
  };

  const closeTimedOut = (socket: Bun.Socket<ConnectionState>): void => {
    if (socket.data.closed) return;
    logger.event("warn", "ipc.connection_timed_out", { authenticated: socket.data.authenticated });
    releaseConnection(socket);
    socket.end('{"v":1,"op":"error","code":"protocol_error"}\n');
  };

  const armDeadline = (socket: Bun.Socket<ConnectionState>, timeoutMilliseconds: number): void => {
    const state = socket.data;
    clearDeadline(state);
    state.deadline = deadlineScheduler.schedule(() => closeTimedOut(socket), timeoutMilliseconds);
  };

  const appendFrameBytes = (socket: Bun.Socket<ConnectionState>, bytes: Uint8Array): boolean => {
    const state = socket.data;
    const maximumBytes = state.authenticated ? MAX_FRAME_BYTES : MAX_HELLO_FRAME_BYTES;
    const nextLength = state.bufferedBytes + bytes.byteLength;
    if (nextLength > maximumBytes) {
      closeWithProtocolError(socket);
      return false;
    }
    if (nextLength > state.buffer.byteLength) {
      const grown = Buffer.alloc(MAX_FRAME_BYTES);
      state.buffer.copy(grown, 0, 0, state.bufferedBytes);
      state.buffer.fill(0);
      state.buffer = grown;
    }
    state.buffer.set(bytes, state.bufferedBytes);
    state.bufferedBytes = nextLength;
    return true;
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
          buffer: Buffer.alloc(MAX_HELLO_FRAME_BYTES),
          bufferedBytes: 0,
          authenticated: false,
          closed: false,
        };
        if (publisherCount >= config.registry.maxPublishers) {
          socket.data.closed = true;
          socket.end('{"v":1,"op":"error","code":"capacity"}\n');
          return;
        }
        publisherCount += 1;
        connections.add(socket);
        armDeadline(socket, HELLO_TIMEOUT_MILLISECONDS);
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.closed) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.byteLength && !state.closed) {
          const newline = bytes.indexOf(0x0a, offset);
          const end = newline < 0 ? bytes.byteLength : newline;
          if (!appendFrameBytes(socket, bytes.subarray(offset, end))) return;
          if (newline < 0) return;
          if (state.bufferedBytes === 0) {
            closeWithProtocolError(socket);
            return;
          }

          const frameLength = state.bufferedBytes;
          try {
            processFrame(socket, state.buffer.subarray(0, frameLength));
            if (!state.closed && state.authenticated) armDeadline(socket, idleTimeoutMilliseconds);
          } catch {
            closeWithProtocolError(socket);
          } finally {
            state.buffer.fill(0, 0, frameLength);
            state.bufferedBytes = 0;
          }
          offset = newline + 1;
        }
      },
      close(socket) {
        releaseConnection(socket);
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
      for (const socket of connections) {
        releaseConnection(socket);
        socket.end();
      }
      server.stop(true);
      registry.clear();
      await removeRuntimeSocket(config);
      logger.event("info", "ipc.stopped");
    },
  };
}
