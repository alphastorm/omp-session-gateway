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
  const merged = {
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
  if (!merged.inputRequired || merged.ask !== undefined) return merged;
  return {
    ...merged,
    ask: {
      requestId: `request-${instanceId}`,
      since: merged.lastSeenAt,
    },
  };
}

async function notificationState(page: Page): Promise<NotificationTestState> {
  return page.evaluate(() => {
    const testGlobal = globalThis as unknown as { __ompNotificationTest: NotificationTestState };
    return structuredClone(testGlobal.__ompNotificationTest);
  });
}

test("attention cards and explicit background alert settings stay metadata-only", async ({ page }) => {
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
    await expect(page.locator("#directory-title")).toHaveText("Needs you");
    await expect(page.locator("#directory-count")).toHaveText("2 waiting");
    await expect(page.locator(".queue-hero h2")).toHaveText("attention-control-0001");
    await expect(page.locator(".queue-hero .ask-preview")).toHaveText("Waiting for your input");
    await expect(page.locator(".queue-hero").getByRole("button")).toHaveText([
      "Open request",
      "View transcript instead",
    ]);
    await expect(page.locator(".queue-row .row-title")).toHaveText(["attention-viewonly-002"]);
    await expect(page.locator(".working-row .row-title")).toHaveText(["ordinary-newest-0003"]);
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const directoryTargets = await page
      .locator("#notify, .action-request, .hero-alt, .queue-row, .working-row")
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    expect(directoryTargets.every(height => height >= 44)).toBe(true);

    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.locator("#notify")).toHaveText("Enable background alerts");
    await expect(page.locator("#notify-note")).toHaveText(
      "Alerts work with the app closed. Tapping one opens current Control after revalidation.",
    );
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });

    await page.locator("#notify").click();
    await expect(page.locator("#notify")).toHaveText("Disable background alerts");
    await expect(page.locator("#notification-settings")).toBeVisible();
    await expect(page.locator('input[name="notification-detail"][value="session"]')).toBeChecked();
    await expect(page.locator(".sheet-footnote")).toHaveText(
      "Per-device, stored with the push subscription on the gateway. Payloads are built at the chosen level — the phone never redacts.",
    );
    await expect(page.locator(".detail-warning")).toContainText("notification history");
    const detailTargets = await page.locator(".detail-option").evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().height),
    );
    expect(detailTargets.every(height => height >= 44)).toBe(true);
    await page.locator('input[name="notification-detail"][value="preview"]').check();
    await expect(page.locator('input[name="notification-detail"][value="preview"]')).toBeChecked();
    expect(await notificationState(page)).toMatchObject({
      permission: "granted",
      permissionRequests: 1,
      subscribeCalls: 1,
      subscriptionActive: true,
      unsubscribeCalls: 0,
    });
    expect(fixture.requests).toContain("POST /api/v1/push/subscription");


    await page.locator("#notification-disable").click();
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
  } finally {
    await fixture.stop();
  }
});
