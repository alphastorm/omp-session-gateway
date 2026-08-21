import { randomUUID } from "node:crypto";
import {
  type LaunchMode,
  type PublishedSessionInput,
  type SecretCapability,
  type SecretSessionRecord,
  type SessionEvent,
  type SessionListResponse,
  type SessionMetadata,
  separatePublishedSession,
} from "@omp-session-gateway/protocol";

export interface RegistryClock {
  monotonicNowMs(): number;
  wallNowIso(): string;
}

export interface RegistryOptions {
  readonly ttlSeconds: number;
  readonly maxSessions: number;
  readonly clock?: RegistryClock;
  readonly requestIdFactory?: () => string;
  readonly onListenerError?: (error: unknown) => void;
}

interface InternalMetadataRecord {
  metadata: SessionMetadata;
  immutableIdentity: string;
  ownerId: string;
  receivedAtMs: number;
}

export type UpsertResult = "inserted" | "updated" | "ignored_older";
export type LaunchLookup =
  | { readonly status: "ok"; readonly capability: SecretCapability }
  | { readonly status: "missing" }
  | { readonly status: "generation_mismatch" }
  | { readonly status: "request_mismatch" };

const systemClock: RegistryClock = {
  monotonicNowMs: () => performance.now(),
  wallNowIso: () => new Date().toISOString(),
};
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

function cloneMetadata(metadata: SessionMetadata): SessionMetadata {
  return { ...metadata, ...(metadata.ask === undefined ? {} : { ask: { ...metadata.ask } }) };
}

export class SessionRegistry {
  readonly #metadata = new Map<string, InternalMetadataRecord>();
  readonly #secrets = new Map<string, SecretSessionRecord>();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #pending: SessionEvent[] = [];
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #clock: RegistryClock;
  readonly #requestIdFactory: () => string;
  readonly #onListenerError: (error: unknown) => void;
  #pendingHead = 0;
  #dispatching = false;
  #revision = 0;

