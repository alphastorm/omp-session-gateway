import { afterAll, describe, expect, test } from "bun:test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";

const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "navigator",
  "Notification",
  "MessageChannel",
  "PushManager",
  "history",
  "EventSource",
  "fetch",
  "isSecureContext",
  "HTMLElement",
] as const;
const nativeGlobals = Object.fromEntries(
  GLOBAL_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
) as Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined>;

class FakeElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  textContent: string | null = "";
  type = "";

  constructor(readonly tagName: string) {
    super();
  }

  get childElementCount(): number {
    return this.children.length;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force?: boolean): void {
    const present = force ?? !this.attributes.has(name);
    if (present) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => {
      if (selector.startsWith(".")) return element.className.split(/\s+/u).includes(selector.slice(1));
      if (selector.startsWith("#")) return element.id === selector.slice(1);
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (matches(element)) found.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return found;
  }
}

class FakeMessagePort {
  peer: FakeMessagePort | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  close(): void {}

  start(): void {}

  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakeWindow extends EventTarget {
  readonly opened: string[] = [];
  readonly timers = new Map<number, () => void>();
  #nextTimer = 1;

  matchMedia(): { matches: boolean; addEventListener(): void } {
    return { matches: false, addEventListener(): void {} };
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, callback);
    return handle;
  }

  runTimers(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const callback of callbacks) callback();
  }

  open(url?: string | URL): null {
    this.opened.push(String(url));
    return null;
  }
}

class FakeEventSource extends EventTarget {
  static readonly instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "snapshot" | "session_upsert" | "session_remove" | "keepalive", payload: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, "data", { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }
}


interface BrowserHarness {
  readonly elements: {
    readonly sessionList: FakeElement;
    readonly notificationButton: FakeElement;
    readonly notificationDisclosure: FakeElement;
    readonly refreshButton: FakeElement;
    readonly statusBanner: FakeElement;
  };
  disconnectEvents(): void;
  expireEventLiveness(): void;
  readonly fetchPaths: string[];
  readonly permissionRequests: { count: number };
  readonly subscriptionRequests: unknown[];
  readonly unsubscribeRequests: unknown[];
  readonly subscriptionCalls: { subscribe: number; unsubscribe: number };
  readonly workerMessages: unknown[];
  readonly replacedPaths: readonly string[];
  readonly window: FakeWindow;
  emit(type: "snapshot" | "session_upsert" | "session_remove" | "keepalive", payload: unknown): void;
  setList(revision: number, sessions: readonly SessionMetadata[], status?: number): void;
}

function session(
  instanceId: string,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    instanceId,
    generation: 1,
    title: instanceId,
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-21T10:00:00.000Z",
    lastSeenAt: "2026-07-21T10:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
    ...overrides,
  };
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("dashboard state did not settle");
}

