import { fileURLToPath } from "node:url";

const playwright = Bun.spawn(
  [process.execPath, "x", "playwright", "test", "-c", "apps/web/playwright.config.ts", ...Bun.argv.slice(2)],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, NO_COLOR: "" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await playwright.exited;
