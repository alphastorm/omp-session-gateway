import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GatewayConfig } from "../src/config.ts";
import { createDiagnosticsBundle, diagnosticsBundleBytes } from "../src/diagnostics.ts";
import { funnelConfigurationDisabled, serveConfigurationMatches, tailscaleSelfIp } from "../src/doctor.ts";

const roots: string[] = [];

function config(): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
    auth: { mode: "tailscale-serve", allowedLogins: ["allowed@example.com"] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 10, maxSessions: 10 },
    paths: {
      configDir: "/private/config",
      stateDir: "/private/state",
      runtimeDir: "/private/run",
      socketPath: "/private/run/registry.sock",
      tokenPath: "/private/config/publisher-token",
      configPath: "/private/config/config.json",
    },
  };
}

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    if (name === "") break;
    const sizeText = header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim();
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    entries.set(name, archive.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("redacted diagnostics", () => {
  test("creates a deterministic manifest-only archive and ignores extra sensitive fields", async () => {
    const source = {
      service: "omp-session-gateway" as const,
      checks: { zeta: false, alpha: true },
      capability: "DIAGNOSTIC_CONTROL_CANARY_0000000000000000",
      fullPath: "/Users/alice/secret-project",
      identity: "alice@example.com",
    };
    const first = diagnosticsBundleBytes(source);
    const second = diagnosticsBundleBytes(source);
    expect(first).toEqual(second);
    const entries = tarEntries(first);
    expect([...entries.keys()]).toEqual(["manifest.json", "doctor.json"]);
    expect(entries.get("doctor.json")?.toString("utf8")).toContain('"alpha": true');
    const archiveText = first.toString("utf8");
    expect(archiveText).not.toContain(source.capability);
    expect(archiveText).not.toContain(source.fullPath);
    expect(archiveText).not.toContain(source.identity);

    const root = await mkdtemp(join(tmpdir(), "omp-diagnostics-"));
    roots.push(root);
    const firstPath = join(root, "first.tar");
    const secondPath = join(root, "second.tar");
    const firstResult = await createDiagnosticsBundle(source, firstPath);
    const secondResult = await createDiagnosticsBundle(source, secondPath);
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(firstResult.sha256).toBe(secondResult.sha256);
    if (process.platform !== "win32") expect((await stat(firstPath)).mode & 0o077).toBe(0);
  });

  test("requires a new diagnostics destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-diagnostics-"));
    roots.push(root);
    const path = join(root, "bundle.tar");
    const report = { service: "omp-session-gateway" as const, checks: { config: true } };
    await createDiagnosticsBundle(report, path);
    await expect(createDiagnosticsBundle(report, path)).rejects.toThrow();
  });
});

describe("Tailscale doctor parsing", () => {
  test("requires the configured HTTPS host and exact loopback proxy", () => {
    const value = {
      Web: {
        "gateway.example.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
        },
      },
    };
    expect(serveConfigurationMatches(value, config())).toBe(true);
    expect(
      serveConfigurationMatches(
        { Web: { "other.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } } },
        config(),
      ),
    ).toBe(false);
    expect(
      serveConfigurationMatches(
        { Web: { "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://0.0.0.0:4317" } } } } },
        config(),
      ),
    ).toBe(false);
  });

  test("selects a validated Tailscale self address for direct HTTPS diagnostics", () => {
    expect(
      tailscaleSelfIp({
        Self: { TailscaleIPs: ["fd7a:115c:a1e0::1234", "100.64.0.7"] },
      }),
    ).toBe("100.64.0.7");
    expect(tailscaleSelfIp({ Self: { TailscaleIPs: ["not-an-ip"] } })).toBeUndefined();
  });

  test("fails when any Funnel configuration is active", () => {
    expect(funnelConfigurationDisabled({})).toBe(true);
    expect(funnelConfigurationDisabled({ AllowFunnel: {} })).toBe(true);
    expect(
      funnelConfigurationDisabled({
        TCP: { "443": { HTTPS: true } },
        Web: {
          "gateway.example.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
          },
        },
      }),
    ).toBe(true);
    expect(funnelConfigurationDisabled({ AllowFunnel: { "gateway.example.ts.net": { "443": false } } })).toBe(true);
    expect(funnelConfigurationDisabled({ AllowFunnel: { "gateway.example.ts.net": { "443": true } } })).toBe(false);
  });
});
