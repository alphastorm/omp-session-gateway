import { expect, test } from "bun:test";
import { parseOmpLinkReply, parseOmpSnapshotReply } from "../packages/protocol/src/index.ts";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";
import { parseSyntheticHostCount, syntheticReply, syntheticSnapshot, syntheticViewCapability } from "./synthetic-hosts.ts";

const INSTANCE = "aaaa1111bbbb2222cccc3333";
const TOKEN = "a".repeat(64);
const CREATED_AT = 1_700_000_000_000;

test("metadata revisions are accepted by the real gateway parser without changing generation", () => {
  const snapshot = syntheticSnapshot(INSTANCE, 2, CREATED_AT);
  const first = parseOmpSnapshotReply(syntheticReply({ v: 1, token: TOKEN, op: "snapshot" }, TOKEN, snapshot));
  const changed = parseOmpSnapshotReply(syntheticReply({ v: 1, token: TOKEN, op: "snapshot" }, TOKEN, syntheticSnapshot(INSTANCE, 2, CREATED_AT, 1)));
  if (!first.ok || !changed.ok) throw new Error("synthetic snapshot refused");
  expect(changed.value.instanceId).toBe(first.value.instanceId);
  expect(changed.value.sessionId).toBe(first.value.sessionId);
  expect(changed.value.startedAt).toBe(first.value.startedAt);
  expect(changed.value.generation).toBe(first.value.generation);
  expect(changed.value.busy).toBe(true);
  expect(changed.value.sessionName).not.toBe(first.value.sessionName);
  expect(syntheticSnapshot(INSTANCE, 2, CREATED_AT, 2).busy).toBe(false);
});

test("View replies are valid non-real capability canaries and revoke old generations", () => {
  const snapshot = { ...syntheticSnapshot(INSTANCE, 0, CREATED_AT), access: "view" as const };
  const query = { v: 1, token: TOKEN, op: "link", access: "view", generation: 1 };
  const reply = parseOmpLinkReply(syntheticReply(query, TOKEN, snapshot, true));
  if (!reply.ok) throw new Error("synthetic link refused");
  expect(reply.value.reveal()).toBe(syntheticViewCapability(INSTANCE, 1));
  expect(findCapabilityLeaks(reply.value.reveal())).toEqual([]);
  expect(parseOmpLinkReply(syntheticReply(query, TOKEN, { ...snapshot, generation: 2 }, true))).toEqual({ ok: false, error: "stale_generation" });
  const next = parseOmpLinkReply(syntheticReply({ ...query, generation: 2 }, TOKEN, { ...snapshot, generation: 2 }, true));
  if (!next.ok) throw new Error("new generation refused");
  expect(next.value.reveal()).not.toBe(reply.value.reveal());
  expect(parseOmpLinkReply(syntheticReply({ ...query, access: "control" }, TOKEN, snapshot, true))).toEqual({ ok: false, error: "access_unavailable" });
  expect(parseOmpLinkReply(syntheticReply(query, TOKEN, snapshot))).toEqual({ ok: false, error: "access_unavailable" });
});

test("host authentication and protocol refusals do not release a link", () => {
  const snapshot = syntheticSnapshot(INSTANCE, 0, CREATED_AT);
  const query = { v: 1, token: TOKEN, op: "link", access: "view", generation: 1 };
  for (const [request, error] of [
    [null, "malformed_request"], [[query], "malformed_request"],
    [{ ...query, v: 2 }, "unsupported_protocol"], [{ ...query, token: "wrong" }, "authentication_failed"],
    [{ ...query, op: "other" }, "invalid_operation"], [{ ...query, access: "other" }, "invalid_access"],
    [{ ...query, generation: undefined }, "stale_generation"],
  ] as const) {
    expect(parseOmpLinkReply(syntheticReply(request, TOKEN, snapshot, true))).toEqual({ ok: false, error });
  }
});

test("capacity CLI preserves its fifty-host admission ceiling", () => {
  expect(parseSyntheticHostCount("1")).toBe(1);
  expect(parseSyntheticHostCount("50")).toBe(50);
  for (const value of [undefined, "", "0", "51", "1.5", "Infinity"]) expect(() => parseSyntheticHostCount(value)).toThrow();
});
