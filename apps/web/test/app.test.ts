import { afterAll, describe, expect, test } from "bun:test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";

const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "navigator",
  "Notification",
  "MessageChannel",
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
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "snapshot" | "session_upsert" | "session_remove", payload: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, "data", { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }
}

interface NotificationCall {
  readonly title: string;
  readonly options: NotificationOptions;
}

interface BrowserHarness {
  readonly elements: {
    readonly sessionList: FakeElement;
    readonly notificationButton: FakeElement;
    readonly notificationDisclosure: FakeElement;
    readonly refreshButton: FakeElement;
  };
  disconnectEvents(): void;
  readonly fetchPaths: string[];
  readonly notificationCalls: NotificationCall[];
  readonly permissionRequests: { count: number };
  readonly workerMessages: unknown[];
  readonly window: FakeWindow;
  emit(type: "snapshot" | "session_upsert" | "session_remove", payload: unknown): void;
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
  readonly suffix: string;
}): Promise<BrowserHarness> {
  FakeEventSource.instances.length = 0;
  const sessionList = new FakeElement("section");
  const emptyState = new FakeElement("section");
  const statusBanner = new FakeElement("div");
  const refreshButton = new FakeElement("button");
  refreshButton.textContent = "Refresh";
  const notificationButton = new FakeElement("button");
  notificationButton.textContent = "Checking notifications…";
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
  const location = { origin: "https://sessions.example" };
  const fetchPaths: string[] = [];
  let listRevision = 1;
  let listSessions = [...options.initialSessions];
  let listStatus = 200;
  const notificationCalls: NotificationCall[] = [];
  const workerMessages: unknown[] = [];
  const permissionRequests = { count: 0 };
  const notificationApi = {
    permission: options.permission,
    async requestPermission(): Promise<NotificationPermission> {
      permissionRequests.count += 1;
      this.permission = options.permissionResult ?? "granted";
      return this.permission;
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
    async showNotification(title: string, notificationOptions: NotificationOptions = {}): Promise<void> {
      notificationCalls.push({ title, options: notificationOptions });
    },
  };
  const navigator = {
    serviceWorker: {
      async register(): Promise<typeof registration> {
        return registration;
      },
    },
  };
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    fetchPaths.push(path);
    if (path !== "/api/v1/sessions") throw new Error(`unexpected fetch: ${path}`);
    if (listStatus !== 200) return new Response("", { status: listStatus });
    return Response.json({ revision: listRevision, sessions: listSessions });
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    location: { configurable: true, value: location },
    navigator: { configurable: true, value: navigator },
    Notification: { configurable: true, value: notificationApi },
    MessageChannel: { configurable: true, value: FakeMessageChannel },
    EventSource: { configurable: true, value: FakeEventSource },
    fetch: { configurable: true, value: fetch },
    isSecureContext: { configurable: true, value: true },
    HTMLElement: { configurable: true, value: class extends EventTarget {} },
  });

  // app.ts bootstraps at import time, so a cache-busted test module is required for an isolated page.
  await import(`../src/app.ts?${options.suffix}`);
  await settleUntil(() => notificationButton.textContent !== "Checking notifications…");
  await settleUntil(() => FakeEventSource.instances.length === 1);

  return {
    elements: { sessionList, notificationButton, notificationDisclosure, refreshButton },
    fetchPaths,
    notificationCalls,
    permissionRequests,
    workerMessages,
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
    expect(harness.notificationCalls).toEqual([]);
    expect(harness.workerMessages).toEqual([{ type: "omp-notification-support-request", version: 1 }]);
    expect(harness.elements.notificationButton.textContent).toBe("Enable notifications");
    expect(harness.elements.notificationButton.dataset.state).toBe("idle");
    expect(harness.elements.notificationDisclosure.textContent).toBe(
      "Notifications may show session names on your lock screen.",
    );
  });

  test("notifies only on accepted same-generation false-to-true transitions after explicit grant", async () => {
    const base = session("transition-session-001", { title: "Safe title" });
    const harness = await bootApp({
      permission: "default",
      permissionResult: "granted",
      suffix: "notification-transitions",
      initialSessions: [base],
    });

    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    expect(harness.elements.notificationButton.dataset.state).toBe("enabling");
    await settleUntil(() => harness.elements.notificationButton.textContent === "Notifications enabled");
    expect(harness.elements.notificationButton.dataset.state).toBe("enabled");
    expect(harness.permissionRequests.count).toBe(1);

    harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: { ...base, inputRequired: true } });
    await settleUntil(() => harness.notificationCalls.length === 1);
    harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: { ...base, inputRequired: true } });
    harness.emit("session_upsert", { type: "session_upsert", revision: 1, session: { ...base, inputRequired: false } });
    expect(harness.notificationCalls).toEqual([
      { title: "OMP session needs attention", options: { body: "Safe title" } },
    ]);

    harness.emit("session_upsert", { type: "session_upsert", revision: 4, session: base });
    harness.emit("session_remove", {
      type: "session_remove",
      revision: 5,
      instanceId: base.instanceId,
      generation: base.generation,
    });
    harness.emit("session_upsert", { type: "session_upsert", revision: 6, session: { ...base, inputRequired: true } });
    await settleUntil(() => harness.notificationCalls.length === 2);

    const replacement = { ...base, generation: 2, inputRequired: true };
    harness.emit("session_upsert", { type: "session_upsert", revision: 7, session: replacement });
    expect(harness.notificationCalls).toHaveLength(2);
    harness.emit("session_upsert", { type: "session_upsert", revision: 8, session: { ...replacement, inputRequired: false } });
    harness.emit("session_upsert", { type: "session_upsert", revision: 9, session: replacement });
    await settleUntil(() => harness.notificationCalls.length === 3);
    expect(harness.fetchPaths).toEqual(["/api/v1/sessions"]);

    const { title: _cwdTitle, ...cwdOnly } = session("cwd-only-session-001", { cwdLabel: "Safe project" });
    harness.emit("session_upsert", { type: "session_upsert", revision: 10, session: cwdOnly });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 11,
      session: { ...cwdOnly, inputRequired: true },
    });
    await settleUntil(() => harness.notificationCalls.length === 4);
    const { title: _unlabeledTitle, cwdLabel: _unlabeledCwd, ...unlabeled } = session("unlabeled-session-01");
    harness.emit("session_upsert", { type: "session_upsert", revision: 12, session: unlabeled });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 13,
      session: { ...unlabeled, inputRequired: true },
    });
    await settleUntil(() => harness.notificationCalls.length === 5);
    expect(harness.notificationCalls.slice(-2)).toEqual([
      { title: "OMP session needs attention", options: { body: "Safe project" } },
      { title: "OMP session needs attention", options: {} },
    ]);
    expect(harness.window.opened).toEqual([]);
  });

  test("preserves reconnect transitions but clears notification history after authorization failure", async () => {
    const base = session("reconnect-session-001");
    const harness = await bootApp({
      permission: "granted",
      suffix: "notification-reconnect",
      initialSessions: [base],
    });

    harness.disconnectEvents();
    harness.setList(2, [{ ...base, inputRequired: true }]);
    harness.elements.refreshButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.notificationCalls.length === 1);
    await settleUntil(() => !harness.elements.refreshButton.disabled);

    harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: base });
    harness.setList(4, [], 403);
    harness.elements.refreshButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.fetchPaths.length === 3 && !harness.elements.refreshButton.disabled);

    harness.setList(5, [{ ...base, inputRequired: true }]);
    harness.elements.refreshButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.fetchPaths.length === 4 && !harness.elements.refreshButton.disabled);
    expect(harness.notificationCalls).toHaveLength(1);
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
    expect(unavailable.elements.notificationButton.textContent).toBe("Notifications unavailable");
    expect(unavailable.elements.notificationButton.dataset.state).toBe("unavailable");
    expect(unavailable.elements.notificationButton.disabled).toBeTrue();
    expect(unavailable.notificationCalls).toEqual([]);
  });
});
