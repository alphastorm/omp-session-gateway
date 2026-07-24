import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture } from "./fixture-server.ts";

interface NotificationTestState {
  permission: NotificationPermission;
  permissionRequests: number;
  subscribeCalls: number;
  subscriptionActive: boolean;
  unsubscribeCalls: number;
}

function session(instanceId: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
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

async function notificationState(page: Page): Promise<NotificationTestState> {
  return page.evaluate(() => {
    const testGlobal = globalThis as unknown as { __ompNotificationTest: NotificationTestState };
    return structuredClone(testGlobal.__ompNotificationTest);
  });
}

test("attention cards and explicit background Web Push stay metadata-only", async ({ context, page }) => {
  const controlAttention = session("attention-control-0001", { inputRequired: true });
  const viewAttention = session("attention-viewonly-002", {
    canControl: false,
    inputRequired: true,
    startedAt: "2026-07-21T09:00:00.000Z",
  });
  const ordinary = session("ordinary-newest-0003", { startedAt: "2026-07-21T12:00:00.000Z" });
  const fixture = await startDashboardFixture([ordinary, viewAttention, controlAttention]);
  const forbiddenCanaries = [
    "PROMPT_CONTENT_CANARY",
    "OPTION_CONTENT_CANARY",
    "PREFILL_CONTENT_CANARY",
    "ANSWER_CONTENT_CANARY",
    "PRIVATE_REQUEST_ID_CANARY",
    "CAPABILITY_CONTENT_CANARY",
  ];

  try {
    await page.addInitScript(() => {
      const state: NotificationTestState = {
        permission: "default",
        permissionRequests: 0,
        subscribeCalls: 0,
        subscriptionActive: false,
        unsubscribeCalls: 0,
      };
      const subscriptionJson = {
        endpoint: "https://push.example.test/send/e2e-browser",
        expirationTime: null,
        keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      };
      let subscription: PushSubscription | null = null;
      const createSubscription = (): PushSubscription => ({
        endpoint: subscriptionJson.endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey(): ArrayBuffer | null {
          return null;
        },
        async unsubscribe(): Promise<boolean> {
          state.unsubscribeCalls += 1;
          state.subscriptionActive = false;
          subscription = null;
          return true;
        },
        toJSON(): PushSubscriptionJSON {
          return structuredClone(subscriptionJson);
        },
      });
      const pushManager = {
        async getSubscription(): Promise<PushSubscription | null> {
          return subscription;
        },
        async subscribe(): Promise<PushSubscription> {
          state.subscribeCalls += 1;
          state.subscriptionActive = true;
          subscription = createSubscription();
          return subscription;
        },
      };
      Object.defineProperty(globalThis, "__ompNotificationTest", { configurable: true, value: state });
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: class {
          static get permission(): NotificationPermission {
            return state.permission;
          }

          static async requestPermission(): Promise<NotificationPermission> {
            state.permissionRequests += 1;
            state.permission = "granted";
            return state.permission;
          }
        },
      });
      Object.defineProperty(globalThis, "PushManager", {
        configurable: true,
        value: class {},
      });
      Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
        configurable: true,
        get(): typeof pushManager {
          return pushManager;
        },
      });
      Object.defineProperty(ServiceWorkerRegistration.prototype, "showNotification", {
        configurable: true,
        async value(): Promise<void> {},
      });
    });

    await page.goto(fixture.origin);
    await expect(page.locator(".session-card")).toHaveCount(3);
    await expect(page.locator(".session-card h2")).toHaveText([
      "attention-control-0001",
      "attention-viewonly-002",
      "ordinary-newest-0003",
    ]);
    await expect(page.locator(".attention")).toHaveText([
      "Needs attention",
      "Needs attention — Control unavailable",
    ]);
    await expect(page.locator(".session-card").nth(0).getByRole("button")).toHaveText(["View", "Control"]);
    await expect(page.locator(".session-card").nth(1).getByRole("button")).toHaveText(["View"]);
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });

    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.locator("#notify")).toHaveText("Enable background alerts");
    await expect(page.locator("#notify-note")).toHaveText(
      "Alerts work with the app closed. Tapping one opens current Control after revalidation.",
    );
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });

    await page.locator("#notify").click();
    await expect(page.locator("#notify")).toHaveText("Disable background alerts");
    expect(await notificationState(page)).toMatchObject({
      permission: "granted",
      permissionRequests: 1,
      subscribeCalls: 1,
      subscriptionActive: true,
      unsubscribeCalls: 0,
    });
    expect(fixture.requests).toContain("POST /api/v1/push/subscription");

    const worker = context.serviceWorkers().find(candidate => candidate.url().endsWith("/service-worker.js"));
    expect(worker).toBeDefined();
    const pushResult = await worker!.evaluate(async () => {
      const scope = globalThis as unknown as {
        dispatchEvent(event: Event): boolean;
        registration: ServiceWorkerRegistration;
      };
      const showDescriptor = Object.getOwnPropertyDescriptor(scope.registration, "showNotification");
      let completion: Promise<unknown> = Promise.resolve();
      let shown: { title: string; options: Record<string, unknown> } | undefined;
      Object.defineProperty(scope.registration, "showNotification", {
        configurable: true,
        async value(title: string, options: NotificationOptions): Promise<void> {
          shown = { title, options: structuredClone(options) as Record<string, unknown> };
        },
      });
      try {
        const message = {
          version: 1,
          type: "attention",
          instanceId: "attention-control-0001",
          generation: 1,
        };
        const event = new Event("push");
        Object.defineProperties(event, {
          data: { value: { json(): unknown { return message; } } },
          waitUntil: { value(promise: Promise<unknown>): void { completion = promise; } },
        });
        scope.dispatchEvent(event);
        await completion;
      } finally {
        if (showDescriptor === undefined) Reflect.deleteProperty(scope.registration, "showNotification");
        else Object.defineProperty(scope.registration, "showNotification", showDescriptor);
      }
      return shown;
    });
    expect(pushResult).toEqual({
      title: "OMP session needs attention",
      options: {
        badge: "/icon-192.png",
        data: {
          version: 1,
          type: "attention",
          instanceId: "attention-control-0001",
          generation: 1,
        },
        icon: "/icon-192.png",
        tag: "omp-attention-attention-control-0001-1",
      },
    });

    const notificationClick = await worker!.evaluate(async () => {
      const scope = globalThis as unknown as { dispatchEvent(event: Event): boolean; location: Location };
      const clientsDescriptor = Object.getOwnPropertyDescriptor(scope, "clients");
      let closed = false;
      let focused = false;
      let opened = false;
      let navigated = "";
      let completion: Promise<unknown> = Promise.resolve();
      Object.defineProperty(scope, "clients", {
        configurable: true,
        value: {
          async matchAll(): Promise<readonly unknown[]> {
            return [{
              url: `${scope.location.origin}/`,
              async navigate(path: string): Promise<object> {
                navigated = path;
                return {
                  async focus(): Promise<object> {
                    focused = true;
                    return {};
                  },
                };
              },
            }];
          },
          async openWindow(): Promise<null> {
            opened = true;
            return null;
          },
        },
      });
      try {
        const event = new Event("notificationclick");
        Object.defineProperties(event, {
          notification: {
            value: {
              close(): void { closed = true; },
              data: {
                version: 1,
                type: "attention",
                instanceId: "attention-control-0001",
                generation: 1,
              },
            },
          },
          waitUntil: { value(promise: Promise<unknown>): void { completion = promise; } },
        });
        scope.dispatchEvent(event);
        await completion;
      } finally {
        if (clientsDescriptor === undefined) Reflect.deleteProperty(scope, "clients");
        else Object.defineProperty(scope, "clients", clientsDescriptor);
      }
      return { closed, focused, opened, navigated };
    });
    expect(notificationClick).toEqual({
      closed: true,
      focused: true,
      opened: false,
      navigated: "/attention/attention-control-0001/1",
    });

    await page.locator("#notify").click();
    await expect(page.locator("#notify")).toHaveText("Enable background alerts");
    expect(await notificationState(page)).toMatchObject({
      subscribeCalls: 1,
      subscriptionActive: false,
      unsubscribeCalls: 1,
    });
    expect(fixture.requests).toContain("DELETE /api/v1/push/subscription");

    const browserResidue = await page.evaluate(async canaries => {
      const cacheEntries: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          cacheEntries.push(request.url, await (await cache.match(request))!.text());
        }
      }
      const databaseNames = typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map(database => database.name ?? "")
        : [];
      const text = [
        document.documentElement.textContent ?? "",
        location.href,
        JSON.stringify(history.state),
        document.cookie,
        JSON.stringify({ ...localStorage }),
        JSON.stringify({ ...sessionStorage }),
        JSON.stringify(databaseNames),
        JSON.stringify(cacheEntries),
        (() => {
          const testGlobal = globalThis as unknown as { __ompNotificationTest: NotificationTestState };
          return JSON.stringify(testGlobal.__ompNotificationTest);
        })(),
      ].join("\n");
      return {
        found: canaries.filter(canary => text.includes(canary)),
        cacheUrls: cacheEntries.filter(entry => entry.startsWith("http")),
      };
    }, forbiddenCanaries);
    expect(browserResidue.found).toEqual([]);
    expect(browserResidue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
    expect(fixture.requests.some(request => request.includes("/launch") || request.includes("/client/"))).toBe(false);
    expect(forbiddenCanaries.some(canary => JSON.stringify(pushResult).includes(canary))).toBe(false);
  } finally {
    await fixture.stop();
  }
});
