import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Chrome's reduced UA freezes the platform at "Android 10; K" by design; do not
// "fix" it to report the device's Android 17 version.
const androidUserAgent =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";

export default defineConfig({
  testDir: fileURLToPath(new URL("./e2e", import.meta.url)),
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  use: {
    browserName: "chromium",
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "allow",
    userAgent: androidUserAgent,
  },
  projects: [
    // Measured on a Pixel 10 Pro on 2026-08-20: 411x816 layout viewport, 412x919 screen, DPR 2.625.
    // `screen` is recorded here rather than set, because this Playwright version does not accept it
    // as a project `use` option; only the viewport and scale factor affect rendering anyway.
    {
      name: "pixel-10-pro-411x816",
      use: {
        viewport: { width: 411, height: 816 },
        deviceScaleFactor: 2.625,
      },
    },
    // Deliberately synthetic narrow viewport for responsive layout coverage,
    // not an emulation of a measured physical device.
    {
      name: "synthetic-narrow-390x844",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
});
