import { describe, expect, test } from "bun:test";
import type { PublishedSessionInput, SessionEvent } from "@omp-session-gateway/protocol";
import { SessionRegistry, type RegistryClock } from "../src/registry.ts";

class FakeClock implements RegistryClock {
  monotonic = 1_000;
  wall = Date.parse("2026-07-19T00:00:00.000Z");

  monotonicNowMs(): number {
    return this.monotonic;
  }

  wallNowIso(): string {
    return new Date(this.wall).toISOString();
  }

  advance(milliseconds: number): void {
    this.monotonic += milliseconds;
    this.wall += milliseconds;
  }
}

const viewCapability = ["REGISTRY", "VIEW", "CANARY", "0000000000000000"].join("__");
const controlCapability = ["REGISTRY", "CONTROL", "CANARY", "0000000000000000"].join("__");

function published(generation = 1, overrides: Partial<PublishedSessionInput> = {}): PublishedSessionInput {
  return {
    instanceId: "registry-instance-0001",
    generation,
    pid: 4242,
    sessionId: `session-${generation}`,
    title: `Session ${generation}`,
    cwdLabel: "repository",
    model: "fixture/model",
    startedAt: "2026-07-19T00:00:00.000Z",
    inputRequired: false,
    viewLink: viewCapability,
    controlLink: controlCapability,
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  test("keeps metadata and bearer values structurally separate", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.upsert("owner-a", published());
    const snapshot = registry.snapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain(viewCapability);
    expect(JSON.stringify(snapshot)).not.toContain(controlCapability);
    expect(registry.lookupCapability("registry-instance-0001", 1, "view")).toMatchObject({ status: "ok" });
  });

  test("creates stable attention identity and replaces it only after authoritative clear", () => {
    const clock = new FakeClock();
    const requestIds = ["attention-request-000001", "attention-request-000002"];
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      clock,
      requestIdFactory: () => requestIds.shift() ?? "attention-request-fallback",
    });
    const events: SessionEvent[] = [];
    registry.subscribe(event => events.push(event));

    registry.upsert("owner-a", published());
    clock.advance(1_000);
    registry.upsert("owner-a", published(1, { inputRequired: true }));
    const firstAsk = registry.snapshot().sessions[0]?.ask;
    clock.advance(1_000);
    registry.upsert("owner-a", published(1, { inputRequired: true, title: "Updated title" }));
    expect(registry.snapshot().sessions[0]?.ask).toEqual(firstAsk);
    registry.upsert("owner-a", published(1, { inputRequired: false }));
    clock.advance(1_000);
    registry.upsert("owner-a", published(1, { inputRequired: true }));

    expect(firstAsk).toEqual({
      requestId: "attention-request-000001",
      since: "2026-07-19T00:00:01.000Z",
    });
    expect(registry.snapshot().sessions[0]?.ask?.requestId).toBe("attention-request-000002");
    expect(
      registry.lookupCapability("registry-instance-0001", 1, "control", "attention-request-000001"),
    ).toMatchObject({ status: "request_mismatch" });
    expect(
      registry.lookupCapability("registry-instance-0001", 1, "control", "attention-request-000002"),
    ).toMatchObject({ status: "ok" });
    expect(
      events.map(event => [
        event.revision,
        event.type === "session_upsert" ? event.session.inputRequired : undefined,
      ]),
    ).toEqual([
      [1, false],
      [2, true],
      [3, true],
      [4, false],
      [5, true],
    ]);
    expect(registry.lookupCapability("registry-instance-0001", 1, "view")).toMatchObject({ status: "ok" });
    expect(registry.lookupCapability("registry-instance-0001", 1, "control")).toMatchObject({ status: "ok" });
  });

  test("revokes an old generation before replacement becomes observable", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const observations: Array<{ event: SessionEvent; oldStatus: string }> = [];
    registry.upsert("owner-a", published(1));
    registry.subscribe(event => {
      observations.push({ event, oldStatus: registry.lookupCapability("registry-instance-0001", 1, "control").status });
    });
    registry.upsert("owner-a", published(2));
    expect(observations.at(-1)?.oldStatus).toBe("generation_mismatch");
    expect(registry.lookupCapability("registry-instance-0001", 1, "control").status).toBe("generation_mismatch");
    expect(registry.lookupCapability("registry-instance-0001", 2, "control").status).toBe("ok");
  });

  test("ignores older upserts and old-generation removes", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.upsert("owner-a", published(2));
    expect(registry.upsert("owner-a", published(1))).toBe("ignored_older");
    expect(registry.remove("owner-a", "registry-instance-0001", 1)).toBeFalse();
    expect(registry.snapshot().sessions[0]?.generation).toBe(2);
  });

  test("uses monotonic receipt time instead of publisher wall time", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.upsert("owner-a", published());
    clock.wall = Date.parse("1970-01-01T00:00:00.000Z");
    clock.advance(34_999);
    expect(registry.sweepExpired()).toBe(0);
    clock.advance(1);
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.lookupCapability("registry-instance-0001", 1, "view").status).toBe("missing");
  });

  test("heartbeats require the owning connection and current generation", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.upsert("owner-a", published());
    expect(registry.heartbeat("owner-b", "registry-instance-0001", 1)).toBeFalse();
    expect(registry.heartbeat("owner-a", "registry-instance-0001", 2)).toBeFalse();
    clock.advance(30_000);
    expect(registry.heartbeat("owner-a", "registry-instance-0001", 1)).toBeTrue();
    clock.advance(30_000);
    expect(registry.sweepExpired()).toBe(0);
  });

  test("socket-owner removal and record limits stay bounded", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 1 });
    registry.upsert("owner-a", published());
    expect(() =>
      registry.upsert("owner-b", published(1, { instanceId: "registry-instance-0002", sessionId: "other" })),
    ).toThrow("capacity");
    expect(registry.removeOwner("owner-b")).toBe(0);
    expect(registry.removeOwner("owner-a")).toBe(1);
    expect(registry.size).toBe(0);
  });

  test("prevents one authenticated connection from replacing another instance", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.upsert("owner-a", published(1));
    expect(() => registry.upsert("owner-b", published(2))).toThrow("owned by another publisher");
    expect(registry.snapshot().sessions[0]?.generation).toBe(1);
    expect(registry.lookupCapability("registry-instance-0001", 1, "control").status).toBe("ok");
    expect(registry.lookupCapability("registry-instance-0001", 2, "control").status).toBe("generation_mismatch");
  });

  test("rejects conflicting immutable identity within a generation", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.upsert("owner-a", published());
    expect(() => registry.upsert("owner-a", published(1, { sessionId: "different" }))).toThrow("identity conflict");
  });

  test("admits a subscriber atomically when snapshot delivery mutates the registry", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.upsert("owner-a", published(1));
    const observed: SessionEvent[] = [];
    let reentered = false;
    const unsubscribe = registry.subscribeWithSnapshot(event => {
      observed.push(event);
      if (event.type !== "snapshot" || reentered) return;
      reentered = true;
      // Lands after the snapshot was read but before admission completes: exactly the window a
      // snapshot-then-subscribe handshake drops a revision into.
      registry.upsert("owner-a", published(2));
    });
    registry.upsert("owner-a", published(3));
    unsubscribe();
    registry.upsert("owner-a", published(4));

    expect(observed.map(event => [event.type, event.revision])).toEqual([
      ["snapshot", 1],
      ["session_upsert", 2],
      ["session_upsert", 3],
    ]);
    expect(observed[0]).toMatchObject({ sessions: [{ generation: 1 }] });
    expect(registry.snapshot().sessions[0]?.generation).toBe(4);
  });

  test("drops admission-buffered revisions the snapshot already represents", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.upsert("owner-a", published(1));
    clock.advance(35_000);

    const observed: SessionEvent[] = [];
    // Admission sweeps the expired record while the listener is already registered, yet that removal
    // is folded into the snapshot revision; replaying it would repeat revision 2.
    registry.subscribeWithSnapshot(event => observed.push(event));
    registry.upsert("owner-a", published(1));

    expect(observed.map(event => [event.type, event.revision])).toEqual([
      ["snapshot", 2],
      ["session_upsert", 3],
    ]);
    expect(observed[0]).toMatchObject({ sessions: [] });
  });

  test("keeps revisions increasing for every listener when one mutates during dispatch", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.upsert("owner-a", published(1, { instanceId: "registry-instance-0002" }));
    clock.advance(35_000);

    // Mirrors the push service: a listener that reads the directory sweeps it, producing a newer
    // revision from inside the dispatch of an older one.
    registry.subscribe(() => {
      registry.snapshot();
    });
    const observed: SessionEvent[] = [];
    registry.subscribe(event => observed.push(event));
    registry.upsert("owner-a", published(1));

    expect(observed.map(event => [event.type, event.revision])).toEqual([
      ["session_upsert", 2],
      ["session_remove", 3],
    ]);
  });
});
