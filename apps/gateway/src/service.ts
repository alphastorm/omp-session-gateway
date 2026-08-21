import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "./config.ts";
type ServicePathConfig = Pick<GatewayConfig, "paths">;

export interface ServiceDefinition {
  readonly identifier: "omp-session-gateway";
  readonly path: string;
  readonly content: string;
}

export interface UserServiceStatus {
  readonly installed: boolean;
  readonly active: boolean;
}

function serviceArgv(installedCli?: string, readinessInstance?: string): readonly string[] {
  const fallbackSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const cliSource = resolve(installedCli ?? process.argv[1] ?? fallbackSource);
  const argv = basename(process.execPath).startsWith("bun")
    ? [process.execPath, cliSource, "serve"]
    : [process.execPath, "serve"];
  if (readinessInstance !== undefined) argv.push("--readiness-instance", readinessInstance);
  return argv;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function serviceDefinition(
  config: ServicePathConfig,
  platform = process.platform,
  installedCli?: string,
  readinessInstance?: string,
): ServiceDefinition {
  if (readinessInstance !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(readinessInstance)) {
    throw new Error("invalid service readiness instance");
  }
  const argv = serviceArgv(installedCli, readinessInstance);
  if (platform === "linux") {
    const command = argv.map(value => JSON.stringify(value)).join(" ");
    // systemd refuses to start a unit whose ReadWritePaths= names a path that does not exist, and
    // the runtime directory does not exist until the daemon binds its socket. That is invisible at
    // install time, when a previous run has already created it, and fatal after a reboot: the user
    // manager comes up, the unit fails, and the gateway silently never returns. Let systemd own the
    // directory instead. RuntimeDirectory= creates it before start and it is implicitly writable,
    // so it must not also appear in ReadWritePaths=. The mode is explicit because systemd defaults
    // to 0755 while the gateway asserts a private runtime directory and would refuse to start.
    const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const runtimeManagedBySystemd =
      xdgRuntimeDir !== undefined && config.paths.runtimeDir === join(xdgRuntimeDir, "omp-session-gateway");
    const readWritePaths = [config.paths.configDir, config.paths.stateDir];
    if (!runtimeManagedBySystemd) readWritePaths.push(config.paths.runtimeDir);
    const runtimeDirectory = runtimeManagedBySystemd
      ? "RuntimeDirectory=omp-session-gateway\nRuntimeDirectoryMode=0700\n"
      : "";
    return {
      identifier: "omp-session-gateway",
      path: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", "omp-session-gateway.service"),
      content: `[Unit]\nDescription=OMP Session Gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\n${runtimeDirectory}ReadWritePaths=${readWritePaths.map(value => JSON.stringify(value)).join(" ")}\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  if (platform === "darwin") {
    const argumentsXml = argv.map(value => `      <string>${xmlEscape(value)}</string>`).join("\n");
    return {
      identifier: "omp-session-gateway",
      path: join(homedir(), "Library", "LaunchAgents", "omp-session-gateway.plist"),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key><string>omp-session-gateway</string>\n    <key>ProgramArguments</key>\n    <array>\n${argumentsXml}\n    </array>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n    <key>ProcessType</key><string>Background</string>\n    <key>StandardOutPath</key><string>/dev/null</string>\n    <key>StandardErrorPath</key><string>/dev/null</string>\n  </dict>\n</plist>\n`,
    };
  }
  if (platform === "win32") {
    const executable = argv[0];
    if (executable === undefined) throw new Error("service executable is unavailable");
    const argumentsXml = argv
      .slice(1)
      .map(value => `&quot;${xmlEscape(value)}&quot;`)
      .join(" ");
    return {
      identifier: "omp-session-gateway",
      path: join(config.paths.configDir, "omp-session-gateway-task.xml"),
      content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>\n  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><AllowHardTerminate>true</AllowHardTerminate><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>\n  <Actions Context="Author"><Exec><Command>${xmlEscape(executable)}</Command><Arguments>${argumentsXml}</Arguments></Exec></Actions>\n</Task>\n`,
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

async function run(command: readonly string[]): Promise<void> {
  const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`${command[0] ?? "service command"} failed: ${stderr.trim()}`);
}

async function commandSucceeds(command: readonly string[]): Promise<boolean> {
  try {
    const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await subprocess.exited) === 0;
  } catch {
    return false;
  }
}

async function commandOutput(command: readonly string[]): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(subprocess.stdout).text();
    return (await subprocess.exited) === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The OS surface the service verbs read and mutate: the running platform and the service-manager
 * commands.
 *
 * Injectable because the ownership rules below cannot be exercised any other way. A service manager
 * keys its registry on identity no filesystem override can scope, so producing a *foreign* holder of
 * the label on the machine running the suite would mean loading a real unit there — and the refusals
 * have to be proven to fire before the first byte is written and before the first mutating command.
 */
export interface ServiceHost {
  readonly platform: typeof process.platform;
  /** Stdout of a command that exited zero; undefined when it failed or could not be spawned. */
  readonly output: (command: readonly string[]) => Promise<string | undefined>;
  readonly succeeds: (command: readonly string[]) => Promise<boolean>;
  /** Runs a command that must succeed, surfacing its stderr otherwise. */
  readonly run: (command: readonly string[]) => Promise<void>;
}

const systemServiceHost: ServiceHost = {
  platform: process.platform,
  output: commandOutput,
  succeeds: commandSucceeds,
  run,
};

/**
 * Whether a service manager's rendering of a loaded unit names a program under `stateDir`.
 *
 * Installed runtimes live at `<stateDir>/installation/versions/<id>/...`, so the install root is a
 * path prefix of the program the OS is actually executing. The trailing separator matters: without
 * it `/tmp/x/state/omp-session-gateway` would match a sibling root like
 * `/tmp/x/state/omp-session-gateway-2`.
 */
export function serviceProgramBelongsTo(programText: string | undefined, stateDir: string): boolean {
  return programText !== undefined && programText.includes(stateDir + sep);
}

/**
 * What the service manager would execute for the gateway's label, running or not.
 *
 * Registration, not activity: systemd answers for a unit it has loaded but never started, Task
 * Scheduler for a task sitting idle, launchd for any loaded job. Installing and uninstalling are
 * destructive to all of those, so ownership is read from the manager's own metadata rather than from
 * an activity probe. Undefined means nothing holds the label, which is also what a machine with no
 * user service manager reports; the mutating command surfaces that on its own.
 */
async function loadedServiceProgram(host: ServiceHost): Promise<string | undefined> {
  // `systemctl show` prints an empty value for a unit it does not know, so a loaded-but-inactive
  // foreign unit — the one `is-active` hides — still reports its ExecStart here. `launchctl print`
  // and `schtasks /Query /XML` render a registered service in any state and exit non-zero when
  // nothing holds the label.
  const query =
    host.platform === "linux"
      ? ["systemctl", "--user", "show", "-p", "ExecStart", "--value", "omp-session-gateway.service"]
      : host.platform === "darwin"
        ? ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/omp-session-gateway`]
        : ["schtasks.exe", "/Query", "/TN", "OMP Session Gateway", "/XML"];
  const rendered = await host.output(query);
  // A rendering with nothing in it names no program, so nothing holds the label.
  return rendered?.trim() === "" ? undefined : rendered;
}

/**
 * Whether the service instance the OS currently has loaded was installed from *this* config root.
 *
 * Service managers key their registry on identity that no filesystem override can scope: launchd on
 * `gui/<uid>/<label>`, systemd on the user unit name, Task Scheduler on the task name. Pointing
 * `HOME`/`XDG_CONFIG_HOME` at a sandbox therefore isolates every file this program writes and none
 * of the state it reads back, so an install rooted in a temp directory observes the real service and
 * reports it as its own. On 2026-08-19 that cost a live daemon: an isolated archive smoke saw
 * `active: true` from the production service and `rotate-publisher-token` booted it out.
 *
 * The loaded service's own program path is the one piece of identity that does carry the root, so
 * compare against it rather than trusting the label. Returns false when nothing is loaded.
 */
async function loadedServiceIsOurs(config: ServicePathConfig, host: ServiceHost): Promise<boolean> {
  // launchd has no activity gate: a job it has loaded is a job it is keeping alive.
  if (host.platform === "linux") {
    if (!(await host.succeeds(["systemctl", "--user", "is-active", "omp-session-gateway.service"]))) return false;
  } else if (host.platform !== "darwin" && !(await windowsTaskActive(host))) return false;
  return serviceProgramBelongsTo(await loadedServiceProgram(host), config.paths.stateDir);
}

/**
 * Refuses when the label is held by an install root other than this one.
 *
 * Called before every step that destroys what the label resolves to — the definition write, the
 * manager mutation that adopts it, the boot-out that precedes it — because a sandbox reaches the
 * real machine's service through the label alone and each of those steps is enough to break it.
 */
async function assertNoForeignServiceLabel(config: ServicePathConfig, host: ServiceHost): Promise<void> {
  const program = await loadedServiceProgram(host);
  if (program === undefined || serviceProgramBelongsTo(program, config.paths.stateDir)) return;
  const registry =
    host.platform === "linux"
      ? "systemd user unit name"
      : host.platform === "darwin"
        ? "launchd label"
        : "scheduled task name";
  throw new Error(
    `another gateway service already holds this ${registry} from a different install root; ` +
      "uninstall it from that root first",
  );
}


async function bootstrapLaunchAgent(domain: string, path: string, host: ServiceHost): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await host.run(["launchctl", "bootstrap", domain, path]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 19) await Bun.sleep(100);
    }
  }
  throw lastError;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function windowsTaskActive(host: ServiceHost): Promise<boolean> {
  return host.succeeds([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "if ((Get-ScheduledTask -TaskName 'OMP Session Gateway' -ErrorAction Stop).State -eq 'Running') { exit 0 } else { exit 1 }",
  ]);
}

