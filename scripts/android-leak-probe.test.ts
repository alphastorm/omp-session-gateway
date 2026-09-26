import { describe, expect, test } from "bun:test";
import { PAGE_PRELUDE } from "./android-leak-probe.ts";

const NEEDLE = "SYNTHETIC-NOTIFICATION-LEAK-CONTROL";

type ScanSinks = (
  hit: (value: unknown) => boolean,
  note: (sink: string, detail?: string) => void,
) => Promise<void>;

async function scanWithRegistration(registration: object): Promise<readonly string[]> {
  const evaluate = new Function(
    "localStorage",
    "sessionStorage",
    "document",
    "caches",
    "indexedDB",
    "location",
    "history",
    "performance",
    "navigator",
    `${PAGE_PRELUDE}\nreturn scanSinks;`,
  ) as (...globals: unknown[]) => ScanSinks;
  const scanSinks = evaluate(
    { length: 0 },
    { length: 0 },
    { cookie: "", referrer: "", documentElement: { outerHTML: "<html></html>" } },
    { keys: async () => [] },
    { databases: async () => [] },
    { href: "https://gateway.example/", hash: "", search: "" },
    { state: null },
    { getEntriesByType: () => [] },
    { serviceWorker: { getRegistration: async () => registration } },
  );
  const findings: string[] = [];
  await scanSinks(
    value => typeof value === "string" && value.includes(NEEDLE),
    sink => findings.push(sink),
  );
  return findings;
}

describe("notification leak scanning", () => {
  test("completes a clean sink scan when an iOS Safari tab registration has no getNotifications", async () => {
    await expect(scanWithRegistration({})).resolves.toEqual([]);
  });

  test("detects a notification body containing the needle", async () => {
    const findings = await scanWithRegistration({
      getNotifications: async () => [{ title: "Session attention", body: `Prompt: ${NEEDLE}`, data: null }],
    });
    expect(findings).toEqual(["notificationBody"]);
  });
});
