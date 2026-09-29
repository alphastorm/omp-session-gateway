import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Subprocess } from "bun";
import { parseLaunchResponse, parseSessionEvent, parseSessionListResponse, type SessionMetadata } from "../packages/protocol/src/index.ts";
import { LatencyDistribution, parseCpuTime, parseEnduranceOptions, parseLinuxStat, SampleSeries, SseFrames, type EnduranceOptions } from "./endurance-metrics.ts";
import { assertMetadataSafe } from "./metadata-safety.ts";
import { startSyntheticHost, syntheticViewCapability, type SyntheticHost } from "./synthetic-hosts.ts";

const REPOSITORY = resolve(import.meta.dir, "..");

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const text = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error("process counter command failed");
    return text.trim();
  } finally { clearTimeout(timeout); }
}

async function resourceSampler(pid: number) {
  const linux = process.platform === "linux";
  const ticks = linux ? Number(await command(["getconf", "CLK_TCK"])) : 0;
  const pageBytes = linux ? Number(await command(["getconf", "PAGESIZE"])) : 0;
  const lsof = linux ? undefined : Bun.which("lsof");
  return async () => {
    let rssKiB: number;
    let cpuSeconds: number;
    let openFds = -1;
    if (linux) {
      ({ rssKiB, cpuSeconds } = parseLinuxStat(await readFile(`/proc/${pid}/stat`, "utf8"), ticks, pageBytes));
      openFds = (await readdir(`/proc/${pid}/fd`)).length;
    } else {
      const fields = (await command(["ps", "-p", String(pid), "-o", "rss=", "-o", "time="])).split(/\s+/u);
      rssKiB = Number(fields[0]);
      cpuSeconds = parseCpuTime(fields[1] ?? "");
      if (lsof) {
        const descriptors = await command([lsof, "-nP", "-a", "-p", String(pid), "-d", "0-999999", "-F", "f"]);
        openFds = descriptors.split("\n").filter(line => /^f[0-9]+$/u.test(line)).length;
      }
    }
    if (!Number.isFinite(rssKiB) || rssKiB <= 0 || !Number.isFinite(cpuSeconds) || cpuSeconds < 0) throw new Error("invalid process sample");
    return { rssKiB, cpuSeconds, openFds };
  };
}

interface PendingChange {
  title: string;
  revision: number;
  changedAtMs: number;
  replyAtMs?: number;
  seen: Set<number>;
}

