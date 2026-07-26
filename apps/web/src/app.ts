import {
  PUSH_API_VERSION,
  parseLaunchResponse,
  parsePushConfigResponse,
  parsePushSubscriptionRequest,
  parsePushSubscriptionResponse,
  parseSessionEvent,
  parseSessionListResponse,
  type LaunchMode,
  type SessionEvent,
  type SessionMetadata,
  type PushDetailLevel,
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
const notificationButton = requiredElement<HTMLButtonElement>("#notify");
const notificationDisclosure = requiredElement<HTMLElement>("#notify-note");
const directoryTitle = requiredElement<HTMLElement>("#directory-title");
const directoryCount = requiredElement<HTMLElement>("#directory-count");
const notificationSettings = requiredElement<HTMLDialogElement>("#notification-settings");
const notificationSettingsClose = requiredElement<HTMLButtonElement>("#notification-settings-close");
const notificationDisable = requiredElement<HTMLButtonElement>("#notification-disable");
const notificationDetailInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="notification-detail"]'),
];

const EVENT_LIVENESS_TIMEOUT_MS = 12_000;
const SNAPSHOT_TIMEOUT_MS = 4_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 4_000;

const sessions = new Map<string, SessionMetadata>();
let events: EventSource | undefined;
let directoryLoaded = false;
let authorizationDenied = false;
let notificationState: NotificationControlState = "checking";
let directoryEpoch = 0;
let directoryRevision = -1;
let snapshotController: AbortController | undefined;
let eventLivenessTimeout: number | undefined;
let eventStreamStale = false;
let reconnectTimeout: number | undefined;
let lastFreshAt: number | undefined;
let reconnectAttempt = 0;
let notificationRegistration: ServiceWorkerRegistration | undefined;
let applicationServerKey: string | undefined;
let launchInProgress = false;
let workerUpdatePending = false;
let updateReloadTimeout: number | undefined;


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
  readonly requestId: string;
}


interface DashboardSnapshot {
  readonly children: readonly HTMLElement[];
  readonly scrollY: number;
  readonly title: string;
  readonly bodyClass: string;
  readonly order: readonly string[];
}

interface ActiveCollabShell {
  readonly instanceId: string;
  readonly generation: number;
  readonly openedRequestId?: string;
  readonly triageBar: HTMLElement;
  readonly shell: HTMLElement;
  answerShown: boolean;
  reconnectingShown: boolean;
  triageTimeout?: number;
}

let dashboardSnapshot: DashboardSnapshot | undefined;
let activeCollabShell: ActiveCollabShell | undefined;
let disposeActiveCollab: (() => void) | undefined;
let currentNotificationDetail: PushDetailLevel = "session";

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
  notificationState = state;
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
      : state === "enabled"
        ? "Tap to choose what this device can show."
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
    record.version === PUSH_API_VERSION
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
    active.postMessage({ type: "omp-notification-support-request", version: PUSH_API_VERSION }, [channel.port2]);
  } catch {
    finish(false);
  }
  return promise;
}

async function savePushSubscription(
  subscription: PushSubscription,
  detailLevel?: PushDetailLevel,
): Promise<PushDetailLevel> {
  const request = parsePushSubscriptionRequest({
    version: PUSH_API_VERSION,
    ...(detailLevel === undefined ? {} : { detailLevel }),
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
  return parsePushSubscriptionResponse(await response.json()).detailLevel;
}

function selectNotificationDetail(detailLevel: PushDetailLevel): void {
  currentNotificationDetail = detailLevel;
  for (const input of notificationDetailInputs) input.checked = input.value === detailLevel;
}

function clearUpdateReloadTimeout(): void {
  if (updateReloadTimeout === undefined) return;
  window.clearTimeout(updateReloadTimeout);
  updateReloadTimeout = undefined;
}

function applyActivatedWorkerUpdate(): void {
  clearUpdateReloadTimeout();
  if (!workerUpdatePending || launchInProgress || location.pathname === "/client/") return;
  workerUpdatePending = false;
  location.reload();
}

async function initializeApplicationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!isSecureContext || !("serviceWorker" in navigator)) return undefined;
  const serviceWorker = navigator.serviceWorker;
  let currentController = serviceWorker.controller;
  serviceWorker.addEventListener("controllerchange", () => {
    const nextController = serviceWorker.controller;
    if (currentController === null) {
      currentController = nextController;
      return;
    }
    if (nextController === currentController) return;
    currentController = nextController;
    workerUpdatePending = true;
    clearUpdateReloadTimeout();
    updateReloadTimeout = window.setTimeout(applyActivatedWorkerUpdate, 1_000);
  });
  try {
    return await serviceWorker.register("/service-worker.js", { scope: "/" });
  } catch {
    return undefined;
  }
}