export async function assertServiceInstallPreflight(
  activate: boolean,
  host: ServiceHost = systemServiceHost,
): Promise<void> {
  if (host.platform === "win32" && !activate && (await windowsTaskActive(host))) {
    throw new Error("cannot replace an active Windows service with --no-start");
  }
}

async function stopWindowsTask(host: ServiceHost): Promise<void> {
  await host.succeeds(["schtasks.exe", "/End", "/TN", "OMP Session Gateway"]);
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    if (!(await windowsTaskActive(host))) return;
    await Bun.sleep(100);
  }
  throw new Error("running gateway task did not stop");
}

export async function userServiceStatus(
  config: ServicePathConfig,
  host: ServiceHost = systemServiceHost,
): Promise<UserServiceStatus> {
  const definition = serviceDefinition(config, host.platform);
  const definitionExists = await fileExists(definition.path);
  // `active` means "a service this install owns is running", never "some service holds our label".
  // Everything downstream acts on it: rotation restarts, stop boots out, uninstall refuses.
  const active = await loadedServiceIsOurs(config, host);
  if (host.platform === "linux") {
    const installed =
      definitionExists && (await host.succeeds(["systemctl", "--user", "is-enabled", "omp-session-gateway.service"]));
    return { installed, active };
  }
  if (host.platform === "darwin") return { installed: definitionExists, active };
  const installed = await host.succeeds(["schtasks.exe", "/Query", "/TN", "OMP Session Gateway"]);
  return { installed, active };
}

