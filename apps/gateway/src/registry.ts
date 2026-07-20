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
  | { readonly status: "generation_mismatch" };

const systemClock: RegistryClock = {
  monotonicNowMs: () => performance.now(),
  wallNowIso: () => new Date().toISOString(),
};

export class SessionRegistry {
  readonly #metadata = new Map<string, InternalMetadataRecord>();
  readonly #secrets = new Map<string, SecretSessionRecord>();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #clock: RegistryClock;
  #revision = 0;

  constructor(options: RegistryOptions) {
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1) throw new Error("invalid registry TTL");
    if (!Number.isSafeInteger(options.maxSessions) || options.maxSessions < 1) throw new Error("invalid registry capacity");
    this.#ttlMs = options.ttlSeconds * 1_000;
    this.#maxSessions = options.maxSessions;
    this.#clock = options.clock ?? systemClock;
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
        .map(record => ({ ...record.metadata }))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    };
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  upsert(ownerId: string, input: PublishedSessionInput): UpsertResult {
    const existing = this.#metadata.get(input.instanceId);
    if (existing !== undefined && existing.ownerId !== ownerId) throw new Error("instance owned by another publisher");
    if (existing !== undefined && input.generation < existing.metadata.generation) return "ignored_older";
    if (existing === undefined && this.#metadata.size >= this.#maxSessions) throw new Error("registry capacity exceeded");
    const receivedAtMs = this.#clock.monotonicNowMs();
    const separated = separatePublishedSession(input, this.#clock.wallNowIso());
    if (
      existing !== undefined &&
      input.generation === existing.metadata.generation &&
      separated.immutableIdentity !== existing.immutableIdentity
    ) {
      throw new Error("generation identity conflict");
    }

    // Revoke the old secret before making replacement metadata observable.
    this.#secrets.delete(input.instanceId);
    this.#metadata.set(input.instanceId, {
      metadata: separated.metadata,
      immutableIdentity: separated.immutableIdentity,
      ownerId,
      receivedAtMs,
    });
    this.#secrets.set(input.instanceId, separated.secret);
    this.#revision += 1;
    this.#emit({ type: "session_upsert", revision: this.#revision, session: { ...separated.metadata } });
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

  lookupCapability(instanceId: string, generation: number, mode: LaunchMode): LaunchLookup {
    this.sweepExpired();
    const metadata = this.#metadata.get(instanceId);
    const secret = this.#secrets.get(instanceId);
    if (metadata === undefined || secret === undefined) return { status: "missing" };
    if (metadata.metadata.generation !== generation || secret.generation !== generation) {
      return { status: "generation_mismatch" };
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

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
