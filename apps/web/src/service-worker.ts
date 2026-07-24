import { parseAttentionPushMessage, type AttentionPushMessage } from "@omp-session-gateway/protocol";

declare const __SHELL_ASSETS__: readonly string[];
declare const __CACHE_NAME__: string;

const shellAssets = new Set(__SHELL_ASSETS__);
const worker = globalThis as unknown as ServiceWorkerGlobalScope;

function isNotificationSupportRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-request" &&
    record.version === 1
  );
}

worker.addEventListener("message", event => {
  if (!isNotificationSupportRequest(event.data)) return;
  event.ports[0]?.postMessage({ type: "omp-notification-support-response", version: 1 });
});

function notificationTag(message: AttentionPushMessage): string {
  return `omp-attention-${message.instanceId}-${message.generation}`;
}

worker.addEventListener("push", event => {
  let message: AttentionPushMessage;
  try {
    if (event.data === null) return;
    message = parseAttentionPushMessage(event.data.json());
  } catch {
    return;
  }
  const tag = notificationTag(message);
  event.waitUntil(
    message.type === "resolved"
      ? worker.registration
          .getNotifications({ tag })
          .then(notifications => {
            for (const notification of notifications) notification.close();
          })
      : worker.registration.showNotification("OMP session needs attention", {
          tag,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          data: message,
        }),
  );
});

worker.addEventListener("notificationclick", event => {
  event.notification.close();
  let path = "/";
  try {
    const message = parseAttentionPushMessage(event.notification.data);
    if (message.type === "attention") {
      path = `/attention/${encodeURIComponent(message.instanceId)}/${message.generation}`;
    }
  } catch {
    // Invalid or legacy notification data returns to the non-secret directory.
  }
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      const dashboard = windows.find(client => {
        const url = new URL(client.url);
        return (
          url.origin === worker.location.origin &&
          (url.pathname === "/" || url.pathname.startsWith("/attention/"))
        );
      });
      if (dashboard !== undefined) {
        try {
          const navigated = await dashboard.navigate(path);
          const focused = await navigated?.focus();
          if (focused !== null && focused !== undefined) return;
        } catch {
          // Fall through to a fresh dashboard window.
        }
      }
      await worker.clients.openWindow(path);
    })(),
  );
});

worker.addEventListener("install", event => {
  event.waitUntil(caches.open(__CACHE_NAME__).then(cache => cache.addAll(__SHELL_ASSETS__)));
});

worker.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(names => Promise.all(names.filter(name => name.startsWith("omp-sessions-shell-") && name !== __CACHE_NAME__).map(name => caches.delete(name)))),
  );
});

worker.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    request.mode === "navigate" ||
    url.origin !== worker.location.origin ||
    url.search !== "" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/client/") ||
    url.pathname.startsWith("/internal/") ||
    !shellAssets.has(url.pathname)
  ) {
    return;
  }
  event.respondWith(
    caches.open(__CACHE_NAME__).then(async cache => {
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});
