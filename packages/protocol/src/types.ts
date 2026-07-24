export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_CAPABILITY_BYTES = 8 * 1024;
export const MAX_LABEL_CODEPOINTS = 256;
export const MAX_SESSIONS = 1_000;
export const MAX_INSTANCE_ID_BYTES = 128;
export const IPC_AUTH_NONCE_BYTES = 32;
export const IPC_AUTH_VALUE_LENGTH = 43;
export const PUSH_API_VERSION = 1 as const;
export const MAX_PUSH_ENDPOINT_BYTES = 4 * 1024;
export const MAX_PUSH_SUBSCRIPTION_BYTES = 8 * 1024;


export type LaunchMode = "view" | "control";
export type RemoveReason =
  | "stopped"
  | "shutdown"
  | "session_changed"
  | "faulted"
  | "connection_closed"
  | "expired";

export interface HelloFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "hello";
  readonly clientNonce: string;
  readonly instanceId: string;
  readonly pid: number;
}

export interface ChallengeFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "challenge";
  readonly serverNonce: string;
  readonly proof: string;
}

export interface AuthenticateFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "authenticate";
  readonly proof: string;
}

export interface HelloOkFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "hello_ok";
  readonly heartbeatSeconds: number;
  readonly ttlSeconds: number;
}

export interface PublishedSessionInput {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly inputRequired?: boolean;
  readonly viewLink: string;
  readonly controlLink?: string;
}

export interface UpsertFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "upsert";
  readonly session: PublishedSessionInput;
}

export interface HeartbeatFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "heartbeat";
  readonly instanceId: string;
  readonly generation: number;
  readonly observedAt?: string;
}

export interface RemoveFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "remove";
  readonly instanceId: string;
  readonly generation: number;
  readonly reason: RemoveReason;
}

export type AuthenticatedPublisherFrame = UpsertFrame | HeartbeatFrame | RemoveFrame;

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

export interface PushSubscriptionRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly subscription: BrowserPushSubscription;
}

export interface PushUnsubscribeRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly endpoint: string;
}

export interface PushConfigResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly applicationServerKey: string;
}

/** Metadata-only message encrypted for one browser push subscription. */
export type AttentionPushMessage =
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "attention";
      readonly instanceId: string;
      readonly generation: number;
    }
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "resolved";
      readonly instanceId: string;
      readonly generation: number;
    };


export interface LaunchRequest {
  readonly mode: LaunchMode;
  readonly generation: number;
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
