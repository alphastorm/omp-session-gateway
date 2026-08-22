import { afterAll, describe, expect, test } from "bun:test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import fc, { type AsyncCommand } from "fast-check";

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

// A frozen renderer runs no timers while wall-clock time keeps moving, so the test clock has to
// advance independently of the fake timers.
const nativeNow = Date.now;
let clockOffset = 0;
Date.now = (): number => nativeNow() + clockOffset;

class FakeElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  checked = false;
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  open = false;
  textContent: string | null = "";
  type = "";
  value = "";

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

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
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
  readonly timers = new Map<number, { readonly callback: () => void; readonly delay: number }>();
  scrollY = 0;
  #nextTimer = 1;

  matchMedia(): { matches: boolean; addEventListener(): void } {
    return { matches: false, addEventListener(): void {} };
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void, delay = 0): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, { callback, delay });
    return handle;
  }

  runTimers(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const timer of pending) timer.callback();
  }

  /** Delays of every timer still waiting, so a test can bound a scheduled retry. */
  pendingDelays(): number[] {
    return [...this.timers.values()].map(timer => timer.delay);
  }

  scrollTo(_x: number, y: number): void {
    this.scrollY = y;
  }

  open(url?: string | URL): null {
    this.opened.push(String(url));
    return null;
  }
}

class FakeDocument extends EventTarget {
  readonly documentElement = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  visibilityState: "visible" | "hidden" = "visible";

  constructor(
    readonly bySelector: Record<string, FakeElement>,
    readonly detailInputs: readonly FakeElement[],
  ) {
    super();
  }

