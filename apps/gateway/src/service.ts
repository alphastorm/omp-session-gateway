import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "./config.ts";

export interface ServiceDefinition {
  readonly identifier: "omp-session-gateway";
  readonly path: string;
  readonly content: string;
}

export interface UserServiceStatus {
  readonly installed: boolean;
  readonly active: boolean;
}

function serviceArgv(): readonly string[] {
  const fallbackSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const cliSource = resolve(process.argv[1] ?? fallbackSource);
  return basename(process.execPath).startsWith("bun")
    ? [process.execPath, cliSource, "serve"]
    : [process.execPath, "serve"];
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function serviceDefinition(config: GatewayConfig, platform = process.platform): ServiceDefinition {
  const argv = serviceArgv();
  if (platform === "linux") {
    const command = argv.map(value => JSON.stringify(value)).join(" ");
    return {
      identifier: "omp-session-gateway",
      path: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", "omp-session-gateway.service"),
      content: `[Unit]\nDescription=OMP Session Gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${JSON.stringify(config.paths.configDir)} ${JSON.stringify(config.paths.stateDir)} ${JSON.stringify(config.paths.runtimeDir)}\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  if (platform === "darwin") {
    const argumentsXml = argv.map(value => `      <string>${xmlEscape(value)}</string>`).join("\n");
    return {
      identifier: "omp-session-gateway",
      path: join(homedir(), "Library", "LaunchAgents", "omp-session-gateway.plist"),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key><string>omp-session-gateway</string>\n    <key>ProgramArguments</key>\n    <array>\n${argumentsXml}\n    </array>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n    <key>ProcessType</key><string>Background</string>\n    <key>StandardOutPath</key><string>${xmlEscape(join(config.paths.stateDir, "gateway.log"))}</string>\n    <key>StandardErrorPath</key><string>${xmlEscape(join(config.paths.stateDir, "gateway-error.log"))}</string>\n  </dict>\n</plist>\n`,
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
export async function requestGatewayShutdown(config: GatewayConfig, token: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.http.port}/_internal/v1/shutdown`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: config.http.publicOrigin,
        "Sec-Fetch-Site": "same-origin",
      },
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    return false;
  }
  if (response.status !== 202) throw new Error("running gateway rejected authenticated shutdown");
  await response.arrayBuffer();
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${config.http.port}/api/v1/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(500),
      });
      await health.arrayBuffer();
    } catch {
      return true;
    }
    await Bun.sleep(100);
  }
  throw new Error("running gateway did not stop");
}


async function bootstrapLaunchAgent(domain: string, path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await run(["launchctl", "bootstrap", domain, path]);
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

export async function userServiceStatus(config: GatewayConfig): Promise<UserServiceStatus> {
  const definition = serviceDefinition(config);
  const definitionExists = await fileExists(definition.path);
  if (process.platform === "linux") {
    const installed =
      definitionExists && (await commandSucceeds(["systemctl", "--user", "is-enabled", "omp-session-gateway.service"]));
    const active = await commandSucceeds(["systemctl", "--user", "is-active", "omp-session-gateway.service"]);
    return { installed, active };
  }
  if (process.platform === "darwin") {
    const target = `gui/${process.getuid?.() ?? 0}/omp-session-gateway`;
    return { installed: definitionExists, active: await commandSucceeds(["launchctl", "print", target]) };
  }
  const installed = await commandSucceeds(["schtasks.exe", "/Query", "/TN", "OMP Session Gateway"]);
  const active =
    installed &&
    (await commandSucceeds([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if ((Get-ScheduledTask -TaskName 'OMP Session Gateway' -ErrorAction Stop).State -eq 'Running') { exit 0 } else { exit 1 }",
    ]));
  return { installed, active };
}

export async function installUserService(
  config: GatewayConfig,
  token: string,
  activate = true,
): Promise<ServiceDefinition> {
  const definition = serviceDefinition(config);
  await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
  const serialized =
    process.platform === "win32"
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(definition.content, "utf16le")])
      : definition.content;
  await writeFile(definition.path, serialized, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(definition.path, 0o600);
  if (!activate) return definition;
  if (process.platform === "linux") {
    const wasActive = await commandSucceeds(["systemctl", "--user", "is-active", "omp-session-gateway.service"]);
    await run(["systemctl", "--user", "daemon-reload"]);
    await run(["systemctl", "--user", "enable", "omp-session-gateway.service"]);
    await run(["systemctl", "--user", wasActive ? "restart" : "start", "omp-session-gateway.service"]);
  } else if (process.platform === "darwin") {
    const target = `gui/${process.getuid?.() ?? 0}/omp-session-gateway`;
    if (await commandSucceeds(["launchctl", "print", target])) await run(["launchctl", "bootout", target]);
    await bootstrapLaunchAgent(`gui/${process.getuid?.() ?? 0}`, definition.path);
  } else {
    if (await commandSucceeds(["schtasks.exe", "/Query", "/TN", "OMP Session Gateway"])) {
      await requestGatewayShutdown(config, token);
      await commandSucceeds(["schtasks.exe", "/End", "/TN", "OMP Session Gateway"]);
    }
    await run(["schtasks.exe", "/Create", "/TN", "OMP Session Gateway", "/XML", definition.path, "/F"]);
    await run(["schtasks.exe", "/Run", "/TN", "OMP Session Gateway"]);
  }
  return definition;
}

export async function uninstallUserService(config: GatewayConfig, token: string, deactivate = true): Promise<void> {
  const definition = serviceDefinition(config);
  const status = await userServiceStatus(config);
  if (deactivate) {
    if (process.platform === "linux") {
      if (status.installed || status.active) {
        await run(["systemctl", "--user", "disable", "--now", "omp-session-gateway.service"]);
      }
    } else if (process.platform === "darwin") {
      if (status.active) {
        await run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/omp-session-gateway`]);
      }
    } else if (status.installed) {
      if (status.active) await requestGatewayShutdown(config, token);
      await run(["schtasks.exe", "/Delete", "/TN", "OMP Session Gateway", "/F"]);
    }
  }
  await rm(definition.path, { force: true });
  if (process.platform === "linux") await run(["systemctl", "--user", "daemon-reload"]);
}
