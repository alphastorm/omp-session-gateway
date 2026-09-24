import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OmpHostReader } from "../apps/gateway/src/omp-registry.ts";
import type { OmpDiscoveryEntry } from "../packages/protocol/src/types.ts";
import { fixtureModelError, OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { isStockOmpBinary } from "./post-release-smoke.ts";

export const CANARY_STAGES = ["publish", "snapshot", "stale-generation", "view", "control", "unregister"] as const;
export type CanaryStage = typeof CANARY_STAGES[number];
type StageResult = "passed" | "failed" | "skipped";
export interface CanarySummary {
  readonly ompVersion: string;
  readonly stages: Record<CanaryStage, StageResult>;
  readonly failedStage?: CanaryStage;
  readonly durationMs: number;
  readonly discoveryFileRemoved: boolean;
}
export interface CanaryOptions {
  readonly omp: string;
  /** Diagnostic override only; ordinary runs use the shared fixture arguments unchanged. */
  readonly model?: string;
}

interface CanaryGuestSnapshot {
  readonly phase: string;
  readonly readOnly: boolean;
  readonly entries: readonly unknown[];
}
interface CanaryGuestClient {
  connect(): void;
  close(): void;
  sendPrompt(text: string): void;
  getSnapshot(): CanaryGuestSnapshot;
}
interface CanaryClientModule {
  readonly GuestClient: new (capability: string, displayName: string) => CanaryGuestClient;
}

class CanaryFailure extends Error {}

export function parseCanaryArgs(args: readonly string[]): CanaryOptions {
  let omp: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--") || value.includes("\0")) throw new CanaryFailure("invalid arguments");
    if (flag === "--omp" && omp === undefined) omp = value;
    else if (flag === "--model" && model === undefined) model = value;
    else throw new CanaryFailure("invalid arguments");
  }
  if (omp === undefined) throw new CanaryFailure("--omp is required");
  return model === undefined ? { omp } : { omp, model };
}

/** Admit only the version, never trailing diagnostics from the binary's output. */
export function parseOmpVersion(banner: string): string | undefined {
  return /^(?:omp[ /])?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(banner.trim())?.[1];
}

export function isSupportedOmpVersion(version: string): boolean {
  return parseOmpVersion(version) === version && Bun.semver.satisfies(version, ">=18.1.20");
}

export function canarySummary(ompVersion: string, durationMs: number, failedStage?: CanaryStage, discoveryFileRemoved = false): CanarySummary {
  const failedIndex = failedStage === undefined ? CANARY_STAGES.length : CANARY_STAGES.indexOf(failedStage);
  const stages = Object.fromEntries(CANARY_STAGES.map((stage, index) => [
    stage, index < failedIndex ? "passed" : index === failedIndex ? "failed" : "skipped",
  ])) as Record<CanaryStage, StageResult>;
  return { ompVersion, stages, ...(failedStage === undefined ? {} : { failedStage }), durationMs, discoveryFileRemoved };
}

/** Reconstruct the public report before sending it to summaries or issue-job outputs. */
export function parseCanarySummary(text: string): CanarySummary {
  try {
    const value = JSON.parse(text) as CanarySummary;
    if (typeof value.ompVersion !== "string" || (value.ompVersion !== "" && parseOmpVersion(value.ompVersion) !== value.ompVersion)
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || typeof value.discoveryFileRemoved !== "boolean"
      || (value.failedStage !== undefined && !CANARY_STAGES.includes(value.failedStage))) throw new Error();
    const summary = canarySummary(value.ompVersion, value.durationMs, value.failedStage, value.discoveryFileRemoved);
    if (CANARY_STAGES.some(stage => value.stages[stage] !== summary.stages[stage])) throw new Error();
    return summary;
  } catch {
    throw new CanaryFailure("invalid canary summary");
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote one argument for a Windows command line (the CommandLineToArgvW/MSVCRT rules). */
export function windowsArgument(value: string): string {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

/**
 * PowerShell that starts one host in its own hidden console and prints only its PID. The console is
 * the point: OMP starts its interactive session, the only one `collab.autoStart` publishes from,
 * only when it has a terminal, and on Windows a redirected child has none. Nothing is redirected.
 * PowerShell itself runs with the runner's profile, because a cold start against an empty private
 * profile outlasted the command bound; it then replaces its whole environment with `environment`
 * before the start, so the host inherits nothing else, as `env -i` guarantees on POSIX.
 */
export function windowsHostScript(bun: string, argv: readonly string[], work: string, environment: Readonly<Record<string, string>>): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    // Resolve the cmdlet while the runner's module path is still in place.
    "$start = Get-Command -Name Start-Process -CommandType Cmdlet",
    "Get-ChildItem -Path Env: | ForEach-Object { Remove-Item -LiteralPath \"Env:$($_.Name)\" }",
    ...Object.entries(environment).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new CanaryFailure("invalid host environment");
      return `Set-Item -LiteralPath ${literal(`Env:${name}`)} -Value ${literal(value)}`;
    }),
    `$host_process = & $start -FilePath ${literal(bun)} -ArgumentList ${literal(argv.map(windowsArgument).join(" "))} -WorkingDirectory ${literal(work)} -WindowStyle Hidden -PassThru`,
    "[Console]::Out.Write($host_process.Id)",
  ].join("; ");
}

