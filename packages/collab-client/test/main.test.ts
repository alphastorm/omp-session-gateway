import { afterAll, describe, expect, mock, test } from "bun:test";

interface FakeRoot {
  rendered: unknown;
  unmounts: number;
  render(node: unknown): void;
  unmount(): void;
}

const roots: FakeRoot[] = [];
mock.module("react-dom/client", () => ({
  createRoot(): FakeRoot {
    const root: FakeRoot = {
      rendered: undefined,
      unmounts: 0,
      render(node): void {
        this.rendered = node;
      },
      unmount(): void {
        this.rendered = undefined;
        this.unmounts += 1;
      },
    };
    roots.push(root);
    return root;
  },
}));

const GLOBAL_NAMES = ["window", "document", "location", "history", "HTMLElement"] as const;
const nativeGlobals: Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined> = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  location: Object.getOwnPropertyDescriptor(globalThis, "location"),
  history: Object.getOwnPropertyDescriptor(globalThis, "history"),
  HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
};

class ClientWindow extends EventTarget {
  readonly location: { href: string; origin: string; replace(path: string): void };
  readonly opener: { postMessage(message: unknown, targetOrigin: string): void } | null;

  constructor(
    location: { href: string; origin: string; replace(path: string): void },
    opener: { postMessage(message: unknown, targetOrigin: string): void } | null,
  ) {
    super();
    this.location = location;
    this.opener = opener;
  }

  matchMedia(): { matches: boolean; addEventListener(): void } {
    return { matches: false, addEventListener(): void {} };
  }

  setInterval(): number {
    return 1;
  }

  setTimeout(): number {
    return 2;
  }

  close(): void {}
}

function installBrowser(href: string, hasOpener: boolean): {
  window: ClientWindow;
  replacements: string[];
  historyUrls: string[];
  rootElement: { children: unknown[]; replaceChildren(...children: unknown[]): void };
} {
  roots.length = 0;
  const replacements: string[] = [];
  const historyUrls: string[] = [];
  const url = new URL(href);
  const location = {
    href: url.href,
    origin: url.origin,
    replace(path: string): void {
      replacements.push(path);
    },
  };
  const opener = hasOpener ? { postMessage(): void {} } : null;
  const clientWindow = new ClientWindow(location, opener);
  const rootElement = {
    children: [] as unknown[],
    replaceChildren(...children: unknown[]): void {
      this.children = children;
    },
  };
  const document = Object.assign(new EventTarget(), {
    documentElement: { dataset: {} as Record<string, string>, style: {} as Record<string, string> },
    getElementById(id: string): typeof rootElement | null {
      return id === "root" ? rootElement : null;
    },
  });
  const history = {
    replaceState(_state: unknown, _unused: string, nextUrl?: string | URL | null): void {
      historyUrls.push(String(nextUrl));
    },
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: clientWindow },
    document: { configurable: true, value: document },
    location: { configurable: true, value: location },
    history: { configurable: true, value: history },
    HTMLElement: { configurable: true, value: class extends EventTarget {} },
  });
  return { window: clientWindow, replacements, historyUrls, rootElement };
}

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    const descriptor = nativeGlobals[name];
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

// main.tsx bootstraps at import time, so cache-busted imports isolate each browser scenario.
describe("collaboration client document recovery", () => {
  test("replaces a scrubbed reload or direct entry instead of rendering an inert shell", async () => {
    const browser = installBrowser("https://sessions.example/client/", false);

    // @ts-expect-error Bun supports cache-busting query imports; TypeScript does not resolve them.
    await import("../upstream/src/main.tsx?reload-recovery-test");

    expect(browser.replacements).toEqual(["/"]);
    expect(browser.historyUrls).toEqual([]);
    expect(browser.rootElement.children).toEqual([]);
  });

  test("replaces an invalid handoff instead of attempting a transfer", async () => {
    const browser = installBrowser(
      `https://sessions.example/client/?handoff=${"x".repeat(129)}`,
      true,
    );

    // @ts-expect-error Bun supports cache-busting query imports; TypeScript does not resolve them.
    await import("../upstream/src/main.tsx?invalid-handoff-test");

    expect(browser.replacements).toEqual(["/"]);
    expect(browser.historyUrls).toEqual([]);
  });

  test("redirects a BFCache-restored fallback document without retaining its handoff", async () => {
    const handoff = "00000000-0000-4000-8000-000000000000";
    const browser = installBrowser(
      `https://sessions.example/client/?handoff=${handoff}`,
      true,
    );
    // @ts-expect-error Bun supports cache-busting query imports; TypeScript does not resolve them.
    await import("../upstream/src/main.tsx?bfcache-recovery-test");

    expect(browser.historyUrls).toEqual(["/client/"]);
    expect(browser.rootElement.children).toEqual([]);

    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    browser.window.dispatchEvent(pageshow);

    expect(browser.replacements).toEqual(["/"]);
    expect(JSON.stringify(browser.historyUrls)).not.toContain(handoff);
    expect(JSON.stringify(browser.rootElement.children)).not.toContain(handoff);
  });
});
