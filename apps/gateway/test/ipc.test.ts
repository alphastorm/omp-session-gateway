import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionEvent } from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { startRegistryIpcServer } from "../src/ipc.ts";
import { SafeLogger } from "../src/logger.ts";
import { SessionRegistry } from "../src/registry.ts";

interface ClientData {
  text: string;
  waiters: Array<{ needle: string; resolve(): void }>;
}

function waitForText(socket: Bun.Socket<ClientData>, needle: string): Promise<void> {
  if (socket.data.text.includes(needle)) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.data.waiters.push({ needle, resolve });
  return promise;
}

function nextRegistryEvent(registry: SessionRegistry, type: SessionEvent["type"]): Promise<SessionEvent> {
  const { promise, resolve } = Promise.withResolvers<SessionEvent>();
  const unsubscribe = registry.subscribe(event => {
    if (event.type !== type) return;
    unsubscribe();
    resolve(event);
  });
  return promise;
}

function testConfig(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317" },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 5, maxSessions: 5 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "registry.sock"),
      tokenPath: join(root, "config", "publisher-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

async function connect(endpoint: string): Promise<Bun.Socket<ClientData>> {
  return Bun.connect<ClientData>({
    unix: endpoint,
    data: { text: "", waiters: [] },
    socket: {
      data(socket, chunk) {
        socket.data.text += Buffer.from(chunk).toString("utf8");
        for (const waiter of socket.data.waiters.splice(0)) {
          if (socket.data.text.includes(waiter.needle)) waiter.resolve();
          else socket.data.waiters.push(waiter);
        }
      },
      open() {},
      close() {},
      error() {},
    },
  });
}

test("IPC authenticates before accepting capability-bearing frames and removes on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-"));
  const config = testConfig(root);
  await mkdir(config.paths.runtimeDir, { recursive: true, mode: 0o700 });
  const logs: string[] = [];
  const logger = new SafeLogger({ write: line => logs.push(line) });
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 5 });
  const token = "T".repeat(43);
  const capability = ["IPC", "CAPABILITY", "CANARY", "00000000000000000000"].join("__");
  const server = await startRegistryIpcServer({ config, token, registry, logger });

  try {
    const denied = await connect(config.paths.socketPath);
    denied.write(
      `${JSON.stringify({ v: 1, op: "hello", token: "X".repeat(43), instanceId: "ipc-instance-denied", pid: 100 })}\n`,
    );
    await waitForText(denied, "protocol_error");
    expect(registry.size).toBe(0);

    const socket = await connect(config.paths.socketPath);
    socket.write(
      `${JSON.stringify({ v: 1, op: "hello", token, instanceId: "ipc-instance-valid-01", pid: 200 })}\n`,
    );
    await waitForText(socket, "hello_ok");
    const upserted = nextRegistryEvent(registry, "session_upsert");
    socket.write(
      `${JSON.stringify({
        v: 1,
        op: "upsert",
        session: {
          instanceId: "ipc-instance-valid-01",
          generation: 1,
          pid: 200,
          sessionId: "ipc-session",
          title: "IPC session",
          startedAt: "2026-07-19T00:00:00.000Z",
          viewLink: capability,
        },
      })}\n`,
    );
    await upserted;
    expect(JSON.stringify(registry.snapshot())).not.toContain(capability);
    expect(logs.join("\n")).not.toContain(capability);
    const removed = nextRegistryEvent(registry, "session_remove");
    socket.end();
    await removed;
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
