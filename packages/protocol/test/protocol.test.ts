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
  parseAttentionPushMessage,
  parsePushConfigResponse,
  parsePushSubscriptionRequest,
  parsePushSubscriptionResponse,
  parsePushUnsubscribeRequest,
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
    inputRequired: false,
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
    const parsed = parseAuthenticatedPublisherFrame(upsert());
    expect(parsed.op).toBe("upsert");
    if (parsed.op !== "upsert") throw new Error("expected upsert");
    expect(parsed.session.inputRequired).toBe(false);
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
    for (const inputRequired of ["true", 1, {}, []]) {
      expect(() =>
        parseAuthenticatedPublisherFrame({
          ...upsert(),
          session: { ...(upsert().session as Record<string, unknown>), inputRequired },
        }),
      ).toThrow(ProtocolValidationError);
    }
    for (const forbiddenKey of ["prompt", "question", "options", "prefill", "answer", "requestId", "count"]) {
      expect(() =>
        parseAuthenticatedPublisherFrame({
          ...upsert(),
          session: { ...(upsert().session as Record<string, unknown>), [forbiddenKey]: "CONTENT_CANARY" },
        }),
      ).toThrow(ProtocolValidationError);
    }
  });

  test("rejects oversized frames and ambiguous launch bodies", () => {
    expect(() => parseJsonFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(ProtocolValidationError);
    expect(() => parseLaunchRequest({ mode: "view", generation: 1, unexpected: true })).toThrow(
      ProtocolValidationError,
    );
  });

  test("binds control launches to an exact current request", () => {
    expect(
      parseLaunchRequest({
        mode: "control",
        generation: 1,
        requestId: "request-identity-000001",
      }),
    ).toEqual({ mode: "control", generation: 1, requestId: "request-identity-000001" });
    expect(() =>
      parseLaunchRequest({
        mode: "view",
        generation: 1,
        requestId: "request-identity-000001",
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseLaunchRequest({ mode: "control", generation: 1, requestId: "short" }),
    ).toThrow(ProtocolValidationError);
  });

  test("separates serializable metadata from non-serializable capabilities", () => {
    const frame = parseAuthenticatedPublisherFrame(upsert());
    if (frame.op !== "upsert") throw new Error("expected upsert");
    const split = separatePublishedSession(frame.session, "2026-07-19T00:00:01.000Z");
    expect(split.metadata.inputRequired).toBe(false);
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
    expect(list.sessions[0]?.inputRequired).toBe(false);
    expect(
      parseSessionListResponse({
        revision: 2,
        sessions: [
          metadata({
            inputRequired: true,
            ask: {
              requestId: "request-identity-000001",
              since: "2026-07-19T00:00:00.500Z",
            },
          }),
        ],
      }).sessions[0],
    ).toMatchObject({ inputRequired: true, ask: { requestId: "request-identity-000001" } });
    expect(
      parseSessionEvent({ type: "session_upsert", revision: 3, session: metadata({ generation: 2 }) }).type,
    ).toBe("session_upsert");
    expect(parseLaunchResponse({ mode: "view", generation: 2, capability }).capability).toBe(capability);
    expect(() => parseSessionListResponse({ revision: 2, sessions: [metadata({ canView: "yes" })] })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      parseSessionListResponse({ revision: 2, sessions: [metadata({ inputRequired: "true" })] }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseSessionListResponse({ revision: 2, sessions: [metadata({ inputRequired: true })] }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseSessionEvent({ type: "session_remove", revision: 3, instanceId, generation: 2, extra: true }),
    ).toThrow(ProtocolValidationError);
    expect(() => parseLaunchResponse({ mode: "view", generation: 2, capability: "short" })).toThrow(
      ProtocolValidationError,
    );
  });
  test("validates strict capability-free Web Push contracts", () => {
    const subscription = {
      endpoint: "https://push.example.test/send/subscription-1",
      expirationTime: null,
      keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
    };
    const requestId = "request-identity-000001";
    expect(
      parsePushSubscriptionRequest({ version: 2, detailLevel: "session", subscription }),
    ).toEqual({ version: 2, detailLevel: "session", subscription });
    expect(parsePushSubscriptionRequest({ version: 2, subscription }).detailLevel).toBeUndefined();
    expect(
      parsePushSubscriptionResponse({ version: 2, detailLevel: "preview" }),
    ).toEqual({ version: 2, detailLevel: "preview" });
    expect(
      parsePushUnsubscribeRequest({ version: 2, endpoint: subscription.endpoint }).endpoint,
    ).toBe(subscription.endpoint);
    expect(
      parsePushConfigResponse({ version: 2, applicationServerKey: "V".repeat(87) }).applicationServerKey,
    ).toHaveLength(87);
    expect(
      parseAttentionPushMessage({
        version: 2,
        type: "attention",
        instanceId,
        generation: 3,
        requestId,
        pendingAskCount: 2,
        title: "OMP session needs attention",
        body: "Example session · repository",
      }),
    ).toMatchObject({ version: 2, type: "attention", requestId, pendingAskCount: 2 });
    expect(
      parseAttentionPushMessage({
        version: 2,
        type: "clear",
        instanceId,
        requestId,
        pendingAskCount: 0,
      }),
    ).toEqual({ version: 2, type: "clear", instanceId, requestId, pendingAskCount: 0 });

    for (const invalid of [
      { version: 1, detailLevel: "session", subscription },
      { version: 2, detailLevel: "verbose", subscription },
      { version: 2, subscription: { ...subscription, endpoint: "http://push.example.test/send" } },
      { version: 2, subscription: { ...subscription, keys: { ...subscription.keys, auth: "short" } } },
      { version: 2, subscription: { ...subscription, prompt: "PROMPT_CONTENT_CANARY" } },
    ]) {
      expect(() => parsePushSubscriptionRequest(invalid)).toThrow(ProtocolValidationError);
    }
    expect(() =>
      parseAttentionPushMessage({
        version: 2,
        type: "attention",
        instanceId,
        generation: 3,
        requestId,
        pendingAskCount: 1,
        title: "OMP session needs attention",
        prompt: "PROMPT_CONTENT_CANARY",
      }),
    ).toThrow(ProtocolValidationError);
  });

});
