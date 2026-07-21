/**
 * Browser WebSocket wrapper for collab live-session sharing (vendored mirror
 * of `@oh-my-pi/pi-coding-agent/src/collab/relay-client.ts` semantics).
 *
 * Connects to a relay room, seals/opens AES-GCM frames in strict order, and
 * reconnects with exponential backoff on transient drops. Established guests
 * also recover across bounded relay room replacement; initial missing rooms,
 * host conflicts, room capacity, and decryption failures remain terminal.
 */

import type { GuestFrame, HostFrame, RelayControlMessage } from "@oh-my-pi/pi-wire";
import { open, seal } from "./codec";
import { packEnvelope, unpackEnvelope } from "./link";

const ROOM_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
};

const FATAL_CLOSE_REASONS: Record<number, string> = {
	4009: "a host is already connected for this room",
	4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_ROOM_RECOVERY_RETRIES = 6;
/** Max enveloped frames buffered while a reconnect is pending; overflow is dropped. */
const MAX_PENDING_SENDS = 256;

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. */
	key: CryptoKey | PromiseLike<CryptoKey>;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: HostFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires once per terminal close (intentional, fatal code, or bad key). willReconnect=true for transient drops that will retry. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Serializes seals for the active transport generation so frames retain send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Application envelopes held until the active transport's hello is emitted. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];
	/** Invalidates asynchronous sends that began against an older transport. */
	#sendGeneration = 0;
	/** Every opened guest transport must emit its hello before application frames. */
	#awaitingHello = false;
	/** A valid welcome proves this guest capability previously addressed a live room. */
	#roomEstablished = false;
	/** Bounded independently from ordinary transport reconnects, which reset on WebSocket open. */
	#roomRecoveryAttempts = 0;

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	/** Confirm that this guest transport received and applied a valid host welcome. */
	markRoomWelcomed(): void {
		if (this.#opts.role !== "guest" || this.#closed) return;
		this.#roomEstablished = true;
		this.#roomRecoveryAttempts = 0;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#resetSendsForNewTransport();
		this.#attempt = 0;
		this.#roomEstablished = false;
		this.#roomRecoveryAttempts = 0;
		this.#openSocket();
	}

	send(frame: GuestFrame, targetPeer = 0): void {
		const generation = this.#sendGeneration;
		const isHello = frame.t === "hello";
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed || generation !== this.#sendGeneration) return;
				const sealed = await seal(await this.#opts.key, frame);
				if (this.#closed || generation !== this.#sendGeneration) return;
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN && (!this.#awaitingHello || isHello)) {
					ws.send(envelope);
					if (isHello && this.#awaitingHello) {
						this.#awaitingHello = false;
						this.#flushPending(ws);
					}
					return;
				}
				if (!isHello && this.#pendingSends.length < MAX_PENDING_SENDS) {
					this.#pendingSends.push(envelope);
				}
			})
			.catch(() => {
				// dropped frame; the socket-level close path reports actionable failures
			});
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#resetSendsForNewTransport();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	/**
	 * Replace a potentially stale transport without ending the logical guest.
	 * Mobile browsers may suspend a page without delivering a WebSocket close
	 * event, so foreground/online lifecycle events must be able to force a
	 * fresh relay connection.
	 */
	reconnect(): void {
		if (this.#closed) return;
		this.#clearRetry();
		this.#resetSendsForNewTransport();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.("connection refresh", true);
		this.#openSocket();
	}

	#openSocket(): void {
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			this.#awaitingHello = this.#opts.role === "guest";
			if (!this.#awaitingHello) this.#flushPending(ws);
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				console.warn("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			console.warn("collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			console.warn("collab: ignoring truncated envelope");
			return;
		}
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: HostFrame;
				try {
					frame = (await open(await this.#opts.key, envelope.payload)) as HostFrame;
				} catch {
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch(() => {
				// listener threw; keep the receive chain alive
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		this.#resetSendsForNewTransport();
		const roomCloseReason = ROOM_CLOSE_REASONS[code];
		if (roomCloseReason !== undefined) {
			if (
				this.#opts.role === "guest" &&
				this.#roomEstablished &&
				this.#roomRecoveryAttempts < MAX_ROOM_RECOVERY_RETRIES
			) {
				const recoveryAttempt = this.#roomRecoveryAttempts++;
				this.onClose?.(roomCloseReason, true);
				this.#scheduleRetry(recoveryAttempt);
				return;
			}
			this.#closed = true;
			this.onClose?.(roomCloseReason, false);
			return;
		}
		const fatalReason = FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		this.#scheduleRetry(this.#attempt++);
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(attempt: number): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
		const delay = base * (0.75 + Math.random() * 0.5);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#flushPending(ws: WebSocket): void {
		if (this.#ws !== ws || ws.readyState !== WebSocket.OPEN || this.#awaitingHello) return;
		for (const envelope of this.#pendingSends) ws.send(envelope);
		this.#pendingSends.length = 0;
	}

	#resetSendsForNewTransport(): void {
		this.#sendGeneration++;
		this.#sendChain = Promise.resolve();
		this.#pendingSends.length = 0;
		this.#awaitingHello = false;
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
