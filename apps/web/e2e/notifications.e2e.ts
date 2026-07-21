import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture } from "./fixture-server.ts";

interface NotificationTestState {
  permission: NotificationPermission;
  permissionRequests: number;
  notifications: Array<{ title: string; options: Record<string, unknown> }>;
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

test("attention cards and explicit foreground notifications stay metadata-only", async ({ context, page }) => {
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
        notifications: [],
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
      Object.defineProperty(ServiceWorkerRegistration.prototype, "showNotification", {
        configurable: true,
        async value(title: string, options: NotificationOptions = {}): Promise<void> {
          state.notifications.push({ title, options: structuredClone(options) as Record<string, unknown> });
        },
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
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, notifications: [] });

    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.locator("#notify")).toHaveText("Enable notifications");
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, notifications: [] });
    await expect(page.locator("#notify-note")).toHaveText(
      "Notifications may show session names on your lock screen.",
    );

    await page.locator("#notify").click();
    await expect(page.locator("#notify")).toHaveText("Notifications enabled");
    expect(await notificationState(page)).toMatchObject({ permission: "granted", permissionRequests: 1 });

    fixture.upsert({ ...ordinary, inputRequired: true });
    await expect.poll(async () => (await notificationState(page)).notifications.length).toBe(1);
    expect((await notificationState(page)).notifications).toEqual([
      { title: "OMP session needs attention", options: { body: ordinary.title } },
    ]);
    fixture.upsert({ ...ordinary, inputRequired: true });
    expect((await notificationState(page)).notifications).toHaveLength(1);

    fixture.upsert(ordinary);
    await expect(page.locator(".session-card").filter({ hasText: ordinary.title ?? "" }).locator(".attention")).toHaveCount(0);
    fixture.upsert({ ...ordinary, inputRequired: true });
    await expect.poll(async () => (await notificationState(page)).notifications.length).toBe(2);

    fixture.upsert(ordinary);
    fixture.disconnectEvents();
    await expect(page.locator(".session-card")).toHaveCount(0);
    fixture.setSnapshot([{ ...ordinary, inputRequired: true }, viewAttention, controlAttention]);
    await expect.poll(async () => (await notificationState(page)).notifications.length, { timeout: 8_000 }).toBe(3);
    await expect(page.locator(".session-card")).toHaveCount(3);

    const worker = context.serviceWorkers().find(candidate => candidate.url().endsWith("/service-worker.js"));
    expect(worker).toBeDefined();
    const notificationClick = await worker!.evaluate(async () => {
      const scope = globalThis as unknown as { dispatchEvent(event: Event): boolean; location: Location };
      const clientsDescriptor = Object.getOwnPropertyDescriptor(scope, "clients");
      let closed = false;
      let focused = false;
      let opened = false;
      let completion: Promise<unknown> = Promise.resolve();
      Object.defineProperty(scope, "clients", {
        configurable: true,
        value: {
          async matchAll(): Promise<readonly unknown[]> {
            return [{
              url: `${scope.location.origin}/`,
              async focus(): Promise<object> {
                focused = true;
                return {};
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
          notification: { value: { close(): void { closed = true; } } },
          waitUntil: { value(promise: Promise<unknown>): void { completion = promise; } },
        });
        scope.dispatchEvent(event);
        await completion;
      } finally {
        if (clientsDescriptor === undefined) Reflect.deleteProperty(scope, "clients");
        else Object.defineProperty(scope, "clients", clientsDescriptor);
      }
      return { closed, focused, opened };
    });
    expect(notificationClick).toEqual({ closed: true, focused: true, opened: false });
    await expect(page).toHaveURL(`${fixture.origin}/`);

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
    expect(browserResidue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
    expect(fixture.requests.some(request => request.includes("/launch") || request.includes("/client/"))).toBe(false);
    for (const call of (await notificationState(page)).notifications) {
      expect(Object.keys(call.options)).toEqual(call.options.body === undefined ? [] : ["body"]);
    }
  } finally {
    await fixture.stop();
  }
});
