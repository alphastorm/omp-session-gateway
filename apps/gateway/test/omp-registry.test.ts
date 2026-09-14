/**
 * Contract: the gateway reads mainline OMP's own collaboration host registry. Upstream publishes
 * one discovery file plus one owner-only socket per live host, answers exactly one newline-framed
 * request per connection, and refuses a link whose generation no longer matches. These tests drive
 * a host double that speaks that protocol byte for byte, because every rule the gateway depends on
 * — which failures retire a session, which ones must not, and which refusal reaches the operator —
 * is a property of that wire rather than of the gateway's own code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_REGISTRY_VERSION } from "@omp-session-gateway/protocol";
import {
  OmpHostReader,
  OmpLaunchResolver,
  resolveOmpDiscoveryDirectory,
  startHostPoller,
} from "../src/omp-registry.ts";
import { SessionRegistry } from "../src/registry.ts";

const VIEW_URL = "https://collab.example/#wss://relay.example/r/room.viewkeyviewkeyviewkey";
const CONTROL_URL = "https://collab.example/#wss://relay.example/r/room.controlkeycontrolkeyctl";

interface HostDoubleOptions {
  readonly instanceId?: string;
  readonly generation?: number;
  readonly access?: "view" | "control";
  readonly inputRequired?: boolean;
  readonly sessionName?: string | null;
  readonly cwd?: string;
  /** Replaces the whole reply, so a test can return any upstream wire error verbatim. */
  readonly reply?: (request: Record<string, unknown>) => unknown | undefined;
}

interface HostDouble {
  readonly instanceId: string;
  readonly entryId: string;
  readonly token: string;
  readonly endpoint: string;
  readonly requests: Record<string, unknown>[];
  stop(): Promise<void>;
  unpublish(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function discoveryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-collab-hosts-"));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** A published OMP host: the discovery file, the socket, and upstream's request handling. */
async function hostDouble(directory: string, options: HostDoubleOptions = {}): Promise<HostDouble> {
  const instanceId = options.instanceId ?? "aaaa1111bbbb2222";
  const entryId = `e${instanceId.slice(1)}`;
  const token = "a".repeat(64);
  const generation = options.generation ?? 1;
  const access = options.access ?? "control";
  // Short base path: a Unix socket path is bounded well below a temp-dir-nested name.
  const endpointDir = await mkdtemp(join(tmpdir(), "omp-sock-"));
  const endpoint = join(endpointDir, `${entryId}.sock`);
  const requests: Record<string, unknown>[] = [];
  const snapshot = {
    instanceId,
    generation,
    pid: 4242,
    sessionId: "session-alpha",
    sessionName: options.sessionName === undefined ? "Alpha session" : options.sessionName,
    cwd: options.cwd ?? "/Users/you/projects/gateway",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    startedAt: Date.parse("2026-09-14T00:00:00.000Z"),
    participants: 1,
    relayConnected: true,
    inputRequired: options.inputRequired ?? false,
    access,
  };
  const server = Bun.listen<undefined>({
    unix: endpoint,
    socket: {
      data(socket, chunk) {
        const line = new TextDecoder().decode(chunk).split("\n")[0] ?? "";
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "malformed_request" })}\n`);
          return;
        }
        requests.push(request);
        const override = options.reply?.(request);
        if (override !== undefined) {
          socket.end(`${JSON.stringify(override)}\n`);
          return;
        }
        if (request.token !== token) {
          socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "authentication_failed" })}\n`);
          return;
        }
        if (request.op === "snapshot") {
          socket.end(`${JSON.stringify({ ok: true, v: OMP_REGISTRY_VERSION, snapshot })}\n`);
          return;
        }
        if (request.op === "link") {
          if (request.generation !== generation) {
            socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "stale_generation" })}\n`);
            return;
          }
          if (request.access === "control" && access !== "control") {
            socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "access_unavailable" })}\n`);
            return;
          }
          const url = request.access === "view" ? VIEW_URL : CONTROL_URL;
          socket.end(`${JSON.stringify({ ok: true, v: OMP_REGISTRY_VERSION, url })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "invalid_operation" })}\n`);
      },
    },
  });
  const metaPath = join(directory, `${entryId}.json`);
  await writeFile(
    metaPath,
    JSON.stringify({ version: OMP_REGISTRY_VERSION, instanceId, pid: 4242, endpoint, createdAt: Date.now(), token }),
    { mode: 0o600 },
  );
  const stop = async (): Promise<void> => {
    server.stop(true);
    await rm(endpointDir, { recursive: true, force: true });
  };
  cleanups.push(stop);
  return {
    instanceId,
    entryId,
    token,
    endpoint,
    requests,
    stop,
    unpublish: async () => {
      await rm(metaPath, { force: true });
    },
  };
}

