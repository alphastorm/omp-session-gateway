import { afterEach, expect, jest, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { PUSH_API_VERSION, SecretCapability } from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { createHttpHandler, type LaunchBroker } from "../src/http.ts";
import { SafeLogger } from "../src/logger.ts";
import { SessionRegistry } from "../src/registry.ts";
import { PushService } from "../src/push.ts";
import { StaticAssetStore } from "../src/static.ts";
import { WebAuthnService, listWebAuthnCredentials, revokeWebAuthnCredential } from "../src/webauthn.ts";

const origin = "https://gateway.example.test";
const rp = "gateway.example.test";
const peer = { address: "127.0.0.1" };
const roots: string[] = [];
const services: WebAuthnService[] = [];
const enrollmentCode = randomBytes(32).toString("base64url");
const hash = (value: Uint8Array | string): Buffer => createHash("sha256").update(value).digest();
const b64 = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const cbor = (value: unknown): Buffer => Buffer.from(isoCBOR.encode(value as never));

interface Authenticator {
  readonly privateKey: KeyObject;
  readonly id: string;
  readonly publicKey: Buffer;
  userId: string;
}
function authenticator(): Authenticator {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  return { privateKey: keys.privateKey, id: b64(randomBytes(32)), userId: "", publicKey: cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]])) };
}
function registration(device: Authenticator, challenge: string, changes: { flags?: number; origin?: string; rp?: string; crossOrigin?: boolean; topOrigin?: string } = {}): RegistrationResponseJSON {
  const client = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false, ...changes }));
  const id = Buffer.from(device.id, "base64url");
  const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
  const auth = Buffer.concat([hash(changes.rp ?? rp), Buffer.from([changes.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, device.publicKey]);
  return { id: device.id, rawId: device.id, type: "public-key", clientExtensionResults: { credProps: { rk: true } }, response: { clientDataJSON: b64(client), attestationObject: b64(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", auth]]))), transports: ["internal"] } };
}
function assertion(device: Authenticator, challenge: string, changes: { flags?: number; origin?: string; rp?: string; crossOrigin?: boolean; topOrigin?: string; counter?: number; challenge?: string } = {}): AuthenticationResponseJSON {
  const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false, ...changes }));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(changes.counter ?? 0);
  const auth = Buffer.concat([hash(changes.rp ?? rp), Buffer.from([changes.flags ?? 0x05]), counter]);
  return { id: device.id, rawId: device.id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(client), authenticatorData: b64(auth), signature: b64(sign("sha256", Buffer.concat([auth, hash(client)]), device.privateKey)), userHandle: device.userId } };
}
function cookieHeader(response: Response, name = "__Host-omp-auth"): string {
  const field = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  if (field === undefined) throw new Error("expected authentication cookie");
  return field.split(";")[0]!;
}
function post(path: string, body: unknown, cookie = "", headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/v1/auth/${path}`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", Cookie: cookie, ...headers }, body: JSON.stringify(body) });
}

async function fixture(clockBoundary?: "staged" | "committed") {
  const root = await mkdtemp(join(tmpdir(), "gateway-webauthn-")); roots.push(root);
  const config: GatewayConfig = { http: { hostname: "127.0.0.1", port: 4317, publicOrigin: origin }, auth: { mode: "webauthn", allowedLogins: [] }, omp: { discoveryDir: join(root, "omp"), queryTimeoutMs: 1_500 }, registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 }, paths: { configDir: join(root, "config"), stateDir: join(root, "state"), runtimeDir: join(root, "run"), tokenPath: join(root, "config", "token"), configPath: join(root, "config", "config.json") } };
  let time = Date.now();
  let enrollments = 0;
  let clockShifted = false;
  const service = await WebAuthnService.open({ config, enrollmentCode, now: () => {
    if (clockBoundary !== undefined && !clockShifted) {
      // Real filesystem state, not crypto/storage mocks or an assertion about call counts.
      // Model a slow stage/commit by advancing the clock only once those bytes exist.
      const files = readdirSync(config.paths.stateDir);
      clockShifted = clockBoundary === "staged"
        ? files.some(name => name.startsWith("webauthn-credentials.json.") && name.endsWith(".tmp"))
        : files.includes("webauthn-credentials.json");
      if (clockShifted) time += 300_000;
    }
    return time;
  }, onEnrolled: () => { enrollments++; } }); services.push(service);
  const staticRoot = join(root, "static"); await mkdir(join(staticRoot, "assets"), { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Sign in</title>");
  await writeFile(join(staticRoot, "assets", "app.0123456789ab.js"), "export {};");
  await writeFile(join(staticRoot, "service-worker.js"), "// protected");
  const assets = await StaticAssetStore.load(staticRoot);
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
  const logged: string[] = [];
  const logger = new SafeLogger({ write(line) { logged.push(line); } });
  const resolver: LaunchBroker = { async resolve() { return { status: "ok", capability: SecretCapability.from(randomBytes(32).toString("base64url")) }; } };
  const handler = createHttpHandler({ config, registry, staticAssets: assets, webAuthn: service, logger, launchResolver: resolver, sseKeepaliveMs: 60_000 });
  async function enroll(device = authenticator()) {
    const optionsResponse = await handler(post("enroll/options", { code: enrollmentCode, label: "Owner phone" }), peer);
    expect(optionsResponse.status).toBe(200);
    const { options } = await optionsResponse.json(); device.userId = options.user.id;
    expect(options.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "required" });
    expect(options.attestation).toBe("none");
    const response = await handler(post("enroll/verify", { response: registration(device, options.challenge) }, cookieHeader(optionsResponse)), peer);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ enrolled: true });
    return device;
  }
  async function login(device: Authenticator, oldCookie = "", counter = 0) {
    const optionsResponse = await handler(post("login/options", {}, oldCookie), peer); expect(optionsResponse.status).toBe(200);
    const { options } = await optionsResponse.json();
    expect(options.allowCredentials ?? []).toEqual([]);
    const response = await handler(post("login/verify", { response: assertion(device, options.challenge, { counter }) }, cookieHeader(optionsResponse)), peer);
    expect(response.status).toBe(200);
    return { response, cookie: cookieHeader(response, "__Host-omp-session") };
  }
  return { root, config, service, handler, enroll, login, assets, registry, resolver, logged, advance(ms: number) { time += ms; }, enrollments: () => enrollments };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("real signatures admit only an enrolled credential and absolute opaque cookies expire", async () => {
  const f = await fixture(); const device = await f.enroll(); const first = await f.login(device);
  expect(f.enrollments()).toBe(1);
  expect(await listWebAuthnCredentials(f.config)).toEqual([{ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u), label: "Owner phone" }]);
  expect((await stat(join(f.config.paths.stateDir, "webauthn-credentials.json"))).mode & 0o777).toBe(0o600);
  for (const field of first.response.headers.getSetCookie()) {
    expect(field).toContain("Path=/; Secure; HttpOnly; SameSite=Strict");
    expect(field).not.toMatch(/Domain=|Expires=/iu);
    if (field.startsWith("__Host-omp-session=")) expect(field).not.toContain("Max-Age=");
  }
  expect(first.cookie.split("=")[1]).toHaveLength(43);
  const get = () => f.handler(new Request(`${origin}/api/v1/sessions`, { headers: { Cookie: first.cookie } }), peer);
  const admitted = await get(); expect(admitted.status).toBe(200); expect(admitted.headers.get("X-OMP-Auth-Mode")).toBe("webauthn"); expect(admitted.headers.has("Set-Cookie")).toBe(false);
  f.advance(3_599_999); expect((await get()).status).toBe(200);
  f.advance(1); expect((await get()).status).toBe(401);
  const state = await readFile(join(f.config.paths.stateDir, "webauthn-credentials.json"), "utf8");
  expect(state).not.toContain(first.cookie.split("=")[1]!);
  expect(f.logged.join("\n")).not.toContain(first.cookie.split("=")[1]!);
  expect(f.service.identityAllowed(`webauthn:${(await listWebAuthnCredentials(f.config))[0]!.id}`)).toBe(true);
});

test("signature verifier rejects tampering origin RP and user verification", async () => {
  const f = await fixture(); const device = await f.enroll();
  for (const change of [{ origin: "https://wrong.example.test" }, { rp: "wrong.example.test" }, { flags: 0x01 }, { flags: 0x04 }, { crossOrigin: true }, { topOrigin: origin }, { challenge: b64(randomBytes(32)) }]) {
    const optionsResponse = await f.handler(post("login/options", {}), peer); const { options } = await optionsResponse.json();
    const response = await f.handler(post("login/verify", { response: assertion(device, options.challenge, change) }, cookieHeader(optionsResponse)), peer);
    expect(response.status).toBe(400); expect(response.headers.has("Set-Cookie")).toBe(false);
  }
  const optionsResponse = await f.handler(post("login/options", {}), peer); const { options } = await optionsResponse.json();
  const signed = assertion(device, options.challenge); signed.response.signature = b64(randomBytes(72));
  expect((await f.handler(post("login/verify", { response: signed }, cookieHeader(optionsResponse)), peer)).status).toBe(400);
});

test("registration rejects missing presence verification embedded origin and wrong RP", async () => {
  const f = await fixture();
  for (const changes of [{ flags: 0x41 }, { flags: 0x44 }, { crossOrigin: true }, { topOrigin: origin }, { origin: "https://wrong.example.test" }, { rp: "wrong.example.test" }]) {
    const result = await f.handler(post("enroll/options", { code: enrollmentCode, label: "Phone" }), peer); const { options } = await result.json();
    expect((await f.handler(post("enroll/verify", { response: registration(authenticator(), options.challenge, changes) }, cookieHeader(result)), peer)).status).toBe(400);
  }
  expect(await listWebAuthnCredentials(f.config)).toEqual([]);
});

test("one-use challenges are consumed atomically before asynchronous verification", async () => {
  const f = await fixture(); const device = await f.enroll();
  const result = await f.handler(post("login/options", {}), peer); const { options } = await result.json();
  const body = { response: assertion(device, options.challenge) };
  const responses = await Promise.all([f.handler(post("login/verify", body, cookieHeader(result)), peer), f.handler(post("login/verify", body, cookieHeader(result)), peer)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  expect((await f.handler(post("login/verify", body, cookieHeader(result)), peer)).status).toBe(400);
});

test("challenge cookie binds ceremonies and failed signatures burn the challenge", async () => {
  const f = await fixture(); const device = await f.enroll();
  const result = await f.handler(post("login/options", {}), peer); const { options } = await result.json();
  const body = { response: assertion(device, options.challenge) };
  expect((await f.handler(post("login/verify", body), peer)).status).toBe(400);
  expect((await f.handler(post("login/verify", body, cookieHeader(result) + "; " + cookieHeader(result)), peer)).status).toBe(400);
  const bad = structuredClone(body); bad.response.response.signature = b64(randomBytes(72));
  expect((await f.handler(post("login/verify", bad, cookieHeader(result)), peer)).status).toBe(400);
  expect((await f.handler(post("login/verify", body, cookieHeader(result)), peer)).status).toBe(400);
});

test("challenge and enrollment grant have fixed two and five minute deadlines", async () => {
  const f = await fixture(); const result = await f.handler(post("enroll/options", { code: enrollmentCode, label: "Phone" }), peer); const { options } = await result.json();
  f.advance(120_000);
  expect((await f.handler(post("enroll/verify", { response: registration(authenticator(), options.challenge) }, cookieHeader(result)), peer)).status).toBe(400);
  f.advance(180_000);
  expect((await f.handler(post("enroll/options", { code: enrollmentCode, label: "Phone" }), peer)).status).toBe(400);
});

test("synced zero counters remain usable and concurrent public counters serialize", async () => {
  const f = await fixture(); const device = await f.enroll();
  await f.login(device); await f.login(device);
  const a = await f.handler(post("login/options", {}), peer); const b = await f.handler(post("login/options", {}), peer);
  const oa = (await a.json()).options; const ob = (await b.json()).options;
  const responses = await Promise.all([f.handler(post("login/verify", { response: assertion(device, oa.challenge, { counter: 1 }) }, cookieHeader(a)), peer), f.handler(post("login/verify", { response: assertion(device, ob.challenge, { counter: 1 }) }, cookieHeader(b)), peer)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  const stored = JSON.parse(await readFile(join(f.config.paths.stateDir, "webauthn-credentials.json"), "utf8"));
  expect(stored.credentials[0].counter).toBe(1);
});

test("logout immediately closes SSE and a resolved launch cannot cross revocation", async () => {
  const f = await fixture(); const device = await f.enroll(); const login = await f.login(device);
  const events = await f.handler(new Request(`${origin}/api/v1/events`, { headers: { Cookie: login.cookie } }), peer);
  const reader = events.body!.getReader(); expect((await reader.read()).done).toBe(false);
  let release!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }); const began = new Promise<void>(resolve => { entered = resolve; });
  const handler = createHttpHandler({ config: f.config, registry: f.registry, staticAssets: f.assets, webAuthn: f.service, logger: new SafeLogger({ write() {} }), launchResolver: { async resolve() { entered(); await pending; return { status: "ok", capability: SecretCapability.from(randomBytes(32).toString("base64url")) }; } } });
  const launch = handler(new Request(`${origin}/api/v1/sessions/http-instance-000001/launch`, { method: "POST", headers: { Cookie: login.cookie, Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "view", generation: 3 }) }), peer);
  await began;
  expect((await f.handler(post("logout", {}, login.cookie), peer)).status).toBe(204);
  expect((await reader.read()).done).toBe(true);
  release(); expect((await launch).status).toBe(401);
  expect((await f.handler(new Request(`${origin}/api/v1/sessions`, { headers: { Cookie: login.cookie } }), peer)).status).toBe(401);
  await f.login(device);
});

test("session rotation and restart invalidate old cookies while credentials survive", async () => {
  const f = await fixture(); const device = await f.enroll(); const old = await f.login(device); const current = await f.login(device, old.cookie);
  expect(f.service.session(new Request(origin, { headers: { Cookie: old.cookie } }))).toBeUndefined();
  expect(f.service.session(new Request(origin, { headers: { Cookie: current.cookie } }))?.isActive()).toBe(true);
  await f.service.close();
  const restarted = await WebAuthnService.open({ config: f.config }); services.push(restarted);
  expect(restarted.session(new Request(origin, { headers: { Cookie: current.cookie } }))).toBeUndefined();
  expect(restarted.identityAllowed(`webauthn:${(await listWebAuthnCredentials(f.config))[0]!.id}`)).toBe(true);
  await expect(restarted.options(post("enroll/options", {}), "enroll", { code: enrollmentCode, label: "More" })).rejects.toThrow();
});

test("unsafe missing corrupt or mismatched credential state never becomes fresh enrollment", async () => {
  const f = await fixture(); await expect(WebAuthnService.open({ config: f.config })).rejects.toThrow();
  await f.enroll(); await f.service.close();
  const path = join(f.config.paths.stateDir, "webauthn-credentials.json"); const original = await readFile(path, "utf8");
  await chmod(path, 0o644); await expect(WebAuthnService.open({ config: f.config, enrollmentCode })).rejects.toThrow(); await chmod(path, 0o600);
  await writeFile(path, "{}"); await expect(WebAuthnService.open({ config: f.config, enrollmentCode })).rejects.toThrow();
  const mismatch = JSON.parse(original); mismatch.origin = "https://other.example.test"; await writeFile(path, JSON.stringify(mismatch)); await expect(WebAuthnService.open({ config: f.config, enrollmentCode })).rejects.toThrow();
  await rm(path); await symlink(join(f.root, "missing"), path); await expect(WebAuthnService.open({ config: f.config, enrollmentCode })).rejects.toThrow();
});

test("local revoke removes only selected credential and leaves no permanent enrollment grant", async () => {
  const f = await fixture(); await f.enroll(); await f.service.close(); const records = await listWebAuthnCredentials(f.config);
  const second = await WebAuthnService.open({ config: f.config, enrollmentCode }); services.push(second);
  const result = await second.options(post("enroll/options", {}), "enroll", { code: enrollmentCode, label: "Backup key" });
  const options = (await result.json()).options; const device = authenticator();
  await second.verify(post("enroll/verify", {}, cookieHeader(result)), "enroll", { response: registration(device, options.challenge) });
  await second.close();
  await revokeWebAuthnCredential(f.config, records[0]!.id);
  const remaining = await listWebAuthnCredentials(f.config);
  expect(remaining).toEqual([{ id: expect.any(String), label: "Backup key" }]);
  const reopened = await WebAuthnService.open({ config: f.config }); services.push(reopened);
  expect(reopened.identityAllowed(`webauthn:${records[0]!.id}`)).toBe(false);
  expect(reopened.identityAllowed(`webauthn:${remaining[0]!.id}`)).toBe(true); await reopened.close();
  await revokeWebAuthnCredential(f.config, remaining[0]!.id);
  await expect(WebAuthnService.open({ config: f.config })).rejects.toThrow();
  await expect(revokeWebAuthnCredential(f.config, records[0]!.id)).rejects.toThrow();
});

test("WebAuthn ingress ignores forged identity and enforces origin JSON and cookie boundaries", async () => {
  const f = await fixture(); const device = await f.enroll(); const login = await f.login(device);
  const forged = new Request(`${origin}/api/v1/sessions`, { headers: { "Tailscale-User-Login": "owner@example.test", "Tailscale-User-Name": "Owner" } });
  expect((await f.handler(forged, peer)).status).toBe(401);
  expect((await f.handler(new Request(`${origin}/api/v1/sessions`, { headers: { Cookie: login.cookie + "; " + login.cookie } }), peer)).status).toBe(401);
  expect((await f.handler(new Request(`${origin}/api/v1/sessions`, { headers: { Cookie: login.cookie } }), { address: "203.0.113.7" })).status).toBe(401);
  for (const headers of [{ Origin: "https://other.example.test" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "" }]) expect((await f.handler(post("login/options", {}, "", headers), peer)).status).toBe(403);
  expect((await f.handler(post("login/options", {}, "", { "Content-Type": "text/plain" }), peer)).status).toBe(415);
  expect((await f.handler(post("login/options", { extra: "x" }), peer)).status).toBe(400);
  expect((await f.handler(post("login/options", { oversized: "x".repeat(65_536) }), peer)).status).toBe(400);
  const unauth = await f.handler(new Request(`${origin}/api/v1/sessions`), peer); expect(unauth.headers.get("Cache-Control")).toContain("no-store");
  expect((await f.handler(new Request(`${origin}/`), peer)).status).toBe(200);
  expect((await f.handler(new Request(`${origin}/assets/app.0123456789ab.js`), peer)).status).toBe(200);
  expect((await f.handler(new Request(`${origin}/service-worker.js`), peer)).status).toBe(401);
});


test("absolute session timer closes an idle SSE stream without a heartbeat", async () => {
  const f = await fixture(); const device = await f.enroll();
  jest.useFakeTimers();
  try {
    const login = await f.login(device);
    const handler = createHttpHandler({ config: f.config, registry: f.registry, staticAssets: f.assets, webAuthn: f.service, logger: new SafeLogger({ write() {} }), launchResolver: f.resolver, sseKeepaliveMs: 7_200_000 });
    const events = await handler(new Request(`${origin}/api/v1/events`, { headers: { Cookie: login.cookie } }), peer);
    const reader = events.body!.getReader(); expect((await reader.read()).done).toBe(false);
    f.advance(3_600_000); jest.advanceTimersByTime(3_600_000);
    expect((await reader.read()).done).toBe(true);
  } finally { jest.useRealTimers(); }
});

test("SSE refuses metadata emitted after session expiry before its timer runs", async () => {
  const f = await fixture(); const device = await f.enroll(); const login = await f.login(device);
  const events = await f.handler(new Request(`${origin}/api/v1/events`, { headers: { Cookie: login.cookie } }), peer);
  const reader = events.body!.getReader(); await reader.read();
  f.advance(3_600_000);
  f.registry.reconcile({ observed: [{ instanceId: "http-instance-000001", generation: 1, pid: 1234, sessionId: "synthetic-session", title: "Private metadata", cwdLabel: "repository", model: "fixture/model", startedAt: "2026-07-19T00:00:00.000Z", inputRequired: false, canControl: true }], retained: new Set() });
  expect((await reader.read()).done).toBe(true);
});

test("closing service during a real asynchronous verifier cannot mint a session", async () => {
  const f = await fixture(); const device = await f.enroll();
  const result = await f.handler(post("login/options", {}), peer); const { options } = await result.json();
  const request = post("login/verify", {}, cookieHeader(result));
  const pending = f.service.verify(request, "login", { response: assertion(device, options.challenge, { counter: 1 }) });
  // The queue begins verification on its first microtask; close during its crypto await.
  await Promise.resolve();
  const closing = f.service.close();
  await expect(pending).rejects.toThrow(); await closing;
  expect(f.service.identityAllowed(`webauthn:${(await listWebAuthnCredentials(f.config))[0]!.id}`)).toBe(false);
});


test("logout removes only this browser endpoint while expired sessions keep opted-in push", async () => {
  const f = await fixture(); const device = await f.enroll(); const login = await f.login(device);
  const identity = f.service.session(new Request(origin, { headers: { Cookie: login.cookie } }))!.identityKey;
  const push = await PushService.open({ config: f.config, registry: f.registry, identityAllowed: key => f.service.identityAllowed(key), logger: new SafeLogger({ write() {} }) });
  const endpoints = ["https://push.example.test/first", "https://push.example.test/second"];
  try {
    for (const endpoint of endpoints) await push.subscribe(identity, { version: PUSH_API_VERSION, subscription: { endpoint, expirationTime: null, keys: { p256dh: b64(randomBytes(65)), auth: b64(randomBytes(16)) } } });
    const handler = createHttpHandler({ config: f.config, registry: f.registry, staticAssets: f.assets, webAuthn: f.service, pushService: push, launchResolver: f.resolver });
    expect((await handler(post("logout", { endpoint: endpoints[0] }, login.cookie), peer)).status).toBe(204);
    const remaining = JSON.parse(await readFile(join(f.config.paths.stateDir, "push-state.json"), "utf8"));
    expect(remaining.subscriptions.map((item: { endpoint: string }) => item.endpoint)).toEqual([endpoints[1]]);
    const renewed = await f.login(device); f.advance(3_600_000);
    expect(f.service.session(new Request(origin, { headers: { Cookie: renewed.cookie } }))).toBeUndefined();
    expect(f.service.identityAllowed(identity)).toBe(true);
    expect((await readFile(join(f.config.paths.stateDir, "push-state.json"), "utf8"))).toContain(endpoints[1]!);
  } finally { await push.stop(); }
});


test("enrollment expiring during real private staging cannot commit a credential", async () => {
  const f = await fixture("staged");
  const result = await f.handler(post("enroll/options", { code: enrollmentCode, label: "Phone" }), peer);
  const { options } = await result.json();
  const response = await f.handler(post("enroll/verify", { response: registration(authenticator(), options.challenge) }, cookieHeader(result)), peer);
  expect(response.status).toBe(400);
  expect(await listWebAuthnCredentials(f.config)).toEqual([]);
  expect(readdirSync(f.config.paths.stateDir)).toEqual([]);
  expect(f.enrollments()).toBe(0);
});

test("an admitted durable enrollment reports success instead of rejecting after commit", async () => {
  const f = await fixture("committed"); await f.enroll();
  expect((await listWebAuthnCredentials(f.config)).map(item => item.label)).toEqual(["Owner phone"]);
  expect(f.enrollments()).toBe(1);
  expect((await f.handler(post("enroll/options", { code: enrollmentCode, label: "Another" }), peer)).status).toBe(400);
});



