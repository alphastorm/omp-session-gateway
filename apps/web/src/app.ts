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
import type {
  CollabEmbedOptions,
  CollabEmbedState,
} from "../../../packages/collab-client/upstream/src/embed-contract";

type PathHealth = CollabEmbedState["gatewayHealth"];

type StartCollabWithCapability = (
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
  options?: CollabEmbedOptions,
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
const networkRecoveryHelp = requiredElement<HTMLDialogElement>("#network-recovery-help");
const networkRecoveryHelpClose = requiredElement<HTMLButtonElement>("#network-recovery-help-close");
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
const RECOVERY_SNAPSHOT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CONNECTION_EXTENDED_MS = 3_000;
const CONNECTION_RECOVERED_MS = 1_800;
const TRANSPORT_GUIDANCE_DELAY_MS = 45_000;

type TransportFailureKind = "offline" | "tailnet" | "desktop" | "gateway";

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
let transportFailureSince: number | undefined;
let transportFailureKind: TransportFailureKind | undefined;
let transportGuidanceTimeout: number | undefined;
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


interface DirectoryHistoryState {
  readonly order: readonly string[];
  readonly scrollY: number;
}

interface DashboardSnapshot {
  readonly children: readonly HTMLElement[];
  readonly scrollY: number;
  readonly title: string;
  readonly bodyClass: string;
  readonly historyState: DirectoryHistoryState;
}

interface ActiveCollabShell {
  readonly instanceId: string;
  readonly generation: number;
  readonly openedRequestId?: string;
  readonly connectionChip: HTMLElement;
  readonly triageBar: HTMLElement;
  readonly shell: HTMLElement;
  answerShown: boolean;
  answerTriageVisible: boolean;
  triageTimeout?: number;
  hasBeenLive: boolean;
  latestEmbedState?: CollabEmbedState;
  outagePath?: "gateway" | "relay";
  interruptionStartedAt?: number;
  connectionDelayTimeout?: number;
  connectionTickTimeout?: number;
  recoveredTimeout?: number;
}

let dashboardSnapshot: DashboardSnapshot | undefined;
let activeCollabShell: ActiveCollabShell | undefined;
let disposeActiveCollab: (() => void) | undefined;
/**
 * `pagehide` disposes the collab client and drops its capability with it, but the shell DOM, the
 * `/client/` URL, and the document itself all survive into the bfcache. A restore of that entry is
 * an inert shell, so it has to be handed back to the directory instead of reconnected behind dead
 * DOM — and never by restarting a client whose capability is gone.
 */
let collabShellDisposedOnPageHide = false;
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
  notificationDisclosure.hidden = state !== "blocked";
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

type StatusKind = "ready" | "offline" | "tailnet" | "desktop" | "gateway" | "unauthorized" | "expired" | "loading";

function setStatus(kind: StatusKind, message: string): void {
  if (kind === "ready" || kind === "unauthorized" || kind === "expired") clearTransportFailureTracking();
  statusBanner.dataset.kind = kind;
  statusBanner.replaceChildren();
  statusBanner.textContent = message;
  statusBanner.hidden = kind === "ready";
}

function parseDirectoryHistoryState(value: unknown): DirectoryHistoryState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const directory = (value as Record<string, unknown>).ompDirectory;
  if (typeof directory !== "object" || directory === null || Array.isArray(directory)) return undefined;
  const record = directory as Record<string, unknown>;
  if (
    !Array.isArray(record.order) ||
    !record.order.every(
      item => typeof item === "string" && /^[A-Za-z0-9._:-]{16,128}$/u.test(item),
    ) ||
    new Set(record.order).size !== record.order.length ||
    typeof record.scrollY !== "number" ||
    !Number.isFinite(record.scrollY) ||
    record.scrollY < 0
  ) {
    return undefined;
  }
  return { order: [...record.order], scrollY: record.scrollY };
}

function clearTransportFailureTracking(): void {
  if (transportGuidanceTimeout !== undefined) {
    window.clearTimeout(transportGuidanceTimeout);
    transportGuidanceTimeout = undefined;
  }
  transportFailureSince = undefined;
  if (networkRecoveryHelp.open) networkRecoveryHelp.close();
  transportFailureKind = undefined;
}

