import { describe, expect, test } from "bun:test";
import type { ObservedSessionInput, SessionEvent } from "@omp-session-gateway/protocol";
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

function observedSession(generation = 1, overrides: Partial<ObservedSessionInput> = {}): ObservedSessionInput {
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
    canControl: true,
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  test("exposes only metadata in snapshots and launch authorization", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.reconcile({ observed: [observedSession()], retained: new Set() });
    const metadata = {
      instanceId: "registry-instance-0001",
      generation: 1,
      title: "Session 1",
      cwdLabel: "repository",
      model: "fixture/model",
      startedAt: "2026-07-19T00:00:00.000Z",
      lastSeenAt: "2026-07-19T00:00:00.000Z",
      inputRequired: false,
      canView: true,
      canControl: true,
    };
    expect(JSON.parse(JSON.stringify(registry.snapshot()))).toEqual({ revision: 1, sessions: [metadata] });
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "view")).toEqual({ status: "ok", session: metadata });
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

    registry.reconcile({ observed: [observedSession()], retained: new Set() });
    clock.advance(1_000);
    registry.reconcile({ observed: [observedSession(1, { inputRequired: true })], retained: new Set() });
    const firstAsk = registry.snapshot().sessions[0]?.ask;
    clock.advance(1_000);
    registry.reconcile({ observed: [observedSession(1, { inputRequired: true })], retained: new Set() });
    expect(registry.revision).toBe(2);
    expect(registry.snapshot().sessions[0]?.ask).toEqual(firstAsk);
    registry.reconcile({ observed: [observedSession(1, { inputRequired: true, title: "Updated title" })], retained: new Set() });
    expect(registry.snapshot().sessions[0]?.ask).toEqual(firstAsk);
    registry.reconcile({ observed: [observedSession(1, { inputRequired: false })], retained: new Set() });
    clock.advance(1_000);
    registry.reconcile({ observed: [observedSession(1, { inputRequired: true })], retained: new Set() });

    expect(firstAsk).toEqual({
      requestId: "attention-request-000001",
      since: "2026-07-19T00:00:01.000Z",
    });
    expect(registry.snapshot().sessions[0]?.ask?.requestId).toBe("attention-request-000002");
    expect(
      registry.authorizeLaunch("registry-instance-0001", 1, "control", "attention-request-000001"),
    ).toMatchObject({ status: "request_mismatch" });
    expect(
      registry.authorizeLaunch("registry-instance-0001", 1, "control", "attention-request-000002"),
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
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "view")).toMatchObject({ status: "ok" });
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "control")).toMatchObject({ status: "ok" });
  });

  test("revokes an old generation before replacement becomes observable", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const observations: Array<{ event: SessionEvent; oldStatus: string }> = [];
    registry.reconcile({ observed: [observedSession(1)], retained: new Set() });
    registry.subscribe(event => {
      observations.push({ event, oldStatus: registry.authorizeLaunch("registry-instance-0001", 1, "control").status });
    });
    registry.reconcile({ observed: [observedSession(2)], retained: new Set() });
    expect(observations.at(-1)?.oldStatus).toBe("generation_mismatch");
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "control").status).toBe("generation_mismatch");
    expect(registry.authorizeLaunch("registry-instance-0001", 2, "control").status).toBe("ok");
  });

  test("ignores lower generations without refreshing their liveness", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.reconcile({ observed: [observedSession(2)], retained: new Set() });
    clock.advance(30_000);
    expect(registry.reconcile({ observed: [observedSession(1)], retained: new Set() })).toEqual({
      inserted: 0, updated: 0, removed: 0,
    });
    expect(registry.snapshot().sessions[0]?.generation).toBe(2);
    expect(registry.revision).toBe(1);
    clock.advance(5_000);
    expect(registry.sweepExpired()).toBe(1);
  });

  test("uses monotonic observation time instead of host wall time", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.reconcile({ observed: [observedSession()], retained: new Set() });
    clock.wall = Date.parse("1970-01-01T00:00:00.000Z");
    clock.advance(34_999);
    expect(registry.sweepExpired()).toBe(0);
    clock.advance(1);
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "view").status).toBe("missing");
  });

  test("refreshes liveness without issuing a revision for an unchanged poll", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.reconcile({ observed: [observedSession()], retained: new Set() });
    clock.advance(30_000);
    registry.reconcile({ observed: [observedSession()], retained: new Set() });
    expect(registry.revision).toBe(1);
    expect(registry.snapshot().sessions[0]?.lastSeenAt).toBe("2026-07-19T00:00:30.000Z");
    clock.advance(30_000);
    expect(registry.sweepExpired()).toBe(0);
    clock.advance(5_000);
    expect(registry.sweepExpired()).toBe(1);
  });

  test("keeps record admission bounded without replacing an admitted host", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 1 });
    const first = observedSession();
    const second = observedSession(1, { instanceId: "registry-instance-0002", sessionId: "other" });
    registry.reconcile({ observed: [first], retained: new Set() });
    registry.reconcile({ observed: [first, second], retained: new Set() });
    expect(registry.size).toBe(1);
    expect(registry.authorizeLaunch(first.instanceId, 1, "view").status).toBe("ok");
    expect(registry.authorizeLaunch(second.instanceId, 1, "view").status).toBe("missing");
    registry.reconcile({ observed: [], retained: new Set() });
    registry.reconcile({ observed: [second], retained: new Set() });
    expect(registry.snapshot().sessions.map(session => session.instanceId)).toEqual([second.instanceId]);
  });

  test("removes a host absent from both observed and retained on that poll", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const events: SessionEvent[] = [];
    registry.reconcile({ observed: [observedSession()], retained: new Set() });
    registry.subscribe(event => events.push(event));
    expect(registry.reconcile({ observed: [], retained: new Set() })).toEqual({ inserted: 0, updated: 0, removed: 1 });
    expect(registry.size).toBe(0);
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "view").status).toBe("missing");
    expect(events).toEqual([{ type: "session_remove", revision: 2, instanceId: "registry-instance-0001", generation: 1 }]);
  });

  test("retains an unreadable host until the TTL without refreshing its last observation", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.reconcile({ observed: [observedSession(1, { inputRequired: true })], retained: new Set() });
    const original = registry.snapshot().sessions[0];
    if (original === undefined) throw new Error("expected an observed host");
    const retained = new Set(["registry-instance-0001"]);
    clock.advance(30_000);
    registry.reconcile({ observed: [], retained });
    clock.advance(4_999);
    registry.reconcile({ observed: [], retained });
    expect(registry.snapshot().sessions).toEqual([original]);
    clock.advance(1);
    registry.reconcile({ observed: [], retained });
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.snapshot().sessions).toEqual([]);
  });

  test("treats a changed same-generation host identity as a fresh attention request", () => {
    const requestIds = ["attention-request-000001", "attention-request-000002"];
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      requestIdFactory: () => requestIds.shift() ?? "attention-request-fallback",
    });
    registry.reconcile({ observed: [observedSession(1, { inputRequired: true })], retained: new Set() });
    registry.reconcile({ observed: [observedSession(1, { sessionId: "different", inputRequired: true })], retained: new Set() });
    expect(registry.snapshot().sessions[0]).toMatchObject({ ask: { requestId: "attention-request-000002" } });
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "control", "attention-request-000001").status).toBe("request_mismatch");
  });

  test("admits a subscriber atomically when snapshot delivery mutates the registry", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.reconcile({ observed: [observedSession(1)], retained: new Set() });
    const observed: SessionEvent[] = [];
    let reentered = false;
    const unsubscribe = registry.subscribeWithSnapshot(event => {
      observed.push(event);
      if (event.type !== "snapshot" || reentered) return;
      reentered = true;
      // Lands after the snapshot was read but before admission completes: exactly the window a
      // snapshot-then-subscribe handshake drops a revision into.
      registry.reconcile({ observed: [observedSession(2)], retained: new Set() });
    });
    registry.reconcile({ observed: [observedSession(3)], retained: new Set() });
    unsubscribe();
    registry.reconcile({ observed: [observedSession(4)], retained: new Set() });

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
    registry.reconcile({ observed: [observedSession(1)], retained: new Set() });
    clock.advance(35_000);

    const observed: SessionEvent[] = [];
    // Admission sweeps the expired record while the listener is already registered, yet that removal
    // is folded into the snapshot revision; replaying it would repeat revision 2.
    registry.subscribeWithSnapshot(event => observed.push(event));
    registry.reconcile({ observed: [observedSession(1)], retained: new Set() });

    expect(observed.map(event => [event.type, event.revision])).toEqual([
      ["snapshot", 2],
      ["session_upsert", 3],
    ]);
    expect(observed[0]).toMatchObject({ sessions: [] });
  });

  test("keeps revisions increasing for every listener when one mutates during dispatch", () => {
    const clock = new FakeClock();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock });
    registry.reconcile({ observed: [observedSession(1, { instanceId: "registry-instance-0002" })], retained: new Set() });
    clock.advance(35_000);

    // Mirrors the push service: a listener that reads the directory sweeps it, producing a newer
    // revision from inside the dispatch of an older one.
    registry.subscribe(() => {
      registry.snapshot();
    });
    const observed: SessionEvent[] = [];
    registry.subscribe(event => observed.push(event));
    registry.reconcile({ observed: [observedSession(1)], retained: new Set() });

    expect(observed.map(event => [event.type, event.revision])).toEqual([
      ["session_upsert", 2],
      ["session_remove", 3],
    ]);
  });

  test("reports observer failure after delivering queued revisions to every healthy listener", () => {
    const errors: unknown[] = [];
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      onListenerError: error => errors.push(error),
    });
    const first: number[] = [];
    const third: number[] = [];
    registry.subscribe(event => first.push(event.revision));
    registry.subscribe(event => {
      if (event.type !== "session_upsert" || event.revision !== 1) return;
      registry.reconcile({ observed: [observedSession(2)], retained: new Set() });
      throw new Error("observer failed");
    });
    registry.subscribe(event => third.push(event.revision));

    registry.reconcile({ observed: [observedSession(1)], retained: new Set() });

    expect(first).toEqual([1, 2]);
    expect(third).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("observer failed");
    expect(registry.snapshot().sessions[0]?.generation).toBe(2);
  });

  test("retires every missing host even when a removal observer fails", () => {
    const errors: unknown[] = [];
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      onListenerError: error => errors.push(error),
    });
    registry.subscribe(event => {
      if (event.type === "session_remove") throw new Error("remove observer failed");
    });
    registry.reconcile({
      observed: [
        observedSession(1, { instanceId: "registry-instance-0001" }),
        observedSession(1, { instanceId: "registry-instance-0002" }),
      ],
      retained: new Set(),
    });

    expect(registry.reconcile({ observed: [], retained: new Set() }).removed).toBe(2);

    expect(registry.size).toBe(0);
    expect(registry.authorizeLaunch("registry-instance-0001", 1, "control").status).toBe("missing");
    expect(registry.authorizeLaunch("registry-instance-0002", 1, "control").status).toBe("missing");
    expect(errors).toHaveLength(2);
  });
});
