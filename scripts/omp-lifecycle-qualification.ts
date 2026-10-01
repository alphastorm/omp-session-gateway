export interface OmpSessionWait {
  readonly timeoutMs?: number;
  readonly matches?: (session: Record<string, unknown>) => boolean;
}

/** All observation goes through the gateway; terminal output is discarded by both drivers. */
export interface OmpLifecycleObserver {
  readonly origin: string;
  readonly waitForPublishedSession: (origin: string, label: string, options?: OmpSessionWait) => Promise<Record<string, unknown>>;
  readonly verifyLaunchContracts: (origin: string, session: Record<string, unknown>, expected?: "live" | "stale") => Promise<Record<string, unknown>>;
  readonly waitForRevocation: (origin: string, label: string, timeoutMs?: number) => Promise<void>;
}

export interface OmpLifecycleHost {
  write(bytes: string): Promise<void>;
  stop(): Promise<void>;
  startContinued(): Promise<void>;
  stopAll(): Promise<void>;
}

export interface OmpTerminalProcess {
  readonly stdin: { write(bytes: string): number | Promise<number>; flush(): number | Promise<number>; end(): void | number | Promise<number> };
  readonly exitCode: number | null;
}

/** The same owned pipe feeds an SSH remote PTY or the development PTY bridge. */
export function createOmpStdinDriver<T extends OmpTerminalProcess>(
  initial: T,
  startContinued: () => T | Promise<T>,
  stopProcess: (process: T) => Promise<void>,
): OmpLifecycleHost {
  const owned = [initial];
  let current = initial;
  return {
    async write(bytes) {
      if (current.exitCode !== null) throw new Error("OMP lifecycle terminal is unavailable");
      await current.stdin.write(bytes);
      await current.stdin.flush();
    },
    async stop() { await stopProcess(current); },
    async startContinued() {
      current = await startContinued();
      owned.push(current);
    },
    async stopAll() {
      let failed = false;
      for (const child of owned) {
        try { await stopProcess(child); } catch { failed = true; }
      }
      if (failed) throw new Error("OMP lifecycle cleanup failed");
    },
  };
}

export interface OmpLifecycleEvidence {
  readonly newGeneration: { readonly sameInstance: boolean; readonly generationDelta: number; readonly staleRejected: boolean; readonly liveLaunches: number; readonly noStore: boolean };
  readonly fork: { readonly sameInstance: boolean; readonly generationDelta: number; readonly syntheticMessages: number; readonly staleRejected: boolean; readonly liveLaunches: number; readonly noStore: boolean };
  readonly resumed: { readonly newInstance: boolean; readonly generation: number; readonly sameLabel: boolean; readonly liveLaunches: number; readonly noStore: boolean; readonly revocations: number };
}

export interface OmpLifecycleTimeouts {
  readonly publicationMs: number;
  readonly revocationMs: number;
  readonly messageSettleMs: number;
}

const DEFAULT_TIMEOUTS: OmpLifecycleTimeouts = { publicationMs: 90_000, revocationMs: 45_000, messageSettleMs: 3_000 };
type LifecycleStep = "bounds" | "initial publication" | "new generation" | "fork messages" | "fork" | "first stop" | "first revocation" | "continue start" | "continue publication" | "continue launches" | "final stop" | "final revocation" | "cleanup";

export class OmpLifecycleFailure extends Error {
  constructor(readonly step: LifecycleStep) { super(`OMP lifecycle ${step} failed`); }
}

/**
 * `/fork` in stock OMP 18.4.8 forks immediately; `/branch` is an in-file rewind and has
 * no gateway-visible identity transition. Never infer a rewind from unchanged metadata.
 */
export async function runOmpLifecycle(options: {
  readonly host: OmpLifecycleHost;
  readonly observer: OmpLifecycleObserver;
  readonly label: string;
  readonly timeouts?: OmpLifecycleTimeouts;
}): Promise<OmpLifecycleEvidence> {
  const { host, observer, label } = options;
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  let phase: LifecycleStep = "bounds";
  let evidence: OmpLifecycleEvidence | undefined;
  try {
    for (const [name, value] of Object.entries(timeouts)) {
      if (!Number.isInteger(value) || value < (name === "messageSettleMs" ? 0 : 1) || value > 120_000) throw new Error();
    }
    phase = "initial publication";
    const initial = await observer.waitForPublishedSession(observer.origin, label, { timeoutMs: timeouts.publicationMs });
    if (typeof initial.instanceId !== "string" || initial.generation !== 1) throw new Error();
    const rotate = async (previous: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (typeof previous.generation !== "number") throw new Error();
      const generation = previous.generation + 1;
      const next = await observer.waitForPublishedSession(observer.origin, label, {
        timeoutMs: timeouts.publicationMs,
        matches: session => session.instanceId === previous.instanceId && session.generation === generation,
      });
      if (next.instanceId !== previous.instanceId || next.generation !== generation) throw new Error();
      await observer.verifyLaunchContracts(observer.origin, previous, "stale");
      await observer.verifyLaunchContracts(observer.origin, next);
      return next;
    };
    phase = "new generation";
    await host.write("/new\r");
    const fresh = await rotate(initial);
    phase = "fork messages";
    for (const message of ["Lifecycle qualification first synthetic message", "Lifecycle qualification second synthetic message"]) {
      await host.write(`${message}\r`);
      await Bun.sleep(timeouts.messageSettleMs);
    }
    phase = "fork";
    await host.write("/fork\r");
    await rotate(fresh);
    phase = "first stop";
    await host.stop();
    phase = "first revocation";
    await observer.waitForRevocation(observer.origin, label, timeouts.revocationMs);
    phase = "continue start";
    await host.startContinued();
    phase = "continue publication";
    const resumed = await observer.waitForPublishedSession(observer.origin, label, { timeoutMs: timeouts.publicationMs });
    if (typeof resumed.instanceId !== "string" || resumed.instanceId === initial.instanceId || resumed.generation !== 1 || resumed.cwdLabel !== label) throw new Error();
    phase = "continue launches";
    await observer.verifyLaunchContracts(observer.origin, resumed);
    phase = "final stop";
    await host.stop();
    phase = "final revocation";
    await observer.waitForRevocation(observer.origin, label, timeouts.revocationMs);
    evidence = {
      newGeneration: { sameInstance: true, generationDelta: 1, staleRejected: true, liveLaunches: 2, noStore: true },
      fork: { sameInstance: true, generationDelta: 1, syntheticMessages: 2, staleRejected: true, liveLaunches: 2, noStore: true },
      resumed: { newInstance: true, generation: 1, sameLabel: true, liveLaunches: 2, noStore: true, revocations: 2 },
    };
  } catch {
    // Never forward exception text from a terminal, host, fetch, or capability response.
  }
  // Every host stops whatever happened; a cleanup failure outranks the step that preceded it.
  const stopped = await host.stopAll().then(() => true, () => false);
  if (!stopped) throw new OmpLifecycleFailure("cleanup");
  if (evidence === undefined) throw new OmpLifecycleFailure(phase);
  return evidence;
}
