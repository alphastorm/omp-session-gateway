import { randomBytes } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { OMP_REGISTRY_VERSION, type OmpHostSnapshot, type OmpRegistryErrorCode } from "../packages/protocol/src/index.ts";

export const SYNTHETIC_CAPABILITY_MARKER = "synthetic-view-only";

/** Deliberately short, non-credential key, like the gateway's existing host doubles. Never a real relay. */
export function syntheticViewCapability(instanceId: string, generation: number): string {
  return `https://collab.example/#wss://relay.example/r/${instanceId}.${SYNTHETIC_CAPABILITY_MARKER}-${generation}`;
}

export function syntheticSnapshot(instanceId: string, index: number, createdAt: number, revision = 0): OmpHostSnapshot {
  return {
    instanceId, generation: 1, pid: process.pid, sessionId: instanceId,
    sessionName: `Synthetic discovery host ${index}${revision === 0 ? "" : ` revision ${revision}`}`,
    cwd: "capacity-qualification", startedAt: createdAt, participants: 0,
    relayConnected: true, inputRequired: false, access: "control",
    ...(revision === 0 ? {} : { busy: revision % 2 === 1 }),
  };
}

type Reply = { ok: false; v: number; error: OmpRegistryErrorCode }
  | { ok: true; v: number; snapshot: OmpHostSnapshot }
  | { ok: true; v: number; url: string };

/** Same default refusals as the capacity fixture; View links are opt-in for endurance runs. */
export function syntheticReply(request: unknown, token: string, snapshot: OmpHostSnapshot, viewLinks = false): Reply {
  const refuse = (error: OmpRegistryErrorCode): Reply => ({ ok: false, v: OMP_REGISTRY_VERSION, error });
  if (typeof request !== "object" || request === null || Array.isArray(request)) return refuse("malformed_request");
  const query = request as Record<string, unknown>;
  if (query.v !== OMP_REGISTRY_VERSION) return refuse("unsupported_protocol");
  if (query.token !== token) return refuse("authentication_failed");
  if (query.op === "snapshot") return { ok: true, v: OMP_REGISTRY_VERSION, snapshot };
  if (query.op !== "link") return refuse("invalid_operation");
  if (!viewLinks) return refuse("access_unavailable");
  if (query.access !== "view" && query.access !== "control") return refuse("invalid_access");
  if (query.generation !== snapshot.generation) return refuse("stale_generation");
  if (query.access !== "view") return refuse("access_unavailable");
  return { ok: true, v: OMP_REGISTRY_VERSION, url: syntheticViewCapability(snapshot.instanceId, snapshot.generation) };
}

export interface SyntheticHost {
  readonly instanceId: string;
  readonly token: string;
  readonly generation: number;
  readonly revision: number;
  updateMetadata(): { title: string; changedAtMs: number; revision: number };
  stop(): Promise<void>;
}

export async function startSyntheticHost(options: {
  directory: string;
  index: number;
  viewLinks?: boolean;
  /** Timestamp immediately before the successful snapshot reply is written, not daemon receipt. */
  onSnapshot?: (instanceId: string, revision: number, replyAtMs: number) => void;
}): Promise<SyntheticHost> {
  const instanceId = randomBytes(12).toString("hex");
  const token = randomBytes(32).toString("hex");
  const endpoint = join(options.directory, `${instanceId}.sock`);
  const discovery = join(options.directory, `${instanceId}.json`);
  const createdAt = Date.now();
  let revision = 0;
  let snapshot = syntheticSnapshot(instanceId, options.index, createdAt);
  if (options.viewLinks) snapshot = { ...snapshot, access: "view" };
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    // A partial query must not keep teardown waiting forever.
    socket.setTimeout(5_000, () => socket.destroy());
    let frame = "";
    socket.on("data", chunk => {
      frame += chunk.toString("utf8");
      // Preserve the capacity fixture's 16 KiB request bound and one-line/one-connection contract.
      if (frame.length > 16_384) { socket.destroy(); return; }
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      let request: unknown;
      try { request = JSON.parse(frame.slice(0, newline)); } catch { /* malformed_request below */ }
      const reply = syntheticReply(request, token, snapshot, options.viewLinks);
      if (reply.ok && "snapshot" in reply) options.onSnapshot?.(instanceId, revision, performance.now());
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  let published = false;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Revoke before withdrawing publication; a stale card can never launch the departing host.
    for (const socket of sockets) socket.destroy();
    const closing = server.listening ? new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }) : Promise.resolve();
    try { if (published) await unlink(discovery); } finally { await closing; }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(endpoint, 0o600);
    await writeFile(discovery, JSON.stringify({ version: 1, instanceId, pid: process.pid, endpoint, createdAt, token }), {
      mode: 0o600, flag: "wx",
    });
    published = true;
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    instanceId, token, get generation() { return snapshot.generation; }, get revision() { return revision; },
    updateMetadata() {
      if (stopped) throw new Error("synthetic host stopped");
      revision++;
      // Title/activity changes are metadata, not a new collaboration generation or session.
      snapshot = { ...syntheticSnapshot(instanceId, options.index, createdAt, revision), access: snapshot.access };
      return { title: snapshot.sessionName!, changedAtMs: performance.now(), revision };
    },
    stop,
  };
}

export function parseSyntheticHostCount(value: string | undefined): number {
  const count = Number(value);
  if (!value || !/^[0-9]+$/u.test(value) || !Number.isSafeInteger(count) || count < 1 || count > 50) {
    throw new Error("synthetic host count must be 1..50");
  }
  return count;
}

if (import.meta.main) {
  const hosts: SyntheticHost[] = [];
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const directory = process.argv[2];
    const count = parseSyntheticHostCount(process.argv[3]);
    if (!directory || process.argv.length !== 4) throw new Error("invalid synthetic host arguments");
    for (let index = 0; index < count && !stopping; index++) hosts.push(await startSyntheticHost({ directory, index }));
    if (!stopping) console.log(JSON.stringify({ hosts: hosts.length }));
    while (!stopping) await Bun.sleep(100);
  } catch {
    console.error(JSON.stringify({ syntheticHostFailure: 1 }));
    process.exitCode = 1;
  } finally {
    const results = await Promise.allSettled(hosts.map(host => host.stop()));
    if (results.some(result => result.status === "rejected")) process.exitCode = 1;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
