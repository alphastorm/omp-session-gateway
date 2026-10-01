import { describe, expect, test } from "bun:test";
import { createOmpStdinDriver, runOmpLifecycle, type OmpLifecycleHost, type OmpLifecycleObserver } from "./omp-lifecycle-qualification.ts";

const LABEL = "synthetic-lifecycle-label";
const INITIAL_ID = "synthetic-original-instance";
const RESUMED_ID = "synthetic-resumed-instance";
const timeouts = { publicationMs: 10, revocationMs: 10, messageSettleMs: 0 };

function fixture(failAt?: string, badTransition?: "new" | "fork" | "resume") {
  const events: string[] = [];
  let session: Record<string, unknown> | undefined = { instanceId: INITIAL_ID, generation: 1, cwdLabel: LABEL };
  const hosts = [{ stopped: false }];
  let current = hosts[0]!;
  let listCount = 0;
  let stopCount = 0;
  let revokeCount = 0;
  let messages = 0;
  const event = (name: string) => {
    events.push(name);
    if (name === failAt) throw new Error("private host diagnostic must not escape");
  };
  const host: OmpLifecycleHost = {
    async write(bytes) {
      if (bytes === "/new\r" || bytes === "/fork\r") {
        const transition = bytes === "/new\r" ? "new" : "fork";
        event(transition);
        if (transition === "fork" && messages !== 2) throw new Error("fork without transcript");
        if (badTransition !== transition) session = { ...session, generation: transition === "new" ? 2 : 3 };
      } else {
        messages += 1;
        event(`message ${messages}`);
      }
    },
    async stop() { event(`stop ${++stopCount}`); current.stopped = true; session = undefined; },
    async startContinued() {
      event("continue");
      current = { stopped: false };
      hosts.push(current);
      session = { instanceId: badTransition === "resume" ? INITIAL_ID : RESUMED_ID, generation: 1, cwdLabel: LABEL };
    },
    async stopAll() {
      for (const owned of hosts) owned.stopped = true;
      event("cleanup");
    },
  };
  const observer: OmpLifecycleObserver = {
    origin: "http://127.0.0.1:43218",
    async waitForPublishedSession(_origin, label, options) {
      event(`list ${++listCount}`);
      if (session === undefined || session.cwdLabel !== label || (options?.matches !== undefined && !options.matches(session))) throw new Error("wrong card");
      return { ...session };
    },
    async verifyLaunchContracts(_origin, card, expected = "live") {
      event(`${expected} ${card.generation}`);
      if (session === undefined || card.instanceId !== session.instanceId ||
        (expected === "live" ? card.generation !== session.generation : card.generation === session.generation)) throw new Error("launch bound to wrong card");
      return {};
    },
    async waitForRevocation() {
      event(`revoke ${++revokeCount}`);
      if (session !== undefined) throw new Error("host remains published");
    },
  };
  return { host, observer, events, hosts };
}

const sequence = ["list 1", "new", "list 2", "stale 1", "live 2", "message 1", "message 2", "fork", "list 3", "stale 2", "live 3", "stop 1", "revoke 1", "continue", "list 4", "live 1", "stop 2", "revoke 2", "cleanup"];

function onlyFacts(value: unknown): boolean {
  if (typeof value === "boolean" || typeof value === "number") return true;
  return typeof value === "object" && value !== null && Object.values(value).every(onlyFacts);
}

describe("gateway-visible OMP lifecycle", () => {
  test("rotates both sessions before resume, rejects old launches, and leaves both hosts stopped", async () => {
    const f = fixture();
    const evidence = await runOmpLifecycle({ ...f, label: LABEL, timeouts });
    expect(f.events).toEqual(sequence);
    expect(f.hosts).toEqual([{ stopped: true }, { stopped: true }]);
    expect(evidence.newGeneration.generationDelta).toBe(1);
    expect(evidence.fork).toEqual({ sameInstance: true, generationDelta: 1, syntheticMessages: 2, staleRejected: true, liveLaunches: 2, noStore: true });
    expect(evidence.resumed).toEqual({ newInstance: true, generation: 1, sameLabel: true, liveLaunches: 2, noStore: true, revocations: 2 });
    expect(onlyFacts(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/synthetic-|https?:|#|capability|instanceId|cwdLabel/u);
  });

  test.each([
    ["list 1", "initial publication"], ["new", "new generation"], ["list 2", "new generation"],
    ["stale 1", "new generation"], ["live 2", "new generation"], ["message 1", "fork messages"], ["message 2", "fork messages"],
    ["fork", "fork"], ["list 3", "fork"], ["stale 2", "fork"], ["live 3", "fork"],
    ["stop 1", "first stop"], ["revoke 1", "first revocation"], ["continue", "continue start"],
    ["list 4", "continue publication"], ["live 1", "continue launches"], ["stop 2", "final stop"], ["revoke 2", "final revocation"], ["cleanup", "cleanup"],
  ])("%s failure redacts the diagnostic and stops every owned host", async (step, phase) => {
    const f = fixture(step);
    await expect(runOmpLifecycle({ ...f, label: LABEL, timeouts })).rejects.toThrow(`OMP lifecycle ${phase} failed`);
    expect(f.hosts.every(host => host.stopped)).toBe(true);
    expect(f.events.at(-1)).toBe("cleanup");
    if (step !== "cleanup") expect(f.events.slice(0, -1)).toEqual(sequence.slice(0, sequence.indexOf(step!) + 1));
  });

  test.each(["new", "fork", "resume"] as const)("refuses an unchanged %s identity rather than recording a pass", async transition => {
    const f = fixture(undefined, transition);
    await expect(runOmpLifecycle({ ...f, label: LABEL, timeouts })).rejects.toThrow("failed");
    expect(f.hosts.every(host => host.stopped)).toBe(true);
  });

  test("invalid bounds still stop the already started host", async () => {
    const f = fixture();
    await expect(runOmpLifecycle({ ...f, label: LABEL, timeouts: { ...timeouts, publicationMs: Infinity } })).rejects.toThrow("OMP lifecycle bounds failed");
    expect(f.events).toEqual(["cleanup"]);
    expect(f.hosts[0]?.stopped).toBe(true);
  });
});

test("stdin driver owns resumed hosts even when stopping an earlier host fails", async () => {
  const writes: string[] = [];
  const sink = { write: (bytes: string) => writes.push(bytes), flush: () => 0, end() {} };
  const first = { stdin: sink, exitCode: null };
  const second = { stdin: sink, exitCode: null };
  const stopped: object[] = [];
  const driver = createOmpStdinDriver(first, () => second, async child => {
    stopped.push(child);
    if (child === first) throw new Error("private cleanup diagnostic");
  });
  await driver.write("/new\r");
  await driver.startContinued();
  await driver.write("/fork\r");
  await expect(driver.stopAll()).rejects.toThrow("OMP lifecycle cleanup failed");
  expect(stopped).toEqual([first, second]);
  expect(writes).toEqual(["/new\r", "/fork\r"]);
});
