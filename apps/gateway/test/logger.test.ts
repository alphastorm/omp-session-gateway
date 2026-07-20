import { expect, test } from "bun:test";
import { SafeLogger } from "../src/logger.ts";

test("coalesces repetitive denial events into a bounded log rate", () => {
  const lines: string[] = [];
  let now = 1_000;
  const logger = new SafeLogger({ write: line => lines.push(line) }, () => now);

  logger.event("warn", "http.authorization_denied");
  logger.event("warn", "http.authorization_denied");
  logger.event("warn", "http.authorization_denied");
  expect(lines).toHaveLength(1);

  now += 60_000;
  logger.event("warn", "http.authorization_denied");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
    level: "warn",
    event: "http.authorization_denied",
    suppressed: 2,
  });
});

test("does not suppress distinct lifecycle information", () => {
  const lines: string[] = [];
  const logger = new SafeLogger({ write: line => lines.push(line) });
  logger.event("info", "http.listening", { port: 4317 });
  logger.event("info", "http.listening", { port: 4318 });
  expect(lines).toHaveLength(2);
});
