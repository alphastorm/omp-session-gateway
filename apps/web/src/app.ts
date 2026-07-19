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

function setStatus(kind: "ready" | "offline" | "unauthorized" | "expired" | "loading", message: string): void {
  statusBanner.dataset.kind = kind;
  statusBanner.textContent = message;
  statusBanner.hidden = kind === "ready";
}

function formatStartedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Started recently" : `Started ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
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
  const ordered = [...sessions.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  emptyState.hidden = ordered.length !== 0;
  for (const session of ordered) {
    const article = document.createElement("article");
    article.className = "session-card";
    article.dataset.instanceId = session.instanceId;

    const heading = document.createElement("h2");
    heading.textContent = session.title || session.cwdLabel || "OMP session";
    const project = createMetadataLine("Project", session.cwdLabel);
    const model = createMetadataLine("Model", session.model);
    const timing = createMetadataLine("", formatStartedAt(session.startedAt));

    const actions = document.createElement("div");
    actions.className = "session-actions";
    const view = document.createElement("button");
    view.type = "button";
    view.className = "action action-primary";
    view.textContent = "View";
    view.disabled = !session.canView;
    view.addEventListener("click", () => void launch(session, "view", view));
    actions.append(view);

    if (session.canControl) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = "action action-control";
      control.textContent = "Control";
      control.addEventListener("click", () => void launch(session, "control", control));
      actions.append(control);
    }

    article.append(heading);
    if (project !== undefined) article.append(project);
    if (model !== undefined) article.append(model);
    if (timing !== undefined) article.append(timing);
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
  button.disabled = true;
  const handoff = crypto.randomUUID();
  const child = window.open(`/client/?handoff=${encodeURIComponent(handoff)}`, "_blank");
  if (child === null) {
    button.disabled = false;
    setStatus("offline", "Allow this site to open the collaboration client, then try again.");
    return;
  }
  const clientWindow = child;

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
    closeChild(child);
    button.disabled = false;
    setStatus("offline", "Gateway unavailable. Check your tailnet connection and try again.");
    return;
  }

  if (!response.ok) {
    closeChild(child);
    button.disabled = false;
    if (response.status === 403) setStatus("unauthorized", "This tailnet identity is not authorized.");
    else if (response.status === 404 || response.status === 409) {
      setStatus("expired", "That session changed or expired. The list has been refreshed.");
      await loadSnapshot();
    } else setStatus("offline", "The session could not be opened. Try again.");
    return;
  }

  let capability: string | undefined;
  try {
    const payload = parseLaunchResponse(await response.json());
    if (payload.mode !== mode || payload.generation !== session.generation) {
      throw new Error("invalid launch response");
    }
    capability = payload.capability;
  } catch {
    closeChild(child);
    button.disabled = false;
    setStatus("offline", "The gateway returned an invalid launch response.");
    return;
  }

  const channel = new MessageChannel();
  const timeout = window.setTimeout(() => {
    window.removeEventListener("message", receiveReady);
    capability = undefined;
    channel.port1.close();
    closeChild(child);
    button.disabled = false;
    setStatus("offline", "The collaboration client did not start. Try again.");
  }, 10_000);
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
    clientWindow.postMessage({ type: "omp-client-port", handoff }, location.origin, [channel.port2]);
    channel.port1.postMessage({ type: "omp-client-capability", handoff, mode, capability });
    capability = undefined;
  }
  channel.port1.onmessage = event => {
    const message = event.data as Record<string, unknown> | null;
    if (message?.type !== "omp-client-accepted" || message.handoff !== handoff) return;
    clearTimeout(timeout);
    channel.port1.close();
    button.disabled = false;
    setStatus("ready", "");
  };
  window.addEventListener("message", receiveReady);
}

function applyEvent(event: SessionEvent): void {
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
}

async function loadSnapshot(): Promise<void> {
  setStatus("loading", "Refreshing sessions…");
  try {
    const response = await fetch("/api/v1/sessions", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 403) {
      setStatus("unauthorized", "This tailnet identity is not authorized.");
      return;
    }
    if (!response.ok) throw new Error("snapshot failed");
    const payload = parseSessionListResponse(await response.json());
    sessions.clear();
    for (const session of payload.sessions) sessions.set(session.instanceId, session);
    render();
    setStatus("ready", "");
  } catch {
    sessions.clear();
    render();
    setStatus("offline", "Gateway unavailable. Check your tailnet connection.");
  }
}

function connectEvents(): void {
  events?.close();
  events = new EventSource("/api/v1/events", { withCredentials: true });
  for (const type of ["snapshot", "session_upsert", "session_remove"] as const) {
    events.addEventListener(type, event => {
      try {
        applyEvent(parseSessionEvent(JSON.parse(event.data)));
        setStatus("ready", "");
      } catch {
        events?.close();
        void loadSnapshot().then(connectEvents);
      }
    });
  }
  events.onerror = () => setStatus("offline", "Live updates paused. Reconnecting…");
}

refreshButton.addEventListener("click", () => void loadSnapshot().then(connectEvents));
window.addEventListener("pageshow", event => {
  if (event.persisted) void loadSnapshot().then(connectEvents);
});
window.addEventListener("online", () => void loadSnapshot().then(connectEvents));
window.addEventListener("offline", () => setStatus("offline", "Offline. Sessions are not available without the gateway."));

if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
await loadSnapshot();
connectEvents();