function transportGuidanceVisible(kind: TransportFailureKind): boolean {
  return (
    kind !== "offline" &&
    transportFailureSince !== undefined &&
    Date.now() - transportFailureSince >= TRANSPORT_GUIDANCE_DELAY_MS &&
    document.visibilityState === "visible"
  );
}

function scheduleTransportGuidance(): void {
  if (transportFailureSince === undefined || transportGuidanceTimeout !== undefined) return;
  const remaining = TRANSPORT_GUIDANCE_DELAY_MS - (Date.now() - transportFailureSince);
  if (remaining <= 0) return;
  transportGuidanceTimeout = window.setTimeout(() => {
    transportGuidanceTimeout = undefined;
    const kind = transportFailureKind;
    if (kind !== undefined && document.visibilityState === "visible") showTransportFailure(kind);
  }, remaining);
}
function showTransportFailure(kind: TransportFailureKind): void {
  const tracksVisibleFailure = kind !== "offline" && document.visibilityState === "visible";
  if (tracksVisibleFailure) {
    if (transportFailureSince === undefined) transportFailureSince = Date.now();
    transportFailureKind = kind;
  } else {
    clearTransportFailureTracking();
  }
  directoryRevision = -1;
  render();
  const asOf =
    lastFreshAt === undefined
      ? "before the last successful connection"
      : new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(lastFreshAt);
  const copy: Record<TransportFailureKind, readonly [string, string]> = {
    offline: [
      "You're offline",
      "This phone has no connection. Showing the list as of " + asOf + " — retries automatically.",
    ],
    tailnet: [
      "Tailnet unreachable",
      "Phone is online, but your tailnet isn't answering — Tailscale is off or logged out on this phone.",
    ],
    desktop: [
      "Desktop unreachable",
      "Tailnet looks fine, but the desktop isn't answering — asleep, or the gateway stopped. Last seen " + asOf + ".",
    ],
    gateway: [
      "Gateway unavailable",
      "Live updates paused; showing the list as of " + asOf + ". Reconnects automatically.",
    ],
  };
  const [title, body] = copy[kind];
  const text = document.createElement("span");
  text.className = "status-copy";
  text.append(
    createTextElement("strong", "status-title", title),
    createTextElement("span", "status-detail", body),
  );
  if (kind === "tailnet") {
    text.append(createTextElement("span", "status-freshness", "Last seen " + asOf + "."));
  }

  const extended = transportGuidanceVisible(kind);
  if (extended) {
    text.append(
      createTextElement(
        "span",
        "status-guidance",
        "Still unreachable? Android Chrome may be stuck after a network change. Force stop the browser hosting OMP Sessions in Android Settings, then reopen OMP Sessions.",
      ),
    );
  }

  statusBanner.dataset.kind = kind;
  statusBanner.replaceChildren(text);
  if (kind === "desktop" || extended) {
    const actions = document.createElement("span");
    actions.className = "status-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "status-action";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void refreshAndConnect());
    actions.append(retry);
    if (extended) {
      const troubleshooting = document.createElement("button");
      troubleshooting.type = "button";
      troubleshooting.className = "status-action";
      troubleshooting.textContent = "Troubleshooting";
      troubleshooting.addEventListener("click", () => networkRecoveryHelp.showModal());
      actions.append(troubleshooting);
    }
    statusBanner.append(actions);
  }
  statusBanner.hidden = false;
  if (tracksVisibleFailure) scheduleTransportGuidance();
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

/**
 * True only when the event stream has demonstrably been heard from inside the liveness window.
 *
 * Neither `events !== undefined` nor `eventStreamStale` survives a freeze. Chrome freezes the
 * renderer while the display is off, so a page that resumes still holds an `EventSource` that
 * reports open and a liveness timeout that never ran, however long the stream has been dead.
 * Wall-clock freshness is the one signal a frozen page cannot have faked.
 */
function directoryStreamIsLive(): boolean {
  if (events === undefined || eventStreamStale || lastFreshAt === undefined) return false;
  return Date.now() - lastFreshAt < EVENT_LIVENESS_TIMEOUT_MS;
}

function scheduleReconnect(): void {
  if (authorizationDenied || reconnectTimeout !== undefined) return;
  const exponent = Math.min(reconnectAttempt, 5);
  const cap = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
  const floor = Math.floor(cap / 2);
  const delay = floor + Math.floor(Math.random() * (cap - floor));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
  reconnectTimeout = window.setTimeout(() => {
    reconnectTimeout = undefined;
    void refreshAndConnect(false);
  }, delay);
}
function markEventStreamInterrupted(source: EventSource, epoch: number): boolean {
  if (events !== source || epoch !== directoryEpoch) return false;
  clearEventLiveness();
  eventStreamStale = true;
  showTransportFailure(navigator.onLine === false ? "offline" : "gateway");
  scheduleReconnect();
  return true;
}

function failEventStream(source: EventSource, epoch: number): void {
  if (!markEventStreamInterrupted(source, epoch)) return;
  source.close();
  events = undefined;
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
  button.addEventListener("click", () =>
    void launch(session, mode, button, mode === "control" ? session.ask?.requestId : undefined),
  );
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
    const mode: LaunchMode = hero.canControl ? "control" : "view";
    void launch(hero, mode, primary, mode === "control" ? hero.ask?.requestId : undefined);
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
  if (activeCollabShell !== undefined) return;
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

function setConnectionState(
  chip: HTMLElement,
  state: "connected" | "reconnecting" | "offline",
  copy?: string,
): void {
  const label = copy ?? (state === "connected" ? "Connected" : state === "reconnecting" ? "Reconnecting…" : "Offline");
  chip.dataset.state = state;
  chip.dataset.compact = state === "connected" && copy === undefined ? "true" : "false";
  chip.textContent = label;
  chip.setAttribute("aria-label", label);
  chip.title = label;
}

function sessionEndedCopy(reason: string | null): string {
  const exitCode = reason?.match(/\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s+(-?\d+)\b/iu)?.[1];
  return exitCode === undefined ? "Mac/session ended" : `Mac/session ended · exit ${exitCode}`;
}

function hideTriageBar(shell: ActiveCollabShell, rerenderConnection = true): void {
  const hidAnswerTriage = shell.answerTriageVisible;
  if (shell.triageTimeout !== undefined) {
    window.clearTimeout(shell.triageTimeout);
    delete shell.triageTimeout;
  }
  shell.answerTriageVisible = false;
  shell.triageBar.hidden = true;
  delete shell.triageBar.dataset.dismissible;
  delete shell.shell.dataset.triageVisible;
  if (hidAnswerTriage && rerenderConnection) renderConnectionState(shell);
}

function showTriageBar(
  shell: ActiveCollabShell,
  kind: "next" | "clear" | "sending" | "reconnecting" | "ended",
  copy: string,
  actionLabel?: string,
  action?: () => void,
): void {
  hideTriageBar(shell, false);
  shell.triageBar.dataset.kind = kind;
  shell.answerTriageVisible = kind === "next" || kind === "clear";
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
    shell.triageBar.dataset.dismissible = "true";
    shell.triageTimeout = window.setTimeout(() => hideTriageBar(shell), 8_000);
  }
}

function clearConnectionTimers(shell: ActiveCollabShell): void {
  if (shell.connectionDelayTimeout !== undefined) {
    window.clearTimeout(shell.connectionDelayTimeout);
    delete shell.connectionDelayTimeout;
  }
  if (shell.connectionTickTimeout !== undefined) {
    window.clearTimeout(shell.connectionTickTimeout);
    delete shell.connectionTickTimeout;
  }
  if (shell.recoveredTimeout !== undefined) {
    window.clearTimeout(shell.recoveredTimeout);
    delete shell.recoveredTimeout;
  }
}

function pathInterrupted(health: PathHealth): boolean {
  return (
    health.state === "degraded" ||
    health.state === "unreachable" ||
    (health.state === "checking" && health.failureSince !== null)
  );
}

function retryingCopy(path: "gateway" | "relay", state: CollabEmbedState): string {
  const label = path === "gateway" ? "Gateway unavailable" : "Relay unavailable";
  const retryAt = path === "gateway" ? state.gatewayHealth.retryAt : state.relayHealth.retryAt;
  if (retryAt === null) return `${label} — retrying…`;
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  return seconds > 0 ? `${label} — retrying in ${seconds}s` : `${label} — retrying…`;
}

function scheduleConnectionRender(shell: ActiveCollabShell, delay: number, kind: "delay" | "tick"): void {
  const existing = kind === "delay" ? shell.connectionDelayTimeout : shell.connectionTickTimeout;
  if (existing !== undefined) window.clearTimeout(existing);
  const timeout = window.setTimeout(() => {
    if (kind === "delay") delete shell.connectionDelayTimeout;
    else delete shell.connectionTickTimeout;
    renderConnectionState(shell);
  }, delay);
  if (kind === "delay") shell.connectionDelayTimeout = timeout;
  else shell.connectionTickTimeout = timeout;
}

function renderConnectionState(shell: ActiveCollabShell): void {
  const state = shell.latestEmbedState;
  if (state === undefined || activeCollabShell !== shell) return;

  if (state.phase === "ended") {
    clearConnectionTimers(shell);
    shell.answerShown = true;
    setConnectionState(shell.connectionChip, "offline", "Ended");
    showTriageBar(
      shell,
      "ended",
      sessionEndedCopy(state.endedReason),
      "Back to Sessions",
      returnToDirectory,
    );
    return;
  }

  const live = state.phase === "live";
  if (!shell.hasBeenLive) {
    if (!live) {
      setConnectionState(shell.connectionChip, "reconnecting", "Connecting…");
      return;
    }
    shell.hasBeenLive = true;
  }

  const gatewayInterrupted = pathInterrupted(state.gatewayHealth);
  const relayInterrupted = pathInterrupted(state.relayHealth);
  if (gatewayInterrupted || relayInterrupted) {
    if (shell.recoveredTimeout !== undefined) {
      window.clearTimeout(shell.recoveredTimeout);
      delete shell.recoveredTimeout;
    }
    shell.interruptionStartedAt ??= Date.now();
    shell.outagePath = gatewayInterrupted ? "gateway" : "relay";
    const elapsed = Date.now() - shell.interruptionStartedAt;
    if (elapsed < CONNECTION_EXTENDED_MS) {
      setConnectionState(shell.connectionChip, "reconnecting", "Reconnecting…");
      if (state.responsePending && !shell.answerTriageVisible) showTriageBar(shell, "sending", "Sending…");
      else if (shell.triageBar.dataset.kind === "reconnecting" || shell.triageBar.dataset.kind === "sending") {
        hideTriageBar(shell);
      }
      scheduleConnectionRender(shell, CONNECTION_EXTENDED_MS - elapsed, "delay");
      return;
    }
    const path = shell.outagePath ?? "relay";
    const copy = retryingCopy(path, state);
    setConnectionState(shell.connectionChip, "reconnecting", path === "gateway" ? "Gateway unavailable" : "Relay unavailable");
    if (state.responsePending && !shell.answerTriageVisible) showTriageBar(shell, "sending", "Sending…");
    else if (!shell.answerTriageVisible) showTriageBar(shell, "reconnecting", copy);
    scheduleConnectionRender(shell, 1_000, "tick");
    return;
  }

  const recovered = shell.interruptionStartedAt !== undefined;
  if (shell.connectionDelayTimeout !== undefined) {
    window.clearTimeout(shell.connectionDelayTimeout);
    delete shell.connectionDelayTimeout;
  }
  if (shell.connectionTickTimeout !== undefined) {
    window.clearTimeout(shell.connectionTickTimeout);
    delete shell.connectionTickTimeout;
  }
  delete shell.interruptionStartedAt;
  delete shell.outagePath;
  if (recovered) {
    window.clearTimeout(shell.recoveredTimeout);
    setConnectionState(shell.connectionChip, "connected", "Connected");
    shell.recoveredTimeout = window.setTimeout(() => {
      delete shell.recoveredTimeout;
      if (activeCollabShell === shell && shell.latestEmbedState?.phase === "live") {
        setConnectionState(shell.connectionChip, "connected");
      }
    }, CONNECTION_RECOVERED_MS);
  } else if (shell.recoveredTimeout === undefined) {
    setConnectionState(shell.connectionChip, "connected");
  }
  if (state.responsePending && !shell.answerTriageVisible) showTriageBar(shell, "sending", "Sending…");
  else if (shell.triageBar.dataset.kind === "reconnecting" || shell.triageBar.dataset.kind === "sending") {
    hideTriageBar(shell);
  }
}

function returnToDirectory(historyValue?: unknown): void {
  collabShellDisposedOnPageHide = false;
  const snapshot = dashboardSnapshot;
  if (snapshot === undefined) {
    location.replace("/");
    return;
  }
  const historyState = parseDirectoryHistoryState(historyValue) ?? snapshot.historyState;
  disposeActiveCollab?.();
  disposeActiveCollab = undefined;
  activeCollabShell = undefined;
  document.body.className = snapshot.bodyClass;
  document.body.replaceChildren(...snapshot.children);
  document.title = snapshot.title;
  dashboardSnapshot = undefined;
  history.replaceState({ ompDirectory: historyState }, "", "/");
  window.scrollTo(0, historyState.scrollY);
  void refreshAndConnect();
  applyActivatedWorkerUpdate();
}

function reconcileActiveCollabShell(): void {
  const shell = activeCollabShell;
  if (
    shell === undefined ||
    shell.answerShown ||
    !directoryLoaded ||
    shell.latestEmbedState?.responsePending === true
  ) {
    return;
  }
  const current = sessions.get(shell.instanceId);
  if (current === undefined || current.generation !== shell.generation) {
    shell.answerShown = true;
    clearConnectionTimers(shell);
    setConnectionState(shell.connectionChip, "offline", "Ended");
    showTriageBar(shell, "ended", "Mac/session ended", "Back to Sessions", returnToDirectory);
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
    showTriageBar(shell, "next", copy, "Next ask →", () =>
      void launch(next, "control", undefined, next.ask?.requestId),
    );
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
  requestId?: string,
): void {
  setStatus("ready", "");
  if (dashboardSnapshot === undefined) {
    const historyState: DirectoryHistoryState = {
      scrollY: window.scrollY,
      order: [...sessionList.querySelectorAll<HTMLElement>("[data-instance-id]")]
        .map(element => element.dataset.instanceId)
        .filter((instanceId): instanceId is string => instanceId !== undefined),
    };
    dashboardSnapshot = {
      children: [...document.body.children] as HTMLElement[],
      scrollY: historyState.scrollY,
      title: document.title,
      bodyClass: document.body.className,
      historyState,
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
  control.addEventListener("click", () => {
    const current = sessions.get(session.instanceId) ?? session;
    void launch(current, "control", control, current.ask?.requestId);
  });
  const connection = createTextElement("span", "conn-chip", "Connecting…");
  setConnectionState(connection, "reconnecting", "Connecting…");
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  connection.setAttribute("aria-atomic", "true");
  const shellActions = document.createElement("span");
  shellActions.className = "shell-actions";
  shellActions.append(control, connection);
  bar.append(back, title, shellActions);

  const container = document.createElement("div");
  container.id = "root";
  container.setAttribute("role", "application");
  container.setAttribute("aria-label", "OMP collaboration session");
  const triageBar = document.createElement("aside");
  triageBar.className = "triage-bar";
  triageBar.hidden = true;
  shell.append(bar, container, triageBar);
  let triageSwipeStart: number | undefined;
  shell.addEventListener("pointerdown", event => {
    if (
      triageBar.dataset.dismissible === "true" &&
      event.target !== null &&
      !triageBar.contains(event.target as Node)
    ) {
      hideTriageBar(activeCollabShell ?? shellState);
    }
  });
  shell.addEventListener("keydown", event => {
    if (event.key === "Escape" && triageBar.dataset.dismissible === "true") {
      event.preventDefault();
      hideTriageBar(activeCollabShell ?? shellState);
    }
  });
  triageBar.addEventListener("pointerdown", event => {
    triageSwipeStart = triageBar.dataset.dismissible === "true" ? event.clientY : undefined;
  });
  triageBar.addEventListener("pointerup", event => {
    if (triageSwipeStart !== undefined && Math.abs(event.clientY - triageSwipeStart) >= 32) {
      hideTriageBar(activeCollabShell ?? shellState);
    }
    triageSwipeStart = undefined;
  });
  triageBar.addEventListener("pointercancel", () => {
    triageSwipeStart = undefined;
  });

  snapshotController?.abort();
  snapshotController = undefined;
  clearReconnectTimeout();
  reconnectAttempt = 0;
  launchInProgress = false;
  if (location.pathname !== "/client/") {
    history.replaceState({ ompDirectory: dashboardSnapshot.historyState }, "", "/");
    history.pushState({ ompCollab: true }, "", "/client/");
  }
  document.body.className = "collab-shell-active";
  document.body.replaceChildren(shell);
  document.title = `${sessionTitle(session)} · OMP Sessions`;

  const shellState: ActiveCollabShell = {
    instanceId: session.instanceId,
    generation: session.generation,
    ...(requestId === undefined ? {} : { openedRequestId: requestId }),
    connectionChip: connection,
    triageBar,
    shell,
    answerShown: false,
    answerTriageVisible: false,
    hasBeenLive: false,
  };
  activeCollabShell = shellState;
  // A live shell supersedes any disposed predecessor, so the bfcache restore path must not fire.
  collabShellDisposedOnPageHide = false;

  const updateConnection = (state: CollabEmbedState): void => {
    shellState.latestEmbedState = state;
    renderConnectionState(shellState);
    reconcileActiveCollabShell();
  };

  let disposeClient = (): void => undefined;
  const removeLifecycleListeners = (): void => {
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("popstate", handlePopState);
  };
  const dispose = (): void => {
    hideTriageBar(shellState, false);
    clearConnectionTimers(shellState);
    removeLifecycleListeners();
    disposeClient();
    disposeClient = (): void => undefined;
    if (activeCollabShell === shellState) activeCollabShell = undefined;
    if (disposeActiveCollab === dispose) disposeActiveCollab = undefined;
  };
  const handlePageHide = (): void => {
    collabShellDisposedOnPageHide = true;
    dispose();
  };
  const handlePopState = (event: PopStateEvent): void => {
    returnToDirectory(event.state);
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("popstate", handlePopState);
  try {
    disposeClient = startCollabWithCapability(
      container,
      capability,
      () => {
        // The client has already unmounted itself. Restore the cached directory synchronously so a
        // failed location.replace() cannot strand an inert shell without lifecycle listeners.
        disposeClient = (): void => undefined;
        returnToDirectory();
      },
      {
        focusPendingRequest: requestId !== undefined,
        shellOwnsLifecycle: true,
        onStateChange: updateConnection,
      },
    );
    disposeActiveCollab = dispose;
  } catch (error) {
    dispose();
    returnToDirectory();
    throw error;
  }
}

async function launch(
  session: SessionMetadata,
  mode: LaunchMode,
  button?: HTMLButtonElement,
  requestId?: string,
): Promise<void> {
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
      body: JSON.stringify({
        mode,
        generation: session.generation,
        ...(requestId === undefined ? {} : { requestId }),
      }),
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
    enterCollabClient(capability, startCollabWithCapability, session, mode, requestId);
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
  const timeoutMs =
    directoryLoaded || transportFailureSince !== undefined || navigator.onLine === false
      ? RECOVERY_SNAPSHOT_TIMEOUT_MS
      : SNAPSHOT_TIMEOUT_MS;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
    clearReconnectTimeout();
    reconnectAttempt = 0;
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
    // Native EventSource reconnects on network restoration even when Android Chrome loses a
    // scheduled JavaScript timer. Keep that browser-owned recovery path alive; the snapshot retry
    // remains a bounded fallback and will close this source if it fires first.
    markEventStreamInterrupted(source, epoch);
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
networkRecoveryHelpClose.addEventListener("click", () => networkRecoveryHelp.close());
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
  if (!event.persisted) return;
  if (collabShellDisposedOnPageHide) {
    returnToDirectory();
    return;
  }
  void refreshAndConnect();
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
  // `online` is not a dependable wake-up. Issue #65 measured `navigator.onLine` reporting true
  // through a total outage on the device, so an offline state whose only exit is an `online` event
  // is a state the page can never leave. Keep the bounded retry chain running instead.
  scheduleReconnect();
});

/**
 * Resume is a recovery signal Android actually delivers, so treat it as one.
 *
 * A page frozen across a network change has no way to notice the change: its timers did not run and
 * its `EventSource` still reports open. `pageshow` does not cover this — it fires for a bfcache
 * restore, not for freeze/resume of the foreground page. So on resume, unless the stream can be
 * shown to be live, throw the whole connection away and build a new one now rather than waiting out
 * a timer that was frozen with it.
 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    clearTransportFailureTracking();
    return;
  }
  if (authorizationDenied || directoryStreamIsLive()) return;
  void refreshAndConnect();
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
      await launch(session, "control", undefined, pendingAttentionLaunch.requestId);
    } else {
      setStatus("expired", "That attention request was already resolved or the session changed.");
    }
  }
}