function reader(directory: string): OmpHostReader {
  return new OmpHostReader({ directory, timeoutMs: 500 });
}

describe("OMP discovery directory", () => {
  test("resolves the same directory OMP publishes into, including a renamed config directory", () => {
    const home = join(tmpdir(), "fixture-home");
    expect(resolveOmpDiscoveryDirectory({}, home)).toBe(join(home, ".omp", "run", "collab-hosts"));
    expect(resolveOmpDiscoveryDirectory({ PI_CONFIG_DIR: ".omp-alt" }, home)).toBe(
      join(home, ".omp-alt", "run", "collab-hosts"),
    );
  });

  test("treats an absent directory as healthy and empty", async () => {
    const missing = join(await discoveryDirectory(), "never-created");
    const subject = reader(missing);
    expect(await subject.directoryUsable()).toBe(true);
    expect(await subject.listEntries()).toEqual([]);
  });

  test("refuses a discovery directory that is a symlink", async () => {
    const base = await discoveryDirectory();
    const real = join(base, "real");
    const link = join(base, "link");
    await mkdir(real);
    await symlink(real, link, "dir");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await reader(link).directoryUsable()).toBe(false);
  });

  test("ignores in-flight and foreign artifacts instead of treating them as hosts", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    await writeFile(join(directory, "partial.json.tmp"), "{");
    await writeFile(join(directory, "garbage.json"), "not json");
    await writeFile(
      join(directory, "future.json"),
      JSON.stringify({ version: 99, instanceId: "cccc3333dddd4444", pid: 1, endpoint: "/dev/null", createdAt: 1, token: "b".repeat(64) }),
    );
    const entries = await reader(directory).listEntries();
    expect(entries.map(entry => entry.instanceId)).toEqual([host.instanceId]);
  });
});

describe("OMP host queries", () => {
  test("projects a snapshot onto browser-safe metadata", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory, { cwd: "/Users/you/projects/gateway" });
    const observation = await reader(directory).observe();
    expect(observation.directoryHealthy).toBe(true);
    expect(observation.hosts).toHaveLength(1);
    const [observed] = observation.hosts;
    expect(observed?.session).toMatchObject({
      instanceId: host.instanceId,
      generation: 1,
      title: "Alpha session",
      // The card names the project, not the operator's whole filesystem layout.
      cwdLabel: "gateway",
      model: "anthropic/claude-sonnet-4-5",
      startedAt: "2026-09-14T00:00:00.000Z",
      canControl: true,
      inputRequired: false,
    });
    expect(host.requests[0]).toEqual({ v: 1, token: host.token, op: "snapshot" });
  });

  test("asks each host on its own connection, never reusing one", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const subject = reader(directory);
    await subject.observe();
    await subject.observe();
    expect(host.requests).toHaveLength(2);
  });

  test("reports a refused socket as gone and a hung socket as merely unavailable", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const subject = reader(directory);
    const [entry] = await subject.listEntries();
    if (entry === undefined) throw new Error("expected one published entry");

    const silent = await hostDouble(await discoveryDirectory(), { instanceId: "eeee5555ffff6666" });
    await silent.stop();
    const deadSocket = await subject.snapshot({ ...entry, endpoint: silent.endpoint });
    expect(deadSocket.status).toBe("gone");

    await host.stop();
    const absent = await subject.snapshot(entry);
    expect(absent.status).toBe("gone");
  });

  test("keeps a host that answers a wire error, because only the socket proves death", async () => {
    const directory = await discoveryDirectory();
    await hostDouble(directory, {
      reply: request =>
        request.op === "snapshot" ? { ok: false, v: OMP_REGISTRY_VERSION, error: "snapshot_unavailable" } : undefined,
    });
    const observation = await reader(directory).observe();
    expect(observation.hosts).toHaveLength(0);
    expect([...observation.retained]).toEqual(["aaaa1111bbbb2222"]);
  });
});

