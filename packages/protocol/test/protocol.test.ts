import { describe, expect, test } from "bun:test";
import {
  MAX_FRAME_BYTES,
  ProtocolValidationError,
  SecretCapability,
  parseAuthenticateFrame,
  parseAuthenticatedPublisherFrame,
  parseHelloFrame,
  parseChallengeFrame,
  parseHelloOkFrame,
  parseJsonFrame,
  parseLaunchRequest,
  parseLaunchResponse,
  parseSessionEvent,
  parseSessionListResponse,
  separatePublishedSession,
} from "../src/index.ts";

const encoder = new TextEncoder();
const instanceId = "instance-test-0001";
const token = "A".repeat(43);
const nonce = "B".repeat(43);
const capability = ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__");

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, op: "hello", clientNonce: nonce, instanceId, pid: 1234, ...overrides };
}

function upsert(generation = 1): Record<string, unknown> {
  return {
    v: 1,
    op: "upsert",
    session: {
      instanceId,
      generation,
      pid: 1234,
      sessionId: "session-one",
      title: "Example session",
      cwdLabel: "repository",
      model: "provider/model",
      startedAt: "2026-07-19T00:00:00.000Z",
      viewLink: capability,
    },
  };
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId,
    generation: 1,
    title: "Example session",
    startedAt: "2026-07-19T00:00:00.000Z",
    lastSeenAt: "2026-07-19T00:00:01.000Z",
    canView: true,
    canControl: false,
    ...overrides,
  };
}

describe("strict protocol validation", () => {
  test("accepts strict mutual-authentication and publisher frames", () => {
    expect(parseHelloFrame(hello()).instanceId).toBe(instanceId);
    expect(parseChallengeFrame({ v: 1, op: "challenge", serverNonce: "C".repeat(43), proof: "D".repeat(43) }).op).toBe(
      "challenge",
    );
    expect(parseAuthenticateFrame({ v: 1, op: "authenticate", proof: "E".repeat(43) }).op).toBe("authenticate");
    expect(parseHelloOkFrame({ v: 1, op: "hello_ok", heartbeatSeconds: 10, ttlSeconds: 35 }).ttlSeconds).toBe(35);
    expect(parseAuthenticatedPublisherFrame(upsert()).op).toBe("upsert");
  });

  test("rejects unknown versions, fields, duplicate keys, and invalid UTF-8", () => {
    expect(() => parseHelloFrame(hello({ v: 2 }))).toThrow(ProtocolValidationError);
    expect(() => parseHelloFrame(hello({ extra: true }))).toThrow(ProtocolValidationError);
    expect(() => parseHelloFrame(hello({ token }))).toThrow(ProtocolValidationError);
    expect(() => parseChallengeFrame({ v: 1, op: "challenge", serverNonce: "short", proof: "D".repeat(43) })).toThrow(
      ProtocolValidationError,
    );
    expect(() => parseAuthenticateFrame({ v: 1, op: "authenticate", proof: "E".repeat(43), extra: true })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      parseHelloOkFrame({ v: 1, op: "hello_ok", heartbeatSeconds: 10, ttlSeconds: 20 }),
    ).toThrow(ProtocolValidationError);
    expect(() => parseJsonFrame(encoder.encode('{"v":1,"v":1}'))).toThrow(ProtocolValidationError);
    expect(() => parseJsonFrame(new Uint8Array([0xc3, 0x28]))).toThrow(ProtocolValidationError);
  });

  test("rejects oversized frames and ambiguous launch bodies", () => {
    expect(() => parseJsonFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(ProtocolValidationError);
    expect(() => parseLaunchRequest({ mode: "view", generation: 1, unexpected: true })).toThrow(
      ProtocolValidationError,
    );
  });

  test("separates serializable metadata from non-serializable capabilities", () => {
    const frame = parseAuthenticatedPublisherFrame(upsert());
    if (frame.op !== "upsert") throw new Error("expected upsert");
    const split = separatePublishedSession(frame.session, "2026-07-19T00:00:01.000Z");
    expect(JSON.stringify(split.metadata)).not.toContain(capability);
    expect(split.secret.view.reveal()).toBe(capability);
    expect(() => JSON.stringify(split.secret)).toThrow("must not be serialized");
  });

  test("redacts secret string and inspector conversions", () => {
    const secret = SecretCapability.from(capability);
    expect(String(secret)).toBe("[REDACTED]");
    expect(Bun.inspect(secret)).not.toContain(capability);
  });

  test("removes control and bidi characters from display labels", () => {
    const frame = parseAuthenticatedPublisherFrame({
      ...upsert(),
      session: { ...(upsert().session as Record<string, unknown>), title: "safe\u202etext\u0007" },
    });
    if (frame.op !== "upsert") throw new Error("expected upsert");
    expect(frame.session.title).toBe("safetext");
  });

  test("validates browser metadata, events, and one-time launch responses", () => {
    const list = parseSessionListResponse({ revision: 2, sessions: [metadata()] });
    expect(list.sessions[0]?.instanceId).toBe(instanceId);
    expect(
      parseSessionEvent({ type: "session_upsert", revision: 3, session: metadata({ generation: 2 }) }).type,
    ).toBe("session_upsert");
    expect(parseLaunchResponse({ mode: "view", generation: 2, capability }).capability).toBe(capability);
    expect(() => parseSessionListResponse({ revision: 2, sessions: [metadata({ canView: "yes" })] })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      parseSessionEvent({ type: "session_remove", revision: 3, instanceId, generation: 2, extra: true }),
    ).toThrow(ProtocolValidationError);
    expect(() => parseLaunchResponse({ mode: "view", generation: 2, capability: "short" })).toThrow(
      ProtocolValidationError,
    );
  });
});