export async function installUserService(
  config: GatewayConfig,
  activate = true,
  installedCli?: string,
  readinessInstance?: string,
  host: ServiceHost = systemServiceHost,
): Promise<ServiceDefinition> {
  // Ownership first, before `mkdir` and before the definition write. Two roots that share a HOME
  // compute the same definition path, so the write alone replaces the other root's service, and on
  // Linux and Windows the manager mutations that follow act on a label a sandbox cannot scope.
  await assertNoForeignServiceLabel(config, host);
  await assertServiceInstallPreflight(activate, host);
  const definition = serviceDefinition(config, host.platform, installedCli, readinessInstance);
  await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
  const serialized =
    host.platform === "win32"
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(definition.content, "utf16le")])
      : definition.content;
  await writeFile(definition.path, serialized, { mode: 0o600 });
  if (host.platform !== "win32") await chmod(definition.path, 0o600);
  if (host.platform === "linux") {
    const wasActive = await host.succeeds(["systemctl", "--user", "is-active", "omp-session-gateway.service"]);
    // Re-read ownership immediately before the manager is touched. Nothing has reloaded yet, so the
    // manager still reports the unit it holds, and an install that landed from another root while
    // this one was writing must not be reloaded, enabled or restarted out from under it.
    await assertNoForeignServiceLabel(config, host);
    await host.run(["systemctl", "--user", "daemon-reload"]);
    await host.run(["systemctl", "--user", "enable", "omp-session-gateway.service"]);
    if (activate) {
      await host.run(["systemctl", "--user", wasActive ? "restart" : "start", "omp-session-gateway.service"]);
    }
  } else if (host.platform === "darwin") {
    if (!activate) return definition;
    const target = `gui/${process.getuid?.() ?? 0}/omp-session-gateway`;
    if (await host.succeeds(["launchctl", "print", target])) {
      // Replacing our own running instance is the ordinary upgrade path. Booting out a service that
      // belongs to a different install root is how a sandboxed run kills the real daemon, so refuse
      // instead: launchd keys the label on uid alone and cannot tell the two apart for us.
      await assertNoForeignServiceLabel(config, host);
      await host.run(["launchctl", "bootout", target]);
    }
    await bootstrapLaunchAgent(`gui/${process.getuid?.() ?? 0}`, definition.path, host);
  } else {
    const status = await userServiceStatus(config, host);
    await assertNoForeignServiceLabel(config, host);
    if (status.active) await stopWindowsTask(host);
    await host.run(["schtasks.exe", "/Create", "/TN", "OMP Session Gateway", "/XML", definition.path, "/F"]);
    if (activate) await host.run(["schtasks.exe", "/Run", "/TN", "OMP Session Gateway"]);
  }
  return definition;
}

