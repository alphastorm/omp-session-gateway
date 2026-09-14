import { describe, expect, test } from "bun:test";
import {
  MAX_FRAME_BYTES,
  ProtocolValidationError,
  SecretCapability,
  parseOmpDiscoveryEntry,
  parseOmpHostSnapshot,
  parseOmpSnapshotReply,
  parseOmpLinkReply,
  observedSessionFromSnapshot,
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
  sessionMetadataFromObserved,
} from "../src/index.ts";

const encoder = new TextEncoder();
const instanceId = "aaaa1111bbbb2222";
const entryId = "eaaa1111bbbb2222";
const capability = ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__");

function discoveryFile(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    instanceId,
    pid: 1234,
    endpoint: "/tmp/omp-host-double/relocated.sock",
    createdAt: Date.parse("2026-07-19T00:00:00.000Z"),
    token: "a".repeat(64),
    ...overrides,
  };
}

function hostSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    instanceId,
    generation: 1,
    pid: 1234,
    sessionId: "session-one",
    sessionName: "Example session",
    cwd: "/Users/you/projects/repository/",
    model: { provider: "provider", id: "model" },
    startedAt: Date.parse("2026-07-19T00:00:00.000Z"),
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    access: "view" as const,
    ...overrides,
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
  test("round-trips a discovery file and a host snapshot using the mainline wire shape", () => {
    const entry = parseOmpDiscoveryEntry(entryId, parseJsonFrame(encoder.encode(JSON.stringify(discoveryFile()))));
    expect(entry).toEqual({ entryId, ...discoveryFile() });
    const snapshot = hostSnapshot();
    expect(parseOmpHostSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseOmpSnapshotReply(parseJsonFrame(encoder.encode(JSON.stringify({ ok: true, v: 1, snapshot })))),
    ).toEqual({ ok: true, value: snapshot });
  });

  test("rejects unknown versions, fields, duplicate keys, and invalid UTF-8", () => {
    expect(() => parseOmpSnapshotReply({ ok: true, v: 2, snapshot: hostSnapshot() })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: true, v: 2, url: capability })).toThrow(ProtocolValidationError);
    expect(() => parseOmpDiscoveryEntry(entryId, discoveryFile({ extra: true }))).toThrow(ProtocolValidationError);
    expect(() => parseOmpDiscoveryEntry(entryId, discoveryFile({ token: "short" }))).toThrow(ProtocolValidationError);
    expect(() => parseOmpSnapshotReply({ ok: true, v: 1, snapshot: hostSnapshot(), extra: true })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: true, v: 1, url: capability, extra: true })).toThrow(ProtocolValidationError);
    expect(() => parseJsonFrame(encoder.encode('{"v":1,"v":1}'))).toThrow(ProtocolValidationError);
    expect(() => parseJsonFrame(new Uint8Array([0xc3, 0x28]))).toThrow(ProtocolValidationError);
    for (const inputRequired of ["true", 1, {}, []]) {
      expect(() => parseOmpHostSnapshot(hostSnapshot({ inputRequired }))).toThrow(ProtocolValidationError);
    }
    for (const forbiddenKey of ["prompt", "question", "options", "prefill", "answer", "requestId", "count"]) {
      expect(() => parseOmpHostSnapshot(hostSnapshot({ [forbiddenKey]: "CONTENT_CANARY" }))).toThrow(ProtocolValidationError);
    }
  });

  test("requires the discovery, snapshot, and reply fields rather than supplying defaults", () => {
    const discovery: Record<string, unknown> = discoveryFile();
    delete discovery.token;
    expect(() => parseOmpDiscoveryEntry(entryId, discovery)).toThrow(ProtocolValidationError);
    const snapshot: Record<string, unknown> = hostSnapshot();
    delete snapshot.startedAt;
    expect(() => parseOmpHostSnapshot(snapshot)).toThrow(ProtocolValidationError);
    expect(() => parseOmpSnapshotReply({ ok: true, v: 1 })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: true, v: 1 })).toThrow(ProtocolValidationError);
  });

  test("parses every upstream wire error without mistaking it for a successful snapshot or link", () => {
    for (const error of [
      "malformed_request",
      "unsupported_protocol",
      "authentication_failed",
      "snapshot_unavailable",
      "invalid_operation",
      "invalid_access",
      "stale_generation",
      "access_unavailable",
    ] as const) {
      const reply = { ok: false, v: 1, error };
      expect(parseOmpSnapshotReply(reply)).toEqual({ ok: false, error });
      expect(parseOmpLinkReply(reply)).toEqual({ ok: false, error });
    }
    expect(() => parseOmpSnapshotReply({ ok: false, v: 1, error: "unknown_error" })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: false, v: 1, error: "unknown_error" })).toThrow(ProtocolValidationError);
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

  test("projects a host into basename-only metadata rather than exposing its full path or identity", () => {
    const observed = observedSessionFromSnapshot(parseOmpHostSnapshot(hostSnapshot()));
    expect(observed).toMatchObject({
      cwdLabel: "repository",
      model: "provider/model",
      startedAt: "2026-07-19T00:00:00.000Z",
      canControl: false,
    });
    const projected = sessionMetadataFromObserved(observed, "2026-07-19T00:00:01.000Z");
    expect(JSON.parse(JSON.stringify(projected.metadata))).toEqual(metadata({ cwdLabel: "repository", model: "provider/model" }));
    const windows = observedSessionFromSnapshot(parseOmpHostSnapshot(hostSnapshot({
      cwd: "C:\\Users\\operator\\projects\\repository\\",
      access: "control",
    })));
    expect(windows).toMatchObject({ cwdLabel: "repository", model: "provider/model", canControl: true });
  });

  test("wraps a link reply URL before it can be serialized or inspected", () => {
    const url = new URL("https://collab.example.test");
    url.hash = capability;
    const reply = parseOmpLinkReply({ ok: true, v: 1, url: url.href });
    if (!reply.ok) throw new Error("expected a successful link reply");
    expect(reply.value).toBeInstanceOf(SecretCapability);
    expect(reply.value.reveal() === url.href).toBe(true);
    expect(() => JSON.stringify(reply)).toThrow("must not be serialized");
    expect(Bun.inspect(reply)).not.toContain(capability);
  });

  test("redacts secret string and inspector conversions", () => {
    const secret = SecretCapability.from(capability);
    expect(String(secret)).toBe("[REDACTED]");
    expect(Bun.inspect(secret)).not.toContain(capability);
  });

  test("removes control and bidi characters from display labels", () => {
    const snapshot = parseOmpHostSnapshot(hostSnapshot({ sessionName: "safe\u202etext\u0007" }));
    expect(observedSessionFromSnapshot(snapshot).title).toBe("safetext");
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
