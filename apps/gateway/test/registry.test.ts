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

  test("rejects conflicting immutable identity within a generation", () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.upsert("owner-a", published());
    expect(() => registry.upsert("owner-a", published(1, { sessionId: "different" }))).toThrow("identity conflict");
  });
});