async function bootApp(options: {
  readonly permission: NotificationPermission;
  readonly initialSessions: readonly SessionMetadata[];
  readonly workerResponse?: unknown;
  readonly permissionResult?: NotificationPermission;
  readonly existingSubscription?: boolean;
  readonly pathname?: string;
  readonly suffix: string;
}): Promise<BrowserHarness> {
  FakeEventSource.instances.length = 0;
  const sessionList = new FakeElement("section");
  const emptyState = new FakeElement("section");
  const statusBanner = new FakeElement("div");
  const refreshButton = new FakeElement("button");
  refreshButton.textContent = "Refresh";
  const notificationButton = new FakeElement("button");
  notificationButton.textContent = "Checking background alerts…";
  notificationButton.disabled = true;
  const notificationDisclosure = new FakeElement("p");
  const bySelector: Record<string, FakeElement> = {
    "#session-list": sessionList,
    "#empty-state": emptyState,
    "#status-banner": statusBanner,
    "#refresh": refreshButton,
    "#notify": notificationButton,
    "#notify-note": notificationDisclosure,
  };
  const document = {
    documentElement: { dataset: {} as Record<string, string>, style: {} as Record<string, string> },
    querySelector(selector: string): FakeElement | null {
      return bySelector[selector] ?? null;
    },
    createElement(tagName: string): FakeElement {
      return new FakeElement(tagName);
    },
  };
  const window = new FakeWindow();
  const location = {
    origin: "https://sessions.example",
    pathname: options.pathname ?? "/",
    reload(): void {},
    replace(): void {},
  };
  const history = {
    replaced: [] as string[],
    replaceState(_data: unknown, _unused: string, path: string): void {
      this.replaced.push(path);
      location.pathname = path;
    },
    pushState(): void {},
  };
  const fetchPaths: string[] = [];
  let listRevision = 1;
  let listSessions = [...options.initialSessions];
  let listStatus = 200;
  const workerMessages: unknown[] = [];
  const permissionRequests = { count: 0 };
  const subscriptionRequests: unknown[] = [];
  const unsubscribeRequests: unknown[] = [];
  const subscriptionCalls = { subscribe: 0, unsubscribe: 0 };
  const notificationApi = {
    permission: options.permission,
    async requestPermission(): Promise<NotificationPermission> {
      permissionRequests.count += 1;
      this.permission = options.permissionResult ?? "granted";
      return this.permission;
    },
  };
  const pushSubscriptionJson = {
    endpoint: "https://push.example.test/send/browser-device",
    expirationTime: null,
    keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
  };
  let currentSubscription: PushSubscription | null = null;
  const createPushSubscription = (): PushSubscription => ({
    endpoint: pushSubscriptionJson.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey(): ArrayBuffer | null {
      return null;
    },
    toJSON(): PushSubscriptionJSON {
      return pushSubscriptionJson;
    },
    async unsubscribe(): Promise<boolean> {
      subscriptionCalls.unsubscribe += 1;
      currentSubscription = null;
      return true;
    },
  });
  if (options.existingSubscription === true) currentSubscription = createPushSubscription();
  const pushManager = {
    async getSubscription(): Promise<PushSubscription | null> {
      return currentSubscription;
    },
    async subscribe(): Promise<PushSubscription> {
      subscriptionCalls.subscribe += 1;
      currentSubscription = createPushSubscription();
      return currentSubscription;
    },
  };
  const registration = {
    active: {
      postMessage(message: unknown, transfer: readonly MessagePort[]): void {
        workerMessages.push(message);
        const response = options.workerResponse ?? {
          type: "omp-notification-support-response",
          version: 1,
        };
        transfer[0]?.postMessage(response);
      },
    },
    pushManager,
    async showNotification(): Promise<void> {},
  };
  const navigator = {
    serviceWorker: {
      async register(): Promise<typeof registration> {
        return registration;
      },
    },
  };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    fetchPaths.push(path);
    if (path === "/api/v1/push/config") {
      return Response.json({ version: 1, applicationServerKey: "V".repeat(87) });
    }
    if (path === "/api/v1/push/subscription") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      if (init.method === "DELETE") unsubscribeRequests.push(body);
      else subscriptionRequests.push(body);
      return new Response(null, { status: 204 });
    }
    if (path !== "/api/v1/sessions") throw new Error(`unexpected fetch: ${path}`);
    if (listStatus !== 200) return new Response("", { status: listStatus });
    return Response.json({ revision: listRevision, sessions: listSessions });
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    location: { configurable: true, value: location },
    history: { configurable: true, value: history },
    navigator: { configurable: true, value: navigator },
    Notification: { configurable: true, value: notificationApi },
    PushManager: { configurable: true, value: class {} },
    MessageChannel: { configurable: true, value: FakeMessageChannel },
    EventSource: { configurable: true, value: FakeEventSource },
    fetch: { configurable: true, value: fetch },
    isSecureContext: { configurable: true, value: true },
    HTMLElement: { configurable: true, value: class extends EventTarget {} },
  });

  // app.ts bootstraps at import time, so a cache-busted test module is required for an isolated page.
  await import(`../src/app.ts?${options.suffix}`);
  await settleUntil(() => notificationButton.textContent !== "Checking background alerts…");
  await settleUntil(() => FakeEventSource.instances.length === 1);

  return {
    elements: { sessionList, statusBanner, notificationButton, notificationDisclosure, refreshButton },
    fetchPaths,
    permissionRequests,
    subscriptionRequests,
    unsubscribeRequests,
    subscriptionCalls,
    workerMessages,
    replacedPaths: history.replaced,
    window,
    emit(type, payload): void {
      const source = FakeEventSource.instances.at(-1);
      if (source === undefined) throw new Error("missing event source");
      source.emit(type, payload);
    },
    disconnectEvents(): void {
      const source = FakeEventSource.instances.at(-1);
      if (source === undefined) throw new Error("missing event source");
      source.onerror?.();
    },
    expireEventLiveness(): void {
      window.runTimers();
    },
    setList(revision, sessions, status = 200): void {
      listRevision = revision;
      listSessions = [...sessions];
      listStatus = status;
    },
  };
}

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    const descriptor = nativeGlobals[name];
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("dashboard attention and notifications", () => {
  test("renders accessible attention-first cards without prompting or notifying on the initial list", async () => {
    const harness = await bootApp({
      permission: "default",
      suffix: "initial-attention",
      initialSessions: [
        session("ordinary-newest-0003", { startedAt: "2026-07-21T12:00:00.000Z" }),
        session("attention-viewonly-002", {
          startedAt: "2026-07-21T09:00:00.000Z",
          canControl: false,
          inputRequired: true,
        }),
        session("attention-control-0001", { inputRequired: true }),
      ],
    });

    const cards = harness.elements.sessionList.children;
    expect(cards.map(card => card.querySelector("h2")?.textContent)).toEqual([
      "attention-control-0001",
      "attention-viewonly-002",
      "ordinary-newest-0003",
    ]);
    expect(cards[0]?.querySelector(".attention")?.textContent).toBe("Needs attention");
    expect(cards[1]?.querySelector(".attention")?.textContent).toBe(
      "Needs attention — Control unavailable",
    );
    const firstPill = cards[0]?.querySelector(".attention");
    expect(firstPill?.getAttribute("role")).toBeNull();
    expect(firstPill?.getAttribute("aria-live")).toBeNull();
    expect(
      cards[0]?.querySelectorAll("button").map(button => button.getAttribute("aria-describedby")),
    ).toEqual([firstPill?.id ?? null, firstPill?.id ?? null]);
    expect(firstPill?.id).toBe("attention-attention-control-0001");
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.workerMessages).toEqual([{ type: "omp-notification-support-request", version: 1 }]);
    expect(harness.elements.notificationButton.textContent).toBe("Enable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("idle");
    expect(harness.elements.notificationDisclosure.textContent).toBe(
      "Alerts work with the app closed. Tapping one opens current Control after revalidation.",
    );
  });

  test("scrubs stale notification routes and keeps their expired state visible", async () => {
    const harness = await bootApp({
      permission: "denied",
      pathname: "/attention/stale-attention-0001/7",
      suffix: "stale-attention-route",
      initialSessions: [],
    });

    expect(harness.replacedPaths).toEqual(["/"]);
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
    expect(harness.elements.statusBanner.textContent).toBe(
      "That attention request was already resolved or the session changed.",
    );
    harness.emit("snapshot", { type: "snapshot", revision: 2, sessions: [] });
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
  });

  test("clears stale metadata after missed SSE heartbeats and resyncs when transport resumes", async () => {
    const base = session("liveness-session-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "sse-liveness",
      initialSessions: [base],
    });

    expect(harness.elements.sessionList.childElementCount).toBe(1);
    harness.expireEventLiveness();
    expect(harness.elements.sessionList.childElementCount).toBe(0);
    expect(harness.elements.statusBanner.textContent).toBe("Live updates paused. Reconnecting…");

    harness.setList(2, [base]);
    harness.emit("keepalive", {});
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);
    await settleUntil(() => harness.elements.sessionList.childElementCount === 1);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });

  test("creates and removes a persistent push subscription only after explicit user actions", async () => {
    const base = session("transition-session-001", { title: "PROMPT_CONTENT_CANARY" });
    const harness = await bootApp({
      permission: "default",
      permissionResult: "granted",
      suffix: "background-subscription",
      initialSessions: [base],
    });

    expect(harness.subscriptionRequests).toHaveLength(0);
    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Disable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("enabled");
    expect(harness.elements.notificationButton.disabled).toBeFalse();
    expect(harness.permissionRequests.count).toBe(1);
    expect(harness.subscriptionCalls.subscribe).toBe(1);
    expect(harness.subscriptionRequests).toHaveLength(1);
    expect(JSON.stringify(harness.subscriptionRequests)).not.toContain("CONTENT_CANARY");

    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: { ...base, inputRequired: true },
    });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 3,
      session: { ...base, inputRequired: false },
    });
    await Promise.resolve();
    expect(harness.subscriptionRequests).toHaveLength(1);

    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Enable background alerts");
    expect(harness.subscriptionCalls.unsubscribe).toBe(1);
    expect(harness.unsubscribeRequests).toEqual([
      { version: 1, endpoint: "https://push.example.test/send/browser-device" },
    ]);
  });

  test("restores an existing browser subscription without requesting permission again", async () => {
    const base = session("reconnect-session-001");
    const harness = await bootApp({
      permission: "granted",
      existingSubscription: true,
      suffix: "background-subscription-restore",
      initialSessions: [base],
    });

    expect(harness.elements.notificationButton.textContent).toBe("Disable background alerts");
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.subscriptionCalls.subscribe).toBe(0);
    expect(harness.subscriptionRequests).toHaveLength(1);

    harness.disconnectEvents();
    harness.setList(2, [{ ...base, inputRequired: true }]);
    harness.elements.refreshButton.dispatchEvent(new Event("click"));
    await settleUntil(() => !harness.elements.refreshButton.disabled);
    expect(harness.subscriptionRequests).toHaveLength(1);
  });

  test("uses only bounded metadata bodies and fails closed for denied or invalid worker support", async () => {
    const denied = await bootApp({
      permission: "denied",
      suffix: "notifications-denied",
      initialSessions: [session("denied-session-0001")],
    });
    expect(denied.elements.notificationButton.textContent).toBe("Notifications blocked");
    expect(denied.elements.notificationButton.dataset.state).toBe("blocked");
    expect(denied.elements.notificationButton.disabled).toBeTrue();
    expect(denied.elements.notificationDisclosure.textContent).toContain("browser settings");
    denied.elements.notificationButton.dispatchEvent(new Event("click"));
    expect(denied.permissionRequests.count).toBe(0);

    const unavailable = await bootApp({
      permission: "default",
      workerResponse: { type: "omp-notification-support-response", version: 1, extra: true },
      suffix: "notifications-invalid-worker",
      initialSessions: [session("unavailable-session-01")],
    });
    expect(unavailable.elements.notificationButton.textContent).toBe("Background alerts unavailable");
    expect(unavailable.elements.notificationButton.dataset.state).toBe("unavailable");
    expect(unavailable.elements.notificationButton.disabled).toBeTrue();
  });
});
