import { afterAll, describe, expect, test } from "bun:test";

const GLOBAL_NAMES = [
  "addEventListener",
  "caches",
  "clients",
  "fetch",
  "location",
  "__SHELL_ASSETS__",
  "__CACHE_NAME__",
] as const;
const nativeGlobals = Object.fromEntries(
  GLOBAL_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
) as Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined>;

const listeners = new Map<string, Array<(event: unknown) => void>>();
const cacheAdds: string[][] = [];
const cacheDeletes: string[] = [];
const cachePuts: string[] = [];
const fetched: string[] = [];
const cache = {
  async addAll(paths: readonly string[]): Promise<void> {
    cacheAdds.push([...paths]);
  },
  async match(): Promise<Response | undefined> {
    return undefined;
  },
  async put(request: { url: string }): Promise<void> {
    cachePuts.push(request.url);
  },
};
const caches = {
  async open(): Promise<typeof cache> {
    return cache;
  },
  async keys(): Promise<string[]> {
    return ["omp-sessions-shell-old", "omp-sessions-shell-current", "unrelated"];
  },
  async delete(name: string): Promise<boolean> {
    cacheDeletes.push(name);
    return true;
  },
};
const clientState = {
  windows: [] as Array<{ url: string; focus(): Promise<unknown> }>,
  matchOptions: [] as unknown[],
  opened: [] as string[],
};
const clients = {
  async matchAll(options: unknown): Promise<typeof clientState.windows> {
    clientState.matchOptions.push(options);
    return clientState.windows;
  },
  async openWindow(path: string): Promise<null> {
    clientState.opened.push(path);
    return null;
  },
};

Object.defineProperties(globalThis, {
  addEventListener: {
    configurable: true,
    value(type: string, listener: (event: unknown) => void): void {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
  },
  caches: { configurable: true, value: caches },
  clients: { configurable: true, value: clients },
  fetch: {
    configurable: true,
    async value(request: { url: string }): Promise<Response> {
      fetched.push(request.url);
      return new Response("asset", { status: 200 });
    },
  },
  location: { configurable: true, value: { origin: "https://sessions.example" } },
  __SHELL_ASSETS__: { configurable: true, value: ["/assets/app.0123456789ab.js"] },
  __CACHE_NAME__: { configurable: true, value: "omp-sessions-shell-current" },
});

// The worker installs global listeners at import time, so this cache-busted import is the test boundary.
const serviceWorkerTestModule = "../src/service-worker.ts?service-worker-contract";
await import(serviceWorkerTestModule);

function listener(type: string): (event: unknown) => void {
  const registered = listeners.get(type);
  if (registered?.length !== 1) throw new Error(`expected one ${type} listener`);
  return registered[0]!;
}

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    const descriptor = nativeGlobals[name];
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("notification service worker", () => {
  test("responds only to the exact versioned support handshake", () => {
    const responses: unknown[] = [];
    const message = listener("message");
    message({
      data: { type: "omp-notification-support-request", version: 1 },
      ports: [{ postMessage(value: unknown): void { responses.push(value); } }],
    });
    message({
      data: { type: "omp-notification-support-request", version: 1, content: "PROMPT_CANARY" },
      ports: [{ postMessage(value: unknown): void { responses.push(value); } }],
    });
    message({
      data: { type: "omp-notification-support-request", version: 2 },
      ports: [{ postMessage(value: unknown): void { responses.push(value); } }],
    });

    expect(responses).toEqual([{ type: "omp-notification-support-response", version: 1 }]);
    expect(JSON.stringify(responses)).not.toContain("PROMPT_CANARY");
  });

  test("focuses only an exact same-origin dashboard and never a client page", async () => {
    let dashboardFocuses = 0;
    let clientFocuses = 0;
    clientState.windows = [
      {
        url: "https://sessions.example/client/",
        async focus(): Promise<unknown> {
          clientFocuses += 1;
          return this;
        },
      },
      {
        url: "https://other.example/",
        async focus(): Promise<unknown> {
          throw new Error("cross-origin client must not be focused");
        },
      },
      {
        url: "https://sessions.example/",
        async focus(): Promise<unknown> {
          dashboardFocuses += 1;
          return this;
        },
      },
    ];
    clientState.matchOptions.length = 0;
    clientState.opened.length = 0;
    let closed = 0;
    let completion: Promise<void> | undefined;
    listener("notificationclick")({
      notification: { close(): void { closed += 1; }, data: { url: "/client/" } },
      waitUntil(promise: Promise<void>): void { completion = promise; },
    });
    await completion;

    expect(closed).toBe(1);
    expect(clientState.matchOptions).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(dashboardFocuses).toBe(1);
    expect(clientFocuses).toBe(0);
    expect(clientState.opened).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("opens only the root dashboard when focus fails", async () => {
    clientState.windows = [
      {
        url: "https://sessions.example/",
        async focus(): Promise<unknown> {
          throw new Error("focus rejected");
        },
      },
      {
        url: "https://sessions.example/client/",
        async focus(): Promise<unknown> {
          throw new Error("client must not be focused");
        },
      },
    ];
    clientState.opened.length = 0;
    let completion: Promise<void> | undefined;
    listener("notificationclick")({
      notification: { close(): void {} },
      waitUntil(promise: Promise<void>): void { completion = promise; },
    });
    await completion;
    expect(clientState.opened).toEqual(["/"]);
    expect(fetched).toEqual([]);
  });

  test("preserves shell-only cache installation, cleanup, and fetch exclusions", async () => {
    let installCompletion: Promise<void> | undefined;
    listener("install")({ waitUntil(promise: Promise<void>): void { installCompletion = promise; } });
    await installCompletion;
    expect(cacheAdds).toEqual([["/assets/app.0123456789ab.js"]]);

    let activateCompletion: Promise<unknown> | undefined;
    listener("activate")({ waitUntil(promise: Promise<unknown>): void { activateCompletion = promise; } });
    await activateCompletion;
    expect(cacheDeletes).toEqual(["omp-sessions-shell-old"]);

    const fetchListener = listener("fetch");
    const bypasses = [
      { method: "POST", mode: "same-origin", url: "https://sessions.example/assets/app.0123456789ab.js" },
      { method: "GET", mode: "navigate", url: "https://sessions.example/" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/api/v1/sessions" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/client/" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/assets/app.0123456789ab.js?x=1" },
    ];
    for (const request of bypasses) {
      let responded = false;
      fetchListener({ request, respondWith(): void { responded = true; } });
      expect(responded).toBeFalse();
    }

    const shellRequest = {
      method: "GET",
      mode: "same-origin",
      url: "https://sessions.example/assets/app.0123456789ab.js",
    };
    let shellResponse: Promise<Response> | undefined;
    fetchListener({ request: shellRequest, respondWith(promise: Promise<Response>): void { shellResponse = promise; } });
    expect(await shellResponse).toBeInstanceOf(Response);
    expect(fetched).toEqual([shellRequest.url]);
    expect(cachePuts).toEqual([shellRequest.url]);
  });
});
