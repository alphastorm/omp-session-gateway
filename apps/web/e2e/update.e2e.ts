import { expect, type Page, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture, type DashboardFixture } from "./fixture-server.ts";

function session(): SessionMetadata {
  return {
    instanceId: "pwa-upgrade-0001",
    generation: 1,
    title: "Automatic PWA upgrade",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-25T05:00:00.000Z",
    lastSeenAt: "2026-07-25T05:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
  };
}


async function installLoadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const prior = Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10);
    sessionStorage.setItem("omp-e2e-loads", String(prior + 1));
  });
}

async function waitForControlledWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) return;
    await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });
}

async function triggerWorkerUpgrade(page: Page, fixture: DashboardFixture): Promise<void> {
  await page.evaluate(async () => {
    await caches.open("omp-sessions-shell-e2e-previous");
  });
  fixture.upgradeServiceWorker();
  try {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
  } catch (error) {
    if (!String(error).includes("Execution context was destroyed")) throw error;
  }
}


async function loadCount(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10));
  } catch {
    return 0;
  }
}

test("an updated PWA activates and reloads an idle directory automatically", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".session-card")).toHaveCount(1);
    await waitForControlledWorker(page);
    expect(await loadCount(page)).toBe(1);

    await triggerWorkerUpgrade(page, fixture);

    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".session-card")).toHaveCount(1);
  } finally {
    await fixture.stop();
  }
});

test("an updated PWA preserves active collaboration until the user leaves", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: class {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readyState = 0;
        binaryType = "blob";
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        close(): void { this.readyState = 3; }
        send(): void {}
      },
    });
  });

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    await page.getByRole("button", { name: "View Automatic PWA upgrade" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(await loadCount(page)).toBe(1);

    await page.evaluate(() => {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        sessionStorage.setItem("omp-e2e-controller-changed", "true");
      }, { once: true });
    });
    await triggerWorkerUpgrade(page, fixture);
    await expect.poll(
      () => page.evaluate(() => sessionStorage.getItem("omp-e2e-controller-changed")),
    ).toBe("true");
    await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });

    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(await loadCount(page)).toBe(1);

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page.locator(".session-card")).toHaveCount(1);
  } finally {
    await fixture.stop();
  }
});