describe("launch brokering", () => {
  async function brokered(options: HostDoubleOptions = {}): Promise<{
    registry: SessionRegistry;
    resolver: OmpLaunchResolver;
    host: HostDouble;
  }> {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory, options);
    const subject = reader(directory);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const observation = await subject.observe();
    registry.reconcile({
      observed: observation.hosts.map(entry => entry.session),
      retained: observation.retained,
    });
    return { registry, resolver: new OmpLaunchResolver({ registry, reader: subject }), host };
  }

  test("fetches one capability from the owning host for an explicit launch", async () => {
    const { resolver, host } = await brokered();
    const view = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "view" });
    if (view.status !== "ok") throw new Error(`expected a view capability, got ${view.status}`);
    expect(view.capability.reveal()).toBe(VIEW_URL);
    const control = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control" });
    if (control.status !== "ok") throw new Error(`expected a control capability, got ${control.status}`);
    expect(control.capability.reveal()).toBe(CONTROL_URL);
    expect(host.requests.filter(request => request.op === "link")).toHaveLength(2);
  });

  test("a stale card is refused rather than handed a newer session's capability", async () => {
    const { resolver, host } = await brokered();
    const stale = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "view" });
    expect(stale.status).toBe("ok");
    const ahead = await resolver.resolve({ instanceId: host.instanceId, generation: 2, mode: "view" });
    expect(ahead.status).toBe("generation_mismatch");
    expect(host.requests.some(request => request.generation === 2)).toBe(false);
  });

  test("control is refused for a view-only session at both the directory and the host", async () => {
    const { resolver, host, registry } = await brokered({ access: "view" });
    expect(registry.snapshot().sessions[0]?.canControl).toBe(false);
    const refused = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control" });
    expect(refused.status).toBe("mode_unavailable");
  });

  test("a host refusal for the requested access reaches the operator as mode_unavailable", async () => {
    const { resolver, host } = await brokered({
      reply: request =>
        request.op === "link" ? { ok: false, v: OMP_REGISTRY_VERSION, error: "access_unavailable" } : undefined,
    });
    const refused = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control" });
    expect(refused.status).toBe("mode_unavailable");
  });

  test("answering a dismissed attention request is refused", async () => {
    const { resolver, host, registry } = await brokered({ inputRequired: true });
    const requestId = registry.snapshot().sessions[0]?.ask?.requestId;
    if (requestId === undefined) throw new Error("expected an attention request");
    const current = await resolver.resolve({
      instanceId: host.instanceId,
      generation: 1,
      mode: "control",
      requestId,
    });
    expect(current.status).toBe("ok");
    const stale = await resolver.resolve({
      instanceId: host.instanceId,
      generation: 1,
      mode: "control",
      requestId: "a".repeat(20),
    });
    expect(stale.status).toBe("request_mismatch");
  });

  test("an unpublished session is refused without contacting any socket", async () => {
    const { resolver, host } = await brokered();
    await host.unpublish();
    await host.stop();
    const resolved = await resolver.resolve({ instanceId: "ffff7777aaaa8888", generation: 1, mode: "view" });
    expect(resolved.status).toBe("missing");
  });
});

describe("directory polling", () => {
  test("a stopped host leaves the directory on the next poll", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const poller = startHostPoller({ reader: reader(directory), registry, intervalMs: 3_600_000 });
    cleanups.push(async () => poller.stop());

    await poller.poll();
    expect(registry.size).toBe(1);
    expect(poller.discoveryHealthy).toBe(true);

    await host.unpublish();
    await host.stop();
    await poller.poll();
    expect(registry.size).toBe(0);
  });

  test("a host that stops answering keeps its card until the TTL retires it", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory, {
      reply: request =>
        request.op === "snapshot" ? { ok: false, v: OMP_REGISTRY_VERSION, error: "snapshot_unavailable" } : undefined,
    });
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const live = await hostDouble(await discoveryDirectory(), { instanceId: "bbbb2222cccc3333" });
    void live;
    const subject = reader(directory);
    const poller = startHostPoller({ reader: subject, registry, intervalMs: 3_600_000 });
    cleanups.push(async () => poller.stop());

    // Seed a record the way a healthy poll would, then let the host go quiet.
    registry.reconcile({
      observed: [
        {
          instanceId: host.instanceId,
          generation: 1,
          pid: 4242,
          sessionId: "session-alpha",
          startedAt: "2026-09-14T00:00:00.000Z",
          canControl: true,
          inputRequired: false,
        },
      ],
      retained: new Set<string>(),
    });
    expect(registry.size).toBe(1);
    await poller.poll();
    expect(registry.size).toBe(1);
    expect(registry.sweepExpired()).toBe(0);
  });

  test("polls never overlap", async () => {
    const directory = await discoveryDirectory();
    await hostDouble(directory);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const poller = startHostPoller({ reader: reader(directory), registry, intervalMs: 3_600_000 });
    cleanups.push(async () => poller.stop());
    await Promise.all([poller.poll(), poller.poll(), poller.poll()]);
    expect(registry.size).toBe(1);
  });
});