  querySelector(selector: string): FakeElement | null {
    return this.bySelector[selector] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'input[name="notification-detail"]' ? [...this.detailInputs] : [];
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  /** Android freeze/resume delivers exactly this, and nothing else the page can observe. */
  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
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
    readonly notificationSettings: FakeElement;
    readonly networkRecoveryHelp: FakeElement;
    readonly notificationDisable: FakeElement;
    readonly notificationDetailInputs: readonly FakeElement[];
    readonly statusBanner: FakeElement;
    readonly directoryTitle: FakeElement;
    readonly directoryCount: FakeElement;
  };
  disconnectEvents(): void;
  expireEventLiveness(): void;
  runTimers(): void;
  pendingDelays(): number[];
  setVisibility(state: "visible" | "hidden"): void;
  advanceClock(milliseconds: number): void;
  hangNextListRequest(): void;
  failNextListRequest(): void;
  setOnline(online: boolean): void;
  activateWorker(): void;
  readonly reloads: { count: number };
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
  const merged = {
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
  if (!merged.inputRequired || merged.ask !== undefined) return merged;
  return {
    ...merged,
    ask: {
      requestId: `request-${instanceId.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}`,
      since: merged.lastSeenAt,
    },
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
  readonly search?: string;
  readonly suffix: string;
}): Promise<BrowserHarness> {
  FakeEventSource.instances.length = 0;
  clockOffset = 0;
  const sessionList = new FakeElement("section");
  const emptyState = new FakeElement("section");
  const statusBanner = new FakeElement("div");
  const notificationButton = new FakeElement("button");
  notificationButton.textContent = "Checking background alerts…";
  notificationButton.disabled = true;
  const notificationDisclosure = new FakeElement("p");
  const notificationSettings = new FakeElement("dialog");
  const networkRecoveryHelp = new FakeElement("dialog");
  const networkRecoveryHelpClose = new FakeElement("button");
  const notificationSettingsClose = new FakeElement("button");
  const notificationDisable = new FakeElement("button");
  const notificationDetailInputs = (["private", "session", "preview"] as const).map(value => {
    const input = new FakeElement("input");
    input.type = "radio";
    input.value = value;
    input.checked = value === "session";
    return input;
  });
  const directoryTitle = new FakeElement("h1");
  directoryTitle.textContent = "Sessions";
  const directoryCount = new FakeElement("p");
  directoryCount.hidden = true;
  const bySelector: Record<string, FakeElement> = {
    "#session-list": sessionList,
    "#empty-state": emptyState,
    "#status-banner": statusBanner,
    "#notify": notificationButton,
    "#notify-note": notificationDisclosure,
    "#directory-title": directoryTitle,
    "#directory-count": directoryCount,
    "#notification-settings": notificationSettings,
    "#notification-settings-close": notificationSettingsClose,
    "#notification-disable": notificationDisable,
    "#network-recovery-help": networkRecoveryHelp,
    "#network-recovery-help-close": networkRecoveryHelpClose,
  };
  const document = new FakeDocument(bySelector, notificationDetailInputs);
  const window = new FakeWindow();
  const reloads = { count: 0 };
  const location = {
    origin: "https://sessions.example",
    pathname: options.pathname ?? "/",
    search: options.search ?? "",
    get href(): string { return `${this.origin}${this.pathname}${this.search}`; },
    reload(): void { reloads.count += 1; },
    replace(path: string): void {
      location.pathname = path;
      location.search = "";
    },
  };
  const history = {
    replaced: [] as string[],
    state: null as unknown,
    replaceState(data: unknown, _unused: string, path: string): void {
      this.replaced.push(path);
      this.state = data;
      location.pathname = path;
      location.search = "";
    },
    pushState(data: unknown, _unused: string, path: string): void {
      this.state = data;
      location.pathname = path;
      location.search = "";
    },
    back(): void {},
  };
  const fetchPaths: string[] = [];
  let listRevision = 1;
  let listSessions = [...options.initialSessions];
  let listStatus = 200;
  const workerMessages: unknown[] = [];
  let hangingListRequests = 0;
  let failedListRequests = 0;
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
          version: 2,
        };
        transfer[0]?.postMessage(response);
      },
    },
    pushManager,
    async showNotification(): Promise<void> {},
  };
  const serviceWorker = new EventTarget() as EventTarget & {
    controller: object | null;
    readonly ready: Promise<typeof registration>;
    register(): Promise<typeof registration>;
  };
  serviceWorker.controller = {};
  Object.defineProperties(serviceWorker, {
    ready: { value: Promise.resolve(registration) },
    register: {
      async value(): Promise<typeof registration> {
        return registration;
      },
    },
  });
  const navigator = { serviceWorker, onLine: true };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    fetchPaths.push(path);
    if (path === "/api/v1/push/config") {
      return Response.json({ version: 2, applicationServerKey: "V".repeat(87) });
    }
    if (path === "/api/v1/push/subscription") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (init.method === "DELETE") {
        unsubscribeRequests.push(body);
        return new Response(null, { status: 204 });
      }
      subscriptionRequests.push(body);
      return Response.json({
        version: 2,
        detailLevel: body.detailLevel ?? "session",
      });
    }
    if (path !== "/api/v1/sessions") throw new Error(`unexpected fetch: ${path}`);
    if (failedListRequests > 0) {
      failedListRequests -= 1;
      throw new TypeError("network request failed");
    }
    if (hangingListRequests > 0) {
      hangingListRequests -= 1;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const abort = (): void => reject(new DOMException("snapshot timed out", "AbortError"));
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
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
    elements: {
      sessionList,
      statusBanner,
      notificationButton,
      notificationDisclosure,
      notificationSettings,
      networkRecoveryHelp,
      notificationDisable,
      notificationDetailInputs,
      directoryTitle,
      directoryCount,
    },
    fetchPaths,
    permissionRequests,
    subscriptionRequests,
    unsubscribeRequests,
    subscriptionCalls,
    workerMessages,
    replacedPaths: history.replaced,
    reloads,
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
    runTimers(): void {
      window.runTimers();
    },
    pendingDelays(): number[] {
      return window.pendingDelays();
    },
    setVisibility(state): void {
      document.setVisibility(state);
    },
    advanceClock(milliseconds): void {
      clockOffset += milliseconds;
    },
    hangNextListRequest(): void {
      hangingListRequests += 1;
    },
    failNextListRequest(): void {
      failedListRequests += 1;
    },
    setOnline(online): void {
      navigator.onLine = online;
    },
    activateWorker(): void {
      serviceWorker.controller = {};
      serviceWorker.dispatchEvent(new Event("controllerchange"));
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
  Date.now = nativeNow;
});

