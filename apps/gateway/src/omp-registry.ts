import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_OMP_REGISTRY_RESPONSE_BYTES,
  OMP_REGISTRY_VERSION,
  observedSessionFromSnapshot,
  parseJsonFrame,
  parseOmpDiscoveryEntry,
  parseOmpLinkReply,
  parseOmpSnapshotReply,
  type LaunchMode,
  type ObservedSessionInput,
  type OmpDiscoveryEntry,
  type OmpHostSnapshot,
  type OmpRegistryErrorCode,
  type SecretCapability,
} from "@omp-session-gateway/protocol";
import type { SessionRegistry } from "./registry.ts";

/**
 * Mainline OMP anchors its collaboration discovery directory under the base configuration root
 * rather than a profile root, so hosts started under any profile are discoverable. `PI_CONFIG_DIR`
 * is a directory *name* relative to the home directory in OMP, not a path; mirror that exactly or
 * the gateway looks in a directory no host ever writes to.
 */
export function resolveOmpDiscoveryDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string {
  const configDirName = environment.PI_CONFIG_DIR ?? ".omp";
  return join(home, configDirName, "run", "collab-hosts");
}

/**
 * Why a host was not readable this round.
 *
 * `gone` is reserved for the two answers upstream treats as authoritative death — the socket is
 * absent or refuses — because only those mean the host is really finished. Everything else
 * (timeouts, descriptor exhaustion, permission faults, a room mid-teardown answering
 * `snapshot_unavailable`) is `unavailable`: transient, and unpublishing a live session because the
 * machine was briefly busy is the failure mode worth avoiding.
 */
export type HostUnreachableReason = "gone" | "unavailable";

export type HostQueryResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: HostUnreachableReason; readonly detail: string };

export interface OmpHostObservation {
  readonly entry: OmpDiscoveryEntry;
  readonly snapshot: OmpHostSnapshot;
  readonly session: ObservedSessionInput;
}

export interface OmpDiscoveryObservation {
  /** Hosts that answered `snapshot` this round. */
  readonly hosts: readonly OmpHostObservation[];
  /** Published instance IDs that exist but could not be read; their records must survive. */
  readonly retained: ReadonlySet<string>;
  /** False only when the directory itself is unusable, which is an operator-visible fault. */
  readonly directoryHealthy: boolean;
}

const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
/** Upstream classifies exactly these two as a dead endpoint; everything else is transient. */
const DEAD_ENDPOINT_CODES: Readonly<Record<string, true>> = { ENOENT: true, ECONNREFUSED: true };

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "";
}

/**
 * One request, one connection. Upstream answers the first line and closes, so a reader that keeps
 * the socket open or pipelines a second request simply hangs.
 */
async function connectAndRequest(endpoint: string, timeoutMs: number, payload: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let buffer = "";
  let settled = false;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let socket: Bun.Socket<undefined> | undefined;
  const finish = (outcome: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      socket?.end();
    } catch {
      // The peer closing first is the normal path; the request already has its answer.
    }
    outcome();
  };
  const timer = setTimeout(() => {
    finish(() => reject(Object.assign(new Error("omp host query timed out"), { code: "ETIMEDOUT" })));
  }, timeoutMs);
  try {
    socket = await Bun.connect<undefined>({
      unix: endpoint,
      socket: {
        open(open) {
          open.write(payload);
          open.flush();
        },
        data(_socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > MAX_OMP_REGISTRY_RESPONSE_BYTES) {
            finish(() => reject(new Error("omp host response exceeded the bounded response size")));
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const line = buffer.slice(0, newline);
            finish(() => resolve(line));
          }
        },
        error(_socket, error) {
          finish(() => reject(error));
        },
        close() {
          finish(() => reject(new Error("omp host closed the query before answering")));
        },
      },
    });
  } catch (error) {
    finish(() => reject(error));
  }
  return promise;
}

export interface OmpHostReaderOptions {
  readonly directory: string;
  readonly timeoutMs?: number;
  /** Test seam: replaces the socket round trip with a deterministic transport. */
  readonly request?: (endpoint: string, payload: string, timeoutMs: number) => Promise<string>;
  readonly onFault?: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
}

/**
 * Reads mainline OMP's own collaboration host registry: one discovery file plus one owner-only
 * socket per live host. The gateway is a guest in this directory — it parses and queries, and it
 * never writes, renames, or unlinks anything, because the publishing host and OMP's own lister own
 * that lifecycle.
 */
export class OmpHostReader {
  readonly #directory: string;
  readonly #timeoutMs: number;
  readonly #request: (endpoint: string, payload: string, timeoutMs: number) => Promise<string>;
  readonly #onFault: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
  #entries = new Map<string, OmpDiscoveryEntry>();