export async function stopUserService(config: ServicePathConfig, host: ServiceHost = systemServiceHost): Promise<void> {
  const status = await userServiceStatus(config, host);
  // `active` is ownership-scoped, so a foreign holder of the label leaves nothing here to stop.
  if (!status.active) return;
  // The label can be replaced after the status probe; re-read immediately before stopping it.
  await assertNoForeignServiceLabel(config, host);
  if (host.platform === "linux") {
    await host.run(["systemctl", "--user", "stop", "omp-session-gateway.service"]);
  } else if (host.platform === "darwin") {
    const target = `gui/${process.getuid?.() ?? 0}/omp-session-gateway`;
    await host.run(["launchctl", "bootout", target]);
  } else {
    await stopWindowsTask(host);
  }
  if ((await userServiceStatus(config, host)).active) throw new Error("gateway service remained active after stop");
}

export async function uninstallUserService(
  config: ServicePathConfig,
  deactivate = true,
  host: ServiceHost = systemServiceHost,
): Promise<void> {
  // `installed` answers for the label, not for the root that owns it: `schtasks /Query` finds any
  // task carrying our name and `systemctl is-enabled` any unit carrying our unit name. Every branch
  // below acts on that — `disable --now`, `/End`, `/Delete` — and the closing `rm` targets a path
  // two roots sharing a HOME compute identically. Refuse first, so an uninstall run from one root
  // cannot stop, delete or unfile another root's service.
  await assertNoForeignServiceLabel(config, host);
  const definition = serviceDefinition(config, host.platform);
  const status = await userServiceStatus(config, host);
  if (!deactivate && status.active) {
    throw new Error("cannot uninstall an active gateway with --no-stop");
  }
  // The status probes are read-only but not atomic with manager mutation; close that interleaving.
  await assertNoForeignServiceLabel(config, host);
  if (host.platform === "linux") {
    if (status.installed || status.active) {
      await host.run([
        "systemctl",
        "--user",
        "disable",
        ...(deactivate ? ["--now"] : []),
        "omp-session-gateway.service",
      ]);
    }
  } else if (host.platform === "darwin") {
    if (deactivate && status.active) {
      await host.run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/omp-session-gateway`]);
    }
  } else if (status.installed) {
    if (deactivate && status.active) await stopWindowsTask(host);
    await host.run(["schtasks.exe", "/Delete", "/TN", "OMP Session Gateway", "/F"]);
  }
  await rm(definition.path, { force: true });
  if (host.platform === "linux") await host.run(["systemctl", "--user", "daemon-reload"]);
}
