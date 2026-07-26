import {
  PUSH_API_VERSION,
  parseAttentionPushMessage,
  type AttentionPushMessage,
} from "@omp-session-gateway/protocol";

declare const __SHELL_ASSETS__: readonly string[];
declare const __CACHE_NAME__: string;

const shellAssets = new Set(__SHELL_ASSETS__);
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const SHELL_CACHE_PREFIX = "omp-sessions-shell-";

function isNotificationSupportRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-request" &&
    record.version === PUSH_API_VERSION
  );
}

worker.addEventListener("message", event => {
  if (!isNotificationSupportRequest(event.data)) return;
  event.ports[0]?.postMessage({
    type: "omp-notification-support-response",
    version: PUSH_API_VERSION,
  });
});


async function updateAppBadge(pendingAskCount: number): Promise<void> {
  const badgeNavigator = worker.navigator as Navigator & {
    clearAppBadge?: () => Promise<void>;
    setAppBadge?: (contents?: number) => Promise<void>;
  };
  if (pendingAskCount === 0) {
    await badgeNavigator.clearAppBadge?.();
  } else {
    await badgeNavigator.setAppBadge?.(pendingAskCount);
  }
}

worker.addEventListener("push", event => {
  let message: AttentionPushMessage;
  try {
    if (event.data === null) return;
    message = parseAttentionPushMessage(event.data.json());
  } catch {
    return;
  }
  const tag = `omp-attention-${message.instanceId}`;
  event.waitUntil(
    (async () => {
      if (message.type === "clear") {
        const notifications = await worker.registration.getNotifications({ tag });
        for (const notification of notifications) {
          const data = notification.data as { readonly requestId?: unknown } | undefined;
          if (data?.requestId === message.requestId) notification.close();
        }
      } else {
        const options = {
          tag,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          renotify: false,
          ...(message.body === undefined ? {} : { body: message.body }),
          data: {
            version: message.version,
            type: message.type,
            instanceId: message.instanceId,
            requestId: message.requestId,
          },
        } satisfies NotificationOptions & { readonly renotify: boolean };
        await worker.registration.showNotification(message.title, options);
      }
      await updateAppBadge(message.pendingAskCount);
    })(),
  );
});

worker.addEventListener("notificationclick", event => {
  event.notification.close();
  let path = "/";
  const data = event.notification.data as Record<string, unknown> | undefined;
  if (
    data?.version === PUSH_API_VERSION &&
    data.type === "attention" &&
    typeof data.instanceId === "string" &&
    /^[A-Za-z0-9._:-]{16,128}$/u.test(data.instanceId) &&
    typeof data.requestId === "string" &&
    /^[A-Za-z0-9_-]{16,128}$/u.test(data.requestId)
  ) {
    path = `/collab/${encodeURIComponent(data.instanceId)}?request=${encodeURIComponent(data.requestId)}`;
  }
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      const dashboard = windows.find(client => {
        const url = new URL(client.url);
        return (
          url.origin === worker.location.origin &&
          (url.pathname === "/" || url.pathname.startsWith("/collab/"))
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
  event.waitUntil(
    (async () => {
      const cache = await caches.open(__CACHE_NAME__);
      await cache.addAll(__SHELL_ASSETS__);
      await worker.skipWaiting();
    })(),
  );
});

worker.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const shellUpgrade = names.some(name => name.startsWith(SHELL_CACHE_PREFIX) && name !== __CACHE_NAME__);
      await Promise.all(
        names
          .filter(name => name.startsWith(SHELL_CACHE_PREFIX) && name !== __CACHE_NAME__)
          .map(name => caches.delete(name)),
      );
      await worker.clients.claim();
      if (!shellUpgrade) return;
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        try {
          const url = new URL(client.url);
          if (url.origin !== worker.location.origin || url.pathname !== "/" || url.search !== "") continue;
          void client.navigate("/update/").catch(() => undefined);
        } catch {
          // Active collaboration and non-directory clients keep their current in-memory state.
        }
      }
    })(),
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
    url.pathname.startsWith("/collab/") ||
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