  constructor(options: OmpHostReaderOptions) {
    this.#directory = options.directory;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.#request = options.request ?? ((endpoint, payload, timeoutMs) => connectAndRequest(endpoint, timeoutMs, payload));
    this.#onFault = options.onFault ?? (() => undefined);
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * An absent directory is the normal state of a machine with no shared session, so it is healthy.
   * A symlink or a directory owned by another user is not: reading it would either follow a
   * redirect the gateway cannot vouch for or expose another account's sessions.
   */
  async directoryUsable(): Promise<boolean> {
    try {
      const info = await lstat(this.#directory);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
      if (process.platform !== "win32") {
        const uid = process.getuid?.();
        if (uid !== undefined && info.uid !== uid) return false;
      }
      return true;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }

  /**
   * Lists the current discovery files. `.tmp` files are mid-write by construction and `.sock`
   * entries are the endpoints themselves, so only `.json` is read; a file that vanishes between
   * the readdir and the read is a host that just rotated, not an error.
   */
  async listEntries(): Promise<readonly OmpDiscoveryEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        // Deliberately fieldless: an errno is a string, and no string enters the gateway log.
        this.#onFault("omp.discovery_unreadable", {});
      }
      return [];
    }
    const entries: OmpDiscoveryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const entryId = name.slice(0, -".json".length);
      let raw: Buffer;
      try {
        raw = await readFile(join(this.#directory, name));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          this.#onFault("omp.entry_unreadable", {});
        }
        continue;
      }
      try {
        const entry = parseOmpDiscoveryEntry(entryId, parseJsonFrame(raw));
        if (entry.version !== OMP_REGISTRY_VERSION) continue;
        entries.push(entry);
      } catch {
        // A malformed or foreign-versioned artifact is not a host. OMP prunes its own leftovers.
        continue;
      }
    }
    return entries;
  }

  async snapshot(entry: OmpDiscoveryEntry): Promise<HostQueryResult<OmpHostSnapshot>> {
    const reply = await this.#query(entry, { v: OMP_REGISTRY_VERSION, token: entry.token, op: "snapshot" });
    if (reply.status !== "ok") return reply;
    try {
      const parsed = parseOmpSnapshotReply(parseJsonFrame(new TextEncoder().encode(reply.value)));
      if (!parsed.ok) return { status: "unavailable", detail: parsed.error };
      return { status: "ok", value: parsed.value };
    } catch {
      return { status: "unavailable", detail: "malformed_snapshot" };
    }
  }

  /**
   * Requests one capability for an exact generation. Passing the generation is what makes a stale
   * card fail instead of silently receiving a link to a session the operator never looked at.
   */
  async link(
    entry: OmpDiscoveryEntry,
    access: LaunchMode,
    generation: number,
  ): Promise<HostQueryResult<SecretCapability> | { readonly status: "refused"; readonly error: OmpRegistryErrorCode }> {
    const reply = await this.#query(entry, {
      v: OMP_REGISTRY_VERSION,
      token: entry.token,
      op: "link",
      access,
      generation,
    });
    if (reply.status !== "ok") return reply;
    try {
      const parsed = parseOmpLinkReply(parseJsonFrame(new TextEncoder().encode(reply.value)));
      if (!parsed.ok) return { status: "refused", error: parsed.error };
      return { status: "ok", value: parsed.value };
    } catch {
      return { status: "unavailable", detail: "malformed_link" };
    }
  }

  /** The discovery entry the last observation bound to this instance, if it is still published. */
  entryFor(instanceId: string): OmpDiscoveryEntry | undefined {
    return this.#entries.get(instanceId);
  }

  /**
   * Re-reads the directory and asks every published host for its snapshot. Hosts are queried
   * concurrently: one busy session must not delay the whole directory behind it.
   */
  async observe(): Promise<OmpDiscoveryObservation> {
    const directoryHealthy = await this.directoryUsable();
    const entries = directoryHealthy ? await this.listEntries() : [];
    const results = await Promise.all(
      entries.map(async entry => ({ entry, result: await this.snapshot(entry) })),
    );
    const hosts: OmpHostObservation[] = [];
    const retained = new Set<string>();
    const nextEntries = new Map<string, OmpDiscoveryEntry>();
    for (const { entry, result } of results) {
      if (result.status === "ok") {
        // The host's own answer is authoritative over the file it published under.
        nextEntries.set(result.value.instanceId, entry);
        hosts.push({ entry, snapshot: result.value, session: observedSessionFromSnapshot(result.value) });
        continue;
      }
      if (result.status === "unavailable") {
        nextEntries.set(entry.instanceId, entry);
        retained.add(entry.instanceId);
      }
    }
    this.#entries = nextEntries;
    return { hosts, retained, directoryHealthy };
  }

  async #query(entry: OmpDiscoveryEntry, request: Record<string, unknown>): Promise<HostQueryResult<string>> {
    try {
      const line = await this.#request(entry.endpoint, `${JSON.stringify(request)}\n`, this.#timeoutMs);
      return { status: "ok", value: line };
    } catch (error) {
      const code = errorCode(error);
      if (Object.hasOwn(DEAD_ENDPOINT_CODES, code)) return { status: "gone", detail: code };
      return { status: "unavailable", detail: code || "transport" };
    }
  }
}