describe("dashboard attention and notifications", () => {
  test("renders the boolean-only triage queue without prompting or notifying on the initial list", async () => {
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

    expect(harness.elements.directoryTitle.textContent).toBe("Needs you");
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting");
    expect(harness.elements.directoryCount.className).toContain("count-pill-waiting");
    const hero = harness.elements.sessionList.querySelector(".queue-hero");
    expect(hero?.querySelector("h2")?.textContent).toBe("attention-control-0001");
    expect(hero?.querySelector(".ask-preview")?.textContent).toBe("Waiting for your input");
    expect(hero?.querySelector(".action-request")?.textContent).toBe("Open request");
    expect(hero?.querySelector(".hero-alt")?.textContent).toBe("View transcript instead");
    const waitingRows = harness.elements.sessionList.querySelectorAll(".queue-row");
    expect(waitingRows.map(row => row.querySelector(".row-title")?.textContent)).toEqual([
      "attention-viewonly-002",
    ]);
    expect(waitingRows[0]?.getAttribute("aria-label")).toBe("View attention-viewonly-002");
    expect(
      harness.elements.sessionList.querySelectorAll(".working-row").map(
        row => row.querySelector(".row-title")?.textContent,
      ),
    ).toEqual(["ordinary-newest-0003"]);
    expect(harness.elements.sessionList.querySelector(".attention")).toBeNull();
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.workerMessages).toEqual([{ type: "omp-notification-support-request", version: 2 }]);
    expect(harness.elements.notificationButton.textContent).toBe("Enable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("idle");
    expect(harness.elements.notificationDisclosure.textContent).toBe(
      "Alerts work with the app closed. Tapping one opens current Control after revalidation.",
    );
    expect(harness.elements.notificationDisclosure.hidden).toBeTrue();
  });

  test("renders the exact all-clear resting state", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "all-clear",
      initialSessions: [
        session("working-session-0001", { startedAt: "2026-07-21T10:00:00.000Z" }),
        session("working-session-0002", { startedAt: "2026-07-21T11:00:00.000Z" }),
      ],
    });

    expect(harness.elements.directoryTitle.textContent).toBe("Sessions");
    expect(harness.elements.directoryCount.textContent).toBe("Live · 2");
    expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("All clear");
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe(
      "Nothing needs you — 2 working. You'll get pinged.",
    );
    expect(
      harness.elements.sessionList
        .querySelectorAll(".working-row")
        .map(row => row.querySelector(".row-title")?.textContent),
    ).toEqual(["working-session-0002", "working-session-0001"]);
  });

  test("scrubs stale notification routes and keeps their expired state visible", async () => {
    const harness = await bootApp({
      permission: "denied",
      pathname: "/collab/stale-attention-0001",
      search: "?request=stale-request-0001",
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

  test("reloads an idle directory after an updated worker activates", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "worker-activation",
      initialSessions: [session("worker-update-0001")],
    });

    harness.activateWorker();
    expect(harness.reloads.count).toBe(0);
    harness.runTimers();
    expect(harness.reloads.count).toBe(1);
  });

  test("closes a silent SSE stream and resyncs without manual refresh", async () => {
    const base = session("liveness-session-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "sse-liveness",
      initialSessions: [base],
    });

    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    harness.expireEventLiveness();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.statusBanner.dataset.kind).toBe("gateway");
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Gateway unavailable",
    );
    expect(FakeEventSource.instances[0]?.closed).toBeTrue();

    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1);
    await settleUntil(() => FakeEventSource.instances.length === 2);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });
  test("recovers through the native event stream when browser timers are lost", async () => {
    const base = session("native-reconnect-0001");
    const recovered = session("native-reconnect-0001", { title: "Recovered natively" });
    const harness = await bootApp({
      permission: "denied",
      suffix: "native-eventsource-reconnect",
      initialSessions: [base],
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing initial event stream");

    harness.disconnectEvents();
    expect(source.closed).toBeFalse();

    source.onopen?.();
    source.emit("snapshot", { type: "snapshot", revision: 2, sessions: [recovered] });
    await settleUntil(() => harness.elements.statusBanner.hidden);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(harness.elements.sessionList.querySelector(".row-title")?.textContent).toBe(
      "Recovered natively",
    );
  });



  test("keeps the last directory while distinguishing phone and tailnet outages", async () => {
    const offlineBase = session("offline-session-0001");
    const offline = await bootApp({
      permission: "denied",
      suffix: "phone-offline",
      initialSessions: [offlineBase],
    });
    offline.setOnline(false);
    offline.window.dispatchEvent(new Event("offline"));
    expect(offline.elements.statusBanner.dataset.kind).toBe("offline");
    expect(offline.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "You're offline",
    );
    expect(offline.elements.statusBanner.querySelector(".status-detail")?.textContent).toContain(
      "Showing the list as of",
    );
    expect(offline.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);

    const tailnetBase = session("tailnet-session-0001");
    const tailnet = await bootApp({
      permission: "denied",
      suffix: "tailnet-offline",
      initialSessions: [tailnetBase],
    });
    tailnet.failNextListRequest();
    tailnet.disconnectEvents();
    tailnet.runTimers();
    await settleUntil(() => tailnet.elements.statusBanner.dataset.kind === "tailnet");
    expect(tailnet.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Tailnet unreachable",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-detail")?.textContent).toBe(
      "Phone is online, but your tailnet isn't answering — Tailscale is off or logged out on this phone.",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-freshness")?.textContent).toContain(
      "Last seen",
    );
    expect(tailnet.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("offers local browser recovery help only after a prolonged visible outage", async () => {
    const base = session("prolonged-outage-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "prolonged-outage",
      initialSessions: [base],
    });

    harness.failNextListRequest();
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();

    harness.setVisibility("hidden");
    harness.advanceClock(45_000);
    harness.failNextListRequest();
    harness.setVisibility("visible");
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();

    harness.advanceClock(45_000);
    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.querySelector(".status-guidance") !== null);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")?.textContent).toContain(
      "Android Chrome may be stuck after a network change",
    );
    const troubleshooting = harness.elements.statusBanner
      .querySelectorAll(".status-action")
      .find(element => element.tagName === "button" && element.textContent === "Troubleshooting");
    troubleshooting?.dispatchEvent(new Event("click"));
    expect(harness.elements.networkRecoveryHelp.open).toBeTrue();

    harness.setList(2, [base]);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.hidden);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
    expect(harness.elements.networkRecoveryHelp.open).toBeFalse();
  });
  test("times out a hung snapshot and keeps retrying automatically", async () => {
    const base = session("snapshot-timeout-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "snapshot-timeout",
      initialSessions: [base],
    });

    harness.hangNextListRequest();
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);

    expect(harness.pendingDelays()).toContain(20_000);
    harness.runTimers();

    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "desktop");
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Desktop unreachable",
    );

    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 3);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });
  test("backs off repeated visible network failures instead of churning connections", async () => {
    const nativeRandom = Math.random;
    Math.random = () => 0.999;
    try {
      const base = session("network-backoff-0001");
      const harness = await bootApp({
        permission: "denied",
        suffix: "network-backoff",
        initialSessions: [base],
      });
      const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
      const retryDelays: number[] = [];

      harness.disconnectEvents();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await settleUntil(() => harness.pendingDelays().some(delay => delay < 45_000));
        retryDelays.push(Math.min(...harness.pendingDelays().filter(delay => delay < 45_000)));
        harness.failNextListRequest();
        harness.runTimers();
        await settleUntil(() => snapshots() === attempt + 2);
      }

      expect(retryDelays).toEqual([999, 1_999, 3_998, 7_996, 15_992]);
    } finally {
      Math.random = nativeRandom;
    }
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
      session: session(base.instanceId, { ...base, inputRequired: true }),
    });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 3,
      session: { ...base, inputRequired: false },
    });
    await Promise.resolve();
    expect(harness.subscriptionRequests).toHaveLength(1);

    expect(harness.elements.notificationSettings.open).toBeTrue();
    harness.elements.notificationDisable.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Enable background alerts");
    expect(harness.subscriptionCalls.unsubscribe).toBe(1);
    expect(harness.unsubscribeRequests).toEqual([
      { version: 2, endpoint: "https://push.example.test/send/browser-device" },
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
    harness.setList(2, [session(base.instanceId, { ...base, inputRequired: true })]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length >= 2);
    expect(harness.subscriptionRequests).toHaveLength(1);
  });


  test("updates notification detail for the existing device subscription", async () => {
    const harness = await bootApp({
      permission: "granted",
      existingSubscription: true,
      suffix: "notification-detail",
      initialSessions: [session("notification-detail-0001")],
    });

    expect(harness.subscriptionRequests).toHaveLength(1);
    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    expect(harness.elements.notificationSettings.open).toBeTrue();
    const preview = harness.elements.notificationDetailInputs.find(input => input.value === "preview");
    expect(preview).toBeDefined();
    if (preview === undefined) throw new Error("missing preview detail input");
    for (const input of harness.elements.notificationDetailInputs) input.checked = input === preview;
    preview.dispatchEvent(new Event("change"));
    await settleUntil(() => harness.subscriptionRequests.length === 2);
    expect(harness.subscriptionRequests[1]).toMatchObject({
      version: 2,
      detailLevel: "preview",
    });
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
      workerResponse: { type: "omp-notification-support-response", version: 2, extra: true },
      suffix: "notifications-invalid-worker",
      initialSessions: [session("unavailable-session-01")],
    });
    expect(unavailable.elements.notificationButton.textContent).toBe("Background alerts unavailable");
    expect(unavailable.elements.notificationButton.dataset.state).toBe("unavailable");
    expect(unavailable.elements.notificationButton.disabled).toBeTrue();
  });

  test("rebuilds a frozen directory connection on resume instead of trusting the old one", async () => {
    const base = session("resume-session-00001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "frozen-resume",
      initialSessions: [base],
    });
    const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(snapshots()).toBe(1);
    const frozen = FakeEventSource.instances[0];

    // #65's reproduction recipe: display off freezes the renderer, so no timer runs and the liveness
    // watchdog never fires, while wall-clock time passes and the stream silently dies. The
    // EventSource still reports open because nothing in the page ran to notice otherwise.
    harness.setVisibility("hidden");
    harness.advanceClock(45_000);
    harness.setList(2, [base]);
    harness.setVisibility("visible");

    // No timer is flushed anywhere below: resume alone has to produce the fresh connection.
    expect(frozen?.closed).toBeTrue();
    await settleUntil(() => FakeEventSource.instances.length === 2);
    await settleUntil(() => snapshots() === 2);
    expect(FakeEventSource.instances[1]?.closed).toBeFalse();
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("keeps a bounded retry pending when the phone reports offline and no online event follows", async () => {
    const base = session("offline-retry-000001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "offline-retry",
      initialSessions: [base],
    });
    const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;

    expect(snapshots()).toBe(1);
    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "You're offline",
    );

    // The offline state must carry its own way out: #65 measured `navigator.onLine` reporting true
    // through a total outage, so an `online` event is not a wake-up the page can count on. One
    // retry is pending, and it is scheduled inside the backoff ceiling.
    expect(harness.pendingDelays()).toHaveLength(1);
    expect(harness.pendingDelays()[0]).toBeLessThanOrEqual(4_000);

    harness.setOnline(true);
    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => snapshots() === 2);
    await settleUntil(() => FakeEventSource.instances.length === 2);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("does not count offline time toward browser recovery guidance", async () => {
    const base = session("offline-guidance-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "offline-guidance",
      initialSessions: [base],
    });

    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    harness.advanceClock(60_000);
    harness.setOnline(true);
    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
  });
});

