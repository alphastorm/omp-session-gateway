import { ProtocolValidationError, SecretCapability, type SecretSessionRecord } from "./secret.ts";
import {
  MAX_FRAME_BYTES,
  IPC_AUTH_VALUE_LENGTH,
  MAX_INSTANCE_ID_BYTES,
  MAX_SESSIONS,
  MAX_LABEL_CODEPOINTS,
  PROTOCOL_VERSION,
  type AuthenticatedPublisherFrame,
  type AuthenticateFrame,
  type ChallengeFrame,
  type HeartbeatFrame,
  type HelloFrame,
  type HelloOkFrame,
  type LaunchRequest,
  type LaunchResponse,
  type PublishedSessionInput,
  type RemoveFrame,
  type SessionEvent,
  type SessionListResponse,
  type SessionMetadata,
  type UpsertFrame,
} from "./types.ts";

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;
const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const IPC_AUTH_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DISALLOWED_LABEL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const REMOVE_REASONS: Record<RemoveFrame["reason"], true> = {
  stopped: true,
  shutdown: true,
  session_changed: true,
  faulted: true,
  connection_closed: true,
  expired: true,
};

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError();
  }
  return value as JsonRecord;
}

function requireExactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ProtocolValidationError();
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ProtocolValidationError();
  }
}

function requireInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolValidationError();
  }
  return value as number;
}

function requireInstanceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_INSTANCE_ID_BYTES ||
    !INSTANCE_ID_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requireIpcAuthValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== IPC_AUTH_VALUE_LENGTH ||
    !IPC_AUTH_VALUE_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requireDateTime(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolValidationError();
  }
  return value;
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFC").replace(DISALLOWED_LABEL_PATTERN, "").trim();
  if ([...normalized].length > MAX_LABEL_CODEPOINTS) throw new ProtocolValidationError();
  return normalized;
}

function assertNoDuplicateObjectKeys(text: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const current = text[index];
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          throw new ProtocolValidationError();
        }
      }
      index += 1;
    }
    throw new ProtocolValidationError();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        if (text[index] !== '"') throw new ProtocolValidationError();
        const key = parseString();
        if (keys.has(key)) throw new ProtocolValidationError();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") throw new ProtocolValidationError();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new ProtocolValidationError();
        index += 1;
      }
      throw new ProtocolValidationError();
    }
    if (current === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new ProtocolValidationError();
        index += 1;
      }
      throw new ProtocolValidationError();
    }
    if (current === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? "")) index += 1;
    if (start === index) throw new ProtocolValidationError();
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) throw new ProtocolValidationError();
}

export function parseJsonFrame(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) throw new ProtocolValidationError();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolValidationError();
  }
  if (text.includes("\0")) throw new ProtocolValidationError();
  assertNoDuplicateObjectKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolValidationError();
  }
}

export function parseHelloFrame(value: unknown): HelloFrame {
  const record = requireRecord(value);
  requireExactKeys(record, ["v", "op", "clientNonce", "instanceId", "pid"]);
  if (record.v !== PROTOCOL_VERSION || record.op !== "hello") throw new ProtocolValidationError();
  return {
    v: PROTOCOL_VERSION,
    op: "hello",
    clientNonce: requireIpcAuthValue(record.clientNonce),
    instanceId: requireInstanceId(record.instanceId),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
  };
}

export function parseChallengeFrame(value: unknown): ChallengeFrame {
  const record = requireRecord(value);
  requireExactKeys(record, ["v", "op", "serverNonce", "proof"]);
  if (record.v !== PROTOCOL_VERSION || record.op !== "challenge") throw new ProtocolValidationError();
  return {
    v: PROTOCOL_VERSION,
    op: "challenge",
    serverNonce: requireIpcAuthValue(record.serverNonce),
    proof: requireIpcAuthValue(record.proof),
  };
}

export function parseAuthenticateFrame(value: unknown): AuthenticateFrame {
  const record = requireRecord(value);
  requireExactKeys(record, ["v", "op", "proof"]);
  if (record.v !== PROTOCOL_VERSION || record.op !== "authenticate") throw new ProtocolValidationError();
  return { v: PROTOCOL_VERSION, op: "authenticate", proof: requireIpcAuthValue(record.proof) };
}

export function parseHelloOkFrame(value: unknown): HelloOkFrame {
  const record = requireRecord(value);
  requireExactKeys(record, ["v", "op", "heartbeatSeconds", "ttlSeconds"]);
  if (record.v !== PROTOCOL_VERSION || record.op !== "hello_ok") throw new ProtocolValidationError();
  const heartbeatSeconds = requireInteger(record.heartbeatSeconds, 2, 60);
  const ttlSeconds = requireInteger(record.ttlSeconds, 5, 300);
  if (ttlSeconds <= heartbeatSeconds * 2) throw new ProtocolValidationError();
  return {
    v: PROTOCOL_VERSION,
    op: "hello_ok",
    heartbeatSeconds,
    ttlSeconds,
  };
}

