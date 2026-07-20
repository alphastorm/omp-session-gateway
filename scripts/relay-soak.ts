import { parseLaunchResponse, parseSessionListResponse } from "../packages/protocol/src/index.ts";

const DEFAULT_DURATION_SECONDS = 8 * 60 * 60;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const READY_TIMEOUT_MILLISECONDS = 30_000;
const HEALTH_CHECK_INTERVAL_MILLISECONDS = 10_000;

export interface RelaySoakConfig {
  readonly gatewayOrigin: string;
  readonly publicOrigin: string;
  readonly tailscaleLogin: string;
  readonly durationSeconds: number;
  readonly instanceId?: string;
}

interface RelaySoakSnapshot {
  readonly phase: string;
  readonly endedReason?: string | null;
}

interface RelaySoakClient {
  connect(): void;
  close(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RelaySoakSnapshot;
}

interface RelaySoakClientModule {
  readonly GuestClient: new (capability: string, displayName: string) => RelaySoakClient;
}

async function createRelaySoakClient(capability: string): Promise<RelaySoakClient> {
  // Static import makes every root project re-typecheck the pinned upstream subtree outside its relaxed tsconfig.
  const moduleUrl = new URL("../packages/collab-client/upstream/src/lib/client.ts", import.meta.url).href;
  const clientModule = (await import(moduleUrl)) as RelaySoakClientModule;
  if (typeof clientModule.GuestClient !== "function") throw new Error("pinned collaboration client is unavailable");
  return new clientModule.GuestClient(capability, "gateway-relay-soak");
}

function requireOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url;
}

function requireLoopbackGatewayOrigin(value: string): string {
  const url = requireOrigin(value, "OMP_GATEWAY_SOAK_GATEWAY_ORIGIN");
  if (url.protocol !== "http:") throw new Error("OMP_GATEWAY_SOAK_GATEWAY_ORIGIN must use loopback HTTP");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("OMP_GATEWAY_SOAK_GATEWAY_ORIGIN must be a numeric loopback origin");
  }
  return url.origin;
}

function requirePublicOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error("OMP_GATEWAY_SOAK_PUBLIC_ORIGIN is required");
  const url = requireOrigin(value, "OMP_GATEWAY_SOAK_PUBLIC_ORIGIN");
  if (url.protocol !== "https:") throw new Error("OMP_GATEWAY_SOAK_PUBLIC_ORIGIN must use HTTPS");
  return url.origin;
}

function requireTailscaleLogin(value: string | undefined): string {
  const login = value?.trim().toLowerCase();
  if (login === undefined || login.length === 0 || login.length > 320) {
    throw new Error("OMP_GATEWAY_SOAK_TAILSCALE_LOGIN must be a non-empty login");
  }
  return login;
}

function requireDurationSeconds(value: string | undefined): number {
  const raw = value ?? String(DEFAULT_DURATION_SECONDS);
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error("OMP_GATEWAY_SOAK_SECONDS must be a positive integer");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_DURATION_SECONDS) {
    throw new Error(`OMP_GATEWAY_SOAK_SECONDS must not exceed ${MAX_DURATION_SECONDS}`);
  }
  return seconds;
}

export function parseRelaySoakConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RelaySoakConfig {
  const instanceId = environment.OMP_GATEWAY_SOAK_INSTANCE_ID?.trim();
  if (instanceId !== undefined && (instanceId.length === 0 || instanceId.length > 128)) {
    throw new Error("OMP_GATEWAY_SOAK_INSTANCE_ID must contain 1 to 128 characters");
  }
  return {
    gatewayOrigin: requireLoopbackGatewayOrigin(
      environment.OMP_GATEWAY_SOAK_GATEWAY_ORIGIN ?? "http://127.0.0.1:4317",
    ),
    publicOrigin: requirePublicOrigin(environment.OMP_GATEWAY_SOAK_PUBLIC_ORIGIN),
    tailscaleLogin: requireTailscaleLogin(environment.OMP_GATEWAY_SOAK_TAILSCALE_LOGIN),
    durationSeconds: requireDurationSeconds(environment.OMP_GATEWAY_SOAK_SECONDS),
    ...(instanceId === undefined ? {} : { instanceId }),
  };
}

function assertNoStore(response: Response): void {
  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (!cacheControl.split(",").some(directive => directive.trim() === "no-store")) {
    throw new Error(`gateway response ${response.status} did not include Cache-Control: no-store`);
  }
}

export async function runRelaySoak(config: RelaySoakConfig): Promise<void> {
  const listResponse = await fetch(`${config.gatewayOrigin}/api/v1/sessions`, {
    headers: { "Tailscale-User-Login": config.tailscaleLogin },
    cache: "no-store",
  });
  assertNoStore(listResponse);
  if (!listResponse.ok) throw new Error(`session list failed with status ${listResponse.status}`);
  const list = parseSessionListResponse(await listResponse.json());
  const session = list.sessions.find(candidate => {
    if (!candidate.canView) return false;
    return config.instanceId === undefined || candidate.instanceId === config.instanceId;
  });
  if (session === undefined) throw new Error("no matching view-capable live session");

  const launchResponse = await fetch(
    `${config.gatewayOrigin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": config.tailscaleLogin,
        Origin: config.publicOrigin,
      },
      body: JSON.stringify({ mode: "view", generation: session.generation }),
    },
  );
  assertNoStore(launchResponse);
  if (!launchResponse.ok) throw new Error(`launch failed with status ${launchResponse.status}`);
  let capability = parseLaunchResponse(await launchResponse.json()).capability;
  const client = await createRelaySoakClient(capability);
  capability = "";

  let liveObserved = false;
  let endedReason: string | null = null;
  let transitions = 0;
  let previousPhase = client.getSnapshot().phase;
  const unsubscribe = client.subscribe(() => {
    const snapshot = client.getSnapshot();
    if (snapshot.phase !== previousPhase) {
      transitions += 1;
      previousPhase = snapshot.phase;
    }
    if (snapshot.phase === "live") liveObserved = true;
    if (snapshot.phase === "ended") endedReason = snapshot.endedReason ?? "ended";
  });

  try {
    client.connect();
    const readyDeadline = performance.now() + READY_TIMEOUT_MILLISECONDS;
    while (!liveObserved && endedReason === null && performance.now() < readyDeadline) await Bun.sleep(100);
    if (!liveObserved) throw new Error(endedReason ?? "relay did not become live");

    const startedAt = new Date().toISOString();
    const startedMonotonic = performance.now();
    const durationMilliseconds = config.durationSeconds * 1_000;
    while (performance.now() - startedMonotonic < durationMilliseconds) {
      const remaining = durationMilliseconds - (performance.now() - startedMonotonic);
      await Bun.sleep(Math.min(HEALTH_CHECK_INTERVAL_MILLISECONDS, Math.max(1, remaining)));
      if (endedReason !== null) throw new Error(`relay ended during soak: ${endedReason}`);
    }

    const finalPhase = client.getSnapshot().phase;
    if (finalPhase !== "live") throw new Error(`relay was not live at completion: ${finalPhase}`);
    console.log(
      JSON.stringify({
        startedAt,
        completedAt: new Date().toISOString(),
        durationSeconds: Math.floor((performance.now() - startedMonotonic) / 1_000),
        transitions,
        finalPhase,
      }),
    );
  } finally {
    unsubscribe();
    client.close();
  }
}

if (import.meta.main) {
  try {
    await runRelaySoak(parseRelaySoakConfig());
  } catch (error) {
    console.error(`relay soak failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