/** Numeric evidence only. Failure codes are documented in TEST_PLAN; never echo a response or caught error. */
async function runEndurance(options: EnduranceOptions) {
  const abort = new AbortController();
  let failureCode = 0;
  let stage = 2;
  let interruptedSignal = 0;
  let closing = false;
  let temporaryRoot: string | undefined;
  let daemon: Subprocess | undefined;
  let csv: FileHandle | undefined;
  let samplesBytes = 0;
  let rootRemoved = 0;
  let daemonStopped = 0;
  const hosts = new Map<string, SyntheticHost>();
  const secrets = new Set<string>();
  const readers: Promise<void>[] = [];
  const clients = Array.from({ length: options.subscribers }, () => ({
    ready: false, revision: -1, sessions: new Map<string, SessionMetadata>(),
  }));
  const pending = new Map<string, PendingChange>();
  let churn: { oldId: string; newId: string; deadlineMs: number } | undefined;
  const launchLatency = new LatencyDistribution();
  const changeLatency = new LatencyDistribution();
  const replyLatency = new LatencyDistribution();
  const rss = new SampleSeries();
  const cpu = new SampleSeries();
  const fds = new SampleSeries();
  const sessionCounts = new SampleSeries();
  let idleRssKiB = 0;
  let idleCpuSeconds = 0;
  let launchFailures = 0;
  let sseEvents = 0;
  let metadataChanges = 0;
  let churns = 0;
  let listChecks = 0;
  let beganMs = 0;
  let elapsedSeconds = 0;
  let launchIndex = 0;
  const fail = (code: number): void => {
    if (!failureCode) failureCode = code;
    abort.abort();
  };
  const check = (): void => { if (abort.signal.aborted) throw new Error("endurance stopped"); };
  const sigint = (): void => { interruptedSignal = 2; fail(10); };
  const sigterm = (): void => { interruptedSignal = 15; fail(10); };
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  const base = `http://127.0.0.1:${options.port}`;
  const deliveryBudgetMs = (2 * options.pollSeconds + 5) * 1_000;
  const request = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${base}${path}`, {
    ...init, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
  });
  const list = async () => {
    const response = await request("/api/v1/sessions");
    if (response.status !== 200) throw new Error("session list failed");
    const body = assertMetadataSafe(await response.text(), secrets);
    const result = parseSessionListResponse(body);
    listChecks++;
    return result.sessions;
  };
  const startHost = async (index: number): Promise<SyntheticHost> => {
    check();
    const host = await startSyntheticHost({
      directory: join(temporaryRoot!, "run", "collab-hosts"), index, viewLinks: true,
      onSnapshot(instanceId, revision, replyAtMs) {
        const change = pending.get(instanceId);
        if (change && change.revision === revision && change.replyAtMs === undefined) change.replyAtMs = replyAtMs;
      },
    });
    hosts.set(host.instanceId, host);
    secrets.add(host.token);
    return host;
  };
  const consume = async (index: number): Promise<void> => {
    const handshake = new AbortController();
    const timeout = setTimeout(() => handshake.abort(), 10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${base}/api/v1/events`, { signal: AbortSignal.any([abort.signal, handshake.signal]) });
      clearTimeout(timeout);
      if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
        throw new Error("SSE handshake failed");
      }
      reader = response.body.getReader();
      const frames = new SseFrames();
      const client = clients[index]!;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE closed unexpectedly");
        const receivedAtMs = performance.now();
        for (const frame of frames.push(chunk.value)) {
          const value = assertMetadataSafe(frame.data, secrets);
          if (frame.event === "keepalive") {
            if (JSON.stringify(value) !== "{}") throw new Error("invalid keepalive");
            continue;
          }
          const event = parseSessionEvent(value);
          if (event.type !== frame.event || event.revision <= client.revision) throw new Error("out of order SSE");
          client.revision = event.revision;
          sseEvents++;
          if (event.type === "snapshot") {
            if (client.ready) throw new Error("unexpected SSE snapshot");
            for (const session of event.sessions) client.sessions.set(session.instanceId, session);
            client.ready = true;
          } else if (!client.ready) {
            throw new Error("SSE missing initial snapshot");
          } else if (event.type === "session_remove") {
            if (!churn || churn.oldId !== event.instanceId) throw new Error("unexpected session removal");
            client.sessions.delete(event.instanceId);
          } else {
            client.sessions.set(event.session.instanceId, event.session);
            const change = pending.get(event.session.instanceId);
            if (change && change.title === event.session.title && !change.seen.has(index)) {
              if (change.replyAtMs === undefined || event.session.generation !== hosts.get(event.session.instanceId)?.generation) {
                throw new Error("unbound metadata event");
              }
              changeLatency.observe(receivedAtMs - change.changedAtMs);
              replyLatency.observe(receivedAtMs - change.replyAtMs);
              change.seen.add(index);
              if (change.seen.size === options.subscribers) pending.delete(event.session.instanceId);
            }
          }
        }
      }
    } catch {
      if (!closing && !abort.signal.aborted) fail(6);
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => undefined);
    }
  };
  try {
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Unix host required");
    // Validate callers too: no imported invocation may bypass the live-daemon port exclusion.
    if (!Number.isInteger(options.port) || options.port < 1_024 || options.port > 65_535 || options.port === 4317) throw new Error("unsafe port");
    if (!await Bun.file(join(REPOSITORY, "apps/web/dist/index.html")).exists()) throw new Error("build required");
    stage = 3;
    await mkdir(resolve(options.output), { mode: 0o700 });
    csv = await open(join(resolve(options.output), "samples.csv"), "wx", 0o600);
    await csv.write("sample,elapsed_s,sessions,rss_kib,cpu_seconds,open_fds,sse_events,launches,metadata_changes,churns,capability_free\n");
    // /tmp keeps all Unix socket paths short on macOS as well as Linux. No real discovery/config roots.
    temporaryRoot = await mkdtemp("/tmp/omp-endurance-");
    for (const path of ["config/omp-session-gateway", "state/omp-session-gateway", "run/collab-hosts"]) {
      await mkdir(join(temporaryRoot, path), { recursive: true, mode: 0o700 });
    }
    await writeFile(join(temporaryRoot, "config/omp-session-gateway/config.json"), JSON.stringify({
      http: { hostname: "127.0.0.1", port: options.port, publicOrigin: base },
      auth: { mode: "dev-localhost", allowedLogins: [] },
      omp: { discoveryDir: join(temporaryRoot, "run/collab-hosts") },
      registry: { heartbeatSeconds: options.pollSeconds, ttlSeconds: options.pollSeconds * 3 + 5, maxSessions: 100 },
    }), { mode: 0o600, flag: "wx" });
    const readiness = "synthetic-readiness-".padEnd(43, "x");
    secrets.add(readiness);
    await writeFile(join(temporaryRoot, "config/omp-session-gateway/readiness-token"), `${readiness}\n`, { mode: 0o600, flag: "wx" });
    // Fail on an occupied port rather than accidentally measuring another daemon.
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(options.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    check();
    stage = 4;
    daemon = Bun.spawn([process.execPath, "apps/gateway/src/cli.ts", "serve"], {
      cwd: REPOSITORY, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      env: { ...process.env, XDG_CONFIG_HOME: join(temporaryRoot, "config"), XDG_STATE_HOME: join(temporaryRoot, "state"),
        XDG_RUNTIME_DIR: join(temporaryRoot, "run"), TMPDIR: join(temporaryRoot, "run") },
    });
    void daemon.exited.then(() => { if (!closing) fail(4); });
    const readyDeadline = performance.now() + 90_000;
    while (true) {
      check();
      try {
        const health = await request("/api/v1/health");
        const body: unknown = await health.json();
        if (health.status === 200 && typeof body === "object" && body !== null && "status" in body && body.status === "ready") {
          await list();
          break;
        }
      } catch { check(); }
      if (performance.now() >= readyDeadline) throw new Error("readiness deadline");
      await delay(100, undefined, { signal: abort.signal });
    }
    const resources = await resourceSampler(daemon.pid);
    const idle = await resources();
    idleRssKiB = idle.rssKiB;
    idleCpuSeconds = idle.cpuSeconds;
    stage = 5;
    for (let index = 0; index < options.hosts; index++) await startHost(index);
    const registrationDeadline = performance.now() + 120_000;
    while ((await list()).length !== options.hosts) {
      check();
      if (performance.now() >= registrationDeadline) throw new Error("registration deadline");
      await delay(100, undefined, { signal: abort.signal });
    }
    stage = 6;
    for (let index = 0; index < options.subscribers; index++) readers.push(consume(index));
    const streamDeadline = performance.now() + 15_000;
    while (!clients.every(client => client.ready && client.sessions.size === options.hosts)) {
      check();
      if (performance.now() >= streamDeadline) throw new Error("SSE readiness deadline");
      await delay(50, undefined, { signal: abort.signal });
    }
    beganMs = performance.now();
    const endMs = beganMs + options.durationSeconds * 1_000;
    let nextSampleMs = beganMs;
    let nextLaunchMs = beganMs + 2_000;
    let nextMetadataMs = beganMs + 1_000;
    let nextChurnMs = options.churnSeconds ? beganMs + options.churnSeconds * 1_000 : Infinity;
    const sample = async (): Promise<void> => {
      stage = 5;
      const sessions = await list();
      const expectedFloor = options.hosts - Number(churn !== undefined);
      if (sessions.length < expectedFloor || sessions.length > options.hosts) throw new Error("session count changed");
      if (!churn && (sessions.some(session => !hosts.has(session.instanceId))
        || clients.some(client => client.sessions.size !== options.hosts || [...hosts.keys()].some(id => !client.sessions.has(id))))) {
        throw new Error("session membership changed");
      }
      stage = 9;
      const counters = await resources();
      elapsedSeconds = (performance.now() - beganMs) / 1_000;
      rss.observe(elapsedSeconds, counters.rssKiB);
      cpu.observe(elapsedSeconds, counters.cpuSeconds);
      if (counters.openFds >= 0) fds.observe(elapsedSeconds, counters.openFds);
      sessionCounts.observe(elapsedSeconds, sessions.length);
      const values = [rss.summary().count, elapsedSeconds.toFixed(3), sessions.length, counters.rssKiB,
        counters.cpuSeconds.toFixed(3), counters.openFds, sseEvents, launchLatency.summary().count, metadataChanges, churns, 1];
      await csv!.write(`${values.join(",")}\n`);
    };
    while (performance.now() < endMs) {
      check();
      const now = performance.now();
      stage = 7;
      for (const change of pending.values()) if (now - change.changedAtMs > deliveryBudgetMs) throw new Error("metadata delivery deadline");
      if (churn) {
        if (clients.every(client => !client.sessions.has(churn!.oldId) && client.sessions.has(churn!.newId))) {
          churn = undefined;
          churns++;
        } else if (now > churn.deadlineMs) throw new Error("churn convergence deadline");
      }
      if (now >= nextSampleMs) {
        await sample();
        nextSampleMs += options.sampleSeconds * 1_000;
        // Do not manufacture samples to backfill a blocked sampler.
        if (nextSampleMs < performance.now()) nextSampleMs = beganMs + (Math.floor((performance.now() - beganMs) / (options.sampleSeconds * 1_000)) + 1) * options.sampleSeconds * 1_000;
      }
      if (now >= nextLaunchMs) {
        const candidates = [...hosts.values()].filter(host => clients.every(client => client.sessions.get(host.instanceId)?.generation === host.generation));
        if (candidates.length) {
          stage = 8;
          const host = candidates[launchIndex++ % candidates.length]!;
          const started = performance.now();
          try {
            const response = await request(`/api/v1/sessions/${host.instanceId}/launch`, {
              method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
              body: JSON.stringify({ mode: "view", generation: host.generation }),
            });
            if (response.status !== 200 || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("launch failed");
            const reply = parseLaunchResponse(await response.json());
            if (reply.mode !== "view" || reply.generation !== host.generation
              || reply.capability !== syntheticViewCapability(host.instanceId, host.generation)) throw new Error("wrong launch capability");
            launchLatency.observe(performance.now() - started);
          } catch { launchFailures++; throw new Error("launch failed"); }
        }
        // >=4s between starts stays below the production per-identity 20/minute limiter, without retries.
        nextLaunchMs = performance.now() + options.launchSeconds * 1_000;
      }
      if (now >= nextChurnMs && now + deliveryBudgetMs < endMs) {
        if (!pending.size && !churn) {
          stage = 5;
          const departing = [...hosts.values()][churns % hosts.size]!;
          churn = { oldId: departing.instanceId, newId: "", deadlineMs: now + deliveryBudgetMs };
          await departing.stop();
          hosts.delete(departing.instanceId);
          const replacement = await startHost(options.hosts + churns);
          churn.newId = replacement.instanceId;
          nextChurnMs = now + options.churnSeconds * 1_000;
        } else nextChurnMs = now + 1_000;
      }
      if (now >= nextMetadataMs && now + deliveryBudgetMs < endMs) {
        if (!churn && !pending.size) {
          for (const host of hosts.values()) {
            pending.set(host.instanceId, { ...host.updateMetadata(), seen: new Set() });
            metadataChanges++;
          }
          nextMetadataMs = now + options.metadataSeconds * 1_000;
        } else nextMetadataMs = now + 1_000;
      }
      await delay(Math.max(1, Math.min(1_000, nextSampleMs - performance.now(), nextLaunchMs - performance.now(),
        nextMetadataMs > now && nextMetadataMs + deliveryBudgetMs < endMs ? nextMetadataMs - performance.now() : 1_000,
        nextChurnMs > now && nextChurnMs + deliveryBudgetMs < endMs ? nextChurnMs - performance.now() : 1_000,
        endMs - performance.now())), undefined, { signal: abort.signal });
    }
    check();
    stage = 7;
    if (pending.size || churn || changeLatency.summary().count !== metadataChanges * options.subscribers || !launchLatency.summary().count) {
      throw new Error("incomplete measurement");
    }
    await sample();
  } catch {
    if (!failureCode) failureCode = stage;
  } finally {
    closing = true;
    abort.abort();
    const stopped = await Promise.allSettled([...hosts.values()].map(host => host.stop()));
    if (stopped.some(result => result.status === "rejected") && !failureCode) failureCode = 11;
    await Promise.all(readers);
    if (daemon) {
      try {
        if (daemon.exitCode === null) daemon.kill("SIGTERM");
        const deadline = setTimeout(() => daemon?.kill("SIGKILL"), 5_000);
        try { await daemon.exited; daemonStopped = 1; } finally { clearTimeout(deadline); }
      } catch { if (!failureCode) failureCode = 11; }
    }
    if (temporaryRoot) {
      try { await rm(temporaryRoot, { recursive: true, force: true }); rootRemoved = 1; }
      catch { if (!failureCode) failureCode = 11; }
    }
    if (csv) {
      try { samplesBytes = (await csv.stat()).size; await csv.close(); }
      catch { if (!failureCode) failureCode = 11; }
    }
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
  const launch = launchLatency.summary();
  const memory = rss.summary();
  const cpuTime = cpu.summary();
  const fileDescriptors = fds.summary();
  const cpuPercent = elapsedSeconds > 0 ? 100 * (cpuTime.end - cpuTime.start) / elapsedSeconds : 0;
  return {
    schemaVersion: 1, correctness: { passed: Number(failureCode === 0), failureCode, interruptedSignal, daemonStopped, rootRemoved },
    config: { hosts: options.hosts, subscribers: options.subscribers, durationSeconds: options.durationSeconds,
      sampleSeconds: options.sampleSeconds, pollSeconds: options.pollSeconds, metadataSeconds: options.metadataSeconds,
      churnSeconds: options.churnSeconds, launchSeconds: options.launchSeconds, port: options.port },
    elapsedSeconds, samplesBytes, listChecks, sessions: sessionCounts.summary(),
    launch: { ...launch, failures: launchFailures },
    sse: { events: sseEvents, metadataChanges, churns, pendingChanges: pending.size,
      changeToReceipt: changeLatency.summary(), snapshotReplyToReceipt: replyLatency.summary() },
    daemon: { idleRssKiB, idleCpuSeconds, rssKiB: memory, cpuSeconds: cpuTime,
      cpuWindowSeconds: cpuTime.end - cpuTime.start, cpuOneCorePercent: cpuPercent,
      openFds: { available: Number(fileDescriptors.count > 0), ...fileDescriptors } },
    targets: {
      launchP95: { measuredMs: launch.p95Ms, belowMs: 250, passed: launch.count ? Number(launch.p95Ms < 250) : -1 },
      idleMemory: { measuredMiB: idleRssKiB / 1_024, belowMiB: 100, passed: idleRssKiB ? Number(idleRssKiB < 102_400) : -1 },
      cpu: { measuredOneCorePercent: cpuPercent, belowOneCorePercent: 1, passed: cpuTime.count ? Number(cpuPercent < 1) : -1 },
      metadataDelivery: { measuredReplyP95Ms: replyLatency.summary().p95Ms, passed: -1 },
      eightHourGrowth: { windowReached: Number(elapsedSeconds >= 28_800), rssKiBPerHour: memory.slopePerSecond * 3_600,
        fdsPerHour: fileDescriptors.slopePerSecond * 3_600, internalCountsMeasured: 0, passed: -1 },
    },
  };
}

if (import.meta.main) {
  try {
    const summary = await runEndurance(parseEnduranceOptions(process.argv.slice(2)));
    console.log(JSON.stringify(summary));
    process.exitCode = summary.correctness.passed ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, correctness: { passed: 0, failureCode: 1 } }));
    process.exitCode = 1;
  }
}
