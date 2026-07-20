import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CollabSocket } from "../upstream/src/lib/socket.ts";

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

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

  close(code = 1000): void {
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "" } as CloseEvent);
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = NativeWebSocket;
});

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
});