  constructor(options: RegistryOptions) {
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1) throw new Error("invalid registry TTL");
    if (!Number.isSafeInteger(options.maxSessions) || options.maxSessions < 1) throw new Error("invalid registry capacity");
    this.#ttlMs = options.ttlSeconds * 1_000;
    this.#maxSessions = options.maxSessions;
    this.#clock = options.clock ?? systemClock;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.#onListenerError = options.onListenerError ?? (() => undefined);
  }

  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#metadata.size;
  }

  snapshot(): SessionListResponse {
    this.sweepExpired();
    return {
      revision: this.#revision,
      sessions: [...this.#metadata.values()]
        .map(record => cloneMetadata(record.metadata))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    };
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Atomic admission: the listener is registered before the snapshot is observed, so a mutation that
   * races the handshake — including one the listener itself causes while reading the snapshot — is
   * buffered instead of falling into the gap between reading the directory and subscribing to it.
   * Buffered revisions at or below the snapshot revision are already represented by the snapshot and
   * are dropped; every newer one is replayed in order before the subscription goes live, so the
   * listener observes exactly one snapshot followed by strictly increasing revisions.
   */
  subscribeWithSnapshot(listener: (event: SessionEvent) => void): () => void {
    const buffered: SessionEvent[] = [];
    let snapshotRevision = -1;
    let live = false;
    const gate = (event: SessionEvent): void => {
      if (!live) {
        buffered.push(event);
        return;
      }
      // Still filtered once live: admission can complete inside an in-flight dispatch that has yet to
      // reach this listener, and that event is already folded into the snapshot.
      if (event.revision > snapshotRevision) listener(event);
    };
    this.#listeners.add(gate);
    const unsubscribe = (): void => {
      this.#listeners.delete(gate);
    };
    try {
      const snapshot = this.snapshot();
      snapshotRevision = snapshot.revision;
      listener({ type: "snapshot", revision: snapshot.revision, sessions: snapshot.sessions });
      // Indexed rather than shifted: the gate keeps appending while this drains, and those late
      // arrivals belong at the tail of the same ordered replay.
      for (let index = 0; index < buffered.length; index += 1) {
        const event = buffered[index] as SessionEvent;
        if (event.revision > snapshotRevision) listener(event);
      }
      live = true;
    } catch (error) {
      // A throwing listener must not leave its admission wrapper registered on the registry.
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  upsert(ownerId: string, input: PublishedSessionInput): UpsertResult {
    const existing = this.#metadata.get(input.instanceId);
    if (existing !== undefined && existing.ownerId !== ownerId) throw new Error("instance owned by another publisher");
    if (existing !== undefined && input.generation < existing.metadata.generation) return "ignored_older";
    if (existing === undefined && this.#metadata.size >= this.#maxSessions) throw new Error("registry capacity exceeded");
    const receivedAtMs = this.#clock.monotonicNowMs();
    const receivedAt = this.#clock.wallNowIso();
    const separated = separatePublishedSession(input, receivedAt);
    if (
      existing !== undefined &&
      input.generation === existing.metadata.generation &&
      separated.immutableIdentity !== existing.immutableIdentity
    ) {
      throw new Error("generation identity conflict");
    }
    let metadata = separated.metadata;
    if (metadata.inputRequired) {
      const preservedAsk =
        existing !== undefined &&
        existing.metadata.generation === metadata.generation &&
        existing.metadata.inputRequired
          ? existing.metadata.ask
          : undefined;
      const requestId = preservedAsk?.requestId ?? this.#requestIdFactory();
      if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("invalid attention request ID");
      metadata = {
        ...metadata,
        ask: preservedAsk ?? { requestId, since: receivedAt },
      };
    }

    // Revoke the old secret before making replacement metadata observable.
    this.#secrets.delete(input.instanceId);
    this.#metadata.set(input.instanceId, {
      metadata,
      immutableIdentity: separated.immutableIdentity,
      ownerId,
      receivedAtMs,
    });
    this.#secrets.set(input.instanceId, separated.secret);
    this.#revision += 1;
    this.#emit({ type: "session_upsert", revision: this.#revision, session: cloneMetadata(metadata) });
    return existing === undefined ? "inserted" : "updated";
  }

  heartbeat(ownerId: string, instanceId: string, generation: number): boolean {
    const existing = this.#metadata.get(instanceId);
    if (existing === undefined || existing.ownerId !== ownerId || existing.metadata.generation !== generation) return false;
    existing.receivedAtMs = this.#clock.monotonicNowMs();
    existing.metadata = { ...existing.metadata, lastSeenAt: this.#clock.wallNowIso() };
    return true;
  }

  remove(ownerId: string, instanceId: string, generation: number): boolean {
    const existing = this.#metadata.get(instanceId);
    if (existing === undefined || existing.ownerId !== ownerId || existing.metadata.generation !== generation) return false;
    this.#removeRecord(instanceId, existing.metadata.generation);
    return true;
  }

  removeOwner(ownerId: string): number {
    const owned = [...this.#metadata.entries()].filter(([, record]) => record.ownerId === ownerId);
    for (const [instanceId, record] of owned) this.#removeRecord(instanceId, record.metadata.generation);
    return owned.length;
  }

  lookupCapability(instanceId: string, generation: number, mode: LaunchMode, requestId?: string): LaunchLookup {
    this.sweepExpired();
    const metadata = this.#metadata.get(instanceId);
    const secret = this.#secrets.get(instanceId);
    if (metadata === undefined || secret === undefined) return { status: "missing" };
    if (metadata.metadata.generation !== generation || secret.generation !== generation) {
      return { status: "generation_mismatch" };
    }
    if (
      requestId !== undefined &&
      (mode !== "control" ||
        !metadata.metadata.inputRequired ||
        metadata.metadata.ask?.requestId !== requestId)
    ) {
      return { status: "request_mismatch" };
    }
    const capability = mode === "view" ? secret.view : secret.control;
    return capability === undefined ? { status: "missing" } : { status: "ok", capability };
  }

  sweepExpired(): number {
    const now = this.#clock.monotonicNowMs();
    const expired = [...this.#metadata.entries()].filter(([, record]) => now - record.receivedAtMs >= this.#ttlMs);
    for (const [instanceId, record] of expired) this.#removeRecord(instanceId, record.metadata.generation);
    return expired.length;
  }

  clear(): void {
    for (const [instanceId, record] of [...this.#metadata.entries()]) {
      this.#removeRecord(instanceId, record.metadata.generation);
    }
  }

  #removeRecord(instanceId: string, generation: number): void {
    this.#secrets.delete(instanceId);
    this.#metadata.delete(instanceId);
    this.#revision += 1;
    this.#emit({ type: "session_remove", revision: this.#revision, instanceId, generation });
  }

  /**
   * Dispatch is serialized. A listener is free to mutate the registry — `PushService` does so
   * indirectly by sweeping through `snapshot()` — and delivering that nested revision inline would
   * hand it to every listener the outer loop has not reached yet, ahead of the older revision they
   * are still owed. Queueing keeps delivery in strictly increasing revision order for all listeners.
   */
  #emit(event: SessionEvent): void {
    this.#pending.push(event);
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#pendingHead < this.#pending.length) {
        const next = this.#pending[this.#pendingHead] as SessionEvent;
        this.#pendingHead += 1;
        for (const listener of this.#listeners) {
          try {
            listener(next);
          } catch (error) {
            // Observers do not own registry state. Report the fault without letting one callback
            // interrupt capability revocation or starve the remaining observers.
            try {
              this.#onListenerError(error);
            } catch {
              // Error reporting is an observer too and must not become a mutation dependency.
            }
          }
        }
      }
    } finally {
      this.#pending.splice(0, this.#pendingHead);
      this.#pendingHead = 0;
      this.#dispatching = false;
    }
  }
}
