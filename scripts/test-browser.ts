import { fileURLToPath } from "node:url";

// `--compat` selects the browser-neutral lane (every engine, `@core` tests); the default is the
// deep Pixel/Chromium lane. Every other argument passes through to Playwright.
const args = Bun.argv.slice(2);
const compat = args.includes("--compat");
const config = compat ? "apps/web/playwright.compat.config.ts" : "apps/web/playwright.config.ts";

const playwright = Bun.spawn(
  [process.execPath, "x", "playwright", "test", "-c", config, ...args.filter(arg => arg !== "--compat")],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, NO_COLOR: "" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await playwright.exited;
