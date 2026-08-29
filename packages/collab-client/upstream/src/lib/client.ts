/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * applied frame, so React change detection is reference equality all the way.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	HostFrame,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import type { ConnectionPhase, PathHealth } from "../embed-contract";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket, type GatewayHostFrame } from "./socket";

export type { ConnectionPhase, PathHealth, PathHealthState } from "../embed-contract";


export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** True after a response is sent and until the host acknowledges it. */
	uiResponsePending: boolean;
	/** Browser-to-gateway HTTP path health. */
	gatewayHealth: PathHealth;
	/** Browser-to-host encrypted relay path health. */
	relayHealth: PathHealth;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
const RELAY_IDLE_PROBE_MS = 10_000;
const RELAY_INITIAL_TIMEOUT_MS = 3_000;
const RELAY_MIN_TIMEOUT_MS = 1_500;
const RELAY_MAX_TIMEOUT_MS = 8_000;

const INITIAL_PATH_HEALTH: PathHealth = {
	state: "checking",
	rttMs: null,
	lastSuccessAt: null,
	failureSince: null,
	retryAt: null,
};

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

interface PendingUiResponse {
	request: CollabUiRequest;
	value: CollabUiResponseValue | undefined;
}

export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	#gatewayHealth: PathHealth = INITIAL_PATH_HEALTH;
	#relayHealth: PathHealth = INITIAL_PATH_HEALTH;
	#pendingUiResponse: PendingUiResponse | null = null;
	#relayProbeSupported = false;
	#relayProbeSeq = 0;
	#relayConsecutiveMisses = 0;
	#relayProbeTimer: Timer | null = null;
	#relayProbeTimeoutTimer: Timer | null = null;
	#pendingRelayProbe: { seq: number; sentAt: number } | null = null;
	#lastRelayActivityAt = Date.now();
	#relaySrtt: number | null = null;
	#relayRttVariance: number | null = null;
	#relayProbesPaused = false;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: readonly SessionEntry[] = [];
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#snapshot: GuestSnapshot;

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#readOnly = this.#writeToken === undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#socket.onRetryScheduled = (retryAt, _delay, _attempt) => {
			this.#relayHealth = {
				...this.#relayHealth,
				state: "unreachable",
				failureSince: this.#relayHealth.failureSince ?? Date.now(),
				retryAt,
			};
			this.#commit();
		};
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) this.#armWelcomeTimer();
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#socket.close();
	}

	/** Force a fresh relay transport after a browser foreground/network transition. */
	refreshConnection(): void {
		if (this.#phase === "ended") return;
		this.#socket.reconnect();
	}

	/** Measure the established browser-to-host path without replacing a healthy socket. */
	remeasureRelay(): void {
		if (
			this.#relayProbesPaused ||
			this.#phase !== "live" ||
			!this.#relayProbeSupported ||
			!this.#socket.isOpen ||
			this.#pendingRelayProbe !== null
		) {
			return;
		}
		clearTimeout(this.#relayProbeTimer ?? undefined);
		this.#relayProbeTimer = null;
		this.#sendRelayProbe();
	}

	/** Stop idle and pending relay probes while the browser page is hidden. */
	setRelayProbesPaused(paused: boolean): void {
		if (this.#relayProbesPaused === paused) return;
		this.#relayProbesPaused = paused;
		if (paused) {
			this.#clearRelayProbe();
			return;
		}
		this.#lastRelayActivityAt = Date.now();
		this.#scheduleRelayProbe();
	}

	setGatewayHealth(health: PathHealth): void {
		if (
			this.#gatewayHealth.state === health.state &&
			this.#gatewayHealth.rttMs === health.rttMs &&
			this.#gatewayHealth.lastSuccessAt === health.lastSuccessAt &&
			this.#gatewayHealth.failureSince === health.failureSince &&
			this.#gatewayHealth.retryAt === health.retryAt
		) {
			return;
		}
		this.#gatewayHealth = health;
		this.#commit();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per applied frame. */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		if (this.#readOnly) return;
		this.#socket.send({ t: "prompt", text, images: images && images.length > 0 ? images : undefined });
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		if (this.#readOnly || this.#pendingUiResponse !== null || this.#uiRequest?.reqId !== reqId) return;
		this.#pendingUiResponse = { request: this.#uiRequest, value };
		this.#socket.send({ t: "ui-response", reqId, value });
		this.#commit();
	}

	sendAbort(): void {
		if (this.#readOnly) return;
		this.#socket.send({ t: "abort" });
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		if (this.#readOnly) return;
		this.#socket.send({ t: "agent-cmd", cmd, agentId, ...(text === undefined ? {} : { text }) });
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: GatewayHostFrame): void {
		this.#applyFrameSafe(frame);
	}

	#handleOpen(): void {
		this.#welcomed = false;
		this.#clearRelayProbe();
		this.#relayProbeSupported = false;
		this.#relayHealth = {
			...this.#relayHealth,
			state: "checking",
			retryAt: null,
		};
		this.#armWelcomeTimer();
		this.#socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#name,
			...(this.#writeToken === undefined ? {} : { writeToken: this.#writeToken }),
		});
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		this.#clearWelcomeTimer();
		this.#clearRelayProbe();
		this.#relayProbeSupported = false;
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			this.#relayHealth = {
				...this.#relayHealth,
				state: this.#relayHealth.state === "unreachable" ? "unreachable" : "degraded",
				failureSince: this.#relayHealth.failureSince ?? Date.now(),
				retryAt: null,
			};
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearRelayProbe();
		this.#phase = "ended";
		this.#endedReason = reason;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#pendingUiResponse = null;
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
		}, WELCOME_TIMEOUT_MS);
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: GatewayHostFrame): void {
		if (frame.t === "gateway-health-pong") {
			this.#handleRelayPong(frame.seq);
			return;
		}
		this.#recordRelayActivity(undefined, false);
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				// Reset accumulator: a fresh welcome arriving mid-load (reconnect)
				// supersedes any partially-streamed snapshot from the prior session.
				this.#header = frame.header;
				this.#entries = [];
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#restorePendingUiRequest();
				this.#welcomed = true;
				this.#socket.markRoomWelcomed();
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
					this.#resendPendingUiResponse();
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			case "snapshot-chunk": {
				// Stream transcript fragments into the live snapshot. The host
				// always closes the train with `final: true`; that flip is what
				// moves the guest from "waiting" to "live".
				this.#entries = [...this.#entries, ...frame.entries];
				if (frame.final) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
					this.#resendPendingUiResponse();
				} else {
					this.#armSnapshotProgressTimer();
				}
				break;
			}
			case "entry":
				this.#entries = [...this.#entries, frame.entry];
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				if (
					this.#pendingUiResponse?.request.reqId === frame.request.reqId ||
					this.#uiRequest?.reqId === frame.request.reqId ||
					this.#uiRequestQueue.some(request => request.reqId === frame.request.reqId)
				) {
					break;
				}
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#pendingUiResponse?.request.reqId === frame.reqId) this.#pendingUiResponse = null;
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		this.#commit();
		this.#scheduleRelayProbe();
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					...(event.intent === undefined ? {} : { intent: event.intent }),
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#handleRelayPong(seq: number): void {
		if (!Number.isSafeInteger(seq) || seq < 0) return;
		this.#relayProbeSupported = true;
		const pending = this.#pendingRelayProbe;
		const matched = pending?.seq === seq;
		const rtt = matched && pending !== null ? Date.now() - pending.sentAt : undefined;
		this.#recordRelayActivity(rtt, pending === null || matched);
		this.#commit();
		this.#scheduleRelayProbe();
	}

	#recordRelayActivity(rttMs?: number, satisfiesProbe = true): void {
		const now = Date.now();
		this.#lastRelayActivityAt = now;
		if (this.#pendingRelayProbe !== null && !satisfiesProbe) return;
		if (this.#relayProbeTimeoutTimer !== null) {
			clearTimeout(this.#relayProbeTimeoutTimer);
			this.#relayProbeTimeoutTimer = null;
		}
		this.#pendingRelayProbe = null;
		this.#relayConsecutiveMisses = 0;
		if (rttMs !== undefined) this.#recordRelayRtt(Math.max(0, rttMs));
		this.#relayHealth = {
			state: "healthy",
			rttMs: this.#relaySrtt === null ? this.#relayHealth.rttMs : Math.round(this.#relaySrtt),
			lastSuccessAt: now,
			failureSince: null,
			retryAt: null,
		};
	}

	#recordRelayRtt(rttMs: number): void {
		if (this.#relaySrtt === null || this.#relayRttVariance === null) {
			this.#relaySrtt = rttMs;
			this.#relayRttVariance = rttMs / 2;
			return;
		}
		this.#relayRttVariance = this.#relayRttVariance * 0.75 + Math.abs(this.#relaySrtt - rttMs) * 0.25;
		this.#relaySrtt = this.#relaySrtt * 0.875 + rttMs * 0.125;
	}

	#relayProbeTimeoutMs(): number {
		if (this.#relaySrtt === null || this.#relayRttVariance === null) return RELAY_INITIAL_TIMEOUT_MS;
		return Math.min(
			RELAY_MAX_TIMEOUT_MS,
			Math.max(RELAY_MIN_TIMEOUT_MS, this.#relaySrtt + 4 * this.#relayRttVariance),
		);
	}

	#scheduleRelayProbe(): void {
		clearTimeout(this.#relayProbeTimer ?? undefined);
		this.#relayProbeTimer = null;
		if (
			this.#relayProbesPaused ||
			!this.#relayProbeSupported ||
			this.#phase !== "live" ||
			this.#pendingRelayProbe !== null ||
			(typeof document !== "undefined" && document.visibilityState === "hidden")
		) {
			return;
		}
		const delay = Math.max(0, this.#lastRelayActivityAt + RELAY_IDLE_PROBE_MS - Date.now());
		this.#relayProbeTimer = setTimeout(() => {
			this.#relayProbeTimer = null;
			this.#sendRelayProbe();
		}, delay);
	}

	#sendRelayProbe(): void {
		if (
			this.#phase !== "live" ||
			!this.#relayProbeSupported ||
			!this.#socket.isOpen ||
			this.#relayProbesPaused ||
			(typeof document !== "undefined" && document.visibilityState === "hidden")
		) {
			return;
		}
		const seq = ++this.#relayProbeSeq;
		this.#pendingRelayProbe = { seq, sentAt: Date.now() };
		this.#socket.send({ t: "gateway-health-ping", seq });
		this.#relayProbeTimeoutTimer = setTimeout(() => {
			this.#relayProbeTimeoutTimer = null;
			if (this.#pendingRelayProbe?.seq !== seq) return;
			this.#pendingRelayProbe = null;
			this.#relayConsecutiveMisses++;
			const failureSince = this.#relayHealth.failureSince ?? Date.now();
			if (this.#relayConsecutiveMisses < 2) {
				this.#relayHealth = { ...this.#relayHealth, state: "degraded", failureSince, retryAt: null };
				this.#commit();
				this.#sendRelayProbe();
				return;
			}
			this.#relayHealth = { ...this.#relayHealth, state: "unreachable", failureSince, retryAt: null };
			this.#commit();
			this.refreshConnection();
		}, this.#relayProbeTimeoutMs());
	}

	#clearRelayProbe(): void {
		clearTimeout(this.#relayProbeTimer ?? undefined);
		clearTimeout(this.#relayProbeTimeoutTimer ?? undefined);
		this.#relayProbeTimer = null;
		this.#relayProbeTimeoutTimer = null;
		this.#pendingRelayProbe = null;
		this.#relayConsecutiveMisses = 0;
	}

	#restorePendingUiRequest(): void {
		this.#uiRequest = this.#pendingUiResponse?.request ?? null;
		this.#uiRequestQueue = [];
	}

	#resendPendingUiResponse(): void {
		const pending = this.#pendingUiResponse;
		if (pending === null || this.#phase !== "live") return;
		this.#socket.send({ t: "ui-response", reqId: pending.request.reqId, value: pending.value });
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			entries: this.#entries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			uiResponsePending: this.#pendingUiResponse !== null,
			gatewayHealth: this.#gatewayHealth,
			relayHealth: this.#relayHealth,
			notices: this.#notices,
		};
	}

	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
