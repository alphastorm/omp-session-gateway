import { expect, test } from "bun:test";
import { assertMetadataSafe } from "./metadata-safety.ts";
import { syntheticViewCapability } from "./synthetic-hosts.ts";

test("metadata guard accepts ordinary metadata but refuses nested capability-bearing fields", () => {
  const metadata = { revision: 3, sessions: [{ title: "working", busy: true, generation: 1 }] };
  expect(assertMetadataSafe(JSON.stringify(metadata), [])).toEqual(metadata);
  for (const key of ["viewLink", "controlLink", "capability", "token", "secret"]) {
    expect(() => assertMetadataSafe(JSON.stringify({ sessions: [{ [key]: "redacted" }] }), [])).toThrow("secret field");
  }
  expect(() => assertMetadataSafe('{"sessions":[{"\\u0074oken":"redacted"}]}', [])).toThrow("secret field");
});

test("renamed, escaped, and key-position secret values cannot bypass leak detection", () => {
  const syntheticToken = "a".repeat(64);
  const secrets = new Set([syntheticToken]);
  expect(() => assertMetadataSafe(JSON.stringify({ title: syntheticToken }), secrets)).toThrow("metadata leak");
  expect(() => assertMetadataSafe(`{"title":"${"\\u0061".repeat(64)}"}`, secrets)).toThrow("metadata leak");
  expect(() => assertMetadataSafe(JSON.stringify({ [syntheticToken]: 1 }), secrets)).toThrow("metadata leak");
  const canary = syntheticViewCapability("aaaa1111bbbb2222", 1);
  expect(() => assertMetadataSafe(JSON.stringify({ title: canary }), [])).toThrow("metadata leak");
  const encodedCanary = JSON.stringify({ title: canary }).replaceAll("s", "\\u0073");
  expect(() => assertMetadataSafe(encodedCanary, [])).toThrow("metadata leak");
  // Generated only in test memory: also prove that the shared scanner rejects credential-shaped text.
  const shaped = `syntheticroom00.${"z".repeat(43)}`;
  expect(() => assertMetadataSafe(JSON.stringify({ title: shaped }), [])).toThrow("metadata leak");
});

test("malformed and oversized metadata cannot produce a capability-free result", () => {
  expect(() => assertMetadataSafe("not JSON", [])).toThrow();
  expect(() => assertMetadataSafe(JSON.stringify({ title: "x".repeat(1_048_576) }), [])).toThrow("oversized");
});

test("overwritten JSON members cannot hide forbidden fields or escaped values on the wire", () => {
  expect(() => assertMetadataSafe('{"session":{"capability":"redacted"},"session":{}}', [])).toThrow("secret field");
  const canary = syntheticViewCapability("aaaa1111bbbb2222", 1).replaceAll("s", "\\u0073");
  expect(() => assertMetadataSafe(`{"title":"${canary}","title":"working"}`, [])).toThrow("metadata leak");
});
