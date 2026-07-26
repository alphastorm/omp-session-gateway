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
    const card = page.locator(".queue-hero");
    await expect(card).toHaveCount(1);

    await card.getByRole("button", { name: "View transcript instead" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    await expect(page.locator(".shell-title")).toHaveText("Android standalone launch");
    await expect(page.locator(".shell-control")).toBeVisible();
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests).toContain("POST /api/v1/sessions/standalone-launch-0001/launch");

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".queue-hero")).toHaveCount(1);

    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    await expect(page.locator(".shell-control")).toBeHidden();
    fixture.upsert({ ...session(), inputRequired: false });
    await expect(page.locator(".triage-copy")).toHaveText("✓ Answered — all clear · 1 working");
    await expect(page.locator(".triage-action")).toHaveText("Sessions");
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
          for (const frame of frames) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = new Uint8Array(
              await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, encoder.encode(JSON.stringify(frame))),
            );
            const envelope = new Uint8Array(4 + iv.byteLength + ciphertext.byteLength);
            new DataView(envelope.buffer).setUint32(0, 1, false);
            envelope.set(iv, 4);
            envelope.set(ciphertext, 4 + iv.byteLength);
            this.onmessage?.(new MessageEvent("message", { data: envelope.buffer }));
          }
        }
      }

      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: AskWebSocket });
    }, { keyBytes: [...roomKey] });

    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Open request" }).click();

    const recommended = page.locator(".sh-ask-option-recommended");
    await expect(recommended).toHaveText("Recommended");
    await expect(recommended).toHaveCount(1);
    await expect(
      page.locator(".sh-ask-option").filter({ hasText: "Implement ADR-0036 locally" }).locator(".sh-ask-option-recommended"),
    ).toHaveText("Recommended");
    await expect(
      page.locator(".sh-ask-option").filter({ hasText: "Wait for upstream" }).locator(".sh-ask-option-recommended"),
    ).toHaveCount(0);
  } finally {
    await fixture.stop();
  }
});
