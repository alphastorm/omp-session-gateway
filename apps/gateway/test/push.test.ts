import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_API_VERSION,
  type BrowserPushSubscription,
  type ObservedSessionInput,
  type PushSubscriptionKeys,
  parseAttentionPushMessage,
  parsePushSubscriptionRequest,
} from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { SafeLogger } from "../src/logger.ts";
import { PushService, removeWebAuthnPushSubscriptions, type PushTransport } from "../src/push.ts";
import { SessionRegistry } from "../src/registry.ts";

const endpoint = "https://push.example.test/send/device-subscription";
const previousKeys: PushSubscriptionKeys = { p256dh: "P".repeat(88), auth: "A".repeat(22) };
const renewedKeys: PushSubscriptionKeys = { p256dh: "Q".repeat(88), auth: "B".repeat(22) };
const subscription: BrowserPushSubscription = {
  endpoint,
  expirationTime: null,
  keys: previousKeys,
};

/** Names a device by its key pair so a failed expectation never prints transport key material. */
function keyLabel(keys: PushSubscriptionKeys): string {
  if (keys.p256dh === previousKeys.p256dh && keys.auth === previousKeys.auth) return "previous";
  if (keys.p256dh === renewedKeys.p256dh && keys.auth === renewedKeys.auth) return "renewed";
  return "unrecognized";
}

function pushError(status: number): Error {
  const error = new Error("push service rejected request");
  Object.defineProperty(error, "statusCode", { value: status });
  return error;
}

type SettleSend = (error?: unknown) => void;

function config(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317" },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    omp: { discoveryDir: join(root, "omp", "run", "collab-hosts"), queryTimeoutMs: 1_500 },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      tokenPath: join(root, "config", "readiness-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

function observedSession(inputRequired: boolean, generation = 1): ObservedSessionInput {
  return {
    instanceId: "push-instance-000001",
    generation,
    pid: 1234,
    sessionId: `session-${generation}`,
    title: "PROMPT_CONTENT_CANARY",
    cwdLabel: "OPTION_CONTENT_CANARY",
    model: "provider/model",
    startedAt: "2026-07-24T00:00:00.000Z",
    inputRequired,
    canControl: true,
  };
}

class RecordingTransport implements PushTransport {
  readonly calls: Array<{
    readonly subscription: BrowserPushSubscription;
    readonly payload: string;
    readonly options: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
      readonly ttlSeconds: number;
      readonly topic: string;
    };
  }> = [];
  statusCode: number | undefined;
  blockWhen: ((subscription: BrowserPushSubscription) => boolean) | undefined;
  readonly #gates: SettleSend[] = [];
  readonly #waiters: Array<(settle: SettleSend) => void> = [];

  /** Resolves with the gate of the next blocked send, awaiting that signal instead of a timer. */
  nextBlockedSend(): Promise<SettleSend> {
    const ready = this.#gates.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    const { promise, resolve } = Promise.withResolvers<SettleSend>();
    this.#waiters.push(resolve);
    return promise;
  }

  async send(
    pushSubscription: BrowserPushSubscription,
    payload: string,
    options: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
      readonly ttlSeconds: number;
      readonly topic: string;
    },
  ): Promise<void> {
    this.calls.push({ subscription: pushSubscription, payload, options });
    if (this.blockWhen?.(pushSubscription) === true) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const settle: SettleSend = error => {
        if (error === undefined) resolve();
        else reject(error);
      };
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#gates.push(settle);
      else waiter(settle);
      await promise;
      return;
    }
    if (this.statusCode !== undefined) throw pushError(this.statusCode);
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-gateway-push-"));
  return root;
}

