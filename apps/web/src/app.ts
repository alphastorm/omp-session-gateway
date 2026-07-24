import {
  PUSH_API_VERSION,
  parseLaunchResponse,
  parsePushConfigResponse,
  parsePushSubscriptionRequest,
  parseSessionEvent,
  parseSessionListResponse,
  type LaunchMode,
  type SessionEvent,
  type SessionMetadata,
} from "@omp-session-gateway/protocol";
type StartCollabWithCapability = (
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
) => () => void;

interface CollabClientModule {
  startCollabWithCapability: StartCollabWithCapability;
}

declare const __COLLAB_CLIENT_MODULE__: string;
declare const __COLLAB_CLIENT_STYLESHEET__: string;

function importCollabClient(moduleUrl: string): Promise<CollabClientModule> {
  return import(moduleUrl) as Promise<CollabClientModule>;
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error("application shell is incomplete");
  return element;
}

const sessionList = requiredElement<HTMLElement>("#session-list");
const emptyState = requiredElement<HTMLElement>("#empty-state");
const statusBanner = requiredElement<HTMLElement>("#status-banner");
const refreshButton = requiredElement<HTMLButtonElement>("#refresh");
const notificationButton = requiredElement<HTMLButtonElement>("#notify");
const notificationDisclosure = requiredElement<HTMLElement>("#notify-note");

const EVENT_LIVENESS_TIMEOUT_MS = 35_000;

const sessions = new Map<string, SessionMetadata>();
let events: EventSource | undefined;
let directoryLoaded = false;
let authorizationDenied = false;
let refreshRequests = 0;
let directoryEpoch = 0;
let directoryRevision = -1;
let snapshotController: AbortController | undefined;
let eventLivenessTimeout: number | undefined;
let eventStreamStale = false;
let notificationRegistration: ServiceWorkerRegistration | undefined;
let applicationServerKey: string | undefined;


type NotificationControlState =
  | "checking"
  | "idle"
  | "enabling"
  | "disabling"
  | "enabled"
  | "blocked"
  | "unavailable";

interface PendingAttentionLaunch {
  readonly instanceId: string;
  readonly generation: number;
}

const notificationLabels: Readonly<Record<NotificationControlState, string>> = {
  checking: "Checking background alerts…",
  idle: "Enable background alerts",
  enabling: "Enabling…",
  disabling: "Disabling…",
  enabled: "Disable background alerts",
  blocked: "Notifications blocked",
  unavailable: "Background alerts unavailable",
};

function setNotificationControl(state: NotificationControlState): void {
  notificationButton.dataset.state = state;
  notificationButton.textContent = notificationLabels[state];
  notificationButton.disabled =
    state === "checking" ||
    state === "enabling" ||
    state === "disabling" ||
    state === "blocked" ||
    state === "unavailable";
  notificationDisclosure.textContent =
    state === "blocked"
      ? "Notifications are blocked. Enable them in this site's browser settings."
      : "Alerts work with the app closed. Tapping one opens current Control after revalidation.";
}

function isNotificationSupportResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-response" &&
    record.version === 1
  );
}

async function checkNotificationWorker(registration: ServiceWorkerRegistration): Promise<boolean> {
  const active = registration.active;
  if (active === null) return false;
  const channel = new MessageChannel();
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (supported: boolean): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    channel.port1.close();
    try {
      channel.port2.close();
    } catch {
      // The worker may already own the transferred port.
    }
    resolve(supported);
  };
  const timeout = window.setTimeout(() => finish(false), 2_000);
  channel.port1.onmessage = event => finish(isNotificationSupportResponse(event.data));
  channel.port1.start();
  try {
    active.postMessage({ type: "omp-notification-support-request", version: 1 }, [channel.port2]);
  } catch {
    finish(false);
  }
  return promise;
}

