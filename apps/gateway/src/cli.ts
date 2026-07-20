#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuthMode,
  loadGatewayConfig,
  loadOrCreatePublisherToken,
  rotatePublisherToken,
  writeGatewayConfigFile,
} from "./config.ts";
import { createDiagnosticsBundle } from "./diagnostics.ts";
import { gatewayReady, runDoctorChecks } from "./doctor.ts";
import { startHttpServer } from "./http.ts";
import { startRegistryIpcServer } from "./ipc.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";
import {
  installUserService,
  requestGatewayShutdown,
  uninstallUserService,
  userServiceStatus,
} from "./service.ts";
import { StaticAssetStore } from "./static.ts";

interface ParsedArguments {
  readonly command: string;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const values = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) throw new Error(`unexpected argument: ${argument ?? ""}`);
    const [name, inlineValue] = argument.split("=", 2);
    if (name === undefined) throw new Error("invalid option");
    const next = argv[index + 1];
    const value = inlineValue ?? (next !== undefined && !next.startsWith("--") ? next : "true");
    if (inlineValue === undefined && value === next) index += 1;
    const existing = values.get(name) ?? [];
    existing.push(value);
    values.set(name, existing);
  }
  return { command, values };
}

function oneOption(arguments_: ParsedArguments, name: string): string | undefined {
  const values = arguments_.values.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`${name} may be supplied once`);
  return values[0];
}

function hasFlag(arguments_: ParsedArguments, name: string): boolean {
  const value = oneOption(arguments_, name);
  if (value === undefined) return false;
  if (value !== "true") throw new Error(`${name} does not accept a value`);
  return true;
}