describe("WebAuthn push identities", () => {
  for (const previousMode of ["tailscale-serve", "webauthn"] as const) {
    test("reclaims eight predecessor slots after switching from " + previousMode, async () => {
      const root = await createRoot();
      const credentialIdentity = "webauthn:" + "A".repeat(22);
      const serveIdentity = "owner@example.com";
      const modes = {
        "tailscale-serve": { ...config(root), auth: { mode: "tailscale-serve" as const, allowedLogins: [serveIdentity] } },
        webauthn: { ...config(root), auth: { mode: "webauthn" as const, allowedLogins: [] } },
      };
      const currentMode = previousMode === "tailscale-serve" ? "webauthn" : "tailscale-serve";
      const previousIdentity = previousMode === "webauthn" ? credentialIdentity : serveIdentity;
      const currentIdentity = currentMode === "webauthn" ? credentialIdentity : serveIdentity;
      const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
      const identityAllowed = (identity: string): boolean => identity === credentialIdentity;
      const previous = await PushService.open({ config: modes[previousMode], registry, identityAllowed, transport: new RecordingTransport() });
      try {
        for (let index = 0; index < 8; index++) {
          await previous.subscribe(previousIdentity, { version: PUSH_API_VERSION, subscription: { ...subscription, endpoint: "https://push.example.test/send/predecessor-" + index } });
        }
      } finally { await previous.stop(); }
      const statePath = join(root, "state", "push-state.json");
      const before = JSON.parse(await readFile(statePath, "utf8")) as { vapid: unknown };
      const current = await PushService.open({ config: modes[currentMode], registry, identityAllowed, transport: new RecordingTransport() });
      try {
        // The first opt-in under the new authority must not be blocked by all eight old rows.
        await current.subscribe(currentIdentity, { version: PUSH_API_VERSION, subscription });
        const after = JSON.parse(await readFile(statePath, "utf8")) as { vapid: unknown; subscriptions: { identityKey: string }[] };
        expect(after.subscriptions.map(item => item.identityKey)).toEqual([currentIdentity]);
        expect(JSON.stringify(after.vapid) === JSON.stringify(before.vapid)).toBe(true);
      } finally { await current.stop(); }
    });
  }

  test("keeps opted-in delivery across restart but refuses revoked and noncredential identities", async () => {
    const root = await createRoot();
    const gatewayConfig: GatewayConfig = { ...config(root), auth: { mode: "webauthn", allowedLogins: [] } };
    const id = "A".repeat(22);
    const otherId = "B".repeat(22);
    const identities = new Set([`webauthn:${id}`, `webauthn:${otherId}`]);
    const request = parsePushSubscriptionRequest({ version: PUSH_API_VERSION, subscription });
    const service = await PushService.open({
      config: gatewayConfig,
      registry: new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }),
      identityAllowed: identity => identities.has(identity),
      transport: new RecordingTransport(),
    });
    await service.subscribe(`webauthn:${id}`, request);
    await service.subscribe(`webauthn:${otherId}`, { ...request, detailLevel: "preview", subscription: { ...subscription, endpoint: `${endpoint}-other`, expirationTime: 8_640_000_000_000_000 } });
    await service.subscribe(`webauthn:${otherId}`, { ...request, subscription: { ...subscription, endpoint: `${endpoint}-expired`, expirationTime: 1 } });
    await expect(service.subscribe("owner@example.com", request)).rejects.toThrow();
    await expect(service.subscribe("webauthn:short", request)).rejects.toThrow();
    await service.stop();
    await expect(service.subscribe(`webauthn:${id}`, request)).rejects.toThrow();
    await expect(service.unsubscribe(`webauthn:${id}`, { version: PUSH_API_VERSION, endpoint })).rejects.toThrow();

    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const before = JSON.parse(await readFile(statePath, "utf8")) as { vapid: unknown };
    identities.delete(`webauthn:${id}`);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const restarted = await PushService.open({ config: gatewayConfig, registry, transport, identityAllowed: identity => identities.has(identity) });
    try {
      const pruned = JSON.parse(await readFile(statePath, "utf8")) as { vapid: unknown; subscriptions: { identityKey: string; endpoint: string; detailLevel: string }[] };
      expect(pruned.subscriptions.map(item => ({ identity: item.identityKey, endpoint: item.endpoint, detailLevel: item.detailLevel }))).toEqual([
        { identity: `webauthn:${otherId}`, endpoint: `${endpoint}-other`, detailLevel: "preview" },
      ]);
      expect(JSON.stringify(pruned.vapid) === JSON.stringify(before.vapid)).toBe(true);
      registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
      registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
      await restarted.flush();
      expect(transport.calls.map(call => call.subscription.endpoint)).toEqual([`${endpoint}-other`]);
    } finally {
      await restarted.stop();
    }
    await removeWebAuthnPushSubscriptions(gatewayConfig, id);
    const persisted = JSON.parse(await readFile(join(gatewayConfig.paths.stateDir, "push-state.json"), "utf8")) as {
      subscriptions: { identityKey: string }[];
    };
    expect(persisted.subscriptions.map(item => item.identityKey)).toEqual([`webauthn:${otherId}`]);
  });

  test("fails closed without the credential registry predicate", async () => {
    const root = await createRoot();
    const service = await PushService.open({
      config: { ...config(root), auth: { mode: "webauthn", allowedLogins: [] } },
      registry: new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }),
    });
    try {
      await expect(service.subscribe(`webauthn:${"A".repeat(22)}`, parsePushSubscriptionRequest({ version: PUSH_API_VERSION, subscription }))).rejects.toThrow();
    } finally {
      await service.stop();
    }
  });
});