interface RecoveryModel {
  revision: number;
  title: string;
  interrupted: boolean;
  online: boolean;
}

interface RecoveryReal {
  readonly harness: BrowserHarness;
  readonly instanceId: string;
  readonly capabilityCanary: string;
}

type RecoveryCommand = AsyncCommand<RecoveryModel, RecoveryReal>;

function activeModelStreams(): FakeEventSource[] {
  return FakeEventSource.instances.filter(source => !source.closed);
}

async function assertRecoveryInvariants(model: RecoveryModel, real: RecoveryReal): Promise<void> {
  await Promise.resolve();
  expect(activeModelStreams()).toHaveLength(1);

  const retryDelays = real.harness.pendingDelays().filter(delay => delay <= 30_000);
  expect(retryDelays.length).toBeLessThanOrEqual(1);
  expect(retryDelays.every(delay => delay >= 0 && delay <= 30_000)).toBeTrue();
  expect(real.harness.reloads.count).toBe(0);

  const observableSinks = JSON.stringify({
    fetchPaths: real.harness.fetchPaths,
    opened: real.harness.window.opened,
    replacedPaths: real.harness.replacedPaths,
    rowTitle: real.harness.elements.sessionList.querySelector(".row-title")?.textContent,
    status: real.harness.elements.statusBanner.textContent,
    workerMessages: real.harness.workerMessages,
  });
  expect(observableSinks).not.toContain(real.capabilityCanary);

  if (!model.interrupted) {
    expect(real.harness.elements.statusBanner.hidden).toBeTrue();
    expect(real.harness.elements.sessionList.querySelector(".row-title")?.textContent).toBe(
      model.title,
    );
  }
}

