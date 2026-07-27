import { expect, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture } from "./fixture-server.ts";

function session(): SessionMetadata {
  return {
    instanceId: "network-recovery-0001",
    generation: 1,
    title: "Wi-Fi roaming session",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-25T05:00:00.000Z",
    lastSeenAt: "2026-07-25T05:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
  };
}

test("dashboard reconnects after its live transport is interrupted", async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([active]);

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);

    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/events").length,
    ).toBeGreaterThanOrEqual(1);

    fixture.disconnectEvents();
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "relay", { timeout: 900 });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Reconnecting to relay…");
    await expect(page.locator(".working-row")).toHaveCount(1);

    fixture.setSnapshot([active], 2);
    await expect(page.locator(".working-row")).toHaveCount(1, { timeout: 6_000 });
    await expect(page.locator("#status-banner")).toBeHidden();
    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/sessions").length,
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/events").length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await fixture.stop();
  }
});

test("failure states keep stale sessions, exact copy, timestamps, and mobile fit", async ({ context, page }) => {
  const active = session();
  const fixture = await startDashboardFixture([active]);
  const assertFits = async (): Promise<void> => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator(".working-row")).toHaveCount(1);
  };

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);

    await context.setOffline(true);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "offline");
    await expect(page.locator("#status-banner .status-title")).toHaveText("You're offline");
    await expect(page.locator("#status-banner .status-detail")).toContainText(
      "This phone has no connection. Showing the list as of",
    );
    await assertFits();

    await context.setOffline(false);
    await expect(page.locator("#status-banner")).toBeHidden({ timeout: 6_000 });

    await page.route("**/api/v1/sessions", route => route.abort("connectionrefused"));
    fixture.disconnectEvents();
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "tailnet", {
      timeout: 6_000,
    });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Tailnet unreachable");
    await expect(page.locator("#status-banner .status-detail")).toHaveText(
      "Phone is online, but your tailnet isn't answering — Tailscale is off or logged out on this phone.",
    );
    await expect(page.locator("#status-banner .status-freshness")).toContainText("Last seen");
    await assertFits();

    await page.unroute("**/api/v1/sessions");
    await expect(page.locator("#status-banner")).toBeHidden({ timeout: 6_000 });

    await page.route("**/api/v1/sessions", route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    fixture.disconnectEvents();
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop", {
      timeout: 6_000,
    });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Desktop unreachable");
    await expect(page.locator("#status-banner .status-detail")).toContainText(
      "Tailnet looks fine, but the desktop isn't answering — asleep, or the gateway stopped. Last seen",
    );
    const retryHeight = await page.locator("#status-banner .status-action").evaluate(
      element => element.getBoundingClientRect().height,
    );
    expect(retryHeight).toBeGreaterThanOrEqual(44);
    await assertFits();

    await page.unroute("**/api/v1/sessions");
    await expect(page.locator("#status-banner")).toBeHidden({ timeout: 6_000 });

    fixture.disconnectEvents();
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "relay", {
      timeout: 900,
    });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Reconnecting to relay…");
    await expect(page.locator("#status-banner .status-detail")).toContainText(
      "Live updates paused; showing the list as of",
    );
    await assertFits();
  } finally {
    await context.setOffline(false);
    await fixture.stop();
  }
});
