export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_CAPABILITY_BYTES = 8 * 1024;
export const MAX_LABEL_CODEPOINTS = 256;
export const MAX_SESSIONS = 1_000;
export const MAX_INSTANCE_ID_BYTES = 128;

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
  readonly token: string;
  readonly instanceId: string;
  readonly pid: number;
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
