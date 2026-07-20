#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuthMode,
  captureGatewayConfigFile,
  defaultGatewayPaths,
  loadGatewayConfig,
  loadOrCreatePublisherToken,
  loadPublisherToken,
  loopbackHttpOrigin,
  publicOriginHttpsPort,
  restoreGatewayConfigFile,
  rotatePublisherToken,
  writeGatewayConfigFile,
} from "./config.ts";
import { createDiagnosticsBundle } from "./diagnostics.ts";
import { gatewayReady, loopbackHttpResponds, runDoctorChecks } from "./doctor.ts";
import { startHttpServer } from "./http.ts";
import { activateRuntime, currentInstalledRuntime, stageRuntimePayload } from "./installation.ts";
import { startRegistryIpcServer } from "./ipc.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";
import {
  assertServiceInstallPreflight,
  installUserService,
  uninstallUserService,
  stopUserService,
  userServiceStatus,
} from "./service.ts";
import { StaticAssetStore } from "./static.ts";

interface ParsedArguments {
  readonly command: string;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

const MISSING_OPTION_VALUE = "\0";

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const values = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) throw new Error(`unexpected argument: ${argument ?? ""}`);
    const [name, inlineValue] = argument.split("=", 2);
    if (name === undefined) throw new Error("invalid option");
    const next = argv[index + 1];
    const value = inlineValue ?? (next !== undefined && !next.startsWith("--") ? next : MISSING_OPTION_VALUE);
    if (inlineValue === undefined && value === next) index += 1;
    const existing = values.get(name) ?? [];
    existing.push(value);
    values.set(name, existing);
  }
  return { command, values };
}

function optionValues(arguments_: ParsedArguments, name: string): readonly string[] {
  const values = arguments_.values.get(name) ?? [];
  if (values.includes(MISSING_OPTION_VALUE)) throw new Error(`${name} requires a value`);
  return values;
}

const COMMAND_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  serve: new Set(["--dev-localhost", "--port", "--origin", "--readiness-instance"]),
  install: new Set(["--origin", "--allow", "--port", "--no-start"]),
  uninstall: new Set(["--no-stop"]),
  status: new Set(),
  doctor: new Set(["--bundle", "--output"]),
  "rotate-publisher-token": new Set(),
  "serve-guidance": new Set(),
  help: new Set(),
  "--help": new Set(),
};

