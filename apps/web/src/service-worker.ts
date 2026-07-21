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

worker.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      const dashboard = windows.find(client => {
        const url = new URL(client.url);
        return url.origin === worker.location.origin && url.pathname === "/";
      });
      if (dashboard !== undefined) {
        try {
          const focused = await dashboard.focus();
          if (focused !== null) return;
        } catch {
          // Fall through to a fresh dashboard window.
        }
      }
      await worker.clients.openWindow("/");
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
