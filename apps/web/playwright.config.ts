import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const androidUserAgent =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

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
    {
      name: "android-412x915",
      use: { viewport: { width: 412, height: 915 } },
    },
    {
      name: "android-390x844",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
});
