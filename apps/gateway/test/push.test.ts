import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_API_VERSION,
  type BrowserPushSubscription,
  type PublishedSessionInput,
  parseAttentionPushMessage,
  parsePushSubscriptionRequest,
} from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { SafeLogger } from "../src/logger.ts";
import { PushService, type PushTransport } from "../src/push.ts";
import { SessionRegistry } from "../src/registry.ts";

const endpoint = "https://push.example.test/send/device-subscription";
const subscription: BrowserPushSubscription = {
  endpoint,
  expirationTime: null,
  keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
};

function config(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317" },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 100, maxSessions: 100 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      socketPath: join(root, "run", "registry.sock"),
      tokenPath: join(root, "config", "publisher-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

function published(inputRequired: boolean, generation = 1): PublishedSessionInput {
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
    viewLink: `VIEW_CAPABILITY_CANARY_${"V".repeat(20)}`,
    controlLink: `CONTROL_CAPABILITY_CANARY_${"C".repeat(20)}`,
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
    if (this.statusCode !== undefined) {
      const error = new Error("push service rejected request");
      Object.defineProperty(error, "statusCode", { value: this.statusCode });
      throw error;
    }
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-gateway-push-"));
  return root;
}

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

    registry.upsert("owner", published(false));
    registry.upsert("owner", published(true));
    registry.upsert("owner", published(true));
    registry.upsert("owner", published(false));
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

    registry.upsert("owner", published(false));
    registry.upsert("owner", published(true));
    await service.flush();
    await service.stop();

    const state = await readFile(join(gatewayConfig.paths.stateDir, "push-state.json"), "utf8");
    expect(state).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain("CONTENT_CANARY");
    expect(lines.join("\n")).not.toContain("CAPABILITY_CANARY");
  });
});
