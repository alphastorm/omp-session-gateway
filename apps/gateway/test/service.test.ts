import { describe, expect, test } from "bun:test";
import type { GatewayConfig } from "../src/config.ts";
import { serviceDefinition } from "../src/service.ts";

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
    expect(definition.content).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(definition.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(definition.content).not.toContain("HighestAvailable");
  });
});
