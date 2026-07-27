import { expect, test, type Page } from "@playwright/test";
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
    ask: {
      requestId: "standalone-request-0001",
      since: "2026-07-21T10:00:01.000Z",
    },
  };
}

function answeredSession(
  source: SessionMetadata,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  const answered = { ...source, ...overrides, inputRequired: false };
  delete answered.ask;
  return answered;
}

function workingSession(index: number): SessionMetadata {
  const id = `working-session-${String(index).padStart(4, "0")}`;
  return answeredSession(session(), {
    instanceId: id,
    title: id,
    startedAt: `2026-07-21T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
  });
}

async function installSilentWebSocket(page: Page): Promise<void> {
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

        close(): void {
          this.readyState = 3;
        }

        send(): void {}
      },
    });
  });
}

test("installed-PWA View and Control mount in the current window without losing the handoff", async ({ context, page }) => {
  const fixture = await startDashboardFixture([session(), ...Array.from({ length: 12 }, (_, index) => workingSession(index))]);
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
    const card = page.locator(".queue-hero");
    await expect(card).toHaveCount(1);
    const directoryOrder = await page.locator("[data-instance-id]").evaluateAll(elements =>
      elements.map(element => (element as HTMLElement).dataset.instanceId),
    );
    await page.evaluate(() => window.scrollTo(0, 360));
    const directoryScroll = await page.evaluate(() => window.scrollY);
    expect(directoryScroll).toBeGreaterThan(0);

    await card.getByRole("button", { name: "View transcript instead" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    await expect(page.locator(".shell-title")).toHaveText("Android standalone launch");
    await expect(page.locator(".shell-control")).toBeVisible();
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", /^(connected|reconnecting)$/u);
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "reconnecting");
    await expect(page.locator(".triage-copy")).toHaveText("Reconnecting to relay… composer paused");
    await expect(page.locator(".triage-action")).toHaveCount(0);
    const shellTargets = await page.locator(".shell-back, .shell-control").evaluateAll(elements =>
      elements.filter(element => !(element as HTMLElement).hidden).map(element => element.getBoundingClientRect().height),
    );
    expect(shellTargets.every(height => height >= 44)).toBe(true);
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests).toContain("POST /api/v1/sessions/standalone-launch-0001/launch");
    expect(fixture.launchRequests[0]).toEqual({
      instanceId: "standalone-launch-0001",
      generation: 1,
      mode: "view",
    });

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".queue-hero")).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(directoryScroll);
    expect(
      await page.locator("[data-instance-id]").evaluateAll(elements =>
        elements.map(element => (element as HTMLElement).dataset.instanceId),
      ),
    ).toEqual(directoryOrder);
    const controlDirectoryScroll = await page.evaluate(() => window.scrollY);

    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    await expect(page.locator(".shell-control")).toBeHidden();
    expect(fixture.launchRequests[1]).toEqual({
      instanceId: "standalone-launch-0001",
      generation: 1,
      mode: "control",
      requestId: "standalone-request-0001",
    });
    const next = {
      ...session(),
      instanceId: "next-attention-000001",
      title: "Next attention",
      ask: {
        requestId: "next-request-identity-0001",
        since: "2026-07-21T10:00:02.000Z",
      },
    };
    fixture.upsert(next);
    fixture.upsert(answeredSession(session()));
    await expect(page.locator(".triage-copy")).toHaveText("✓ Answered — 1 more needs you");
    await expect(page.locator(".triage-action")).toHaveText("Next ask →");
    await page.locator(".triage-action").click();
    await expect(page.locator(".shell-title")).toHaveText("Next attention");
    expect(fixture.launchRequests[2]).toEqual({
      instanceId: "next-attention-000001",
      generation: 1,
      mode: "control",
      requestId: "next-request-identity-0001",
    });
    fixture.upsert(answeredSession(next));
    await expect(page.locator(".triage-copy")).toHaveText("✓ Answered — all clear · 14 working");
    await expect(page.locator(".triage-action")).toHaveText("Sessions");
    await page.locator(".triage-action").click();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".all-clear-title")).toHaveText("All clear");
    await expect(page.locator(".all-clear-copy")).toHaveText(
      "Nothing needs you — 14 working. You'll get pinged.",
    );
    await expect(page.locator(".working-row")).toHaveCount(14);
    await expect(page.locator("#notify")).toBeVisible();
    const alertsAfterList = await page.evaluate(() =>
      Boolean(document.querySelector("#session-list + .home-alerts")),
    );
    expect(alertsAfterList).toBe(true);
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests.filter(request => request.endsWith("/launch"))).toHaveLength(3);

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
    expect(residue.url).toBe(`${fixture.origin}/`);
    expect(residue.url).not.toContain("handoff");
    expect(residue.url).not.toContain("#");
    expect(JSON.parse(residue.historyState)).toMatchObject({
      ompDirectory: { scrollY: controlDirectoryScroll },
    });
    expect(JSON.parse(residue.localStorage)).toEqual({ "omp.collab.name": "guest" });
    expect(residue.sessionStorage).toBe("{}");
    expect(residue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
  } finally {
    await fixture.stop();
  }
});

test("active ask marks only the explicit recommended option", async ({ page }) => {
  const roomKey = new Uint8Array(32).fill(37);
  const fixture = await startDashboardFixture([session()], { roomKey });

  try {
    await page.addInitScript(({ keyBytes }) => {
      const question = "How should ADR-0036 proceed?";
      const options = [
        { label: "Implement ADR-0036 locally", description: "Apply the compatibility fix in Alpha Founder." },
        { label: "Wait for upstream", description: "Leave the current behavior unchanged." },
      ];
      const args = {
        questions: [{ id: "adr-0036", question, options, multi: false, recommended: 0 }],
      };
      const key = crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-GCM", false, ["encrypt"]);
      const encoder = new TextEncoder();

      class AskWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly url: string;
        readyState = AskWebSocket.CONNECTING;
        binaryType: BinaryType = "arraybuffer";

        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        sentWelcome = false;

        constructor(url: string) {
          this.url = url;
          (globalThis as typeof globalThis & { __askSocket?: AskWebSocket }).__askSocket = this;
          queueMicrotask(() => {
            this.readyState = AskWebSocket.OPEN;
            this.onopen?.(new Event("open"));
          });
        }

        close(): void {
          this.readyState = AskWebSocket.CLOSED;
        }

        send(): void {
          if (this.sentWelcome) return;
          this.sentWelcome = true;
          void this.sendHostFrames();
        }

        async sendHostFrame(frame: unknown): Promise<void> {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv },
              await key,
              encoder.encode(JSON.stringify(frame)),
            ),
          );
          const envelope = new Uint8Array(4 + iv.byteLength + ciphertext.byteLength);
          new DataView(envelope.buffer).setUint32(0, 1, false);
          envelope.set(iv, 4);
          envelope.set(ciphertext, 4 + iv.byteLength);
          this.onmessage?.(new MessageEvent("message", { data: envelope.buffer }));
        }

        async sendHostFrames(): Promise<void> {
          const assistantEntry = {
            id: "ask-entry",
            parentId: null,
            timestamp: "2026-07-25T00:00:00.000Z",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "ask-active", name: "ask", arguments: args }],
              model: "test/model",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
              stopReason: "toolUse",
              timestamp: 0,
            },
          };
          const frames = [
            {
              t: "welcome",
              proto: 3,
              header: {
                type: "session",
                id: "ask-browser-smoke",
                title: "Recommended ask browser smoke",
                timestamp: "2026-07-25T00:00:00.000Z",
                cwd: "/test",
              },
              state: {
                isStreaming: true,
                queuedMessageCount: 0,
                cwd: "/test",
                participants: [{ name: "host", role: "host" }],
              },
              agents: [],
              entryCount: 1,
              readOnly: false,
            },
            { t: "snapshot-chunk", entries: [assistantEntry], final: true },
            {
              t: "event",
              event: { type: "tool_execution_start", toolCallId: "ask-active", toolName: "ask", args },
            },
            {
              t: "ui-request",
              request: {
                reqId: 7,
                kind: "select",
                title: question,
                options,
                initialIndex: 0,
                selectionMarker: "radio",
              },
            },
          ];
          for (const frame of frames) await this.sendHostFrame(frame);
        }
      }

      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: AskWebSocket });
    }, { keyBytes: [...roomKey] });

    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Open request" }).click();

    const recommended = page.locator(".sh-ask-option-recommended");
    await expect(recommended).toHaveText("Recommended");
    await expect(recommended).toHaveCount(1);
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "connected");
    await expect(page.locator(".triage-bar")).toBeHidden();
    await expect(page.locator(".sh-ask-option").first()).toBeFocused();
    await expect(page.locator(".sh-composer")).toHaveCount(1);
    await expect(page.locator(".gateway-shell > .sh-composer")).toHaveCount(0);
    await expect(
      page.locator(".sh-ask-option").filter({ hasText: "Implement ADR-0036 locally" }).locator(".sh-ask-option-recommended"),
    ).toHaveText("Recommended");
    await expect(
      page.locator(".sh-ask-option").filter({ hasText: "Wait for upstream" }).locator(".sh-ask-option-recommended"),
    ).toHaveCount(0);
    await page.evaluate(async () => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { sendHostFrame(frame: unknown): Promise<void> };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      await socket.sendHostFrame({ t: "bye", reason: "Session exited with code 0" });
    });
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "offline");
    await expect(page.locator(".conn-chip")).toHaveText("Offline");
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "ended");
    await expect(page.locator(".triage-copy")).toHaveText("Session ended · exit 0");
    await expect(page.locator(".triage-action")).toHaveText("Back to Sessions");
    const inset = await page.evaluate(() => {
      const composer = document.querySelector(".sh-composer")?.getBoundingClientRect();
      const triage = document.querySelector(".triage-bar")?.getBoundingClientRect();
      if (composer === undefined || triage === undefined) return undefined;
      return { composerBottom: composer.bottom, triageTop: triage.top };
    });
    expect(inset).toBeDefined();
    expect(inset?.composerBottom).toBeLessThanOrEqual(inset?.triageTop ?? 0);
  } finally {
    await fixture.stop();
  }
});

test("answer feedback dismisses by tap-out, swipe, and the eight-second timeout", async ({ page }) => {
  const initial = session();
  const fixture = await startDashboardFixture([initial]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Open request" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    fixture.upsert(answeredSession(initial));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.locator(".shell-bar").dispatchEvent("pointerdown", { pointerId: 1, clientY: 20 });
    await expect(page.locator(".triage-bar")).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    const second = {
      ...initial,
      inputRequired: true,
      ask: {
        requestId: "standalone-request-0002",
        since: "2026-07-21T10:00:02.000Z",
      },
    };
    fixture.upsert(second);
    await page.getByRole("button", { name: "Open request" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    fixture.upsert(answeredSession(second));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.locator(".triage-bar").dispatchEvent("pointerdown", { pointerId: 2, clientY: 80 });
    await page.locator(".triage-bar").dispatchEvent("pointerup", { pointerId: 2, clientY: 20 });
    await expect(page.locator(".triage-bar")).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    const third = {
      ...initial,
      inputRequired: true,
      ask: {
        requestId: "standalone-request-0003",
        since: "2026-07-21T10:00:03.000Z",
      },
    };
    fixture.upsert(third);
    await page.getByRole("button", { name: "Open request" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await page.clock.install();
    fixture.upsert(answeredSession(third));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.clock.fastForward(8_100);
    await expect(page.locator(".triage-bar")).toBeHidden();
  } finally {
    await fixture.stop();
  }
});
