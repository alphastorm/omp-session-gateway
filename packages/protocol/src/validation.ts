import { ProtocolValidationError, SecretCapability } from "./secret.ts";
import {
  MAX_FRAME_BYTES,
  INSTANCE_ID_PATTERN,
  MAX_LABEL_CODEPOINTS,
  MAX_PUSH_PENDING_COUNT,
  MAX_REQUEST_ID_BYTES,
  MAX_PUSH_ENDPOINT_BYTES,
  MAX_SESSIONS,
  OMP_REGISTRY_VERSION,
  PUSH_API_VERSION,
  type AttentionPushMessage,
  type BrowserPushSubscription,
  type LaunchMode,
  type LaunchRequest,
  type LaunchResponse,
  type ObservedSessionInput,
  type OmpDiscoveryEntry,
  type OmpHostSnapshot,
  type OmpRegistryErrorCode,
  type PushConfigResponse,
  type PushSubscriptionRequest,
  type PushSubscriptionResponse,
  type PushDetailLevel,
  type PushUnsubscribeRequest,
  type SessionEvent,
  type SessionListResponse,
  type SessionMetadata,
} from "./types.ts";

const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const DISALLOWED_LABEL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const PUSH_DETAIL_LEVELS: Readonly<Record<PushDetailLevel, true>> = {
  private: true,
  session: true,
  preview: true,
};

/** 32 random bytes, hex encoded, written into the discovery file by the host. */
const OMP_DISCOVERY_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const OMP_REGISTRY_ERROR_CODES: Readonly<Record<OmpRegistryErrorCode, true>> = {
  malformed_request: true,
  unsupported_protocol: true,
  authentication_failed: true,
  snapshot_unavailable: true,
  invalid_operation: true,
  invalid_access: true,
  stale_generation: true,
  access_unavailable: true,
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

/** Every instance identity on every surface: the one OMP mints, validated the way OMP does. */
function requireInstanceId(value: unknown): string {
  if (typeof value !== "string" || !INSTANCE_ID_PATTERN.test(value)) throw new ProtocolValidationError();
  return value;
}

function requireRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_REQUEST_ID_BYTES ||
    !REQUEST_ID_PATTERN.test(value)
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

/**
 * Parses one `<entryId>.json` discovery file. The file is written once per publication and never
 * rewritten, so an unparseable or foreign-shaped file is a stale or alien artifact, not a host.
 */
export function parseOmpDiscoveryEntry(entryId: string, value: unknown): OmpDiscoveryEntry {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "instanceId", "pid", "endpoint", "createdAt", "token"]);
  if (typeof record.endpoint !== "string" || record.endpoint.length === 0 || record.endpoint.includes("\0")) {
    throw new ProtocolValidationError();
  }
  if (typeof record.token !== "string" || !OMP_DISCOVERY_TOKEN_PATTERN.test(record.token)) {
    throw new ProtocolValidationError();
  }
  return {
    entryId: requireInstanceId(entryId),
    version: requireInteger(record.version, 1),
    instanceId: requireInstanceId(record.instanceId),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    endpoint: record.endpoint,
    createdAt: requireInteger(record.createdAt, 0),
    token: record.token,
  };
}

function parseOmpHostModel(value: unknown): { provider: string; id: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value);
  requireExactKeys(record, ["provider", "id"]);
  const provider = optionalLabel(record.provider);
  const id = optionalLabel(record.id);
  if (provider === undefined || id === undefined || provider === "" || id === "") return undefined;
  return { provider, id };
}

/** One host's `snapshot` payload. Upstream bounds every free-form string to 1024 characters. */
export function parseOmpHostSnapshot(value: unknown): OmpHostSnapshot {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    [
      "instanceId",
      "generation",
      "pid",
      "sessionId",
      "startedAt",
      "participants",
      "relayConnected",
      "inputRequired",
      "access",
    ],
    ["sessionName", "cwd", "model"],
  );
  if (typeof record.sessionId !== "string" || !SESSION_ID_PATTERN.test(record.sessionId)) {
    throw new ProtocolValidationError();
  }
  if (typeof record.relayConnected !== "boolean" || typeof record.inputRequired !== "boolean") {
    throw new ProtocolValidationError();
  }
  if (record.access !== "view" && record.access !== "control") throw new ProtocolValidationError();
  const sessionName = record.sessionName === null ? undefined : optionalLabel(record.sessionName);
  const cwd = record.cwd === null ? undefined : optionalLabel(record.cwd);
  const model = parseOmpHostModel(record.model);
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    sessionId: record.sessionId,
    // ECMAScript TimeClip limit: every accepted timestamp must survive ISO projection.
    startedAt: requireInteger(record.startedAt, 0, 8_640_000_000_000_000),
    participants: requireInteger(record.participants, 0),
    relayConnected: record.relayConnected,
    inputRequired: record.inputRequired,
    access: record.access,
    ...(sessionName === undefined || sessionName === "" ? {} : { sessionName }),
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
  };
}

