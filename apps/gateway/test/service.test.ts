import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import type { GatewayConfig } from "../src/config.ts";
import { serviceDefinition, serviceProgramBelongsTo } from "../src/service.ts";

const config: GatewayConfig = {
  http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
  auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
  registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 100, maxSessions: 100 },
  paths: {
    configDir: "/Users/test/.config/omp-session-gateway",
    stateDir: "/Users/test/.local/state/omp-session-gateway",
    runtimeDir: "/private/tmp/omp-session-gateway-501",
    socketPath: "/private/tmp/omp-session-gateway-501/registry.sock",
    tokenPath: "/Users/test/.config/omp-session-gateway/publisher-token",
    configPath: "/Users/test/.config/omp-session-gateway/config.json",
  },
};

describe("service packaging", () => {
  test("generates hardened Linux systemd user service", () => {
    const definition = serviceDefinition(config, "linux");
    expect(definition.path).toEndWith("omp-session-gateway.service");
    expect(definition.content).toContain("WantedBy=default.target");
    expect(definition.content).toContain("NoNewPrivileges=true");
    expect(definition.content).toContain("ProtectSystem=strict");
    expect(definition.content).not.toContain("0.0.0.0");
  });

  test("lets systemd own a runtime directory that does not exist at boot", () => {
    // Regression for #69. ReadWritePaths= naming a missing path makes systemd refuse to start the
    // unit. The runtime directory only exists once the daemon has bound its socket, so the unit
    // installed fine and then failed after every reboot, leaving the gateway silently absent.
    // `serviceDefinition` compares against `join(XDG_RUNTIME_DIR, …)`, which uses the host
    // separator, so the fixture must be built the same way or this silently stops asserting
    // anything on Windows. The same separator assumption already broke the ownership fixtures once.
    const previous = process.env.XDG_RUNTIME_DIR;
    const xdgRuntimeDir = join("/run", "user", "1000");
    const runtimeDir = join(xdgRuntimeDir, "omp-session-gateway");
    process.env.XDG_RUNTIME_DIR = xdgRuntimeDir;
    try {
      const linuxConfig: GatewayConfig = {
        ...config,
        paths: { ...config.paths, runtimeDir, socketPath: join(runtimeDir, "registry.sock") },
      };
      const definition = serviceDefinition(linuxConfig, "linux");
      expect(definition.content).toContain("RuntimeDirectory=omp-session-gateway");
      // systemd defaults this to 0755, which the gateway's private-directory assertion rejects.
      expect(definition.content).toContain("RuntimeDirectoryMode=0700");
      // A RuntimeDirectory= path is implicitly writable; repeating it here is what broke boot.
      expect(definition.content).not.toContain(JSON.stringify(runtimeDir));
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  test("keeps a persistent runtime directory in ReadWritePaths", () => {
    // Without XDG_RUNTIME_DIR the runtime directory lives under the state directory, persists
    // across reboots, and must stay writable the ordinary way.
    const previous = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const definition = serviceDefinition(config, "linux");
      expect(definition.content).not.toContain("RuntimeDirectory=");
      expect(definition.content).toContain(JSON.stringify(config.paths.runtimeDir));
    } finally {
      if (previous !== undefined) process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  test("binds managed service readiness to the installed instance", () => {
    const readinessInstance = "R".repeat(43);
    const definition = serviceDefinition(config, "linux", "/private/runtime/cli.js", readinessInstance);
    expect(definition.content).toContain('"--readiness-instance"');
    expect(definition.content).toContain(`"${readinessInstance}"`);
    expect(() => serviceDefinition(config, "linux", "/private/runtime/cli.js", "invalid")).toThrow(
      "invalid service readiness instance",
    );
  });

  test("generates current-user macOS LaunchAgent", () => {
    const definition = serviceDefinition(config, "darwin");
    expect(definition.path).toEndWith("omp-session-gateway.plist");
    expect(definition.content).toContain("<key>RunAtLoad</key><true/>");
    expect(definition.content).toContain("<key>KeepAlive</key>");
    expect(definition.content).not.toContain("LaunchDaemons");
  });

  test("generates least-privilege Windows logon task", () => {
    const definition = serviceDefinition(config, "win32");
    expect(definition.path).toEndWith("omp-session-gateway-task.xml");
    expect(definition.content).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
    expect(definition.content).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(definition.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(definition.content).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
    expect(definition.content).not.toContain("HighestAvailable");
    expect(definition.content).not.toContain("cmd.exe");
  });
});

/**
 * Regression for a live outage on 2026-08-19. Service managers key their registry on identity no
 * filesystem override can scope — launchd on `gui/<uid>/<label>`, systemd on the unit name, Task
 * Scheduler on the task name — so an install rooted in a sandbox sees the real machine's service and
 * previously reported it as its own. An isolated archive smoke then ran `rotate-publisher-token`,
 * which took the active branch and booted out the production daemon.
 */
describe("loaded service ownership", () => {
  // Build fixtures with the host separator: the predicate compares against `stateDir + sep`, so a
  // hard-coded POSIX fixture would vacuously fail on Windows and pass for the wrong reason on macOS.
  const stateDir = join(sep, "Users", "example", ".local", "state", "omp-session-gateway");
  const installedCli = join(stateDir, "installation", "versions", "0.1.0-77e3a6914cea", "apps", "gateway", "src", "cli.js");
  const otherRoot = join(sep, "tmp", "smoke.abc123", "state", "omp-session-gateway");
  const launchctlPrint = `gui/501/omp-session-gateway = {
	program = /opt/homebrew/Cellar/bun/1.3.14/bin/bun
	arguments = {
		/opt/homebrew/Cellar/bun/1.3.14/bin/bun
		${installedCli}
		serve
	}
}`;

  test("claims a loaded service whose program lives under this install root", () => {
    expect(serviceProgramBelongsTo(launchctlPrint, stateDir)).toBe(true);
  });

  test("disclaims a service installed from a different root", () => {
    expect(serviceProgramBelongsTo(launchctlPrint, otherRoot)).toBe(false);
  });

  test("disclaims a sibling root that shares a path prefix", () => {
    // Without the trailing separator this matches, and a second install silently adopts the first.
    expect(serviceProgramBelongsTo(launchctlPrint, `${stateDir}-2`)).toBe(false);
    expect(serviceProgramBelongsTo(join(`${stateDir}-2`, "installation", "x", "cli.js"), stateDir)).toBe(false);
  });

  test("disclaims when the service manager reports nothing loaded", () => {
    expect(serviceProgramBelongsTo(undefined, stateDir)).toBe(false);
  });

  test("reads a systemd ExecStart line", () => {
    const execStart = `{ path=/usr/bin/bun ; argv[]=/usr/bin/bun ${installedCli} serve ; ignore_errors=no }`;
    expect(serviceProgramBelongsTo(execStart, stateDir)).toBe(true);
    expect(serviceProgramBelongsTo(execStart, otherRoot)).toBe(false);
  });
});
