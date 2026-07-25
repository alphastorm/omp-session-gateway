import { describe, expect, test } from "bun:test";
import {
  installBrowserConnectionRecovery,
  type BrowserRecoveryEnvironment,
} from "../upstream/src/lib/browser-recovery";

class FakeRecoveryWindow extends EventTarget {
  readonly timers = new Map<number, () => void>();
  #nextTimer = 1;

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, callback);
    return handle;
  }

  runNextTimer(): void {
    const next = this.timers.entries().next().value as [number, () => void] | undefined;
    if (next === undefined) throw new Error("missing recovery timer");
    const [handle, callback] = next;
    this.timers.delete(handle);
    callback();
  }
}

class FakeRecoveryDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function recoveryHarness(results: readonly (boolean | "hang")[]): {
  readonly connection: EventTarget;
  readonly environment: BrowserRecoveryEnvironment;
  readonly fetches: Array<{ input: string; init: RequestInit | undefined }>;
  readonly refreshed: { count: number };
  readonly window: FakeRecoveryWindow;
} {
  const connection = new EventTarget();
  const document = new FakeRecoveryDocument();
  const window = new FakeRecoveryWindow();
  const fetches: Array<{ input: string; init: RequestInit | undefined }> = [];
  const refreshed = { count: 0 };
  const responses = [...results];
  const environment: BrowserRecoveryEnvironment = {
    connection,
    document,
    now: () => 1_000,
    window,
    async fetch(input, init): Promise<Response> {
      fetches.push({ input: String(input), init });
      const result = responses.shift();
      if (result === "hang") {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(new DOMException("probe timed out", "AbortError"));
          if (init?.signal?.aborted === true) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return new Response(null, { status: result === false ? 503 : 200 });
    },
  };
  return { connection, environment, fetches, refreshed, window };
}

describe("collaboration browser network recovery", () => {
  test("refreshes the relay transport after a Wi-Fi connection change", async () => {
    const harness = recoveryHarness([true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.refreshed.count).toBe(0);

    harness.connection.dispatchEvent(new Event("change"));
    await settle();
    expect(harness.refreshed.count).toBe(1);
    expect(harness.fetches.map(request => request.input)).toEqual([
      "/api/v1/health",
      "/api/v1/health",
    ]);
    expect(harness.fetches[1]?.init?.cache).toBe("no-store");

    dispose();
    expect(harness.window.timers.size).toBe(0);
  });

  test("turns a detected gateway outage into one fresh relay connection", async () => {
    const harness = recoveryHarness([false, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.refreshed.count).toBe(0);

    harness.window.runNextTimer();
    await settle();
    expect(harness.refreshed.count).toBe(1);
    expect(harness.fetches).toHaveLength(2);

    dispose();
  });

  test("times out a silent health probe before recovering the relay", async () => {
    const harness = recoveryHarness(["hang", true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
    );

    harness.window.runNextTimer();
    await settle();
    harness.window.runNextTimer();
    await settle();
    expect(harness.refreshed.count).toBe(0);

    harness.window.runNextTimer();
    await settle();
    expect(harness.refreshed.count).toBe(1);
    expect(harness.fetches).toHaveLength(2);

    dispose();
  });
});