async function initializeNotifications(
  workerRegistration: Promise<ServiceWorkerRegistration | undefined>,
): Promise<void> {
  setNotificationControl("checking");
  if (
    !isSecureContext ||
    typeof Notification === "undefined" ||
    typeof PushManager === "undefined"
  ) {
    setNotificationControl("unavailable");
    return;
  }
  try {
    const [registered, configResponse] = await Promise.all([
      workerRegistration,
      fetch("/api/v1/push/config", { cache: "no-store", credentials: "same-origin" }),
    ]);
    if (registered === undefined) {
      setNotificationControl("unavailable");
      return;
    }
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
    selectNotificationDetail(await savePushSubscription(existing));
    setNotificationControl("enabled");
  } catch {
    setNotificationControl("unavailable");
  }
}

async function disableBackgroundNotifications(): Promise<void> {
  const registration = notificationRegistration;
  if (registration === undefined) return;
  const existing = await registration.pushManager.getSubscription();
  if (existing === null) {
    notificationSettings.close();
    setNotificationControl("idle");
    return;
  }
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
    notificationSettings.close();
    setNotificationControl("idle");
  } catch {
    setNotificationControl("unavailable");
  }
}

async function toggleBackgroundNotifications(): Promise<void> {
  if (notificationState === "enabled") {
    notificationSettings.showModal();
    return;
  }
  const registration = notificationRegistration;
  const publicKey = applicationServerKey;
  if (registration === undefined || publicKey === undefined) return;

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
      selectNotificationDetail(await savePushSubscription(subscription, "session"));
    } catch (error) {
      await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    setNotificationControl("enabled");
    notificationSettings.showModal();
  } catch {
    setNotificationControl(Notification.permission === "denied" ? "blocked" : "unavailable");
  }
}

function readPendingAttentionLaunch(): PendingAttentionLaunch | undefined {
  const match = /^\/collab\/([^/]{1,384})$/u.exec(location.pathname);
  const requestId = new URL(location.href).searchParams.get("request");
  if (match === null || requestId === null) return undefined;
  const encodedInstanceId = match[1];
  if (encodedInstanceId === undefined) return undefined;
  let instanceId: string;
  try {
    instanceId = decodeURIComponent(encodedInstanceId);
  } catch {
    return undefined;
  }
  if (
    !/^[A-Za-z0-9._:-]{16,128}$/u.test(instanceId) ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(requestId)
  ) {
    return undefined;
  }
  history.replaceState(null, "", "/");
  return { instanceId, requestId };
}

if (location.pathname === "/update/" || location.pathname === "/client/") {
  history.replaceState(null, "", "/");
}

const pendingAttentionLaunch = readPendingAttentionLaunch();
let attentionRouteStatusLocked = pendingAttentionLaunch !== undefined;

type StatusKind = "ready" | "offline" | "tailnet" | "desktop" | "relay" | "unauthorized" | "expired" | "loading";

function setStatus(kind: StatusKind, message: string): void {
  statusBanner.dataset.kind = kind;
  statusBanner.textContent = message;
  statusBanner.hidden = kind === "ready";
}

