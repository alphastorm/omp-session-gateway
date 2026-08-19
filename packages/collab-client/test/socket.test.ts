import type { HostFrame, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GuestClient } from "../upstream/src/lib/client.ts";
import { CollabSocket } from "../upstream/src/lib/socket.ts";
import { importRoomKey, open } from "../upstream/src/lib/codec.ts";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink, unpackEnvelope } from "../upstream/src/lib/link.ts";

const NativeWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCode: number | undefined;
  readonly sent: Uint8Array[] = [];
  readonly #sentWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!(data instanceof Uint8Array)) throw new Error("expected a binary envelope");
    this.sent.push(data.slice());
    for (let index = this.#sentWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#sentWaiters[index];
      if (waiter !== undefined && this.sent.length >= waiter.count) {
        this.#sentWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  waitForSent(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#sentWaiters.push({ count, resolve });
    return promise;
  }

  close(code = 1000): void {
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "" } as CloseEvent);
  }
}

interface FakeTimerHarness {
  pendingDelays(): number[];
  runNext(): void;
  restore(): void;
}

function installFakeTimers(): FakeTimerHarness {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeRandom = Math.random;
  const nativeNow = Date.now;
  const timers = new Map<number, { handler: TimerHandler; delay: number }>();
  let nextTimer = 0;
  // The client schedules its idle relay probe as `lastRelayActivityAt + RELAY_IDLE_PROBE_MS -
  // Date.now()`. Faking setTimeout while leaving Date.now on the wall clock mixes the two, so any
  // real milliseconds the test spends (WebCrypto decodes, machine load) shorten that delay to
  // 9_99x and make exact-delay assertions fail under load. Drive a virtual clock instead: it only
  // advances when a fake timer fires, which is exactly the elapsed time the client should observe.
  let now = nativeNow();
  Date.now = () => now;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
    nextTimer += 1;
    timers.set(nextTimer, { handler, delay: delay ?? 0 });
    return nextTimer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: number | Timer | undefined) => {
    if (typeof timer === "number") timers.delete(timer);
  }) as typeof clearTimeout;
  Math.random = () => 0.5;
  return {
    pendingDelays: () => [...timers.values()].map(timer => timer.delay).sort((left, right) => left - right),
    runNext() {
      const next = [...timers.entries()].sort(([, left], [, right]) => left.delay - right.delay)[0];
      if (next === undefined) throw new Error("no fake timer is pending");
      const [id, timer] = next;
      timers.delete(id);
      if (typeof timer.handler !== "function") throw new Error("string timer handlers are unsupported");
      now += timer.delay;
      timer.handler();
    },
    restore() {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
      Math.random = nativeRandom;
      Date.now = nativeNow;
      timers.clear();
    },
  };
}

async function decodeFrames(socket: FakeWebSocket, key: CryptoKey): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    socket.sent.map(async bytes => {
      const envelope = unpackEnvelope(bytes);
      if (envelope === null) throw new Error("invalid test envelope");
      return (await open(key, envelope.payload)) as Record<string, unknown>;
    }),
  );
}
beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = NativeWebSocket;
});