async function savePushSubscription(subscription: PushSubscription): Promise<void> {
  const request = parsePushSubscriptionRequest({
    version: PUSH_API_VERSION,
    subscription: subscription.toJSON(),
  });
  const response = await fetch("/api/v1/push/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("push subscription was rejected");
}

async function initializeNotifications(): Promise<void> {
  setNotificationControl("checking");
  if (
    !isSecureContext ||
    typeof Notification === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof PushManager === "undefined"
  ) {
    setNotificationControl("unavailable");
    return;
  }
  try {
    const [registered, configResponse] = await Promise.all([
      navigator.serviceWorker.register("/service-worker.js", { scope: "/" }),
      fetch("/api/v1/push/config", { cache: "no-store", credentials: "same-origin" }),
    ]);
    const registration = registered.active === null ? await navigator.serviceWorker.ready : registered;
    if (
      !configResponse.ok ||
      typeof registration.showNotification !== "function" ||
      !(await checkNotificationWorker(registration))
    ) {
      setNotificationControl("unavailable");
      return;
    }
    const config = parsePushConfigResponse(await configResponse.json());
    notificationRegistration = registration;
    applicationServerKey = config.applicationServerKey;
    if (Notification.permission === "denied") {
      setNotificationControl("blocked");
      return;
    }
    const existing = await registration.pushManager.getSubscription();
    if (existing === null) {
      setNotificationControl("idle");
      return;
    }
    await savePushSubscription(existing);
    setNotificationControl("enabled");
  } catch {
    setNotificationControl("unavailable");
  }
}

async function toggleBackgroundNotifications(): Promise<void> {
  const registration = notificationRegistration;
  const publicKey = applicationServerKey;
  if (registration === undefined || publicKey === undefined) return;
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null) {
    setNotificationControl("disabling");
    const endpoint = existing.endpoint;
    try {
      await existing.unsubscribe();
      await fetch("/api/v1/push/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: PUSH_API_VERSION, endpoint }),
        cache: "no-store",
        credentials: "same-origin",
      });
      setNotificationControl("idle");
    } catch {
      setNotificationControl("unavailable");
    }
    return;
  }

  setNotificationControl("enabling");
  try {
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      setNotificationControl(permission === "denied" ? "blocked" : "idle");
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    try {
      await savePushSubscription(subscription);
    } catch (error) {
      await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    setNotificationControl("enabled");
  } catch {
    setNotificationControl(Notification.permission === "denied" ? "blocked" : "unavailable");
  }
}

function readPendingAttentionLaunch(): PendingAttentionLaunch | undefined {
  const match = /^\/attention\/([^/]{1,384})\/([1-9]\d*)$/u.exec(location.pathname);
  if (match === null) return undefined;
  history.replaceState(null, "", "/");
  const encodedInstanceId = match[1];
  const generationText = match[2];
  if (encodedInstanceId === undefined || generationText === undefined) return undefined;
  let instanceId: string;
  try {
    instanceId = decodeURIComponent(encodedInstanceId);
  } catch {
    return undefined;
  }
  const generation = Number(generationText);
  if (
    !/^[A-Za-z0-9._:-]{16,128}$/u.test(instanceId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return undefined;
  }
  return { instanceId, generation };
}

const pendingAttentionLaunch = readPendingAttentionLaunch();
let attentionRouteStatusLocked = pendingAttentionLaunch !== undefined;

function setStatus(kind: "ready" | "offline" | "unauthorized" | "expired" | "loading", message: string): void {
  statusBanner.dataset.kind = kind;
  statusBanner.textContent = message;
  statusBanner.hidden = kind === "ready";
}

function clearEventLiveness(): void {
  if (eventLivenessTimeout === undefined) return;
  window.clearTimeout(eventLivenessTimeout);
  eventLivenessTimeout = undefined;
}

function showTransportFailure(message: string): void {
  directoryRevision = -1;
  directoryLoaded = false;
  sessions.clear();
  render();
  setStatus("offline", message);
}

function armEventLiveness(source: EventSource, epoch: number): void {
  clearEventLiveness();
  eventLivenessTimeout = window.setTimeout(() => {
    eventLivenessTimeout = undefined;
    if (events !== source || epoch !== directoryEpoch) return;
    eventStreamStale = true;
    showTransportFailure("Live updates paused. Reconnecting…");
  }, EVENT_LIVENESS_TIMEOUT_MS);
}

function formatStartedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Started recently" : `Started ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function updateRefreshState(): void {
  const busy = refreshRequests > 0;
  refreshButton.disabled = busy;
  refreshButton.toggleAttribute("aria-busy", busy);
  refreshButton.textContent = busy ? "Refreshing…" : "Refresh";
}

