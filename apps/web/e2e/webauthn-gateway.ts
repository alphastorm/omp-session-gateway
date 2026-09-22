import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SecretCapability, type ObservedSessionInput } from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../../gateway/src/config.ts";
import { createHttpHandler } from "../../gateway/src/http.ts";
import { SafeLogger } from "../../gateway/src/logger.ts";
import { SessionRegistry } from "../../gateway/src/registry.ts";
import { StaticAssetStore } from "../../gateway/src/static.ts";
import { WebAuthnService } from "../../gateway/src/webauthn.ts";

// Synthetic local-only fixture. Control messages use stdin, never an HTTP administration endpoint.
const root = await mkdtemp(join(tmpdir(), "omp-webauthn-browser-"));
const key = join(root, "key.pem");
const cert = join(root, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
  "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
{ stdio: "ignore" });
let handler: ((request: Request, peer: { address: string }) => Promise<Response>) | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { key: Bun.file(key), cert: Bun.file(cert) },
  fetch: request => handler?.(request, { address: "127.0.0.1" }) ?? new Response(null, { status: 503 }),
});
const origin = `https://localhost:${server.port}`;
const config: GatewayConfig = {
  http: { hostname: "127.0.0.1", port: server.port!, publicOrigin: origin },
  auth: { mode: "webauthn", allowedLogins: [] },
  omp: { discoveryDir: join(root, "discovery"), queryTimeoutMs: 1_500 },
  registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 },
  paths: {
    configDir: root, stateDir: root, runtimeDir: root,
    tokenPath: join(root, "readiness-token"), configPath: join(root, "config.json"),
  },
};
let clock = Date.now();
const registry = new SessionRegistry({ ttlSeconds: 86_400, maxSessions: 10 });
let generation = 1;
let inputRequired = false;
function publish(): void {
  const observed: ObservedSessionInput = {
    instanceId: "synthetic-webauthn-session-0001", generation,
    pid: 1234, sessionId: "synthetic-session", title: "Synthetic passkey session",
    cwdLabel: "synthetic-project", model: "fixture/model",
    startedAt: "2026-09-22T10:00:00.000Z", inputRequired, canControl: true,
  };
  registry.reconcile({ observed: [observed], retained: new Set() });
}
publish();
const staticAssets = await StaticAssetStore.load(fileURLToPath(new URL("../dist", import.meta.url)));
const enrollmentCode = "synthetic-enrollment-code-0000000000000001";
let launchCount = 0;
async function open(enroll: boolean): Promise<WebAuthnService> {
  const webAuthn = await WebAuthnService.open({ config, now: () => clock, ...(enroll ? { enrollmentCode } : {}) });
  handler = createHttpHandler({
    config, registry, staticAssets, webAuthn, now: () => clock, sseKeepaliveMs: 100,
    logger: new SafeLogger({ write: line => { process.stderr.write(line + "\n"); } }),
    launchResolver: {
      async resolve({ instanceId, generation, mode, requestId }) {
        const allowed = registry.authorizeLaunch(instanceId, generation, mode, requestId);
        if (allowed.status !== "ok") return allowed;
        launchCount += 1;
        // Valid-shaped synthetic capability, never a live OMP link.
        const roomId = Buffer.alloc(16, 19).toString("base64url");
        const roomKey = Buffer.alloc(mode === "view" ? 32 : 48, 23).toString("base64url");
        return { status: "ok", capability: SecretCapability.from(`${roomId}.${roomKey}`) };
      },
    },
  });
  return webAuthn;
}
let webAuthn = await open(true);
process.stdout.write(JSON.stringify({ origin }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { id: number; action: string; millis?: number };
  if (command.action === "advance") clock += command.millis ?? 0;
  else if (command.action === "restart") { await webAuthn.close(); webAuthn = await open(false); }
  else if (command.action === "generation") { generation += 1; publish(); }
  else if (command.action === "publish") publish();
  else if (command.action === "ask") { inputRequired = true; publish(); }
  else if (command.action === "stop") break;
  else if (command.action !== "stats") throw new Error("Unknown fixture command");
  process.stdout.write(JSON.stringify({ id: command.id, launchCount }) + "\n");
}
await webAuthn.close();
await server.stop(true);
await rm(root, { recursive: true, force: true });
