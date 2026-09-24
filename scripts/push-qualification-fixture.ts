import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { PUSH_FIXTURE_COMMANDS, type PushFixtureCommand } from "./fixtures/push-qualification-extension.ts";

export interface FixtureExecution { readonly exitCode: number; readonly stdout: string }
export type FixtureExecutor = (argv: readonly string[]) => Promise<FixtureExecution>;
export interface PushFixtureLocation {
  readonly root: string;
  readonly epoch: string;
  readonly bun: string;
  readonly binary: string;
  /** Stage this module, omp-fixture.ts/json, and fixtures/ below this scripts directory. */
  readonly scripts: string;
}

export const executeFixture: FixtureExecutor = async argv => {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, exitCode };
};

/** The only host transport boundary. An SSH executor can run these exact argv on the retained Mac. */
export async function commandPushFixture(
  location: PushFixtureLocation,
  operation: "start" | PushFixtureCommand,
  execute: FixtureExecutor = executeFixture,
): Promise<void> {
  const result = await execute([
    location.bun, join(location.scripts, "push-qualification-fixture.ts"), operation,
    location.root, location.epoch, location.binary, location.scripts,
  ]);
  if (result.exitCode !== 0) throw new Error(`Push fixture ${operation} failed`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForAcknowledgement(root: string, epoch: string, sequence: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const raw = await readFile(join(root, "ack.json"), "utf8").catch(() => undefined);
    if (raw !== undefined) {
      const ack: unknown = JSON.parse(raw);
      if (typeof ack !== "object" || ack === null || !("epoch" in ack) || ack.epoch !== epoch ||
        !("sequence" in ack) || !("phase" in ack)) throw new Error("invalid fixture acknowledgement");
      if (ack.sequence === sequence) {
        if (ack.phase === "failed") throw new Error("fixture rejected command");
        if (["ready", "accepted", "settled"].includes(String(ack.phase))) return;
      }
    }
    await Bun.sleep(100);
  }
  throw new Error("fixture acknowledgement timed out");
}

async function control(root: string, epoch: string, operation: PushFixtureCommand): Promise<void> {
  if (await readFile(join(root, "owner"), "utf8") !== epoch) throw new Error("fixture ownership changed");
  const prior: unknown = JSON.parse(await readFile(join(root, "ack.json"), "utf8"));
  if (typeof prior !== "object" || prior === null || !("epoch" in prior) || prior.epoch !== epoch || !("sequence" in prior) || typeof prior.sequence !== "number" ||
    !Number.isSafeInteger(prior.sequence) || prior.sequence < 0) throw new Error("invalid fixture sequence");
  const sequence = prior.sequence + 1;
  await writeFile(join(root, "command.json.tmp"), JSON.stringify({ epoch, sequence, operation }), { mode: 0o600 });
  await rename(join(root, "command.json.tmp"), join(root, "command.json"));
  await waitForAcknowledgement(root, epoch, sequence);
}

export async function runFixtureOperation(location: PushFixtureLocation, operation: "start" | PushFixtureCommand): Promise<void> {
  const { root, epoch, binary, scripts } = location;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(epoch) || root !== resolve(root) || root.includes("collab-hosts")) {
    throw new Error("invalid fixture location");
  }
  const label = `omp-push-${epoch}`;
  if (operation === "start") {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "owner"), epoch, { mode: 0o600, flag: "wx" });
    await mkdir(join(root, "agent"), { mode: 0o700 });
    await writeFile(join(root, "fixture.yml"), "collab:\n  autoStart: control\n", { mode: 0o600, flag: "wx" });
    const host = /\.[cm]?[jt]s$/u.test(binary) ? [location.bun, binary] : [binary];
    const argv = [...host, ...OMP_FIXTURE_ARGS, "--config", join(root, "fixture.yml"),
      "--extension", join(scripts, "fixtures", "push-qualification-extension.ts"), "/push-qualification"];
    await writeFile(join(root, "launch.sh"), ["#!/bin/sh",
      ...Object.entries({ ...OMP_FIXTURE_ENV, PI_CODING_AGENT_DIR: join(root, "agent"), OMP_PUSH_FIXTURE_ROOT: root, OMP_PUSH_FIXTURE_EPOCH: epoch })
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `exec ${argv.map(shellQuote).join(" ")} >/dev/null 2>&1`, ""].join("\n"), { mode: 0o700, flag: "wx" });
    const launched = await executeFixture(["tmux", "new-session", "-d", "-s", label, "-c", root, `exec ${shellQuote(join(root, "launch.sh"))}`]);
    if (launched.exitCode !== 0) throw new Error("fixture launch failed");
    const pane = await executeFixture(["tmux", "display-message", "-p", "-t", label, "#{pane_pid}"]);
    if (pane.exitCode !== 0 || !/^\d+\s*$/u.test(pane.stdout)) throw new Error("fixture process identity unavailable");
    await writeFile(join(root, "pid"), pane.stdout.trim(), { mode: 0o600, flag: "wx" });
    await waitForAcknowledgement(root, epoch, 0);
  } else if (operation === "stop") {
    const owner = await readFile(join(root, "owner"), "utf8").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (owner === undefined) {
      // start can be interrupted between mkdir and its first exclusive owner write.
      // Remove only an empty directory; never recursively remove an unowned tree.
      await rmdir(root).catch(error => { if (error.code !== "ENOENT") throw error; });
      return;
    }
    if (owner !== epoch) throw new Error("fixture ownership changed");
    const alive = await executeFixture(["tmux", "has-session", "-t", label]);
    if (alive.exitCode === 0) {
      await control(root, epoch, "stop").catch(() => undefined);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await executeFixture(["tmux", "has-session", "-t", label])).exitCode === 0) await Bun.sleep(100);
      if ((await executeFixture(["tmux", "has-session", "-t", label])).exitCode === 0) {
        await executeFixture(["tmux", "kill-session", "-t", label]);
      }
      if ((await executeFixture(["tmux", "has-session", "-t", label])).exitCode === 0) throw new Error("fixture remained active");
    }
    const pid = await readFile(join(root, "pid"), "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (pid !== undefined) {
      if (!/^\d+$/u.test(pid)) throw new Error("invalid fixture process identity");
      const deadline = Date.now() + 10_000;
      let ownedAlive = true;
      while (Date.now() < deadline) {
        const process = await executeFixture(["ps", "-p", pid, "-o", "command="]);
        ownedAlive = process.exitCode === 0 && process.stdout.includes(join(root, "fixture.yml"));
        if (!ownedAlive) break;
        await Bun.sleep(100);
      }
      if (ownedAlive) throw new Error("owned OMP process remained active");
    }
    await rm(root, { recursive: true });
  } else {
    await control(root, epoch, operation);
  }
}

if (import.meta.main) {
  const [operation, root, epoch, binary, scripts] = process.argv.slice(2);
  try {
    if (operation === undefined || root === undefined || epoch === undefined || binary === undefined || scripts === undefined ||
      (operation !== "start" && !PUSH_FIXTURE_COMMANDS.includes(operation as PushFixtureCommand))) throw new Error("invalid fixture arguments");
    await runFixtureOperation({ root, epoch, binary, scripts, bun: process.execPath }, operation as "start" | PushFixtureCommand);
    console.log(JSON.stringify({ completed: true }));
  } catch {
    console.error("Push fixture operation failed");
    process.exitCode = 1;
  }
}