function createMetadataLine(label: string, value: string | undefined): HTMLElement | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const line = document.createElement("p");
  line.className = "session-meta";
  const term = document.createElement("span");
  term.className = "session-meta-label";
  term.textContent = `${label} `;
  const content = document.createElement("span");
  content.textContent = value;
  line.append(term, content);
  return line;
}

function render(): void {
  sessionList.replaceChildren();
  const ordered = [...sessions.values()].sort((left, right) => {
    if (left.inputRequired !== right.inputRequired) return left.inputRequired ? -1 : 1;
    const started = right.startedAt.localeCompare(left.startedAt);
    return started === 0 ? left.instanceId.localeCompare(right.instanceId) : started;
  });
  emptyState.hidden = !directoryLoaded || ordered.length !== 0;
  for (const session of ordered) {
    const article = document.createElement("article");
    article.className = "session-card";
    article.dataset.instanceId = session.instanceId;

    const heading = document.createElement("h2");
    heading.textContent = session.title || session.cwdLabel || "OMP session";
    const sessionLabel = heading.textContent;
    const project = createMetadataLine("Project", session.cwdLabel);
    const model = createMetadataLine("Model", session.model);
    const timing = createMetadataLine("", formatStartedAt(session.startedAt));
    const attention = session.inputRequired ? document.createElement("p") : undefined;
    const attentionId = `attention-${session.instanceId}`;
    if (attention !== undefined) {
      attention.id = attentionId;
      attention.className = "attention";
      attention.textContent = session.canControl
        ? "Needs attention"
        : "Needs attention — Control unavailable";
    }

    const actions = document.createElement("div");
    actions.className = "session-actions";
    const view = document.createElement("button");
    view.type = "button";
    view.className = "action action-primary";
    view.textContent = "View";
    view.setAttribute("aria-label", `View ${sessionLabel}`);
    view.disabled = !session.canView;
    if (attention !== undefined) view.setAttribute("aria-describedby", attentionId);
    view.addEventListener("click", () => void launch(session, "view", view));
    actions.append(view);

    if (session.canControl) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = "action action-control";
      control.textContent = "Control";
      control.setAttribute("aria-label", `Control ${sessionLabel}`);
      if (attention !== undefined) control.setAttribute("aria-describedby", attentionId);
      control.addEventListener("click", () => void launch(session, "control", control));
      actions.append(control);
    }

    actions.dataset.count = String(actions.childElementCount);
    article.append(heading);
    if (project !== undefined) article.append(project);
    if (model !== undefined) article.append(model);
    if (timing !== undefined) article.append(timing);
    if (attention !== undefined) article.append(attention);
    article.append(actions);
    sessionList.append(article);
  }
}

async function loadCollabStylesheet(): Promise<HTMLLinkElement> {
  const existing = document.querySelector<HTMLLinkElement>("link[data-omp-collab-styles]");
  if (existing !== null) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = __COLLAB_CLIENT_STYLESHEET__;
  link.dataset.ompCollabStyles = "true";
  const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => reject(new Error("collaboration client stylesheet failed to load")), {
      once: true,
    });
  });
  document.head.append(link);
  return await loaded;
}