function validateCommandOptions(arguments_: ParsedArguments): void {
  const allowed = COMMAND_OPTIONS[arguments_.command];
  if (allowed === undefined) return;
  for (const name of arguments_.values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option for ${arguments_.command}: ${name}`);
  }
}

function oneOption(arguments_: ParsedArguments, name: string): string | undefined {
  const values = optionValues(arguments_, name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error(`${name} may be supplied once`);
  return values[0];
}

function hasFlag(arguments_: ParsedArguments, name: string): boolean {
  const values = arguments_.values.get(name);
  if (values === undefined) return false;
  if (values.length !== 1) throw new Error(`${name} may be supplied once`);
  if (values[0] !== MISSING_OPTION_VALUE) throw new Error(`${name} does not accept a value`);
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
  const readinessInstance = oneOption(arguments_, "--readiness-instance");
  if (readinessInstance !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(readinessInstance)) {
    throw new Error("--readiness-instance must be a 256-bit base64url value");
  }
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
  let http: ReturnType<typeof startHttpServer> | undefined;
  let sweeper: ReturnType<typeof setInterval> | undefined;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    http = startHttpServer({
      config,
      registry,
      staticAssets,
      logger,
      readinessToken: token,
      ...(readinessInstance === undefined ? {} : { readinessInstance }),
    });
    sweeper = setInterval(() => {
      const removed = registry.sweepExpired();
      if (removed > 0) logger.event("info", "registry.expired", { removed });
    }, Math.max(1_000, Math.floor((config.registry.ttlSeconds * 1_000) / 3)));
    await stopped;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (sweeper !== undefined) clearInterval(sweeper);
    try {
      http?.stop(true);
    } finally {
      await ipc.stop();
    }
  }
}

async function waitForGateway(
  config: Awaited<ReturnType<typeof loadGatewayConfig>>,
  readinessToken: string,
  readinessInstance?: string,
  requireManagedService = false,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await gatewayReady(config, readinessToken, readinessInstance)) {
      if (!requireManagedService) return;
      const service = await userServiceStatus(config);
      if (service.installed && service.active) {
        await Bun.sleep(200);
        const stableService = await userServiceStatus(config);
        if (stableService.installed && stableService.active && (await gatewayReady(config, readinessToken))) return;
      }
    }
    await Bun.sleep(100);
  }
  throw new Error("service installed but the loopback readiness proof did not become valid");
}

async function runInstall(arguments_: ParsedArguments): Promise<void> {
  const origin = oneOption(arguments_, "--origin");
  const allowedLogins = optionValues(arguments_, "--allow");
  if (origin === undefined) throw new Error("install requires --origin https://host.tailnet.ts.net");
  const port = numericOption(arguments_, "--port");
  const activate = !hasFlag(arguments_, "--no-start");
  await assertServiceInstallPreflight(activate);
  const configSnapshot = await captureGatewayConfigFile();
  let config: Awaited<ReturnType<typeof writeGatewayConfigFile>> | undefined;
  let runtime: Awaited<ReturnType<typeof stageRuntimePayload>> | undefined;
  let priorRuntime: Awaited<ReturnType<typeof currentInstalledRuntime>> | undefined;
  let priorService: Awaited<ReturnType<typeof userServiceStatus>> | undefined;
  let priorConfig: Awaited<ReturnType<typeof loadGatewayConfig>> | undefined;
  let repairPriorToken = false;
  if (configSnapshot.content !== undefined) {
    priorConfig = await loadGatewayConfig({ configPath: configSnapshot.path });
    priorService = await userServiceStatus(priorConfig);
    if (priorService.active && !priorService.installed) {
      throw new Error("refusing install while an unmanaged gateway service is active");
    }
    if (!activate && priorService.active) {
      throw new Error("refusing --no-start while the gateway service is active");
    }
    let priorToken: string | undefined;
    try {
      priorToken = await loadPublisherToken(priorConfig);
    } catch (error) {
      if (priorService.active) {
        throw new Error("refusing install while the active gateway publisher token is unavailable", { cause: error });
      }
      if (await loopbackHttpResponds(priorConfig)) {
        throw new Error("refusing install while the prior loopback endpoint is occupied and cannot be authenticated", {
          cause: error,
        });
      }
      repairPriorToken = true;
    }
    if (priorToken !== undefined && !priorService.active && (await gatewayReady(priorConfig, priorToken))) {
      throw new Error("refusing install while an authenticated unmanaged gateway listener is active");
    }
    priorRuntime = priorService.installed ? await currentInstalledRuntime(priorConfig) : undefined;
    if (priorService.installed && priorRuntime === undefined) {
      throw new Error("refusing install without a verified prior runtime");
    }
  }
  let serviceAttempted = false;
  try {
    config = await writeGatewayConfigFile({
      publicOrigin: origin,
      allowedLogins,
      ...(port === undefined ? {} : { port }),
    });
    const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await StaticAssetStore.load(webRoot);
    priorService ??= await userServiceStatus(config);
    if (configSnapshot.content === undefined && priorService.installed) {
      throw new Error("refusing install of an existing service without a prior config");
    }
    const sameEndpoint =
      priorConfig !== undefined &&
      priorConfig.http.hostname === config.http.hostname &&
      priorConfig.http.port === config.http.port;
    const readinessToken = repairPriorToken ? await rotatePublisherToken(config) : await loadOrCreatePublisherToken(config);
    if ((!priorService.active || !sameEndpoint) && (await gatewayReady(config, readinessToken))) {
      throw new Error("refusing install while an authenticated unmanaged gateway listener is active");
    }
    runtime = await stageRuntimePayload(config);
    serviceAttempted = true;
    const readinessInstance = randomBytes(32).toString("base64url");
    const definition = await installUserService(config, activate, runtime.cliPath, readinessInstance);
    if (activate) await waitForGateway(config, readinessToken, readinessInstance);
    await activateRuntime(config, runtime);
    console.log(
      `Installed ${definition.identifier} from ${runtime.directory}; loopback health ${activate ? "ready" : "not started"}.`,
    );
    console.log(
      `Configure Tailscale Serve: tailscale serve --bg --https=${publicOriginHttpsPort(config.http.publicOrigin)} ${loopbackHttpOrigin(config.http.hostname, config.http.port)}`,
    );
    console.log("Do not enable Tailscale Funnel.");
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    let restoredConfig: Awaited<ReturnType<typeof loadGatewayConfig>> | undefined;
    try {
      await restoreGatewayConfigFile(configSnapshot);
      if (configSnapshot.content !== undefined) {
        restoredConfig = await loadGatewayConfig({ configPath: configSnapshot.path });
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (serviceAttempted && config !== undefined) {
      try {
        if (priorService?.installed === true && priorRuntime !== undefined && restoredConfig !== undefined) {
          const priorToken = await loadPublisherToken(restoredConfig);
          const rollbackInstance =
            priorRuntime.readinessProtocol === "instance-v1" ? randomBytes(32).toString("base64url") : undefined;
          await installUserService(restoredConfig, priorService.active, priorRuntime.cliPath, rollbackInstance);
          if (priorService.active) {
            await waitForGateway(
              restoredConfig,
              priorToken,
              rollbackInstance,
              priorRuntime.readinessProtocol === "legacy",
            );
          }
          await activateRuntime(restoredConfig, priorRuntime);
        } else if (priorService?.installed !== true) {
          await uninstallUserService(config, true);
        } else {
          throw new Error("prior gateway service could not be restored");
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "gateway install failed and rollback was incomplete");
    }
    throw error;
  }
}

async function runUninstall(arguments_: ParsedArguments): Promise<void> {
  const servicePaths = { paths: defaultGatewayPaths() };
  await uninstallUserService(servicePaths, !hasFlag(arguments_, "--no-stop"));
  console.log("Uninstalled omp-session-gateway service. Configuration and publisher token were preserved.");
}


async function runStatus(): Promise<void> {
  const config = await loadGatewayConfig();
  const readinessToken = await loadPublisherToken(config);
  const [ready, service] = await Promise.all([gatewayReady(config, readinessToken), userServiceStatus(config)]);
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
  const service = await userServiceStatus(config);
  if (service.active && !service.installed) {
    throw new Error("refusing token rotation while an unmanaged gateway service is active");
  }
  const runtime = service.active ? await currentInstalledRuntime(config) : undefined;
  if (service.active && runtime === undefined) {
    throw new Error("refusing token rotation without a verified installed runtime");
  }
  const readinessToken = await rotatePublisherToken(config);
  if (service.active && runtime !== undefined) {
    const readinessInstance =
      runtime.readinessProtocol === "instance-v1" ? randomBytes(32).toString("base64url") : undefined;
    try {
      await installUserService(config, true, runtime.cliPath, readinessInstance);
      await waitForGateway(config, readinessToken, readinessInstance, runtime.readinessProtocol === "legacy");
    } catch (error) {
      try {
        await stopUserService(config);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "publisher token rotated and retained, but gateway restart and fail-closed service stop both failed",
        );
      }
      throw new Error(
        "publisher token rotated and retained, but gateway restart failed; the service was stopped and must be reinstalled",
        { cause: error },
      );
    }
    console.log("Publisher token rotated. Active gateway restarted; live OMP publishers will reconnect.");
  } else {
    console.log("Publisher token rotated. Restart the gateway and live OMP publishers to reconnect.");
  }
}

async function runServeGuidance(): Promise<void> {
  const config = await loadGatewayConfig();
  console.log(
    `tailscale serve --bg --https=${publicOriginHttpsPort(config.http.publicOrigin)} ${loopbackHttpOrigin(config.http.hostname, config.http.port)}`,
  );
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
  validateCommandOptions(parsed);
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