function showTransportFailure(kind: "offline" | "tailnet" | "desktop" | "relay"): void {
  directoryRevision = -1;
  render();
  const asOf =
    lastFreshAt === undefined
      ? "before the last successful connection"
      : new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(lastFreshAt);
  const copy: Record<typeof kind, readonly [string, string]> = {
    offline: [
      "You're offline",
      `This phone has no connection. Showing the list as of ${asOf} — retries automatically.`,
    ],
    tailnet: [
      "Tailnet unreachable",
      `Phone is online, but your tailnet isn't answering — Tailscale is off or logged out on this phone. Last seen ${asOf}.`,
    ],
    desktop: [
      "Desktop unreachable",
      `Tailnet looks fine, but the desktop isn't answering — asleep, or the gateway stopped. Last seen ${asOf}.`,
    ],
    relay: [
      "Reconnecting to relay…",
      `Live updates paused; showing the list as of ${asOf}. Reconnects automatically.`,
    ],
  };
  const [title, body] = copy[kind];
  const text = document.createElement("span");
  text.className = "status-copy";
  text.append(
    createTextElement("strong", "status-title", title),
    createTextElement("span", "status-detail", body),
  );
  statusBanner.dataset.kind = kind;
  statusBanner.replaceChildren(text);
  if (kind === "desktop") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "status-action";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void refreshAndConnect());
    statusBanner.append(retry);
  }
  statusBanner.hidden = false;
}

function clearEventLiveness(): void {
  if (eventLivenessTimeout === undefined) return;
  window.clearTimeout(eventLivenessTimeout);
  eventLivenessTimeout = undefined;
}

function clearReconnectTimeout(): void {
  if (reconnectTimeout === undefined) return;
  window.clearTimeout(reconnectTimeout);
  reconnectTimeout = undefined;
}



function scheduleReconnect(): void {
  if (authorizationDenied || reconnectTimeout !== undefined) return;
  const exponent = Math.min(reconnectAttempt, 2);
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
  reconnectAttempt = Math.min(reconnectAttempt + 1, 2);
  reconnectTimeout = window.setTimeout(() => {
    reconnectTimeout = undefined;
    void refreshAndConnect(false);
  }, delay);
}

function failEventStream(source: EventSource, epoch: number): void {
  if (events !== source || epoch !== directoryEpoch) return;
  source.close();
  events = undefined;
  clearEventLiveness();
  eventStreamStale = true;
  showTransportFailure("relay");
  scheduleReconnect();
}

function armEventLiveness(source: EventSource, epoch: number): void {
  clearEventLiveness();
  eventLivenessTimeout = window.setTimeout(() => {
    eventLivenessTimeout = undefined;
    failEventStream(source, epoch);
  }, EVENT_LIVENESS_TIMEOUT_MS);
}


function sessionTitle(session: SessionMetadata): string {
  return session.title || session.cwdLabel || "OMP session";
}


function replaceSessionSnapshot(nextSessions: readonly SessionMetadata[]): void {
  sessions.clear();
  for (const session of nextSessions) sessions.set(session.instanceId, session);
}

