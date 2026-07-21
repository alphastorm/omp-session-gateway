import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseChallengeFrame,
  parseHelloOkFrame,
  parseJsonFrame,
  type SessionEvent,
} from "@omp-session-gateway/protocol";
import {
  createRegistryAuthNonce,
  createRegistryClientProof,
  createRegistryServerProof,
  registryAuthProofMatches,
  type RegistryAuthBinding,
} from "@omp-session-gateway/protocol/ipc-auth";
import type { GatewayConfig } from "../src/config.ts";
import {
  type RegistryIpcDeadline,
  type RegistryIpcDeadlineScheduler,
  startRegistryIpcServer,
} from "../src/ipc.ts";
import { SafeLogger } from "../src/logger.ts";
import { SessionRegistry } from "../src/registry.ts";

interface ClientData {
  text: string;
  closed: boolean;
  waiters: Array<{ needle: string; resolve(): void }>;
}

class ManualDeadline implements RegistryIpcDeadline {
  active = true;

  constructor(
    readonly callback: () => void,
    readonly timeoutMilliseconds: number,
  ) {}

  cancel(): void {
    if (!this.active) return;
    this.active = false;
  }

  fire(): void {
    if (!this.active) return;
    this.active = false;
    this.callback();
  }
}

class ManualDeadlineScheduler implements RegistryIpcDeadlineScheduler {
  readonly #deadlines: ManualDeadline[] = [];

  schedule(callback: () => void, timeoutMilliseconds: number): ManualDeadline {
    const deadline = new ManualDeadline(callback, timeoutMilliseconds);
    this.#deadlines.push(deadline);
    return deadline;
  }

  onlyActive(expectedTimeoutMilliseconds: number): ManualDeadline {
    const active = this.#deadlines.filter(deadline => deadline.active);
    if (active.length !== 1) throw new Error(`expected one active deadline, received ${active.length}`);
    const deadline = active[0];
    if (deadline === undefined || deadline.timeoutMilliseconds !== expectedTimeoutMilliseconds) {
      throw new Error("active deadline has an unexpected timeout");
    }
    return deadline;
  }
}

function waitForText(socket: Bun.Socket<ClientData>, needle: string): Promise<void> {
  if (socket.data.text.includes(needle)) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.data.waiters.push({ needle, resolve });
  return promise;
}

async function readFrame(socket: Bun.Socket<ClientData>): Promise<unknown> {
  await waitForText(socket, "\n");
  const lineEnd = socket.data.text.indexOf("\n");
  if (lineEnd < 0) throw new Error("expected complete IPC frame");
  const line = socket.data.text.slice(0, lineEnd);
  socket.data.text = socket.data.text.slice(lineEnd + 1);
  return parseJsonFrame(new TextEncoder().encode(line));
}

async function finishPublisherAuthentication(
  socket: Bun.Socket<ClientData>,
  token: string,
  clientNonce: string,
  instanceId: string,
  pid: number,
): Promise<void> {
  const challenge = parseChallengeFrame(await readFrame(socket));
  const binding: RegistryAuthBinding = {
    clientNonce,
    serverNonce: challenge.serverNonce,
    instanceId,
    pid,
  };
  if (!registryAuthProofMatches(createRegistryServerProof(token, binding), challenge.proof)) {
    throw new Error("gateway server proof did not match");
  }
  socket.write(
    `${JSON.stringify({ v: 1, op: "authenticate", proof: createRegistryClientProof(token, binding) })}\n`,
  );
  parseHelloOkFrame(await readFrame(socket));
}

async function authenticatePublisher(
  socket: Bun.Socket<ClientData>,
  token: string,
  instanceId: string,
  pid: number,
): Promise<void> {
  const clientNonce = createRegistryAuthNonce();
  socket.write(`${JSON.stringify({ v: 1, op: "hello", clientNonce, instanceId, pid })}\n`);
  await finishPublisherAuthentication(socket, token, clientNonce, instanceId, pid);
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for IPC state");
    await Bun.sleep(5);
  }
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
function nextRegistryEvents(
  registry: SessionRegistry,
  type: SessionEvent["type"],
  count: number,
): Promise<SessionEvent[]> {
  const { promise, resolve } = Promise.withResolvers<SessionEvent[]>();
  const events: SessionEvent[] = [];
  const unsubscribe = registry.subscribe(event => {
    if (event.type !== type) return;
    events.push(event);
    if (events.length !== count) return;
    unsubscribe();
    resolve(events);
  });
  return promise;
}


