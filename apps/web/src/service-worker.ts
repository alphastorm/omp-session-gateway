import {
  PUSH_API_VERSION,
  parseAttentionPushMessage,
  parseNotificationData,
  notificationRoutePath,
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

// Serialize notification read/replace and badge updates across overlapping push events.
let pushTail: Promise<void> = Promise.resolve();
worker.addEventListener("push", event => {
  let message: AttentionPushMessage;
  try {
    if (event.data === null) return;
    message = parseAttentionPushMessage(event.data.json());
  } catch {
    return;
  }
  const tag = `omp-attention-${message.instanceId}`;
  const delivery = pushTail.then(async () => {
    if (message.type === "clear") {
      const notifications = await worker.registration.getNotifications({ tag });
      for (const notification of notifications) {
        const intent = parseNotificationData(notification.data);
        if (intent?.kind === "attention" && intent.instanceId === message.instanceId && intent.requestId === message.requestId) {
          notification.close();
        }
      }
    } else {
      const notifications = await worker.registration.getNotifications({ tag });
      if (message.type === "activity_stop") {
        if (notifications.some(notification => {
          const intent = parseNotificationData(notification.data);
          return intent?.kind === "attention" && intent.instanceId === message.instanceId;
        })) {
          await updateAppBadge(message.pendingAskCount);
          return;
        }
      }
      const options = {
        tag,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        renotify: message.type === "attention" && notifications.some(notification => {
          const intent = parseNotificationData(notification.data);
          return intent?.kind === "activity_stop" && intent.instanceId === message.instanceId;
        }),
        ...(message.body === undefined ? {} : { body: message.body }),
        data: {
          version: message.version,
          type: message.type,
          instanceId: message.instanceId,
          ...(message.type === "attention" ? { requestId: message.requestId } : { generation: message.generation }),
        },
      } satisfies NotificationOptions & { readonly renotify: boolean };
      await worker.registration.showNotification(message.title, options);
    }
    await updateAppBadge(message.pendingAskCount);
  });
  // Preserve this event's failure without poisoning later deliveries.
  pushTail = delivery.catch(() => {});
  event.waitUntil(delivery);
});

worker.addEventListener("notificationclick", event => {
  event.notification.close();
  const intent = parseNotificationData(event.notification.data);
  const path = intent === undefined ? "/" : notificationRoutePath(intent);
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
      await Promise.all(
        names
          .filter(name => name.startsWith(SHELL_CACHE_PREFIX) && name !== __CACHE_NAME__)
          .map(name => caches.delete(name)),
      );
      // Never navigate clients here. Chromium reports a window client's creation URL, not the route a
      // page later reaches through the history API, so a live `/client/` collaboration or a pending
      // launch looks exactly like an idle `/` directory. Each page observes the controller change and
      // reloads itself only when it is idle.
      await worker.clients.claim();
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
