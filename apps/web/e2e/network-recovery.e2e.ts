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
    await expect(page.locator(".session-card")).toHaveCount(1);

    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/events").length,
    ).toBeGreaterThanOrEqual(1);

    fixture.disconnectEvents();
    await expect(page.locator("#status-banner")).toHaveText("Live updates paused. Reconnecting…");
    await expect(page.locator(".session-card")).toHaveCount(0);

    fixture.setSnapshot([active], 2);
    await expect(page.locator(".session-card")).toHaveCount(1, { timeout: 6_000 });
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