class InterruptStreamCommand implements RecoveryCommand {
  constructor(private readonly reportedOnline: boolean) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.setOnline(this.reportedOnline);
    real.harness.disconnectEvents();
    model.interrupted = true;
    model.online = this.reportedOnline;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `SSE error (navigator.onLine=${String(this.reportedOnline)}, no online event)`;
  }
}

class RepeatStreamFailureCommand implements RecoveryCommand {
  constructor(private readonly repetitions: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing interrupted native stream");
    for (let index = 0; index < this.repetitions; index += 1) source.onerror?.();
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `repeat SSE error x${String(this.repetitions)}`;
  }
}

class LoseTimersCommand implements RecoveryCommand {
  constructor(private readonly elapsedMs: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.advanceClock(this.elapsedMs);
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `freeze timers for ${String(this.elapsedMs)}ms`;
  }
}

class SetReportedOnlineWithoutEventCommand implements RecoveryCommand {
  constructor(private readonly online: boolean) {}

  check(): boolean {
    return true;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.setOnline(this.online);
    model.online = this.online;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `set navigator.onLine=${String(this.online)} without event`;
  }
}

class NativeReopenCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing native stream to reopen");
    const revision = model.revision + 1;
    const title = `native-reopen-${String(this.titleId)}-r${String(revision)}`;
    source.onopen?.();
    source.emit("snapshot", {
      type: "snapshot",
      revision,
      sessions: [session(real.instanceId, { title })],
    });
    await settleUntil(() => real.harness.elements.statusBanner.hidden);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `native SSE reopen ${String(this.titleId)}`;
  }
}

class SnapshotFallbackCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `snapshot-fallback-${String(this.titleId)}-r${String(revision)}`;
    const fetchesBefore = real.harness.fetchPaths.length;
    real.harness.setList(revision, [session(real.instanceId, { title })]);
    real.harness.runTimers();
    await settleUntil(() => real.harness.fetchPaths.length > fetchesBefore);
    await settleUntil(() => activeModelStreams().length === 1);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `snapshot retry ${String(this.titleId)}`;
  }
}

class HideResumeCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `resume-${String(this.titleId)}-r${String(revision)}`;
    const fetchesBefore = real.harness.fetchPaths.length;
    real.harness.setList(revision, [session(real.instanceId, { title })]);
    real.harness.setVisibility("hidden");
    real.harness.advanceClock(45_000);
    real.harness.setVisibility("visible");
    await settleUntil(() => real.harness.fetchPaths.length > fetchesBefore);
    await settleUntil(() => activeModelStreams().length === 1);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `hide/resume ${String(this.titleId)}`;
  }
}

class FreshStreamSnapshotCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `fresh-stream-${String(this.titleId)}-r${String(revision)}`;
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing live stream");
    source.emit("snapshot", {
      type: "snapshot",
      revision,
      sessions: [session(real.instanceId, { title })],
    });
    model.revision = revision;
    model.title = title;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `fresh stream snapshot ${String(this.titleId)}`;
  }
}