export type LaunchResolution =
  | { readonly status: "ok"; readonly capability: SecretCapability }
  | { readonly status: "generation_mismatch" }
  | { readonly status: "request_mismatch" }
  | { readonly status: "mode_unavailable" }
  | { readonly status: "missing" };

/**
 * Brokers one launch: the directory must still show the exact session and generation the operator
 * pressed, and only then is the capability fetched straight from that host. Nothing is cached —
 * the gateway never holds a link between launches, and a stale card gets a refusal, not a link to
 * a session it was never showing.
 */
export class OmpLaunchResolver {
  readonly #registry: SessionRegistry;
  readonly #reader: OmpHostReader;

  constructor(options: { readonly registry: SessionRegistry; readonly reader: OmpHostReader }) {
    this.#registry = options.registry;
    this.#reader = options.reader;
  }

  async resolve(request: {
    readonly instanceId: string;
    readonly generation: number;
    readonly mode: LaunchMode;
    readonly requestId?: string;
  }): Promise<LaunchResolution> {
    const authorized = this.#registry.authorizeLaunch(
      request.instanceId,
      request.generation,
      request.mode,
      request.requestId,
    );
    if (authorized.status !== "ok") return { status: authorized.status };
    const entry = await this.#entryFor(request.instanceId);
    if (entry === undefined) return { status: "missing" };
    const link = await this.#reader.link(entry, request.mode, request.generation);
    if (link.status === "ok") return { status: "ok", capability: link.value };
    if (link.status === "refused") {
      // The host is the authority on its own generation and access: a refusal means the card the
      // operator pressed no longer describes that session.
      if (link.error === "stale_generation") return { status: "generation_mismatch" };
      if (link.error === "access_unavailable" || link.error === "invalid_access") {
        return { status: "mode_unavailable" };
      }
      return { status: "missing" };
    }
    return { status: "missing" };
  }

  /**
   * Prefers the entry the last poll bound, then re-reads the directory once. A room that rotated
   * between the poll and the press publishes under a fresh entry, and its stale generation is
   * rejected by the host rather than guessed at here.
   */
  async #entryFor(instanceId: string): Promise<OmpDiscoveryEntry | undefined> {
    const known = this.#reader.entryFor(instanceId);
    if (known !== undefined) return known;
    const entries = await this.#reader.listEntries();
    return entries.find(entry => entry.instanceId === instanceId);
  }
}

export interface HostPoller {
  /** False while OMP's discovery directory itself is unusable. */
  readonly discoveryHealthy: boolean;
  poll(): Promise<void>;
  stop(): void;
}

/**
 * Polls the discovery directory on a fixed interval. Rounds never overlap — one slow host must not
 * cause a second wave of queries against hosts already struggling to answer — and a caller that
 * asks while a round is in flight joins that round rather than being dropped, so `poll()` always
 * resolves against a completed observation.
 */
export function startHostPoller(options: {
  readonly reader: OmpHostReader;
  readonly registry: SessionRegistry;
  readonly intervalMs: number;
  readonly onEvent?: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
}): HostPoller {
  let healthy = true;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const round = async (): Promise<void> => {
    try {
      const observation = await options.reader.observe();
      healthy = observation.directoryHealthy;
      const result = options.registry.reconcile({
        observed: observation.hosts.map(host => host.session),
        retained: observation.retained,
      });
      if (result.inserted > 0 || result.removed > 0) {
        options.onEvent?.("omp.directory_changed", {
          inserted: result.inserted,
          removed: result.removed,
          hosts: observation.hosts.length,
        });
      }
    } catch {
      healthy = false;
      options.onEvent?.("omp.poll_failed", {});
    }
  };
  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= round().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  const timer = setInterval(() => void poll(), options.intervalMs);
  void poll();
  return {
    get discoveryHealthy(): boolean {
      return healthy;
    },
    poll,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