/** The variables a Windows child needs to start at all, from the runner, plus a private profile. */
function windowsEnvironment(home: string, temp: string, path: string): Record<string, string> {
  const inherited = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"] as const;
  const environment: Record<string, string> = {};
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment, PATH: path, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}

async function runCanary(args: readonly string[]): Promise<{ summary: CanarySummary; reason?: string }> {
  const started = performance.now();
  let stage: CanaryStage = "publish";
  let ompVersion = "";
  let failedStage: CanaryStage | undefined;
  let reason: string | undefined;
  let root: string | undefined;
  let discoveryDirectory: string | undefined;
  let reader: OmpHostReader | undefined;
  const guests: CanaryGuestClient[] = [];
  const session = `omp-upstream-canary-${crypto.randomUUID()}`;
  let ownsSession = false;
  let hostStopRequested = false;
  let hostPid: number | undefined;
  let stockBinary: string | undefined;
  let discoveryFileRemoved = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const path = process.env.PATH ?? "";
  const windows = process.platform === "win32";
  let environment: Record<string, string> = { PATH: path };
  // Stock OMP ships a Bun script. Windows cannot execute its shebang, so this Bun runs it there.
  const omp = (binary: string, ...rest: string[]): string[] => windows ? [process.execPath, binary, ...rest] : [binary, ...rest];

  // All child output is discarded except bounded version/PID/status responses retained in memory.
  function command(argv: string[], failure: string, allowFailure = false, options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {}): string | undefined {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      env: options.env ?? environment, cwd: root === undefined ? undefined : join(root, "work"),
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: options.timeoutMs ?? 10_000, maxBuffer: 4_096,
    });
    if (result.error !== undefined || result.status !== 0) {
      if (allowFailure) return undefined;
      throw new CanaryFailure(failure);
    }
    return result.stdout.trim();
  }

  // The first OMP command in a fresh private home also unpacks OMP's native addon; on a Windows
  // runner that alone outlasted 10 s (run 36015033822). The bound is longer, never retried.
  function ompCommand(binary: string, args: readonly string[], failure: string): string | undefined {
    return command(omp(binary, ...args), failure, false, { timeoutMs: 60_000 });
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, failure: string, cleaning = false): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (!cleaning && interrupted) throw new CanaryFailure("interrupted");
      if (await predicate()) return;
      await Bun.sleep(100);
    }
    throw new CanaryFailure(failure);
  }

  function stopHost(): void {
    if (!ownsSession || hostStopRequested) return;
    if (windows) {
      // A console process takes no signal from outside its console, so end the host's whole tree.
      // It then cannot unregister, which the verdict accepts: its named pipe goes with it.
      if (hostPid !== undefined && !hostExited()) {
        command(["taskkill.exe", "/PID", String(hostPid), "/T", "/F"], "host stop failed");
      }
      hostStopRequested = true;
      return;
    }
    const pidText = command(["tmux", "display-message", "-p", "-t", `=${session}:`, "#{pane_pid}"], "host stop failed", true);
    if (pidText === undefined) return;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new CanaryFailure("host PID query failed");
    if (hostPid !== undefined && hostPid !== pid) throw new CanaryFailure("host PID changed");
    hostPid = pid;
    try { process.kill(pid, "SIGTERM"); hostStopRequested = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CanaryFailure("host signal failed");
    }
  }

  function hostExited(): boolean {
    if (hostPid === undefined) return !ownsSession;
    try { process.kill(hostPid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw new CanaryFailure("host exit query failed");
    }
  }

  async function observeStoppedHost(): Promise<boolean> {
    if (!hostExited()) return false;
    if (reader === undefined) return true;
    if (!await reader.directoryUsable()) return false;
    const entries = await reader.listEntries();
    discoveryFileRemoved = entries.length === 0;
    for (const entry of entries) {
      if ((await reader.snapshot(entry)).status !== "gone") return false;
    }
    return true;
  }

  try {
    const options = parseCanaryArgs(args);
    const binary = await realpath(resolve(options.omp));
    if (!isStockOmpBinary(binary)) throw new CanaryFailure("stock mainline OMP is required");
    stockBinary = binary;
    root = await mkdtemp(join(tmpdir(), "omp-upstream-canary-"));
    await chmod(root, 0o700);
    const home = join(root, "home");
    const work = join(root, "work");
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    if (windows) {
      const temp = join(root, "temp");
      for (const directory of [temp, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      environment = windowsEnvironment(home, temp, path);
    } else {
      environment = { HOME: home, PATH: path, TERM: "xterm-256color" };
    }
    discoveryDirectory = join(home, ".omp", "run", "collab-hosts");
    reader = new OmpHostReader({ directory: discoveryDirectory, timeoutMs: 5_000 });
    ompVersion = parseOmpVersion(ompCommand(binary, ["--version"], "OMP version query failed") ?? "") ?? "";
    if (!isSupportedOmpVersion(ompVersion)) throw new CanaryFailure("stock OMP >=18.1.20 is required");
    ompCommand(binary, ["config", "set", "collab.autoStart", "control"], "auto-start configuration failed");
    const fixtureArgs = OMP_FIXTURE_ARGS.map((value, index) =>
      options.model !== undefined && OMP_FIXTURE_ARGS[index - 1] === "--model" ? options.model : value);
    if (windows) {
      hostPid = Number(command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        windowsHostScript(process.execPath, [binary, ...fixtureArgs], work, { ...environment, ...OMP_FIXTURE_ENV })],
      "host startup failed", false, { env: process.env, timeoutMs: 60_000 }));
      ownsSession = true;
    } else {
      const launcher = join(root, "launch.sh");
      const hostEnvironment = Object.entries({ ...environment, ...OMP_FIXTURE_ENV }).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
      // env -i matters even with a private HOME: an existing tmux server keeps its own environment.
      await writeFile(launcher, `#!/bin/sh\ncd ${quote(work)} || exit 1\nexec /usr/bin/env -i ${hostEnvironment} ${[binary, ...fixtureArgs].map(quote).join(" ")}\n`, { mode: 0o700 });
      command(["tmux", "new-session", "-d", "-s", session, "-x", "200", "-y", "50", `exec ${quote(launcher)}`], "host startup failed");
      ownsSession = true;
      hostPid = Number(command(["tmux", "display-message", "-p", "-t", `=${session}:`, "#{pane_pid}"], "host PID query failed"));
    }
    if (!Number.isSafeInteger(hostPid) || hostPid <= 1) throw new CanaryFailure("host PID query failed");
    let entry: OmpDiscoveryEntry | undefined;
    await waitFor(async () => {
      entry = (await reader!.listEntries())[0];
      return entry !== undefined;
    }, 90_000, "publication timed out");
    if (entry === undefined) throw new CanaryFailure("publication timed out");

    stage = "snapshot";
    const snapshot = await reader.snapshot(entry);
    if (snapshot.status !== "ok") throw new CanaryFailure("snapshot query failed");
    if (snapshot.value.generation !== 1 || snapshot.value.access !== "control") throw new CanaryFailure("snapshot contract mismatch");
    const model = snapshot.value.model;
    const modelError = fixtureModelError({ model: model === undefined ? undefined : `${model.provider}/${model.id}` }, options.model);
    if (modelError !== undefined) throw new CanaryFailure(modelError);
    const generation = snapshot.value.generation;

    stage = "stale-generation";
    const stale = await reader.link(entry, "view", generation + 1);
    if (stale.status !== "refused") throw new CanaryFailure("stale generation was not refused");

    stage = "view";
    // Like relay-soak.ts, preserve the pinned client’s separate, relaxed TypeScript boundary.
    const moduleUrl = new URL("../packages/collab-client/upstream/src/lib/client.ts", import.meta.url).href;
    const { GuestClient } = await import(moduleUrl) as CanaryClientModule;
    if (typeof GuestClient !== "function") throw new CanaryFailure("embedded client is unavailable");
    for (const access of ["view", "control"] as const) {
      stage = access;
      const link = await reader.link(entry, access, generation);
      if (link.status !== "ok") throw new CanaryFailure("capability query failed");
      const guest = new GuestClient(link.value.reveal(), "upstream-canary");
      guests.push(guest);
      guest.connect();
      await waitFor(() => guest.getSnapshot().phase === "live", 30_000, "guest join timed out");
      if (guest.getSnapshot().readOnly !== (access === "view")) throw new CanaryFailure("guest access mismatch");
      if (access === "control") {
        const marker = `upstream-canary-${crypto.randomUUID()}`;
        guest.sendPrompt(marker);
        await waitFor(() => JSON.stringify(guest.getSnapshot().entries).includes(marker), 30_000, "prompt echo timed out");
      }
    }

    stage = "unregister";
    stopHost();
    await waitFor(observeStoppedHost, 30_000, "unregister timed out");
    if (interrupted) throw new CanaryFailure("interrupted");
  } catch (error) {
    failedStage = stage;
    // Never forward exceptions from OMP, the reader, or GuestClient: they may contain bearer data.
    reason = error instanceof CanaryFailure ? error.message : "operation failed";
  } finally {
    let cleanupFailed = false;
    for (const guest of guests) {
      try { guest.close(); } catch { cleanupFailed = true; }
    }
    try {
      stopHost();
      if (ownsSession) {
        await waitFor(hostExited, 10_000, "host stop timed out", true);
      }
    } catch { cleanupFailed = true; }
    if (ownsSession && !windows) {
      command(["tmux", "kill-session", "-t", `=${session}`], "session cleanup failed", true);
      if (command(["tmux", "has-session", "-t", `=${session}`], "session cleanup failed", true) !== undefined) cleanupFailed = true;
    }
    try {
      await waitFor(observeStoppedHost, 30_000, "discovery cleanup timed out", true);
      // The verdict above is already fixed. Let OMP, never the gateway, prune its dead publication.
      if (reader !== undefined && !discoveryFileRemoved && stockBinary !== undefined) {
        ompCommand(stockBinary, ["collab", "list"], "OMP-owned cleanup failed");
      }
      // Refuse to recursively remove a surviving discovery file, including one the reader rejected.
      // OMP alone owns unregistering; rmdir succeeds only once its discovery directory is empty.
      if (discoveryDirectory !== undefined) {
        try { await rmdir(discoveryDirectory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      failedStage ??= "unregister";
      reason = reason === undefined ? "cleanup failed" : `${reason}; cleanup failed`;
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  return { summary: canarySummary(ompVersion, Math.round(performance.now() - started), failedStage, discoveryFileRemoved), ...(reason === undefined ? {} : { reason }) };
}

if (import.meta.main) {
  // The vendored client can warn with raw frame errors. This CLI's only diagnostics are the
  // allowlisted report and fixed stage reasons below; never expose upstream console arguments.
  for (const method of ["log", "info", "warn", "error", "debug", "dir", "trace", "table"] as const) console[method] = () => {};
  const { summary, reason } = await runCanary(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.failedStage !== undefined) process.stderr.write(`${summary.failedStage}: ${reason}\n`);
  process.exitCode = summary.failedStage === undefined ? 0 : 1;
}