function testConfig(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317" },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 1, maxSessions: 5 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      socketPath:
        process.platform === "win32"
          ? `\\\\.\\pipe\\omp-gateway-ipc-${Buffer.from(root).toString("hex").slice(-20)}`
          : join(root, "run", "registry.sock"),
      tokenPath: join(root, "config", "publisher-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

async function connect(endpoint: string): Promise<Bun.Socket<ClientData>> {
  return Bun.connect<ClientData>({
    unix: endpoint,
    data: { text: "", closed: false, waiters: [] },
    socket: {
      data(socket, chunk) {
        socket.data.text += Buffer.from(chunk).toString("utf8");
        for (const waiter of socket.data.waiters.splice(0)) {
          if (socket.data.text.includes(waiter.needle)) waiter.resolve();
          else socket.data.waiters.push(waiter);
        }
      },
      open() {},
      close(socket) {
        socket.data.closed = true;
      },
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
    const deniedHello = JSON.stringify({
      v: 1,
      op: "hello",
      clientNonce: createRegistryAuthNonce(),
      instanceId: "ipc-instance-denied",
      pid: 100,
    });
    expect(deniedHello).not.toContain(token);
    expect(deniedHello).not.toContain(capability);
    denied.write(`${deniedHello}\n`);
    const deniedChallenge = parseChallengeFrame(await readFrame(denied));
    expect(JSON.stringify(deniedChallenge)).not.toContain(token);
    denied.write(`${JSON.stringify({ v: 1, op: "authenticate", proof: "X".repeat(43) })}\n`);
    await waitForText(denied, "protocol_error");
    await waitFor(() => server.publishers === 0);
    expect(registry.size).toBe(0);

    const replaySource = await connect(config.paths.socketPath);
    const sourceNonce = createRegistryAuthNonce();
    const replayInstanceId = "ipc-instance-replay-01";
    replaySource.write(
      `${JSON.stringify({ v: 1, op: "hello", clientNonce: sourceNonce, instanceId: replayInstanceId, pid: 150 })}\n`,
    );
    const sourceChallenge = parseChallengeFrame(await readFrame(replaySource));
    const sourceBinding: RegistryAuthBinding = {
      clientNonce: sourceNonce,
      serverNonce: sourceChallenge.serverNonce,
      instanceId: replayInstanceId,
      pid: 150,
    };
    const oldProof = createRegistryClientProof(token, sourceBinding);
    replaySource.write(`${JSON.stringify({ v: 1, op: "authenticate", proof: oldProof })}\n`);
    parseHelloOkFrame(await readFrame(replaySource));
    replaySource.end();
    await waitFor(() => server.publishers === 0);

    const replayTarget = await connect(config.paths.socketPath);
    replayTarget.write(
      `${JSON.stringify({
        v: 1,
        op: "hello",
        clientNonce: createRegistryAuthNonce(),
        instanceId: replayInstanceId,
        pid: 150,
      })}\n`,
    );
    await readFrame(replayTarget);
    replayTarget.write(`${JSON.stringify({ v: 1, op: "authenticate", proof: oldProof })}\n`);
    await waitForText(replayTarget, "protocol_error");
    await waitFor(() => server.publishers === 0);
    expect(registry.size).toBe(0);

    const socket = await connect(config.paths.socketPath);
    await authenticatePublisher(socket, token, "ipc-instance-valid-01", 200);
    const oldPublisherSession = {
      instanceId: "ipc-instance-valid-01",
      generation: 1,
      pid: 200,
      sessionId: "ipc-session",
      title: "IPC session",
      startedAt: "2026-07-19T00:00:00.000Z",
      viewLink: capability,
    };
    const upserted = nextRegistryEvent(registry, "session_upsert");
    socket.write(`${JSON.stringify({ v: 1, op: "upsert", session: oldPublisherSession })}\n`);
    const inserted = await upserted;
    expect(inserted).toMatchObject({
      type: "session_upsert",
      revision: 1,
      session: { inputRequired: false },
    });

    const required = nextRegistryEvent(registry, "session_upsert");
    socket.write(
      `${JSON.stringify({
        v: 1,
        op: "upsert",
        session: { ...oldPublisherSession, inputRequired: true },
      })}\n`,
    );
    expect(await required).toMatchObject({
      type: "session_upsert",
      revision: 2,
      session: { inputRequired: true },
    });

    const cleared = nextRegistryEvent(registry, "session_upsert");
    socket.write(
      `${JSON.stringify({
        v: 1,
        op: "upsert",
        session: { ...oldPublisherSession, inputRequired: false },
      })}\n`,
    );
    expect(await cleared).toMatchObject({
      type: "session_upsert",
      revision: 3,
      session: { inputRequired: false },
    });
    expect(registry.lookupCapability("ipc-instance-valid-01", 1, "view")).toMatchObject({ status: "ok" });
    expect(JSON.stringify(registry.snapshot())).not.toContain(capability);
    expect(logs.join("\n")).not.toContain(capability);
    const removed = nextRegistryEvent(registry, "session_remove");
    socket.end();
    await removed;
    await waitFor(() => server.publishers === 0);

    const contentCanary = "PROMPT_CONTENT_CANARY";
    const malformed = await connect(config.paths.socketPath);
    await authenticatePublisher(malformed, token, "ipc-instance-invalid-01", 201);
    const unexpectedEvents: SessionEvent[] = [];
    const unsubscribe = registry.subscribe(event => unexpectedEvents.push(event));
    malformed.write(
      `${JSON.stringify({
        v: 1,
        op: "upsert",
        session: {
          ...oldPublisherSession,
          instanceId: "ipc-instance-invalid-01",
          pid: 201,
          prompt: contentCanary,
        },
      })}\n`,
    );
    await waitForText(malformed, "protocol_error");
    unsubscribe();
    expect(unexpectedEvents).toEqual([]);
    expect(logs.join("\n")).not.toContain(contentCanary);
    malformed.end();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("IPC isolates concurrent same-process publishers and enforces capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-concurrent-"));
  const baseConfig = testConfig(root);
  const config: GatewayConfig = {
    ...baseConfig,
    registry: { ...baseConfig.registry, maxPublishers: 3 },
  };
  await mkdir(config.paths.runtimeDir, { recursive: true, mode: 0o700 });
  const registry = new SessionRegistry({ ttlSeconds: config.registry.ttlSeconds, maxSessions: 5 });
  const token = "T".repeat(43);
  const server = await startRegistryIpcServer({
    config,
    token,
    registry,
    logger: new SafeLogger({ write() {} }),
  });
  const instanceIds = ["ipc-concurrent-01", "ipc-concurrent-02", "ipc-concurrent-03"] as const;
  const pid = 400;

  try {
    const sockets = await Promise.all(instanceIds.map(() => connect(config.paths.socketPath)));
    await Promise.all(
      sockets.map((socket, index) => authenticatePublisher(socket, token, instanceIds[index]!, pid)),
    );
    expect(server.publishers).toBe(3);

    const rejected = await connect(config.paths.socketPath);
    expect(await readFrame(rejected)).toMatchObject({ op: "error", code: "capacity" });
    rejected.end();
    expect(server.publishers).toBe(3);

    for (const [index, socket] of sockets.entries()) {
      socket.write(
        `${JSON.stringify({
          v: 1,
          op: "upsert",
          session: {
            instanceId: instanceIds[index]!,
            generation: 1,
            pid,
            sessionId: `ipc-concurrent-session-${index + 1}`,
            title: `Concurrent IPC session ${index + 1}`,
            startedAt: `2026-07-19T00:0${index}:00.000Z`,
            inputRequired: false,
            viewLink: `CONCURRENT_VIEW_${index}_${"V".repeat(20)}`,
          },
        })}\n`,
      );
    }
    await waitFor(() => registry.size === 3);
    expect(registry.snapshot().sessions.map(session => session.instanceId).sort()).toEqual([...instanceIds].sort());

    sockets[0]!.write(
      `${JSON.stringify({
        v: 1,
        op: "upsert",
        session: {
          instanceId: instanceIds[0],
          generation: 2,
          pid,
          sessionId: "ipc-concurrent-session-1-replacement",
          title: "Concurrent IPC session 1 replacement",
          startedAt: "2026-07-19T00:03:00.000Z",
          inputRequired: false,
          viewLink: `CONCURRENT_VIEW_REPLACEMENT_${"R".repeat(20)}`,
        },
      })}\n`,
    );
    for (let iteration = 0; iteration < 20; iteration += 1) {
      for (const [index, socket] of sockets.entries()) {
        socket.write(
          `${JSON.stringify({
            v: 1,
            op: "heartbeat",
            instanceId: instanceIds[index]!,
            generation: index === 0 ? 2 : 1,
          })}\n`,
        );
      }
    }
    await waitFor(
      () => registry.snapshot().sessions.find(session => session.instanceId === instanceIds[0])?.generation === 2,
    );
    const active = registry.snapshot().sessions;
    expect(active.find(session => session.instanceId === instanceIds[0])).toMatchObject({
      generation: 2,
      title: "Concurrent IPC session 1 replacement",
    });
    expect(active.find(session => session.instanceId === instanceIds[1])).toMatchObject({
      generation: 1,
      title: "Concurrent IPC session 2",
    });
    expect(active.find(session => session.instanceId === instanceIds[2])).toMatchObject({
      generation: 1,
      title: "Concurrent IPC session 3",
    });

    sockets[1]!.end();
    await waitFor(() => registry.size === 2 && server.publishers === 2);
    expect(registry.snapshot().sessions.map(session => session.instanceId).sort()).toEqual([
      instanceIds[0],
      instanceIds[2],
    ]);

    sockets[0]!.end();
    sockets[2]!.end();
    await waitFor(() => registry.size === 0 && server.publishers === 0);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test("IPC supports fifty authenticated publishers through upsert and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-load-"));
  const baseConfig = testConfig(root);
  const publisherCount = 50;
  const config: GatewayConfig = {
    ...baseConfig,
    registry: { ...baseConfig.registry, maxPublishers: publisherCount, maxSessions: publisherCount },
  };
  await mkdir(config.paths.runtimeDir, { recursive: true, mode: 0o700 });
  const registry = new SessionRegistry({
    ttlSeconds: config.registry.ttlSeconds,
    maxSessions: config.registry.maxSessions,
  });
  const token = "T".repeat(43);
  const server = await startRegistryIpcServer({
    config,
    token,
    registry,
    logger: new SafeLogger({ write() {} }),
  });
  const instanceIds = Array.from(
    { length: publisherCount },
    (_, index) => `ipc-load-instance-${(index + 1).toString().padStart(2, "0")}`,
  );
  const pid = 500;

  try {
    const sockets = await Promise.all(instanceIds.map(() => connect(config.paths.socketPath)));
    await Promise.all(
      sockets.map((socket, index) => authenticatePublisher(socket, token, instanceIds[index]!, pid)),
    );
    expect(server.publishers).toBe(publisherCount);

    const upsertEvents = nextRegistryEvents(registry, "session_upsert", publisherCount);
    for (const [index, socket] of sockets.entries()) {
      socket.write(
        `${JSON.stringify({
          v: 1,
          op: "upsert",
          session: {
            instanceId: instanceIds[index]!,
            generation: 1,
            pid,
            sessionId: `ipc-load-session-${index + 1}`,
            title: `IPC load session ${index + 1}`,
            startedAt: "2026-07-19T00:00:00.000Z",
            inputRequired: false,
            viewLink: `LOAD_VIEW_${index}_${"V".repeat(20)}`,
          },
        })}\n`,
      );
    }
    expect(await upsertEvents).toHaveLength(publisherCount);
    expect(registry.snapshot().sessions.map(session => session.instanceId).sort()).toEqual(
      [...instanceIds].sort(),
    );

    for (const [index, socket] of sockets.entries()) {
      socket.write(
        `${JSON.stringify({
          v: 1,
          op: "heartbeat",
          instanceId: instanceIds[index]!,
          generation: 1,
        })}\n`,
      );
    }

    const removeEvents = nextRegistryEvents(registry, "session_remove", publisherCount);
    for (const socket of sockets) socket.end();
    expect(await removeEvents).toHaveLength(publisherCount);
    expect(registry.size).toBe(0);
    expect(server.publishers).toBe(0);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});


test("IPC deadlines free publisher capacity and preserve fragmented frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-deadlines-"));
  const baseConfig = testConfig(root);
  const config: GatewayConfig = {
    ...baseConfig,
    registry: { ...baseConfig.registry, maxPublishers: 1 },
  };
  const deadlineScheduler = new ManualDeadlineScheduler();
  await mkdir(config.paths.runtimeDir, { recursive: true, mode: 0o700 });
  const registry = new SessionRegistry({ ttlSeconds: config.registry.ttlSeconds, maxSessions: 5 });
  const token = "T".repeat(43);
  const server = await startRegistryIpcServer({
    config,
    token,
    registry,
    logger: new SafeLogger({ write() {} }),
    deadlineScheduler,
  });

  try {
    const stalled = await connect(config.paths.socketPath);

    const rejected = await connect(config.paths.socketPath);
    await waitForText(rejected, '"capacity"');
    rejected.end();

    deadlineScheduler.onlyActive(5_000).fire();
    expect(server.publishers).toBe(0);

    const socket = await connect(config.paths.socketPath);
    const clientNonce = createRegistryAuthNonce();
    const hello = `${JSON.stringify({
      v: 1,
      op: "hello",
      clientNonce,
      instanceId: "ipc-instance-fragmented",
      pid: 300,
    })}\n`;
    const helloSplit = Math.floor(hello.length / 2);
    socket.write(hello.slice(0, helloSplit));
    socket.write(hello.slice(helloSplit));
    await finishPublisherAuthentication(socket, token, clientNonce, "ipc-instance-fragmented", 300);
    const idleTimeoutMilliseconds = config.registry.ttlSeconds * 1_000;
    const firstIdleDeadline = deadlineScheduler.onlyActive(idleTimeoutMilliseconds);
    expect(firstIdleDeadline.active).toBeTrue();

    const upserted = nextRegistryEvent(registry, "session_upsert");
    const upsert = `${JSON.stringify({
      v: 1,
      op: "upsert",
      session: {
        instanceId: "ipc-instance-fragmented",
        generation: 1,
        pid: 300,
        sessionId: "ipc-session-fragmented",
        title: "Fragmented IPC session",
        startedAt: "2026-07-19T00:00:00.000Z",
        inputRequired: false,
        viewLink: `FRAGMENTED_${"V".repeat(2_048)}`,
      },
    })}\n`;
    socket.write(upsert.slice(0, 700));
    socket.write(upsert.slice(700, 1_400));
    socket.write(upsert.slice(1_400));
    await upserted;
    expect(registry.size).toBe(1);

    expect(firstIdleDeadline.active).toBeFalse();
    const replacementIdleDeadline = deadlineScheduler.onlyActive(idleTimeoutMilliseconds);
    expect(replacementIdleDeadline).not.toBe(firstIdleDeadline);
    replacementIdleDeadline.fire();
    await waitFor(() => socket.data.closed);
    expect(registry.size).toBe(0);
    expect(server.publishers).toBe(0);
    expect(socket.data.text).not.toContain("protocol_error");
    stalled.end();
    socket.end();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("IPC closes authenticated publishers when heartbeat state is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-expired-"));
  const config = testConfig(root);
  await mkdir(config.paths.runtimeDir, { recursive: true, mode: 0o700 });
  const registry = new SessionRegistry({ ttlSeconds: config.registry.ttlSeconds, maxSessions: 5 });
  const token = "T".repeat(43);
  const server = await startRegistryIpcServer({
    config,
    token,
    registry,
    logger: new SafeLogger({ write() {} }),
  });

  try {
    const socket = await connect(config.paths.socketPath);
    const instanceId = "ipc-instance-expired";
    await authenticatePublisher(socket, token, instanceId, 600);
    socket.write(
      `${JSON.stringify({
        v: 1,
        op: "upsert",
        session: {
          instanceId,
          generation: 1,
          pid: 600,
          sessionId: "ipc-session-expired",
          startedAt: "2026-07-21T00:00:00.000Z",
          inputRequired: false,
          viewLink: `EXPIRED_VIEW_${"V".repeat(20)}`,
        },
      })}\n`,
    );
    await waitFor(() => registry.size === 1);

    socket.write(
      `${JSON.stringify({ v: 1, op: "remove", instanceId, generation: 1, reason: "stopped" })}\n`,
    );
    await waitFor(() => registry.size === 0);
    socket.write(`${JSON.stringify({ v: 1, op: "heartbeat", instanceId, generation: 1 })}\n`);

    await waitFor(() => socket.data.closed && server.publishers === 0);
    expect(socket.data.text).not.toContain("protocol_error");
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