function enterCollabClient(capability: string, startCollabWithCapability: StartCollabWithCapability): void {
  const container = document.createElement("div");
  container.id = "root";
  container.setAttribute("role", "application");
  container.setAttribute("aria-label", "OMP collaboration session");
  events?.close();
  events = undefined;
  snapshotController?.abort();
  snapshotController = undefined;
  history.pushState(null, "", "/client/");
  document.body.replaceChildren(container);
  document.title = "OMP collaboration";

  let dispose = (): void => undefined;
  const removeLifecycleListeners = (): void => {
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("popstate", handlePopState);
  };
  const handlePageHide = (): void => {
    dispose();
    removeLifecycleListeners();
  };
  const handlePopState = (): void => {
    dispose();
    removeLifecycleListeners();
    location.reload();
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("popstate", handlePopState);
  try {
    dispose = startCollabWithCapability(container, capability, removeLifecycleListeners);
  } catch (error) {
    removeLifecycleListeners();
    location.replace("/");
    throw error;
  }
}

async function launch(session: SessionMetadata, mode: LaunchMode, button?: HTMLButtonElement): Promise<void> {
  const idleLabel = button?.textContent ?? (mode === "view" ? "View" : "Control");
  if (button !== undefined) {
    button.disabled = true;
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    button.textContent = mode === "view" ? "Opening view…" : "Opening control…";
  } else {
    setStatus("loading", mode === "view" ? "Opening view…" : "Opening control…");
  }
  const resetButton = (): void => {
    if (button === undefined) return;
    button.disabled = mode === "view" && !session.canView;
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    button.textContent = idleLabel;
  };
  let stylesheet: HTMLLinkElement | undefined;
  let startCollabWithCapability: StartCollabWithCapability;
  const fail = (kind: "offline" | "unauthorized" | "expired", message: string): void => {
    stylesheet?.remove();
    resetButton();
    setStatus(kind, message);
  };

  try {
    const [loadedStylesheet, collabClient] = await Promise.all([
      loadCollabStylesheet(),
      importCollabClient(__COLLAB_CLIENT_MODULE__),
    ]);
    stylesheet = loadedStylesheet;
    startCollabWithCapability = collabClient.startCollabWithCapability;
  } catch {
    fail("offline", "The collaboration client did not start. Try again.");
    return;
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, generation: session.generation }),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    fail("offline", "Gateway unavailable. Check your tailnet connection and try again.");
    return;
  }

  if (!response.ok) {
    if (response.status === 403) {
      authorizationDenied = true;
      fail("unauthorized", "This tailnet identity is not authorized.");
    } else if (response.status === 404 || response.status === 409) {
      fail("expired", "That session changed or expired. Refreshing the list…");
      if (await refreshAndConnect()) setStatus("expired", "That session changed or expired. The list has been refreshed.");
    } else {
      fail("offline", "The session could not be opened. Try again.");
    }
    return;
  }

  let capability: string | undefined;
  try {
    const payload = parseLaunchResponse(await response.json());
    if (payload.mode !== mode || payload.generation !== session.generation) {
      throw new Error("invalid launch response");
    }
    capability = payload.capability;
    enterCollabClient(capability, startCollabWithCapability);
    capability = undefined;
  } catch {
    capability = undefined;
    fail("offline", "The gateway returned an invalid launch response.");
  }
}

function applyEvent(event: SessionEvent, epoch: number): boolean {
  if (epoch !== directoryEpoch || event.revision < directoryRevision) return false;
  directoryRevision = event.revision;
  authorizationDenied = false;
  directoryLoaded = true;
  if (event.type === "snapshot") {
    sessions.clear();
    for (const session of event.sessions) sessions.set(session.instanceId, session);
  } else if (event.type === "session_upsert") {
    sessions.set(event.session.instanceId, event.session);
  } else {
    const current = sessions.get(event.instanceId);
    if (current?.generation === event.generation) sessions.delete(event.instanceId);
  }
  render();
  return true;
}

