import { expect, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture } from "./fixture-server.ts";

function session(): SessionMetadata {
  return {
    instanceId: "standalone-launch-0001",
    generation: 1,
    title: "Android standalone launch",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-21T10:00:00.000Z",
    lastSeenAt: "2026-07-21T10:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: true,
  };
}

test("installed-PWA View and Control mount in the current window without losing the handoff", async ({ context, page }) => {
  const fixture = await startDashboardFixture([session()]);
  let auxiliaryPages = 0;
  context.on("page", candidate => {
    if (candidate !== page) auxiliaryPages += 1;
  });

  try {
    await page.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string): MediaQueryList => {
        if (query !== "(display-mode: standalone)") return nativeMatchMedia(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addEventListener(): void {},
          removeEventListener(): void {},
          addListener(): void {},
          removeListener(): void {},
          dispatchEvent(): boolean { return true; },
        };
      };
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: class {
          static readonly CONNECTING = 0;
          static readonly OPEN = 1;
          static readonly CLOSING = 2;
          static readonly CLOSED = 3;
          readonly url: string;
          readyState = 0;
          binaryType = "blob";
          onopen: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;

          constructor(url: string) {
            this.url = url;
          }

          close(): void {
            this.readyState = 3;
          }

          send(): void {}
        },
      });
    });

    await page.goto(fixture.origin);
    const card = page.locator(".session-card");
    await expect(card).toHaveCount(1);

    await card.getByRole("button", { name: "View Android standalone launch" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests).toContain("POST /api/v1/sessions/standalone-launch-0001/launch");

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".session-card")).toHaveCount(1);

    await page.locator(".session-card").getByRole("button", { name: "Control Android standalone launch" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests.filter(request => request.endsWith("/launch"))).toHaveLength(2);

    const residue = await page.evaluate(async () => ({
      url: location.href,
      historyState: JSON.stringify(history.state),
      localStorage: JSON.stringify({ ...localStorage }),
      sessionStorage: JSON.stringify({ ...sessionStorage }),
      cacheUrls: (await Promise.all((await caches.keys()).map(async name => {
        const cache = await caches.open(name);
        return (await cache.keys()).map(request => request.url);
      }))).flat(),
    }));
    expect(residue.url).toBe(`${fixture.origin}/client/`);
    expect(residue.url).not.toContain("handoff");
    expect(residue.url).not.toContain("#");
    expect(residue.historyState).toBe("null");
    expect(JSON.parse(residue.localStorage)).toEqual({ "omp.collab.name": "guest" });
    expect(residue.sessionStorage).toBe("{}");
    expect(residue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
  } finally {
    await fixture.stop();
  }
});