const TEST_LINK = `synthetic-room#${encodeBase64Url(new Uint8Array(32))}`;
const TEST_HEADER: SessionHeader = {
  type: "session",
  id: "socket-lifecycle-test",
  timestamp: "2026-07-20T00:00:00Z",
  cwd: "/test",
};
const TEST_STATE: SessionState = {
  isStreaming: false,
  queuedMessageCount: 0,
  cwd: "/test",
  participants: [{ name: "host", role: "host" }],
};
const TEST_WELCOME: HostFrame = {
  t: "welcome",
  proto: COLLAB_PROTO,
  header: TEST_HEADER,
  state: TEST_STATE,
  agents: [],
  entryCount: 0,
};
describe("CollabSocket browser lifecycle recovery", () => {
  test("replaces a stale transport without ending the logical connection", () => {
    const socket = new CollabSocket({
      wsUrl: "wss://relay.example/r/synthetic-room",
      role: "guest",
      key: {} as CryptoKey,
    });
    const phases: Array<{ reason: string; willReconnect: boolean }> = [];
    let opens = 0;
    socket.onOpen = () => {
      opens += 1;
    };
    socket.onClose = (reason, willReconnect) => {
      phases.push({ reason, willReconnect });
    };

    socket.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const initial = FakeWebSocket.instances[0];
    if (initial === undefined) throw new Error("initial WebSocket was not created");
    initial.open();
    expect(opens).toBe(1);

    socket.reconnect();
    expect(initial.closeCode).toBe(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(phases).toEqual([{ reason: "connection refresh", willReconnect: true }]);

    const replacement = FakeWebSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement WebSocket was not created");
    replacement.open();
    expect(opens).toBe(2);
    expect(socket.isOpen).toBe(true);

    socket.close();
    expect(phases.at(-1)).toEqual({ reason: "closed", willReconnect: false });
    socket.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("times out a blackholed replacement handshake and continues jittered retry", () => {
    const timers = installFakeTimers();
    try {
      const socket = new CollabSocket({
        wsUrl: "wss://relay.example/r/synthetic-room",
        role: "guest",
        key: {} as CryptoKey,
      });
      const phases: Array<{ reason: string; willReconnect: boolean }> = [];
      socket.onClose = (reason, willReconnect) => phases.push({ reason, willReconnect });

      socket.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      initial.close(1006);
      expect(timers.pendingDelays()).toEqual([500]);

      timers.runNext();
      const replacement = FakeWebSocket.instances[1];
      if (replacement === undefined) throw new Error("replacement WebSocket was not created");
      expect(timers.pendingDelays()).toEqual([10_000]);

      timers.runNext();
      expect(replacement.closeCode).toBe(1000);
      expect(phases.at(-1)).toEqual({ reason: "relay connection timed out", willReconnect: true });
      expect(timers.pendingDelays()).toEqual([1_000]);

      timers.runNext();
      expect(FakeWebSocket.instances).toHaveLength(3);
      socket.close();
    } finally {
      timers.restore();
    }
  });

  test("requires a fresh welcome after every replacement transport opens", () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const activeTimers = new Map<number, number>();
    let nextTimer = 0;
    globalThis.setTimeout = ((_: TimerHandler, delay?: number) => {
      nextTimer += 1;
      activeTimers.set(nextTimer, delay ?? 0);
      return nextTimer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: number | Timer | undefined) => {
      if (typeof timer === "number") activeTimers.delete(timer);
    }) as typeof clearTimeout;
    try {
      const client = new GuestClient(TEST_LINK, "test guest");
      client.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      client.applyFrameForTest(TEST_WELCOME);
      expect(client.getSnapshot().phase).toBe("live");
      expect(activeTimers.size).toBe(0);

      client.refreshConnection();
      const replacement = FakeWebSocket.instances[1];
      if (replacement === undefined) throw new Error("replacement WebSocket was not created");
      replacement.open();

      expect(client.getSnapshot().phase).toBe("reconnecting");
      expect([...activeTimers.values()]).toEqual([30_000]);
      client.close();
      expect(activeTimers.size).toBe(0);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    }
  });

  test("holds initial application frames until the guest hello", async () => {
    const key = await importRoomKey(new Uint8Array(32));
    const socket = new CollabSocket({
      wsUrl: "wss://relay.example/r/synthetic-room",
      role: "guest",
      key,
    });
    socket.onOpen = () => {
      socket.send({ t: "hello", proto: 1, name: "test guest" });
    };

    socket.connect();
    socket.send({ t: "prompt", text: "early prompt" });
    const initial = FakeWebSocket.instances[0];
    if (initial === undefined) throw new Error("initial WebSocket was not created");
    initial.open();
    await initial.waitForSent(2);

    expect((await decodeFrames(initial, key)).map(frame => [frame.t, frame.text])).toEqual([
      ["hello", undefined],
      ["prompt", "early prompt"],
    ]);
    socket.close();
  });
  test("emits a fresh hello before queued frames and drops stale queued sends", async () => {
    const key = await importRoomKey(new Uint8Array(32));
    let keyRequests = 0;
    const { promise: secondStaleSendStarted, resolve: markSecondStaleSendStarted } =
      Promise.withResolvers<void>();
    const sequencedKey = {
      then<TResult1 = CryptoKey, TResult2 = never>(
        onfulfilled?: ((value: CryptoKey) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        keyRequests += 1;
        if (keyRequests === 3) markSecondStaleSendStarted();
        return Promise.resolve(key).then(onfulfilled, onrejected);
      },
    };
    const socket = new CollabSocket({
      wsUrl: "wss://relay.example/r/synthetic-room",
      role: "guest",
      key: sequencedKey,
    });
    socket.onOpen = () => {
      socket.send({ t: "hello", proto: 1, name: "test guest" });
    };

    socket.connect();
    const initial = FakeWebSocket.instances[0];
    if (initial === undefined) throw new Error("initial WebSocket was not created");
    initial.open();
    await initial.waitForSent(1);

    initial.readyState = FakeWebSocket.CONNECTING;
    socket.send({ t: "prompt", text: "stale prompt" });
    socket.send({ t: "abort" });
    await secondStaleSendStarted;
    socket.reconnect();
    socket.send({ t: "prompt", text: "current prompt" });

    const replacement = FakeWebSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement WebSocket was not created");
    replacement.open();
    await replacement.waitForSent(2);

    expect((await decodeFrames(replacement, key)).map(frame => [frame.t, frame.text])).toEqual([
      ["hello", undefined],
      ["prompt", "current prompt"],
    ]);

    expect(initial.sent).toHaveLength(1);
    expect(replacement.sent).toHaveLength(2);
    socket.close();
  });

  test("detects two silent end-to-end relay probe failures", async () => {
    const timers = installFakeTimers();
    try {
      const client = new GuestClient(TEST_LINK, "test guest");
      client.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      await initial.waitForSent(1);
      client.applyFrameForTest(TEST_WELCOME);
      client.applyFrameForTest({ t: "gateway-health-pong", seq: 0 });
      expect(client.getSnapshot().relayHealth.state).toBe("healthy");
      expect(timers.pendingDelays()).toEqual([10_000]);

      timers.runNext();
      await initial.waitForSent(2);
      expect((await decodeFrames(initial, await importRoomKey(new Uint8Array(32)))).at(-1)).toMatchObject({
        t: "gateway-health-ping",
        seq: 1,
      });
      expect(timers.pendingDelays()).toEqual([3_000]);

      timers.runNext();
      await initial.waitForSent(3);
      expect(client.getSnapshot().relayHealth.state).toBe("degraded");
      expect(timers.pendingDelays()).toEqual([3_000]);

      timers.runNext();
      expect(client.getSnapshot().relayHealth.state).toBe("unreachable");
      expect(client.getSnapshot().phase).toBe("reconnecting");
      expect(FakeWebSocket.instances).toHaveLength(2);
      client.close();
    } finally {
      timers.restore();
    }
  });

  test("does not let inbound traffic or a stale pong satisfy a current relay probe", async () => {
    const timers = installFakeTimers();
    try {
      const client = new GuestClient(TEST_LINK, "test guest");
      client.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      await initial.waitForSent(1);
      client.applyFrameForTest(TEST_WELCOME);
      client.applyFrameForTest({ t: "gateway-health-pong", seq: 0 });

      client.remeasureRelay();
      await initial.waitForSent(2);
      expect((await decodeFrames(initial, await importRoomKey(new Uint8Array(32)))).at(-1)).toMatchObject({
        t: "gateway-health-ping",
        seq: 1,
      });
      expect(timers.pendingDelays()).toEqual([3_000]);

      client.applyFrameForTest({ t: "state", state: TEST_STATE });
      client.applyFrameForTest({ t: "gateway-health-pong", seq: 0 });
      expect(timers.pendingDelays()).toEqual([3_000]);

      timers.runNext();
      await initial.waitForSent(3);
      expect(client.getSnapshot().relayHealth.state).toBe("degraded");
      client.applyFrameForTest({ t: "gateway-health-pong", seq: 2 });
      expect(client.getSnapshot().relayHealth.state).toBe("healthy");
      expect(timers.pendingDelays()).toEqual([10_000]);
      client.close();
    } finally {
      timers.restore();
    }
  });

  test("cancels idle and pending relay probes while the page is hidden", async () => {
    const timers = installFakeTimers();
    try {
      const client = new GuestClient(TEST_LINK, "test guest");
      client.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      await initial.waitForSent(1);
      client.applyFrameForTest(TEST_WELCOME);
      client.applyFrameForTest({ t: "gateway-health-pong", seq: 0 });
      expect(timers.pendingDelays()).toEqual([10_000]);

      client.setRelayProbesPaused(true);
      expect(timers.pendingDelays()).toEqual([]);
      client.setRelayProbesPaused(false);
      expect(timers.pendingDelays()).toEqual([10_000]);

      client.remeasureRelay();
      await initial.waitForSent(2);
      expect(timers.pendingDelays()).toEqual([3_000]);
      client.setRelayProbesPaused(true);
      expect(timers.pendingDelays()).toEqual([]);
      expect(client.getSnapshot().relayHealth.state).toBe("healthy");
      client.close();
    } finally {
      timers.restore();
    }
  });

  test("keeps a UI response pending until host acknowledgement and resends it after reconnect", async () => {
    const key = await importRoomKey(new Uint8Array(32));
    const client = new GuestClient(TEST_LINK, "test guest");
    client.connect();
    const initial = FakeWebSocket.instances[0];
    if (initial === undefined) throw new Error("initial WebSocket was not created");
    initial.open();
    await initial.waitForSent(1);
    client.applyFrameForTest(TEST_WELCOME);
    client.applyFrameForTest({
      t: "ui-request",
      request: {
        reqId: 42,
        kind: "select",
        title: "Choose",
        options: ["one", "two"],
        initialIndex: 0,
        selectionMarker: "radio",
      },
    });

    client.sendUiResponse(42, "two");
    await initial.waitForSent(2);
    expect(client.getSnapshot().uiRequest?.reqId).toBe(42);
    expect(client.getSnapshot().uiResponsePending).toBeTrue();
    expect((await decodeFrames(initial, key)).at(-1)).toMatchObject({ t: "ui-response", reqId: 42, value: "two" });

    client.refreshConnection();
    const replacement = FakeWebSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement WebSocket was not created");
    replacement.open();
    client.applyFrameForTest(TEST_WELCOME);
    await replacement.waitForSent(2);
    expect((await decodeFrames(replacement, key)).map(frame => frame.t)).toEqual(["hello", "ui-response"]);
    expect(client.getSnapshot().uiResponsePending).toBeTrue();

    client.applyFrameForTest({ t: "ui-request-end", reqId: 42 });
    expect(client.getSnapshot().uiRequest).toBeNull();
    expect(client.getSnapshot().uiResponsePending).toBeFalse();
    client.close();
  });

  test("recovers an established guest after the relay replaces its room", () => {
    const timers = installFakeTimers();
    try {
      const client = new GuestClient(TEST_LINK, "test guest");
      client.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      client.applyFrameForTest(TEST_WELCOME);
      expect(client.getSnapshot().phase).toBe("live");

      initial.onmessage?.({ data: JSON.stringify({ t: "room-closed" }) } as MessageEvent);
      expect(client.getSnapshot().phase).toBe("live");
      initial.close(4001);
      expect(client.getSnapshot().phase).toBe("reconnecting");
      expect(timers.pendingDelays()).toEqual([500]);

      timers.runNext();
      const missingRoom = FakeWebSocket.instances[1];
      if (missingRoom === undefined) throw new Error("missing-room WebSocket was not created");
      missingRoom.open();
      missingRoom.close(4004);
      expect(client.getSnapshot().phase).toBe("reconnecting");
      expect(timers.pendingDelays()).toEqual([1_000]);

      timers.runNext();
      const recovered = FakeWebSocket.instances[2];
      if (recovered === undefined) throw new Error("recovered WebSocket was not created");
      recovered.open();
      client.applyFrameForTest(TEST_WELCOME);
      expect(client.getSnapshot().phase).toBe("live");
      expect(client.getSnapshot().endedReason).toBeNull();
      expect(timers.pendingDelays()).toEqual([]);
      client.close();
    } finally {
      timers.restore();
    }
  });

  test("ends room recovery after six exponential retries", () => {
    const timers = installFakeTimers();
    try {
      const client = new GuestClient(TEST_LINK, "test guest");
      client.connect();
      const initial = FakeWebSocket.instances[0];
      if (initial === undefined) throw new Error("initial WebSocket was not created");
      initial.open();
      client.applyFrameForTest(TEST_WELCOME);
      initial.close(4001);

      const observedDelays: number[] = [];
      for (let retry = 0; retry < 6; retry += 1) {
        const [delay] = timers.pendingDelays();
        if (delay === undefined) throw new Error(`room recovery retry ${retry + 1} was not scheduled`);
        observedDelays.push(delay);
        timers.runNext();
        const replacement = FakeWebSocket.instances.at(-1);
        if (replacement === undefined) throw new Error("replacement WebSocket was not created");
        replacement.open();
        replacement.close(4004);
      }

      expect(observedDelays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000]);
      expect(FakeWebSocket.instances).toHaveLength(7);
      expect(timers.pendingDelays()).toEqual([]);
      expect(client.getSnapshot().phase).toBe("ended");
      expect(client.getSnapshot().endedReason).toBe("no such room");
    } finally {
      timers.restore();
    }
  });

  test("keeps an initially missing room terminal", () => {
    const client = new GuestClient(TEST_LINK, "test guest");
    client.connect();
    const initial = FakeWebSocket.instances[0];
    if (initial === undefined) throw new Error("initial WebSocket was not created");
    initial.open();
    initial.close(4004);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getSnapshot().phase).toBe("ended");
    expect(client.getSnapshot().endedReason).toBe("no such room");
  });

});

describe("Collaboration link error redaction", () => {
  test("accepts a percent-encoded legacy separator from strict URL launchers", () => {
    const parsed = parseCollabLink(TEST_LINK.replace("#", "%23"));
    expect("error" in parsed).toBeFalse();
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.roomId).toBe("synthetic-room");
    expect(parsed.key).toHaveLength(32);
  });

  test("never reflects a malformed capability in parser errors", () => {
    const capability = `synthetic-room-1234.${"A".repeat(43)}`;
    const parsed = parseCollabLink(`://invalid/${capability}`);
    expect("error" in parsed).toBeTrue();
    expect(JSON.stringify(parsed)).not.toContain(capability);
  });
});
