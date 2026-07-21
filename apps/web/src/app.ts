import {
  parseLaunchResponse,
  parseSessionEvent,
  parseSessionListResponse,
  type LaunchMode,
  type SessionEvent,
  type SessionMetadata,
} from "@omp-session-gateway/protocol";

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error("application shell is incomplete");
  return element;
}

const sessionList = requiredElement<HTMLElement>("#session-list");
const emptyState = requiredElement<HTMLElement>("#empty-state");
const statusBanner = requiredElement<HTMLElement>("#status-banner");
const refreshButton = requiredElement<HTMLButtonElement>("#refresh");

const sessions = new Map<string, SessionMetadata>();
let events: EventSource | undefined;
let directoryLoaded = false;
let authorizationDenied = false;
let refreshRequests = 0;
let directoryEpoch = 0;
let directoryRevision = -1;
let snapshotController: AbortController | undefined;

function setStatus(kind: "ready" | "offline" | "unauthorized" | "expired" | "loading", message: string): void {
  statusBanner.dataset.kind = kind;
  statusBanner.textContent = message;
  statusBanner.hidden = kind === "ready";
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

function closeChild(child: Window | null): void {
  try {
    child?.close();
  } catch {
    // Cross-origin navigation is never expected; a browser may still reject close.
  }
}

async function launch(session: SessionMetadata, mode: LaunchMode, button: HTMLButtonElement): Promise<void> {
  const idleLabel = button.textContent ?? (mode === "view" ? "View" : "Control");
  button.disabled = true;
  button.dataset.busy = "true";
  button.setAttribute("aria-busy", "true");
  button.textContent = mode === "view" ? "Opening view…" : "Opening control…";
  const resetButton = (): void => {
    button.disabled = mode === "view" && !session.canView;
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    button.textContent = idleLabel;
  };

  const handoff = crypto.randomUUID();
  const child = window.open(`/client/?handoff=${encodeURIComponent(handoff)}`, "_blank");
  if (child === null) {
    resetButton();
    setStatus("offline", "Allow this site to open the collaboration client, then try again.");
    return;
  }
  const clientWindow = child;
  const channel = new MessageChannel();
  const controller = new AbortController();
  let settled = false;
  let capability: string | undefined;
  let timeout = 0;
  const cleanup = (closeWindow: boolean): void => {
    window.removeEventListener("message", receiveReady);
    clearTimeout(timeout);
    controller.abort();
    capability = undefined;
    channel.port1.close();
    try {
      channel.port2.close();
    } catch {
      // The port may already have been transferred to the client.
    }
    if (closeWindow) closeChild(child);
    resetButton();
  };
  const fail = (kind: "offline" | "unauthorized" | "expired", message: string): void => {
    if (settled) return;
    settled = true;
    cleanup(true);
    setStatus(kind, message);
  };
  function receiveReady(event: MessageEvent): void {
    const message = event.data as Record<string, unknown> | null;
    if (
      event.origin !== location.origin ||
      event.source !== clientWindow ||
      message === null ||
      message.type !== "omp-client-ready" ||
      message.handoff !== handoff
    ) {
      return;
    }
    window.removeEventListener("message", receiveReady);
    try {
      clientWindow.postMessage({ type: "omp-client-port", handoff }, location.origin, [channel.port2]);
    } catch {
      fail("offline", "The collaboration client did not start. Try again.");
    }
  }
  channel.port1.onmessage = event => {
    const message = event.data as Record<string, unknown> | null;
    if (message?.type !== "omp-client-accepted" || message.handoff !== handoff || settled) return;
    settled = true;
    cleanup(false);
    setStatus("ready", "");
  };
  window.addEventListener("message", receiveReady);
  timeout = window.setTimeout(
    () => fail("offline", "The collaboration client did not start. Try again."),
    10_000,
  );

  let response: Response;
  try {
    response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, generation: session.generation }),
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
  } catch {
    if (!settled) fail("offline", "Gateway unavailable. Check your tailnet connection and try again.");
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

  try {
    const payload = parseLaunchResponse(await response.json());
    if (payload.mode !== mode || payload.generation !== session.generation) {
      throw new Error("invalid launch response");
    }
    capability = payload.capability;
    if (settled) return;
    channel.port1.postMessage({ type: "omp-client-capability", handoff, mode, capability });
    capability = undefined;
  } catch {
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
  };
  for (const type of ["snapshot", "session_upsert", "session_remove"] as const) {
    source.addEventListener(type, event => {
      if (events !== source || epoch !== directoryEpoch) return;
      try {
        if (applyEvent(parseSessionEvent(JSON.parse(event.data)), epoch)) setStatus("ready", "");
      } catch {
        source.close();
        if (events === source) events = undefined;
        void refreshAndConnect();
      }
    });
  }
  source.onerror = () => {
    if (events !== source || epoch !== directoryEpoch) return;
    directoryRevision = -1;
    directoryLoaded = false;
    sessions.clear();
    render();
    if (authorizationDenied) setStatus("unauthorized", "This tailnet identity is not authorized.");
    else setStatus("offline", "Live updates paused. Reconnecting…");
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
  const loaded = await loadSnapshot(epoch);
  if (loaded && epoch === directoryEpoch) connectEvents(epoch);
  return loaded && epoch === directoryEpoch;
}
refreshButton.addEventListener("click", () => void refreshAndConnect());
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
  events = undefined;
  authorizationDenied = false;
  directoryLoaded = false;
  sessions.clear();
  render();
  setStatus("offline", "Offline. Sessions are not available without the gateway.");
});

if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
await refreshAndConnect();