function parsePublishedSession(value: unknown): PublishedSessionInput {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["instanceId", "generation", "pid", "sessionId", "startedAt", "viewLink"],
    ["title", "cwdLabel", "model", "inputRequired", "controlLink"],
  );
  if (typeof record.sessionId !== "string" || !SESSION_ID_PATTERN.test(record.sessionId)) {
    throw new ProtocolValidationError();
  }
  if (typeof record.viewLink !== "string") throw new ProtocolValidationError();
  if (record.controlLink !== undefined && typeof record.controlLink !== "string") throw new ProtocolValidationError();
  if (record.inputRequired !== undefined && typeof record.inputRequired !== "boolean") {
    throw new ProtocolValidationError();
  }
  const title = optionalLabel(record.title);
  const cwdLabel = optionalLabel(record.cwdLabel);
  const model = optionalLabel(record.model);
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    sessionId: record.sessionId,
    startedAt: requireDateTime(record.startedAt),
    viewLink: record.viewLink,
    inputRequired: record.inputRequired ?? false,
    ...(record.controlLink === undefined ? {} : { controlLink: record.controlLink }),
    ...(title === undefined ? {} : { title }),
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(model === undefined ? {} : { model }),
  };
}

export function parseAuthenticatedPublisherFrame(value: unknown): AuthenticatedPublisherFrame {
  const record = requireRecord(value);
  if (record.v !== PROTOCOL_VERSION || typeof record.op !== "string") throw new ProtocolValidationError();
  if (record.op === "upsert") {
    requireExactKeys(record, ["v", "op", "session"]);
    return { v: PROTOCOL_VERSION, op: "upsert", session: parsePublishedSession(record.session) } satisfies UpsertFrame;
  }
  if (record.op === "heartbeat") {
    requireExactKeys(record, ["v", "op", "instanceId", "generation"], ["observedAt"]);
    return {
      v: PROTOCOL_VERSION,
      op: "heartbeat",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      ...(record.observedAt === undefined ? {} : { observedAt: requireDateTime(record.observedAt) }),
    } satisfies HeartbeatFrame;
  }
  if (record.op === "remove") {
    requireExactKeys(record, ["v", "op", "instanceId", "generation", "reason"]);
    if (typeof record.reason !== "string" || !Object.hasOwn(REMOVE_REASONS, record.reason)) {
      throw new ProtocolValidationError();
    }
    return {
      v: PROTOCOL_VERSION,
      op: "remove",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      reason: record.reason as RemoveFrame["reason"],
    } satisfies RemoveFrame;
  }
  throw new ProtocolValidationError();
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  return { mode: record.mode, generation: requireInteger(record.generation, 1) };
}

function parseSessionMetadata(value: unknown): SessionMetadata {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["instanceId", "generation", "startedAt", "lastSeenAt", "canView", "canControl"],
    ["title", "cwdLabel", "model", "inputRequired"],
  );
  if (
    typeof record.canView !== "boolean" ||
    typeof record.canControl !== "boolean" ||
    (record.inputRequired !== undefined && typeof record.inputRequired !== "boolean")
  ) {
    throw new ProtocolValidationError();
  }
  const title = optionalLabel(record.title);
  const cwdLabel = optionalLabel(record.cwdLabel);
  const model = optionalLabel(record.model);
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    ...(title === undefined ? {} : { title }),
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(model === undefined ? {} : { model }),
    startedAt: requireDateTime(record.startedAt),
    lastSeenAt: requireDateTime(record.lastSeenAt),
    canView: record.canView,
    canControl: record.canControl,
    inputRequired: record.inputRequired ?? false,
  };
}

function parseSessionArray(value: unknown): readonly SessionMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) throw new ProtocolValidationError();
  return value.map(parseSessionMetadata);
}

export function parseSessionListResponse(value: unknown): SessionListResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["revision", "sessions"]);
  return {
    revision: requireInteger(record.revision, 0),
    sessions: parseSessionArray(record.sessions),
  };
}

export function parseSessionEvent(value: unknown): SessionEvent {
  const record = requireRecord(value);
  if (record.type === "snapshot") {
    requireExactKeys(record, ["type", "revision", "sessions"]);
    return {
      type: "snapshot",
      revision: requireInteger(record.revision, 0),
      sessions: parseSessionArray(record.sessions),
    };
  }
  if (record.type === "session_upsert") {
    requireExactKeys(record, ["type", "revision", "session"]);
    return {
      type: "session_upsert",
      revision: requireInteger(record.revision, 0),
      session: parseSessionMetadata(record.session),
    };
  }
  if (record.type === "session_remove") {
    requireExactKeys(record, ["type", "revision", "instanceId", "generation"]);
    return {
      type: "session_remove",
      revision: requireInteger(record.revision, 0),
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
    };
  }
  throw new ProtocolValidationError();
}

export function parseLaunchResponse(value: unknown): LaunchResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation", "capability"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  return {
    mode: record.mode,
    generation: requireInteger(record.generation, 1),
    capability: SecretCapability.from(record.capability).reveal(),
  };
}

export function separatePublishedSession(
  input: PublishedSessionInput,
  lastSeenAt: string,
): { metadata: SessionMetadata; secret: SecretSessionRecord; immutableIdentity: string } {
  const view = SecretCapability.from(input.viewLink);
  const control = input.controlLink === undefined ? undefined : SecretCapability.from(input.controlLink);
  return {
    metadata: {
      instanceId: input.instanceId,
      generation: input.generation,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.cwdLabel === undefined ? {} : { cwdLabel: input.cwdLabel }),
      ...(input.model === undefined ? {} : { model: input.model }),
      startedAt: input.startedAt,
      lastSeenAt,
      canView: true,
      canControl: control !== undefined,
      inputRequired: input.inputRequired ?? false,
    },
    secret: {
      instanceId: input.instanceId,
      generation: input.generation,
      view,
      ...(control === undefined ? {} : { control }),
    },
    immutableIdentity: `${input.pid}\0${input.sessionId}\0${input.startedAt}`,
  };
}