class StaleStreamSnapshotCommand implements RecoveryCommand {
  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing live stream");
    source.emit("snapshot", {
      type: "snapshot",
      revision: Math.max(0, model.revision - 1),
      sessions: [session(real.instanceId, { title: "stale-snapshot-must-not-win" })],
    });
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return "stale stream snapshot";
  }
}

describe("stateful directory recovery model", () => {
  test("preserves recovery invariants across generated browser lifecycle sequences", async () => {
    let modelRun = 0;
    const setup = async (): Promise<{ model: RecoveryModel; real: RecoveryReal }> => {
      modelRun += 1;
      const instanceId = `recovery-model-${String(modelRun).padStart(4, "0")}`;
      const title = "model-initial-r1";
      const harness = await bootApp({
        permission: "denied",
        suffix: `recovery-model-${String(modelRun)}`,
        initialSessions: [session(instanceId, { title })],
      });
      const model = { revision: 1, title, interrupted: false, online: true };
      const real = {
        harness,
        instanceId,
        capabilityCanary: "MODEL_CAPABILITY_CANARY_8f6b10c2",
      };
      await assertRecoveryInvariants(model, real);
      return { model, real };
    };

    await fc.asyncModelRun(setup, [
      new InterruptStreamCommand(false),
      new LoseTimersCommand(120_000),
      new SetReportedOnlineWithoutEventCommand(true),
      new NativeReopenCommand(1),
      new FreshStreamSnapshotCommand(2),
      new StaleStreamSnapshotCommand(),
    ]);

    await fc.asyncModelRun(setup, [
      new InterruptStreamCommand(true),
      new RepeatStreamFailureCommand(4),
      new HideResumeCommand(3),
      new InterruptStreamCommand(true),
      new RepeatStreamFailureCommand(2),
      new SnapshotFallbackCommand(4),
    ]);

    const commandArbitraries: fc.Arbitrary<RecoveryCommand>[] = [
      fc.boolean().map(online => new InterruptStreamCommand(online)),
      fc.integer({ min: 1, max: 5 }).map(count => new RepeatStreamFailureCommand(count)),
      fc.integer({ min: 1_000, max: 180_000 }).map(elapsed => new LoseTimersCommand(elapsed)),
      fc.boolean().map(online => new SetReportedOnlineWithoutEventCommand(online)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new NativeReopenCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new SnapshotFallbackCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new HideResumeCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new FreshStreamSnapshotCommand(id)),
      fc.constant(new StaleStreamSnapshotCommand()),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbitraries, { maxCommands: 30 }), async commands => {
        await fc.asyncModelRun(setup, commands);
      }),
      { numRuns: 50 },
    );
  });
});