export type OmpRegistryReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OmpRegistryErrorCode };

function parseOmpEnvelope(value: unknown): { record: JsonRecord; ok: boolean } {
  const record = requireRecord(value);
  if (record.v !== OMP_REGISTRY_VERSION || typeof record.ok !== "boolean") throw new ProtocolValidationError();
  if (!record.ok) {
    requireExactKeys(record, ["ok", "v", "error"]);
    if (typeof record.error !== "string" || !Object.hasOwn(OMP_REGISTRY_ERROR_CODES, record.error)) {
      throw new ProtocolValidationError();
    }
  }
  return { record, ok: record.ok };
}

export function parseOmpSnapshotReply(value: unknown): OmpRegistryReply<OmpHostSnapshot> {
  const { record, ok } = parseOmpEnvelope(value);
  if (!ok) return { ok: false, error: record.error as OmpRegistryErrorCode };
  requireExactKeys(record, ["ok", "v", "snapshot"]);
  return { ok: true, value: parseOmpHostSnapshot(record.snapshot) };
}

/**
 * A successful `link` reply carries the one capability this whole system exists to broker, so it is
 * wrapped before it can be logged, serialized, or copied into a plain field.
 */
export function parseOmpLinkReply(value: unknown): OmpRegistryReply<SecretCapability> {
  const { record, ok } = parseOmpEnvelope(value);
  if (!ok) return { ok: false, error: record.error as OmpRegistryErrorCode };
  requireExactKeys(record, ["ok", "v", "url"]);
  return { ok: true, value: SecretCapability.from(record.url) };
}

/**
 * Reduces one host snapshot to the browser-safe directory entry. `cwd` becomes a basename label:
 * the directory listing shows which project a session belongs to, and the full path is neither
 * needed for that nor worth broadcasting to every authenticated viewer.
 */
export function observedSessionFromSnapshot(snapshot: OmpHostSnapshot): ObservedSessionInput {
  const title = optionalLabel(snapshot.sessionName);
  const cwdLabel = optionalLabel(
    snapshot.cwd === undefined ? undefined : (snapshot.cwd.replace(/[/\\]+$/u, "").split(/[/\\]/u).pop() ?? undefined),
  );
  const model = snapshot.model === undefined ? undefined : optionalLabel(`${snapshot.model.provider}/${snapshot.model.id}`);
  return {
    instanceId: snapshot.instanceId,
    generation: snapshot.generation,
    pid: snapshot.pid,
    sessionId: snapshot.sessionId,
    startedAt: new Date(snapshot.startedAt).toISOString(),
    canControl: snapshot.access === "control",
    inputRequired: snapshot.inputRequired,
    ...(title === undefined || title === "" ? {} : { title }),
    ...(cwdLabel === undefined || cwdLabel === "" ? {} : { cwdLabel }),
    ...(model === undefined || model === "" ? {} : { model }),
  };
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation"], ["requestId"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  if (record.requestId !== undefined && record.mode !== "control") throw new ProtocolValidationError();
  return {
    mode: record.mode,
    generation: requireInteger(record.generation, 1),
    ...(record.requestId === undefined ? {} : { requestId: requireRequestId(record.requestId) }),
  };
}
function requirePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_PUSH_ENDPOINT_BYTES) {
    throw new ProtocolValidationError();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProtocolValidationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.href !== value
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requirePushKey(value: unknown, minimumLength: number, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !PUSH_KEY_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function parseBrowserPushSubscription(value: unknown): BrowserPushSubscription {
  const record = requireRecord(value);
  requireExactKeys(record, ["endpoint", "expirationTime", "keys"]);
  const keys = requireRecord(record.keys);
  requireExactKeys(keys, ["p256dh", "auth"]);
  if (
    record.expirationTime !== null &&
    (!Number.isSafeInteger(record.expirationTime) || (record.expirationTime as number) < 0)
  ) {
    throw new ProtocolValidationError();
  }
  return {
    endpoint: requirePushEndpoint(record.endpoint),
    expirationTime: record.expirationTime as number | null,
    keys: {
      p256dh: requirePushKey(keys.p256dh, 80, 128),
      auth: requirePushKey(keys.auth, 20, 64),
    },
  };
}

export function parsePushSubscriptionRequest(value: unknown): PushSubscriptionRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "subscription"], ["detailLevel"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  let detailLevel: PushDetailLevel | undefined;
  if (record.detailLevel !== undefined) {
    if (
      typeof record.detailLevel !== "string" ||
      !Object.hasOwn(PUSH_DETAIL_LEVELS, record.detailLevel)
    ) {
      throw new ProtocolValidationError();
    }
    detailLevel = record.detailLevel as PushDetailLevel;
  }
  return {
    version: PUSH_API_VERSION,
    ...(detailLevel === undefined ? {} : { detailLevel }),
    subscription: parseBrowserPushSubscription(record.subscription),
  };
}

export function parsePushSubscriptionResponse(value: unknown): PushSubscriptionResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "detailLevel"]);
  if (
    record.version !== PUSH_API_VERSION ||
    typeof record.detailLevel !== "string" ||
    !Object.hasOwn(PUSH_DETAIL_LEVELS, record.detailLevel)
  ) {
    throw new ProtocolValidationError();
  }
  return {
    version: PUSH_API_VERSION,
    detailLevel: record.detailLevel as PushDetailLevel,
  };
}