async function loadSnapshot(epoch: number): Promise<boolean> {
  const controller = new AbortController();
  snapshotController = controller;
  refreshRequests += 1;
  updateRefreshState();
  setStatus("loading", "Refreshing sessions…");
  try {
    const response = await fetch("/api/v1/sessions", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (epoch !== directoryEpoch) return false;
    if (response.status === 403) {
      authorizationDenied = true;
      directoryLoaded = false;
      sessions.clear();
      render();
      setStatus("unauthorized", "This tailnet identity is not authorized.");
      return false;
    }
    if (!response.ok) throw new Error("snapshot failed");
    const payload = parseSessionListResponse(await response.json());
    if (epoch !== directoryEpoch || payload.revision < directoryRevision) return false;
    directoryRevision = payload.revision;
    authorizationDenied = false;
    directoryLoaded = true;
    sessions.clear();
    for (const session of payload.sessions) sessions.set(session.instanceId, session);
    render();
    setStatus("ready", "");
    return true;
  } catch {
    if (controller.signal.aborted || epoch !== directoryEpoch) return false;
    authorizationDenied = false;
    directoryLoaded = false;
    sessions.clear();
    render();
    setStatus("offline", "Gateway unavailable. Check your tailnet connection.");
    return false;
  } finally {
    if (snapshotController === controller) snapshotController = undefined;
    refreshRequests = Math.max(0, refreshRequests - 1);
    updateRefreshState();
  }
}

function connectEvents(epoch: number): void {
  if (authorizationDenied || epoch !== directoryEpoch) return;
  const source = new EventSource("/api/v1/events", { withCredentials: true });
  events = source;
  let opened = false;
  source.onopen = () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (opened) directoryRevision = -1;
    opened = true;
    eventStreamStale = false;
    armEventLiveness(source, epoch);
  };
  for (const type of ["snapshot", "session_upsert", "session_remove"] as const) {
    source.addEventListener(type, event => {
      if (events !== source || epoch !== directoryEpoch) return;
      if (eventStreamStale) {
        void refreshAndConnect();
        return;
      }
      armEventLiveness(source, epoch);
      try {
        if (applyEvent(parseSessionEvent(JSON.parse(event.data)), epoch) && !attentionRouteStatusLocked) {
          setStatus("ready", "");
        }
      } catch {
        source.close();
        if (events === source) events = undefined;
        void refreshAndConnect();
      }
    });
  }
  source.addEventListener("keepalive", () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (eventStreamStale) {
      void refreshAndConnect();
      return;
    }
    armEventLiveness(source, epoch);
  });
  source.onerror = () => {
    if (events !== source || epoch !== directoryEpoch) return;
    clearEventLiveness();
    eventStreamStale = true;
    if (authorizationDenied) {
      showTransportFailure("This tailnet identity is not authorized.");
      setStatus("unauthorized", "This tailnet identity is not authorized.");
    } else {
      showTransportFailure("Live updates paused. Reconnecting…");
    }
  };
}

async function refreshAndConnect(): Promise<boolean> {
  const epoch = directoryEpoch + 1;
  directoryEpoch = epoch;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  eventStreamStale = false;
  const loaded = await loadSnapshot(epoch);
  if (loaded && epoch === directoryEpoch) connectEvents(epoch);
  return loaded && epoch === directoryEpoch;
}
refreshButton.addEventListener("click", () => {
  attentionRouteStatusLocked = false;
  void refreshAndConnect();
});
notificationButton.addEventListener("click", () => void toggleBackgroundNotifications());
window.addEventListener("pageshow", event => {
  if (event.persisted) void refreshAndConnect();
});
window.addEventListener("online", () => void refreshAndConnect());
window.addEventListener("offline", () => {
  directoryEpoch += 1;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  clearEventLiveness();
  eventStreamStale = false;
  events = undefined;
  authorizationDenied = false;
  directoryLoaded = false;
  sessions.clear();
  render();
  setStatus("offline", "Offline. Sessions are not available without the gateway.");
});

void initializeNotifications();
if (await refreshAndConnect()) {
  if (pendingAttentionLaunch !== undefined) {
    const session = sessions.get(pendingAttentionLaunch.instanceId);
    if (
      session !== undefined &&
      session.generation === pendingAttentionLaunch.generation &&
      session.inputRequired &&
      session.canControl
    ) {
      await launch(session, "control");
    } else {
      setStatus("expired", "That attention request was already resolved or the session changed.");
    }
  }
}