function elapsedLabel(startedAt: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (elapsedMinutes < 1) return "<1m";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function waitingLabel(session: SessionMetadata): string {
  const since = Date.parse(session.ask?.since ?? session.lastSeenAt);
  return `waiting ${elapsedLabel(Number.isNaN(since) ? Date.now() : since)}`;
}

function uptimeLabel(session: SessionMetadata): string {
  const startedAt = Date.parse(session.startedAt);
  return `up ${elapsedLabel(Number.isNaN(startedAt) ? Date.now() : startedAt)}`;
}

function orderedWaitingSessions(): SessionMetadata[] {
  return [...sessions.values()]
    .filter(session => session.inputRequired)
    .sort((left, right) => {
      const leftSince = left.ask?.since ?? left.lastSeenAt;
      const rightSince = right.ask?.since ?? right.lastSeenAt;
      return leftSince === rightSince
        ? left.instanceId.localeCompare(right.instanceId)
        : leftSince.localeCompare(rightSince);
    });
}

function orderedWorkingSessions(): SessionMetadata[] {
  return [...sessions.values()]
    .filter(session => !session.inputRequired)
    .sort((left, right) => {
      const started = right.startedAt.localeCompare(left.startedAt);
      return started === 0 ? left.instanceId.localeCompare(right.instanceId) : started;
    });
}

function createTextElement(tagName: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function createQueueKicker(label: string, detail?: string): HTMLElement {
  const kicker = createTextElement("p", "queue-kicker", label);
  if (detail !== undefined) {
    kicker.append(createTextElement("span", "queue-wait", detail));
  }
  return kicker;
}

function createSessionSummary(session: SessionMetadata): HTMLElement {
  const values = [session.cwdLabel, session.model].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return createTextElement("p", "session-summary", values.join(" · ") || "Live OMP session");
}

function createWorkingRow(session: SessionMetadata): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "working-row";
  button.dataset.instanceId = session.instanceId;
  button.disabled = !session.canView;
  button.setAttribute("aria-label", `View ${sessionTitle(session)}`);
  button.append(
    createTextElement("span", "row-dot row-dot-live", ""),
    createTextElement("span", "row-title", sessionTitle(session)),
    createTextElement("span", "row-time", uptimeLabel(session)),
  );
  button.addEventListener("click", () => void launch(session, "view", button));
  return button;
}

function createWaitingRow(session: SessionMetadata): HTMLButtonElement {
  const mode: LaunchMode = session.canControl ? "control" : "view";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "queue-row";
  button.dataset.instanceId = session.instanceId;
  button.disabled = mode === "control" ? !session.canControl : !session.canView;
  button.setAttribute(
    "aria-label",
    session.canControl ? `Open request in ${sessionTitle(session)}` : `View ${sessionTitle(session)}`,
  );
  button.append(
    createTextElement("span", "row-dot row-dot-waiting", ""),
    createTextElement("span", "row-title", sessionTitle(session)),
    createTextElement("span", "row-time", waitingLabel(session)),
    createTextElement("span", "row-chevron", "›"),
  );
  button.addEventListener("click", () => void launch(session, mode, button));
  return button;
}

function renderAllClear(working: readonly SessionMetadata[]): void {
  const summary = document.createElement("div");
  summary.className = "all-clear-summary";
  summary.append(
    createTextElement("span", "all-clear-dot", ""),
    createTextElement("h2", "all-clear-title", "All clear"),
    createTextElement(
      "p",
      "all-clear-copy",
      `Nothing needs you — ${working.length} working. You'll get pinged.`,
    ),
  );
  sessionList.append(summary);
  if (working.length === 0) return;
  sessionList.append(createQueueKicker(`Working · ${working.length}`));
  for (const session of working) sessionList.append(createWorkingRow(session));
}

function renderWaitingQueue(
  waiting: readonly SessionMetadata[],
  working: readonly SessionMetadata[],
): void {
  const [hero, ...remaining] = waiting;
  if (hero === undefined) return;
  sessionList.append(createQueueKicker("Up next", waitingLabel(hero)));

  const article = document.createElement("article");
  article.className = "queue-hero";
  article.dataset.instanceId = hero.instanceId;
  const askPreview = createTextElement(
    "p",
    "ask-preview",
    hero.ask?.preview === undefined
      ? hero.canControl
        ? "Waiting for your input"
        : "Waiting for your input — Control unavailable"
      : `「${hero.ask.preview}」`,
  );
  if (hero.ask?.optionCount !== undefined) {
    askPreview.append(createTextElement("span", "", ` · ${hero.ask.optionCount} options`));
  }
  article.append(
    createTextElement("h2", "", sessionTitle(hero)),
    createSessionSummary(hero),
    askPreview,
  );

  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "action action-request";
  primary.textContent = hero.canControl ? "Open request" : "View transcript";
  primary.disabled = hero.canControl ? false : !hero.canView;
  primary.addEventListener("click", () => {
    void launch(hero, hero.canControl ? "control" : "view", primary);
  });
  article.append(primary);

  if (hero.canControl && hero.canView) {
    const alternate = document.createElement("button");
    alternate.type = "button";
    alternate.className = "hero-alt";
    alternate.textContent = "View transcript instead";
    alternate.addEventListener("click", () => void launch(hero, "view", alternate));
    article.append(alternate);
  }
  sessionList.append(article);

  if (remaining.length > 0) {
    sessionList.append(createQueueKicker("Then"));
    for (const session of remaining) sessionList.append(createWaitingRow(session));
  }
  if (working.length > 0) {
    sessionList.append(createQueueKicker(`Working · ${working.length}`));
    for (const session of working) sessionList.append(createWorkingRow(session));
  }
}

function render(): void {
  sessionList.replaceChildren();
  emptyState.hidden = true;
  if (!directoryLoaded) {
    directoryTitle.textContent = "Sessions";
    directoryCount.hidden = true;
    return;
  }

  const waiting = orderedWaitingSessions();
  const working = orderedWorkingSessions();
  directoryCount.hidden = false;
  if (waiting.length > 0) {
    directoryTitle.textContent = "Needs you";
    directoryCount.className = "count-pill count-pill-waiting";
    directoryCount.textContent = `${waiting.length} waiting`;
    sessionList.className = "session-list queue";
    sessionList.setAttribute("aria-label", "Sessions waiting for input");
    renderWaitingQueue(waiting, working);
    return;
  }

  directoryTitle.textContent = "Sessions";
  directoryCount.className = "count-pill count-pill-live";
  directoryCount.textContent = `Live · ${working.length}`;
  sessionList.className = "session-list all-clear";
  sessionList.setAttribute("aria-label", "Live OMP sessions");
  renderAllClear(working);
}

function setConnectionState(chip: HTMLElement, state: "connected" | "reconnecting" | "offline"): void {
  chip.dataset.state = state;
  chip.textContent =
    state === "connected" ? "Connected" : state === "reconnecting" ? "Reconnecting…" : "Offline";
}

function hideTriageBar(shell: ActiveCollabShell): void {
  if (shell.triageTimeout !== undefined) {
    window.clearTimeout(shell.triageTimeout);
    delete shell.triageTimeout;
  }
  shell.triageBar.hidden = true;
  delete shell.shell.dataset.triageVisible;
}

function showTriageBar(
  shell: ActiveCollabShell,
  kind: "next" | "clear" | "reconnecting" | "ended",
  copy: string,
  actionLabel?: string,
  action?: () => void,
): void {
  hideTriageBar(shell);
  shell.triageBar.dataset.kind = kind;
  const message = createTextElement("span", "triage-copy", copy);
  if (actionLabel !== undefined && action !== undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === "next" ? "triage-action triage-action-next" : "triage-action";
    button.textContent = actionLabel;
    button.addEventListener("click", action);
    shell.triageBar.replaceChildren(message, button);
  } else {
    shell.triageBar.replaceChildren(message);
  }
  shell.triageBar.hidden = false;
  shell.shell.dataset.triageVisible = "true";
  if (kind === "next" || kind === "clear") {
    shell.triageTimeout = window.setTimeout(() => hideTriageBar(shell), 8_000);
  }
}

function returnToDirectory(): void {
  const snapshot = dashboardSnapshot;
  if (snapshot === undefined) {
    location.replace("/");
    return;
  }
  disposeActiveCollab?.();
  disposeActiveCollab = undefined;
  activeCollabShell = undefined;
  document.body.className = snapshot.bodyClass;
  document.body.replaceChildren(...snapshot.children);
  document.title = snapshot.title;
  dashboardSnapshot = undefined;
  history.replaceState(
    { ompDirectory: { order: snapshot.order, scrollY: snapshot.scrollY } },
    "",
    "/",
  );
  window.scrollTo(0, snapshot.scrollY);
  void refreshAndConnect();
  applyActivatedWorkerUpdate();
}

function reconcileActiveCollabShell(): void {
  const shell = activeCollabShell;
  if (shell === undefined || shell.answerShown || !directoryLoaded) return;
  const current = sessions.get(shell.instanceId);
  if (current === undefined || current.generation !== shell.generation) {
    shell.answerShown = true;
    showTriageBar(shell, "ended", "Session ended", "Back to Sessions", returnToDirectory);
    return;
  }
  if (shell.openedRequestId === undefined || current.ask?.requestId === shell.openedRequestId) return;

  shell.answerShown = true;
  const waiting = orderedWaitingSessions();
  const next = waiting.find(session => session.canControl);
  if (waiting.length > 0 && next !== undefined) {
    const copy =
      waiting.length === 1
        ? "✓ Answered — 1 more needs you"
        : `✓ Answered — ${waiting.length} more need you`;
    showTriageBar(shell, "next", copy, "Next ask →", () => void launch(next, "control"));
    return;
  }
  const working = orderedWorkingSessions().length;
  showTriageBar(
    shell,
    "clear",
    `✓ Answered — all clear · ${working} working`,
    "Sessions",
    returnToDirectory,
  );
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

function enterCollabClient(
  capability: string,
  startCollabWithCapability: StartCollabWithCapability,
  session: SessionMetadata,
  mode: LaunchMode,
): void {
  if (dashboardSnapshot === undefined) {
    dashboardSnapshot = {
      children: [...document.body.children] as HTMLElement[],
      scrollY: window.scrollY,
      title: document.title,
      bodyClass: document.body.className,
      order: [...sessionList.querySelectorAll<HTMLElement>("[data-instance-id]")]
        .map(element => element.dataset.instanceId)
        .filter((instanceId): instanceId is string => instanceId !== undefined),
    };
  }
  disposeActiveCollab?.();

  const shell = document.createElement("div");
  shell.className = "gateway-shell";
  const bar = document.createElement("header");
  bar.className = "shell-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "shell-back";
  back.textContent = "← Sessions";
  back.addEventListener("click", () => history.back());
  const title = createTextElement("span", "shell-title", sessionTitle(session));
  const control = document.createElement("button");
  control.type = "button";
  control.className = "shell-control";
  control.textContent = "Control";
  control.hidden = mode === "control" || !session.canControl;
  control.addEventListener("click", () => void launch(session, "control", control));
  const connection = createTextElement("span", "conn-chip", "Reconnecting…");
  connection.dataset.state = "reconnecting";
  bar.append(back, title, control, connection);

  const container = document.createElement("div");
  container.id = "root";
  container.setAttribute("role", "application");
  container.setAttribute("aria-label", "OMP collaboration session");
  const triageBar = document.createElement("aside");
  triageBar.className = "triage-bar";
  triageBar.hidden = true;
  shell.append(bar, container, triageBar);

  snapshotController?.abort();
  snapshotController = undefined;
  clearReconnectTimeout();
  reconnectAttempt = 0;
  launchInProgress = false;
  if (location.pathname !== "/client/") {
    history.replaceState(
      { ompDirectory: { order: dashboardSnapshot.order, scrollY: dashboardSnapshot.scrollY } },
      "",
      "/",
    );
    history.pushState({ ompCollab: true }, "", "/client/");
  }
  document.body.className = "collab-shell-active";
  document.body.replaceChildren(shell);
  document.title = `${sessionTitle(session)} · OMP Sessions`;

  const shellState: ActiveCollabShell = {
    instanceId: session.instanceId,
    generation: session.generation,
    ...(mode === "control" && session.inputRequired && session.ask !== undefined
      ? { openedRequestId: session.ask.requestId }
      : {}),
    triageBar,
    shell,
    answerShown: false,
    reconnectingShown: false,
  };
  activeCollabShell = shellState;

  let observer: MutationObserver | undefined;
  const updateConnection = (): void => {
    if (container.querySelector(".sh-ended") !== null) {
      setConnectionState(connection, "offline");
      if (!shellState.answerShown) {
        shellState.answerShown = true;
        showTriageBar(shellState, "ended", "Session ended", "Back to Sessions", returnToDirectory);
      }
      return;
    }
    const banner = container.querySelector(".sh-banner")?.textContent?.toLowerCase() ?? "";
    const reconnecting =
      banner.includes("connecting") || banner.includes("joining") || banner.includes("reconnecting");
    setConnectionState(connection, reconnecting ? "reconnecting" : "connected");
    if (reconnecting && !shellState.answerShown) {
      if (!shellState.reconnectingShown) {
        shellState.reconnectingShown = true;
        showTriageBar(shellState, "reconnecting", "Reconnecting to relay… composer paused");
      }
    } else if (shellState.reconnectingShown) {
      shellState.reconnectingShown = false;
      if (!shellState.answerShown) hideTriageBar(shellState);
    }
  };
  if ("MutationObserver" in window) {
    observer = new MutationObserver(updateConnection);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  }

  let disposeClient = (): void => undefined;
  const removeLifecycleListeners = (): void => {
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("popstate", handlePopState);
    observer?.disconnect();
  };
  const dispose = (): void => {
    hideTriageBar(shellState);
    removeLifecycleListeners();
    disposeClient();
    disposeClient = (): void => undefined;
    if (activeCollabShell === shellState) activeCollabShell = undefined;
  };
  const handlePageHide = (): void => {
    dispose();
  };
  const handlePopState = (): void => {
    returnToDirectory();
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("popstate", handlePopState);
  try {
    disposeClient = startCollabWithCapability(container, capability, () => {
      disposeClient = (): void => undefined;
      removeLifecycleListeners();
    });
    disposeActiveCollab = dispose;
    queueMicrotask(updateConnection);
  } catch (error) {
    dispose();
    returnToDirectory();
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
  launchInProgress = true;

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
    launchInProgress = false;
    if (location.pathname === "/client/") history.replaceState(null, "", "/");
    stylesheet?.remove();
    resetButton();
    setStatus(kind, message);
    applyActivatedWorkerUpdate();
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
    enterCollabClient(capability, startCollabWithCapability, session, mode);
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
  lastFreshAt = Date.now();
  if (event.type === "snapshot") {
    replaceSessionSnapshot(event.sessions);
  } else if (event.type === "session_upsert") {
    sessions.set(event.session.instanceId, event.session);
  } else {
    const current = sessions.get(event.instanceId);
    if (current?.generation === event.generation) sessions.delete(event.instanceId);
  }
  render();
  reconcileActiveCollabShell();
  return true;
}

async function loadSnapshot(epoch: number): Promise<boolean> {
  const controller = new AbortController();
  snapshotController = controller;
  let timedOut = false;
  let responseReceived = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SNAPSHOT_TIMEOUT_MS);
  if (!directoryLoaded) setStatus("loading", "Loading sessions…");
  try {
    const response = await fetch("/api/v1/sessions", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    responseReceived = true;
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
    lastFreshAt = Date.now();
    replaceSessionSnapshot(payload.sessions);
    render();
    setStatus("ready", "");
    return true;
  } catch {
    if (epoch !== directoryEpoch || (controller.signal.aborted && !timedOut)) return false;
    authorizationDenied = false;
    showTransportFailure(
      navigator.onLine === false ? "offline" : timedOut || responseReceived ? "desktop" : "tailnet",
    );
    return false;
  } finally {
    window.clearTimeout(timeout);
    if (snapshotController === controller) snapshotController = undefined;
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
        failEventStream(source, epoch);
        return;
      }
      armEventLiveness(source, epoch);
      try {
        if (applyEvent(parseSessionEvent(JSON.parse(event.data)), epoch) && !attentionRouteStatusLocked) {
          setStatus("ready", "");
        }
      } catch {
        failEventStream(source, epoch);
      }
    });
  }
  source.addEventListener("keepalive", () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (eventStreamStale) {
      failEventStream(source, epoch);
      return;
    }
    lastFreshAt = Date.now();
    armEventLiveness(source, epoch);
    if (!attentionRouteStatusLocked) setStatus("ready", "");
  });
  source.onerror = () => {
    failEventStream(source, epoch);
  };
}