describe("Web Push service", () => {
  test("persists private VAPID and subscription state without session content", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const service = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport() });
    const publicKey = service.configResponse().applicationServerKey;
    await service.subscribe(
      "dev-localhost",
      parsePushSubscriptionRequest({
        version: PUSH_API_VERSION,
        detailLevel: "preview",
        subscription,
      }),
    );
    await service.stop();

    const state = await readFile(statePath, "utf8");
    expect(state).toContain(endpoint);
    expect(state).toContain('"detailLevel": "preview"');
    expect(state).not.toContain("CAPABILITY_CANARY");
    expect((await stat(statePath)).mode & 0o077).toBe(0);

    const reopened = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport() });
    expect(reopened.configResponse().applicationServerKey).toBe(publicKey);
    await reopened.stop();
  });

  test("signs each send with a VAPID contact a push service can reach", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport });
    await service.subscribe(
      "dev-localhost",
      parsePushSubscriptionRequest({ version: PUSH_API_VERSION, detailLevel: "private", subscription }),
    );

    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    await service.stop();

    expect(transport.calls).toHaveLength(1);
    // Apple returns 403 BadJwtToken for a `sub` whose contact host cannot exist (#173); RFC
    // 2606/6761 reserve these names, and web-push itself warns that `localhost` is rejected.
    const subject = new URL(transport.calls[0]?.options.subject ?? "");
    expect(["https:", "mailto:"]).toContain(subject.protocol);
    const host = subject.protocol === "mailto:" ? subject.pathname.slice(subject.pathname.lastIndexOf("@") + 1) : subject.hostname;
    expect(host).not.toMatch(/(^|\.)(invalid|test|example|localhost)$/u);
  });

  test("builds per-device detail, re-pings silently, and clears the exact request", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      requestIdFactory: () => "push-request-identity-0001",
    });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport });
    const subscriptions = (["private", "session", "preview"] as const).map((detailLevel, index) => ({
      detailLevel,
      subscription: {
        ...subscription,
        endpoint: `${endpoint}-${index}`,
      },
    }));
    for (const entry of subscriptions) {
      await service.subscribe(
        "dev-localhost",
        parsePushSubscriptionRequest({
          version: PUSH_API_VERSION,
          detailLevel: entry.detailLevel,
          subscription: entry.subscription,
        }),
      );
    }

    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    // Identical polls coalesce; a visible update while the host keeps asking re-pings the same request.
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    registry.reconcile({ observed: [{ ...observedSession(true), model: "provider/updated" }], retained: new Set() });
    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    await service.flush();

    expect(transport.calls).toHaveLength(9);
    for (const entry of subscriptions) {
      const messages = transport.calls
        .filter(call => call.subscription.endpoint === entry.subscription.endpoint)
        .map(call => parseAttentionPushMessage(JSON.parse(call.payload)));
      expect(messages.map(message => message.type)).toEqual(["attention", "attention", "clear"]);
      expect(messages.map(message => message.pendingAskCount)).toEqual([1, 1, 0]);
      expect(messages.map(message => message.requestId)).toEqual([
        "push-request-identity-0001",
        "push-request-identity-0001",
        "push-request-identity-0001",
      ]);
      const first = messages[0];
      if (first?.type !== "attention") throw new Error("expected attention");
      if (entry.detailLevel === "private") {
        expect(first.body).toBeUndefined();
      } else {
        expect(first.body).toBe("PROMPT_CONTENT_CANARY · OPTION_CONTENT_CANARY");
      }
      for (const call of transport.calls.filter(call => call.subscription.endpoint === entry.subscription.endpoint)) {
        expect(call.payload).not.toContain("CAPABILITY_CANARY");
        expect(call.options.ttlSeconds).toBe(300);
        expect(call.options.topic).toHaveLength(32);
        expect(call.options.privateKey).not.toBe(call.options.publicKey);
      }
    }
    await service.stop();
  });

  test("removes expired push endpoints without logging endpoint or payload data", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    transport.statusCode = 410;
    const lines: string[] = [];
    const logger = new SafeLogger({ write(line): void { lines.push(line); } });
    const service = await PushService.open({ config: gatewayConfig, registry, transport, logger });
    await service.subscribe(
      "dev-localhost",
      parsePushSubscriptionRequest({
        version: PUSH_API_VERSION,
        detailLevel: "private",
        subscription,
      }),
    );

    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    await service.stop();

    const state = await readFile(join(gatewayConfig.paths.stateDir, "push-state.json"), "utf8");
    expect(state).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain("CONTENT_CANARY");
    expect(lines.join("\n")).not.toContain("CAPABILITY_CANARY");
  });

  test("keeps a renewed subscription when the in-flight send for the replaced keys is gone", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const lines: string[] = [];
    const logger = new SafeLogger({ write(line): void { lines.push(line); } });
    const service = await PushService.open({ config: gatewayConfig, registry, transport, logger });
    const subscribeWith = async (keys: PushSubscriptionKeys): Promise<void> => {
      await service.subscribe(
        "dev-localhost",
        parsePushSubscriptionRequest({
          version: PUSH_API_VERSION,
          detailLevel: "private",
          subscription: { endpoint, expirationTime: null, keys: { ...keys } },
        }),
      );
    };
    const storedLabels = async (): Promise<readonly string[]> => {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        readonly subscriptions: readonly { readonly keys: PushSubscriptionKeys }[];
      };
      return state.subscriptions.map(entry => keyLabel(entry.keys));
    };

    await subscribeWith(previousKeys);
    transport.blockWhen = candidate => keyLabel(candidate.keys) === "previous";

    const blockedSend = transport.nextBlockedSend();
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    const settleBlockedSend = await blockedSend;
    expect(transport.calls.map(call => keyLabel(call.subscription.keys))).toEqual(["previous"]);

    await subscribeWith(renewedKeys);
    expect(await storedLabels()).toEqual(["renewed"]);
    expect(transport.calls).toHaveLength(1);

    transport.blockWhen = undefined;
    settleBlockedSend(pushError(410));
    await service.flush();

    expect(await storedLabels()).toEqual(["renewed"]);

    const deliveredBeforeClear = transport.calls.length;
    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    await service.flush();
    const afterRenewal = transport.calls.slice(deliveredBeforeClear);
    expect(afterRenewal.map(call => keyLabel(call.subscription.keys))).toEqual(["renewed"]);
    expect(afterRenewal.map(call => parseAttentionPushMessage(JSON.parse(call.payload)).type)).toEqual(["clear"]);

    transport.statusCode = 410;
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    expect(await storedLabels()).toEqual([]);

    await service.stop();
    const log = lines.join("\n");
    expect(log).not.toContain(endpoint);
    expect(log).not.toContain(previousKeys.auth);
    expect(log).not.toContain(renewedKeys.auth);
    expect(log).not.toContain(previousKeys.p256dh);
    expect(log).not.toContain(renewedKeys.p256dh);
  });
});
