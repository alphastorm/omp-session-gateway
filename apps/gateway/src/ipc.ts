import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseAuthenticateFrame,
  parseAuthenticatedPublisherFrame,
  parseHelloFrame,
  parseJsonFrame,
} from "@omp-session-gateway/protocol";
import {
  createRegistryAuthNonce,
  createRegistryClientProof,
  createRegistryServerProof,
  registryAuthProofMatches,
  type RegistryAuthBinding,
} from "@omp-session-gateway/protocol/ipc-auth";
import {
  assertSocketPrivate,
  type GatewayConfig,
  removeRuntimeSocket,
} from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";

const MAX_HANDSHAKE_FRAME_BYTES = 1_024;
const HELLO_TIMEOUT_MILLISECONDS = 5_000;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface ConnectionState {
  readonly ownerId: string;
  buffer: Buffer;
  bufferedBytes: number;
  deadline?: RegistryIpcDeadline;
  authenticated: boolean;
  clientNonce?: string;
  serverNonce?: string;
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

function isSafeHandshakeCandidate(state: ConnectionState, frame: Uint8Array): boolean {
  if (frame.byteLength > MAX_HANDSHAKE_FRAME_BYTES) return false;
  let text: string;
  try {
    text = fatalUtf8Decoder.decode(frame);
  } catch {
    return false;
  }
  if (/"(?:viewLink|controlLink|session|token)"\s*:/u.test(text)) return false;
  if (state.instanceId === undefined) return /"op"\s*:\s*"hello"/u.test(text);
  return /"op"\s*:\s*"authenticate"/u.test(text);
}

function registryAuthBinding(state: ConnectionState): RegistryAuthBinding {
  if (
    state.clientNonce === undefined ||
    state.serverNonce === undefined ||
    state.instanceId === undefined ||
    state.pid === undefined
  ) {
    throw new ProtocolValidationError();
  }
  return {
    clientNonce: state.clientNonce,
    serverNonce: state.serverNonce,
    instanceId: state.instanceId,
    pid: state.pid,
  };
}

export async function startRegistryIpcServer(options: {
  readonly config: GatewayConfig;
  readonly token: string;
  readonly registry: SessionRegistry;
  readonly logger?: SafeLogger;
  readonly deadlineScheduler?: RegistryIpcDeadlineScheduler;
}): Promise<RegistryIpcServer> {
  const { config, registry } = options;
  const tokenKey = Buffer.from(options.token, "ascii");
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

  const scrubHandshake = (state: ConnectionState): void => {
    delete state.clientNonce;
    delete state.serverNonce;
  };

  const releaseConnection = (socket: Bun.Socket<ConnectionState>): void => {
    const state = socket.data;
    clearDeadline(state);
    scrubBuffer(state);
    scrubHandshake(state);
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
    const maximumBytes = state.authenticated ? MAX_FRAME_BYTES : MAX_HANDSHAKE_FRAME_BYTES;
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
      if (!isSafeHandshakeCandidate(state, frameBytes)) {
        closeWithProtocolError(socket);
        return;
      }
      const value = parseJsonFrame(frameBytes);
      if (state.instanceId === undefined) {
        const hello = parseHelloFrame(value);
        state.clientNonce = hello.clientNonce;
        state.serverNonce = createRegistryAuthNonce();
        state.instanceId = hello.instanceId;
        state.pid = hello.pid;
        const binding = registryAuthBinding(state);
        socket.write(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            op: "challenge",
            serverNonce: binding.serverNonce,
            proof: createRegistryServerProof(tokenKey, binding),
          })}\n`,
        );
        return;
      }

      const authenticate = parseAuthenticateFrame(value);
      const expectedProof = createRegistryClientProof(tokenKey, registryAuthBinding(state));
      if (!registryAuthProofMatches(expectedProof, authenticate.proof)) {
        logger.event("warn", "ipc.authentication_denied");
        closeWithProtocolError(socket);
        return;
      }
      state.authenticated = true;
      scrubHandshake(state);
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
          buffer: Buffer.alloc(MAX_HANDSHAKE_FRAME_BYTES),
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
      tokenKey.fill(0);
      server.stop(true);
      registry.clear();
      await removeRuntimeSocket(config);
      logger.event("info", "ipc.stopped");
    },
  };
}