export function parsePushUnsubscribeRequest(value: unknown): PushUnsubscribeRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "endpoint"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  return { version: PUSH_API_VERSION, endpoint: requirePushEndpoint(record.endpoint) };
}

export function parsePushConfigResponse(value: unknown): PushConfigResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "applicationServerKey"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  return {
    version: PUSH_API_VERSION,
    applicationServerKey: requirePushKey(record.applicationServerKey, 80, 128),
  };
}

export function parseAttentionPushMessage(value: unknown): AttentionPushMessage {
  const record = requireRecord(value);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  if (record.type === "attention") {
    requireExactKeys(
      record,
      ["version", "type", "instanceId", "generation", "requestId", "pendingAskCount", "title"],
      ["body"],
    );
    if (record.title !== "OMP session needs attention") throw new ProtocolValidationError();
    const body = optionalLabel(record.body);
    return {
      version: PUSH_API_VERSION,
      type: "attention",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      requestId: requireRequestId(record.requestId),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
      title: record.title,
      ...(body === undefined ? {} : { body }),
    };
  }
  if (record.type === "clear") {
    requireExactKeys(record, ["version", "type", "instanceId", "requestId", "pendingAskCount"]);
    return {
      version: PUSH_API_VERSION,
      type: "clear",
      instanceId: requireInstanceId(record.instanceId),
      requestId: requireRequestId(record.requestId),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
    };
  }
  throw new ProtocolValidationError();
}


function parseSessionMetadata(value: unknown): SessionMetadata {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["instanceId", "generation", "startedAt", "lastSeenAt", "canView", "canControl"],
    ["title", "cwdLabel", "model", "inputRequired", "ask"],
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
  let ask: SessionMetadata["ask"];
  if (record.ask !== undefined) {
    const askRecord = requireRecord(record.ask);
    requireExactKeys(askRecord, ["requestId", "since"], ["preview", "optionCount"]);
    const preview = optionalLabel(askRecord.preview);
    const optionCount =
      askRecord.optionCount === undefined ? undefined : requireInteger(askRecord.optionCount, 1, 128);
    ask = {
      requestId: requireRequestId(askRecord.requestId),
      since: requireDateTime(askRecord.since),
      ...(preview === undefined ? {} : { preview }),
      ...(optionCount === undefined ? {} : { optionCount }),
    };
  }
  const inputRequired = record.inputRequired ?? false;
  if ((inputRequired && ask === undefined) || (!inputRequired && ask !== undefined)) {
    throw new ProtocolValidationError();
  }
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
    inputRequired,
    ...(ask === undefined ? {} : { ask }),
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

/**
 * Projects one observed host onto the browser-safe directory record. `canView` is unconditional:
 * every published host answers a `view` link request, while `control` depends on how the session
 * was shared. No capability is involved — those are fetched per launch, straight from the host.
 */
export function sessionMetadataFromObserved(
  input: ObservedSessionInput,
  lastSeenAt: string,
): { metadata: SessionMetadata; immutableIdentity: string } {
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
      canControl: input.canControl,
      inputRequired: input.inputRequired,
    },
    immutableIdentity: `${input.pid}\0${input.sessionId}\0${input.startedAt}`,
  };
}