async function refreshAndConnect(resetBackoff = true): Promise<boolean> {
  if (resetBackoff) reconnectAttempt = 0;
  clearReconnectTimeout();
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
  if (loaded && epoch === directoryEpoch) {
    reconnectAttempt = 0;
    connectEvents(epoch);
    return true;
  }
  if (!authorizationDenied && epoch === directoryEpoch) scheduleReconnect();
  return false;
}
notificationButton.addEventListener("click", () => void toggleBackgroundNotifications());
notificationSettingsClose.addEventListener("click", () => notificationSettings.close());
notificationDisable.addEventListener("click", () => void disableBackgroundNotifications());
for (const input of notificationDetailInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || notificationRegistration === undefined) return;
    const detailLevel = input.value as PushDetailLevel;
    void (async () => {
      const subscription = await notificationRegistration?.pushManager.getSubscription();
      if (subscription === null || subscription === undefined) return;
      try {
        selectNotificationDetail(await savePushSubscription(subscription, detailLevel));
      } catch {
        selectNotificationDetail(currentNotificationDetail);
      }
    })();
  });
}
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
  clearReconnectTimeout();
  reconnectAttempt = 0;
  eventStreamStale = false;
  events = undefined;
  authorizationDenied = false;
  showTransportFailure("offline");
});

const applicationWorkerRegistration = initializeApplicationWorker();
void initializeNotifications(applicationWorkerRegistration);
if (await refreshAndConnect()) {
  if (pendingAttentionLaunch !== undefined) {
    const session = sessions.get(pendingAttentionLaunch.instanceId);
    if (
      session !== undefined &&
      session.ask?.requestId === pendingAttentionLaunch.requestId &&
      session.inputRequired &&
      session.canControl
    ) {
      await launch(session, "control");
    } else {
      setStatus("expired", "That attention request was already resolved or the session changed.");
    }
  }
}
