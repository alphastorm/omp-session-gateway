export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_CAPABILITY_BYTES = 8 * 1024;
export const MAX_LABEL_CODEPOINTS = 256;
export const MAX_SESSIONS = 1_000;
export const MAX_INSTANCE_ID_BYTES = 128;
export const MAX_OMP_REGISTRY_REQUEST_BYTES = 4 * 1024;
export const MAX_OMP_REGISTRY_RESPONSE_BYTES = 64 * 1024;
export const PUSH_API_VERSION = 2 as const;
export const MAX_PUSH_ENDPOINT_BYTES = 4 * 1024;
export const MAX_PUSH_SUBSCRIPTION_BYTES = 8 * 1024;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_PUSH_PENDING_COUNT = 1_000;


export type LaunchMode = "view" | "control";
/**
 * Wire version of OMP's own local collaboration host registry. Mainline OMP publishes one
 * discovery file and one owner-only socket per live host; the gateway reads them. Upstream calls
 * this `COLLAB_REGISTRY_VERSION` and rejects any other value with `unsupported_protocol`.
 */
export const OMP_REGISTRY_VERSION = 1 as const;

/** Parsed `<entryId>.json` from OMP's discovery directory. Never carries a capability. */
export interface OmpDiscoveryEntry {
  /** Basename without `.json`. Fresh per publication, so a rotated room never reuses it. */
  readonly entryId: string;
  readonly version: number;
  readonly instanceId: string;
  readonly pid: number;
  /** Absolute socket or named-pipe path. OMP relocates long paths, so never derive it. */
  readonly endpoint: string;
  readonly createdAt: number;
  /** Bearer for querying this host only. Authorizes a question, never an answer. */
  readonly token: string;
}

export interface OmpHostModel {
  readonly provider: string;
  readonly id: string;
}

/** One `snapshot` answer from a live OMP host. Metadata only, by upstream's contract. */
export interface OmpHostSnapshot {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly cwd?: string;
  readonly model?: OmpHostModel;
  readonly startedAt: number;
  readonly participants: number;
  readonly relayConnected: boolean;
  readonly inputRequired: boolean;
  readonly access: LaunchMode;
}

/** Every wire error string upstream's registry server can return. */
export type OmpRegistryErrorCode =
  | "malformed_request"
  | "unsupported_protocol"
  | "authentication_failed"
  | "snapshot_unavailable"
  | "invalid_operation"
  | "invalid_access"
  | "stale_generation"
  | "access_unavailable";

/**
 * A host the gateway observed this poll, reduced to what the directory needs. Capability-free by
 * construction: the gateway asks a host for a link only when an operator presses View or Control.
 */
export interface ObservedSessionInput {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly canControl: boolean;
  readonly inputRequired: boolean;
}

export interface SessionAskMetadata {
  readonly requestId: string;
  readonly since: string;
  readonly preview?: string;
  readonly optionCount?: number;
}

/** Browser-safe metadata. This type can never contain a collaboration capability. */
export interface SessionMetadata {
  readonly instanceId: string;
  readonly generation: number;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly canView: boolean;
  readonly canControl: boolean;
  readonly inputRequired: boolean;
  readonly ask?: SessionAskMetadata;
}

export interface SessionListResponse {
  readonly revision: number;
  readonly sessions: readonly SessionMetadata[];
}

export type SessionEvent =
  | { readonly type: "snapshot"; readonly revision: number; readonly sessions: readonly SessionMetadata[] }
  | { readonly type: "session_upsert"; readonly revision: number; readonly session: SessionMetadata }
  | {
      readonly type: "session_remove";
      readonly revision: number;
      readonly instanceId: string;
      readonly generation: number;
    };
export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: PushSubscriptionKeys;
}

export type PushDetailLevel = "private" | "session" | "preview";

export interface PushSubscriptionRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly detailLevel?: PushDetailLevel;
  readonly subscription: BrowserPushSubscription;
}

export interface PushSubscriptionResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly detailLevel: PushDetailLevel;
}

export interface PushUnsubscribeRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly endpoint: string;
}

export interface PushConfigResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly applicationServerKey: string;
}

/** Capability-free message encrypted for one browser push subscription. */
export type AttentionPushMessage =
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "attention";
      readonly instanceId: string;
      readonly generation: number;
      readonly requestId: string;
      readonly pendingAskCount: number;
      readonly title: "OMP session needs attention";
      readonly body?: string;
    }
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "clear";
      readonly instanceId: string;
      readonly requestId: string;
      readonly pendingAskCount: number;
    };


export interface LaunchRequest {
  readonly mode: LaunchMode;
  readonly generation: number;
  readonly requestId?: string;
}

export interface LaunchResponse {
  readonly mode: LaunchMode;
  readonly generation: number;
  readonly capability: string;
}

export interface ProblemResponse {
  readonly code: string;
  readonly message: string;
}