function numericOption(arguments_: ParsedArguments, name: string): number | undefined {
  const value = oneOption(arguments_, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  return Number(value);
}

async function runServe(arguments_: ParsedArguments): Promise<void> {
  const mode: AuthMode | undefined = hasFlag(arguments_, "--dev-localhost") ? "dev-localhost" : undefined;
  const port = numericOption(arguments_, "--port");
  const publicOrigin = oneOption(arguments_, "--origin");
  const config = await loadGatewayConfig({
    ...(mode === undefined ? {} : { mode }),
    ...(port === undefined ? {} : { port }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
  });
  const token = await loadOrCreatePublisherToken(config);
  const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const staticAssets = await StaticAssetStore.load(webRoot);
  const logger = new SafeLogger();
  const registry = new SessionRegistry({ ttlSeconds: config.registry.ttlSeconds, maxSessions: config.registry.maxSessions });
  const ipc = await startRegistryIpcServer({ config, token, registry, logger });
  let stopping = false;
  let resolveStop: () => void = () => undefined;
  const stopped = new Promise<void>(resolve => {
    resolveStop = resolve;
  });
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    resolveStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const http = startHttpServer({ config, registry, staticAssets, logger, shutdown: { token, request: stop } });
  const sweeper = setInterval(() => {
    const removed = registry.sweepExpired();
    if (removed > 0) logger.event("info", "registry.expired", { removed });
  }, Math.max(1_000, Math.floor((config.registry.ttlSeconds * 1_000) / 3)));

  await stopped;
  clearInterval(sweeper);
  http.stop(true);
  await ipc.stop();
}

async function waitForGateway(port: number): Promise<void> {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    if (await gatewayReady(port)) return;
    await Bun.sleep(100);
  }
  throw new Error("service installed but the loopback health check did not become ready");
}

async function runInstall(arguments_: ParsedArguments): Promise<void> {
  const origin = oneOption(arguments_, "--origin");
  const allowedLogins = arguments_.values.get("--allow") ?? [];
  if (origin === undefined) throw new Error("install requires --origin https://host.tailnet.ts.net");
  const port = numericOption(arguments_, "--port");
  const config = await writeGatewayConfigFile({
    publicOrigin: origin,
    allowedLogins,
    ...(port === undefined ? {} : { port }),
  });
  const token = await loadOrCreatePublisherToken(config);
  const activate = !hasFlag(arguments_, "--no-start");
  const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  await StaticAssetStore.load(webRoot);
  const definition = await installUserService(config, token, activate);
  if (activate) await waitForGateway(config.http.port);
  console.log(`Installed ${definition.identifier}; loopback health ${activate ? "ready" : "not started"}.`);
  console.log(`Configure Tailscale Serve: tailscale serve --bg --https=443 http://127.0.0.1:${config.http.port}`);
  console.log("Do not enable Tailscale Funnel.");
}

async function runUninstall(arguments_: ParsedArguments): Promise<void> {
  const config = await loadGatewayConfig();
  const token = await loadOrCreatePublisherToken(config);
  await uninstallUserService(config, token, !hasFlag(arguments_, "--no-stop"));
  console.log("Uninstalled omp-session-gateway service. Configuration and publisher token were preserved.");
}


async function runStatus(): Promise<void> {
  const config = await loadGatewayConfig();
  const [ready, service] = await Promise.all([gatewayReady(config.http.port), userServiceStatus(config)]);
  console.log(
    JSON.stringify({
      service: "omp-session-gateway",
      installed: service.installed,
      active: service.active,
      ready,
      authMode: config.auth.mode,
    }),
  );
  if (!ready || !service.installed || !service.active) process.exitCode = 1;
}

async function runDoctor(arguments_: ParsedArguments): Promise<void> {
  const report = await runDoctorChecks();
  const shouldBundle = hasFlag(arguments_, "--bundle");
  if (shouldBundle) {
    const destination = resolve(oneOption(arguments_, "--output") ?? "omp-gateway-diagnostics.tar");
    const bundle = await createDiagnosticsBundle(report, destination);
    console.log(
      JSON.stringify({
        ...report,
        bundle: { file: basename(destination), bytes: bundle.bytes, sha256: bundle.sha256 },
      }),
    );
  } else {
    console.log(JSON.stringify(report));
  }
  if (Object.values(report.checks).some(value => !value)) process.exitCode = 1;
}

async function runRotateToken(): Promise<void> {
  const config = await loadGatewayConfig();
  const token = await loadOrCreatePublisherToken(config);
  const service = await userServiceStatus(config);
  if (process.platform === "win32" && service.active) await requestGatewayShutdown(config, token);
  await rotatePublisherToken(config);
  if (service.installed && service.active) {
    const replacementToken = await loadOrCreatePublisherToken(config);
    await installUserService(config, replacementToken);
    await waitForGateway(config.http.port);
    console.log("Publisher token rotated. Active gateway restarted; live OMP publishers will reconnect.");
  } else {
    console.log("Publisher token rotated. Restart the gateway and live OMP publishers to reconnect.");
  }
}

async function runServeGuidance(): Promise<void> {
  const config = await loadGatewayConfig();
  console.log(`tailscale serve --bg --https=443 http://127.0.0.1:${config.http.port}`);
  console.log(`Allowlisted logins: ${config.auth.allowedLogins.length}. Keep tailnet grants restricted to the intended user/device.`);
  console.log("Tailscale Funnel is unsupported and must remain disabled.");
}

function printHelp(): void {
  console.log(`OMP Session Gateway 0.1.0

Usage:
  omp-gateway install --origin https://host.tailnet.ts.net --allow user@example.com [--no-start]
  omp-gateway uninstall [--no-stop]
  omp-gateway status
  omp-gateway doctor [--bundle] [--output omp-gateway-diagnostics.tar]
  omp-gateway serve-guidance
  omp-gateway rotate-publisher-token
  omp-gateway serve [--dev-localhost] [--port 4317] [--origin http://127.0.0.1:4317]
  omp-gatewayd
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const daemonInvocation = basename(process.argv[1] ?? "") === "omp-gatewayd";
  const parsed = parseArguments(daemonInvocation && argv.length === 0 ? ["serve"] : argv);
  if (parsed.command === "serve") await runServe(parsed);
  else if (parsed.command === "install") await runInstall(parsed);
  else if (parsed.command === "uninstall") await runUninstall(parsed);
  else if (parsed.command === "status") await runStatus();
  else if (parsed.command === "doctor") await runDoctor(parsed);
  else if (parsed.command === "rotate-publisher-token") await runRotateToken();
  else if (parsed.command === "serve-guidance") await runServeGuidance();
  else if (parsed.command === "help" || parsed.command === "--help") printHelp();
  else throw new Error(`unknown command: ${parsed.command}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "gateway command failed");
    process.exitCode = 1;
  });
}
