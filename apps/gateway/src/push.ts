import { createHash } from "node:crypto";
import { join } from "node:path";
import webPush from "web-push";
import {
  MAX_FRAME_BYTES,
  PUSH_API_VERSION,
  type AttentionPushMessage,
  type BrowserPushSubscription,
  type PushConfigResponse,
  type PushSubscriptionRequest,
  type PushUnsubscribeRequest,
  type SessionEvent,
  parseJsonFrame,
  parsePushSubscriptionRequest,
} from "@omp-session-gateway/protocol";
import {
  ensureRuntimeDirectories,
  type GatewayConfig,
  readPrivateTextFile,
  writePrivateTextFile,
} from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";

const PUSH_STATE_VERSION = 1 as const;
const MAX_PUSH_SUBSCRIPTIONS = 8;
const PUSH_TTL_SECONDS = 5 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const VAPID_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,128}$/u;
const VAPID_PRIVATE_KEY_PATTERN = /^[A-Za-z0-9_-]{40,64}$/u;
const IDENTITY_PATTERN = /^[^\0\r\n]{1,320}$/u;

interface VapidKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

interface StoredPushSubscription extends BrowserPushSubscription {
  readonly identityKey: string;
}

interface PushState {
  readonly version: typeof PUSH_STATE_VERSION;
  readonly vapid: VapidKeyPair;
  readonly subscriptions: readonly StoredPushSubscription[];
}

interface AttentionState {
  readonly generation: number;
  readonly active: boolean;
}

export interface PushTransport {
  send(
    subscription: BrowserPushSubscription,
    payload: string,
    options: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
      readonly ttlSeconds: number;
      readonly topic: string;
    },
  ): Promise<void>;
}

const defaultTransport: PushTransport = {
  async send(subscription, payload, options) {
    await webPush.sendNotification(subscription, payload, {
      TTL: options.ttlSeconds,
      urgency: "high",
      topic: options.topic,
      timeout: PUSH_TIMEOUT_MS,
      contentEncoding: "aes128gcm",
      vapidDetails: {
        subject: options.subject,
        publicKey: options.publicKey,
        privateKey: options.privateKey,
      },
    });
  },
};

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid push state");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid push state");
  }
  return record;
}

function parseStoredSubscription(value: unknown): StoredPushSubscription {
  const record = exactRecord(value, ["identityKey", "endpoint", "expirationTime", "keys"]);
  if (typeof record.identityKey !== "string" || !IDENTITY_PATTERN.test(record.identityKey)) {
    throw new Error("invalid push state");
  }
  const parsed = parsePushSubscriptionRequest({
    version: PUSH_API_VERSION,
    subscription: {
      endpoint: record.endpoint,
      expirationTime: record.expirationTime,
      keys: record.keys,
    },
  }).subscription;
  return { identityKey: record.identityKey, ...parsed };
}

function parsePushState(value: unknown): PushState {
  const record = exactRecord(value, ["version", "vapid", "subscriptions"]);
  if (record.version !== PUSH_STATE_VERSION || !Array.isArray(record.subscriptions)) {
    throw new Error("invalid push state");
  }
  if (record.subscriptions.length > MAX_PUSH_SUBSCRIPTIONS) throw new Error("invalid push state");
  const vapid = exactRecord(record.vapid, ["publicKey", "privateKey"]);
  if (
    typeof vapid.publicKey !== "string" ||
    typeof vapid.privateKey !== "string" ||
    !VAPID_PUBLIC_KEY_PATTERN.test(vapid.publicKey) ||
    !VAPID_PRIVATE_KEY_PATTERN.test(vapid.privateKey)
  ) {
    throw new Error("invalid push state");
  }
  const subscriptions = record.subscriptions.map(parseStoredSubscription);
  if (new Set(subscriptions.map(subscription => subscription.endpoint)).size !== subscriptions.length) {
    throw new Error("invalid push state");
  }
  return {
    version: PUSH_STATE_VERSION,
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    subscriptions,
  };
}


async function loadOrCreatePushState(config: GatewayConfig, path: string): Promise<PushState> {
  await ensureRuntimeDirectories(config);
  const raw = await readPrivateTextFile(path, MAX_FRAME_BYTES);
  if (raw !== undefined) {
    try {
      return parsePushState(parseJsonFrame(new TextEncoder().encode(raw)));
    } catch {
      throw new Error("push state is invalid or unsafe");
    }
  }
  const vapid = webPush.generateVAPIDKeys();
  const state: PushState = {
    version: PUSH_STATE_VERSION,
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    subscriptions: [],
  };
  await writePrivateTextFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = error.statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export class PushService {
  readonly #config: GatewayConfig;
  readonly #registry: SessionRegistry;
  readonly #logger: SafeLogger;
  readonly #transport: PushTransport;
  readonly #path: string;
  readonly #vapid: VapidKeyPair;
  readonly #attention = new Map<string, AttentionState>();
  readonly #deliveryChains = new Map<string, Promise<void>>();
  #subscriptions: readonly StoredPushSubscription[];
  #mutationTail = Promise.resolve();
  #unsubscribeRegistry: (() => void) | undefined;
  #stopped = false;

  private constructor(options: {
    config: GatewayConfig;
    registry: SessionRegistry;
    logger: SafeLogger;
    transport: PushTransport;
    path: string;
    state: PushState;
  }) {
    this.#config = options.config;
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#transport = options.transport;
    this.#path = options.path;
    this.#vapid = options.state.vapid;
    this.#subscriptions = options.state.subscriptions.filter(subscription =>
      subscription.expirationTime === null || subscription.expirationTime > Date.now(),
    );
    for (const session of this.#registry.snapshot().sessions) {
      this.#attention.set(session.instanceId, {
        generation: session.generation,
        active: session.inputRequired && session.canControl,
      });
    }
    this.#unsubscribeRegistry = this.#registry.subscribe(event => this.#acceptRegistryEvent(event));
  }

  static async open(options: {
    readonly config: GatewayConfig;
    readonly registry: SessionRegistry;
    readonly logger?: SafeLogger;
    readonly transport?: PushTransport;
    readonly statePath?: string;
  }): Promise<PushService> {
    const path = options.statePath ?? join(options.config.paths.stateDir, "push-state.json");
    const state = await loadOrCreatePushState(options.config, path);
    return new PushService({
      config: options.config,
      registry: options.registry,
      logger: options.logger ?? new SafeLogger(),
      transport: options.transport ?? defaultTransport,
      path,
      state,
    });
  }

  configResponse(): PushConfigResponse {
    return { version: PUSH_API_VERSION, applicationServerKey: this.#vapid.publicKey };
  }

  async subscribe(identityKey: string, request: PushSubscriptionRequest): Promise<void> {
    if (!this.#identityAllowed(identityKey)) throw new Error("push identity is not allowed");
    const stored: StoredPushSubscription = { identityKey, ...request.subscription };
    await this.#mutateSubscriptions(current => {
      const remaining = current.filter(subscription => subscription.endpoint !== stored.endpoint);
      if (remaining.length >= MAX_PUSH_SUBSCRIPTIONS) throw new Error("push subscription limit reached");
      return [...remaining, stored];
    });
    for (const [instanceId, attention] of this.#attention) {
      if (attention.active) this.#queueMessage("attention", instanceId, attention.generation, [stored]);
    }
  }

  async unsubscribe(identityKey: string, request: PushUnsubscribeRequest): Promise<boolean> {
    let removed = false;
    await this.#mutateSubscriptions(current =>
      current.filter(subscription => {
        const matches = subscription.identityKey === identityKey && subscription.endpoint === request.endpoint;
        removed ||= matches;
        return !matches;
      }),
    );
    return removed;
  }

  async flush(): Promise<void> {
    while (this.#deliveryChains.size > 0) {
      await Promise.allSettled([...this.#deliveryChains.values()]);
    }
    await this.#mutationTail;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribeRegistry?.();
    this.#unsubscribeRegistry = undefined;
    await this.flush();
  }

  #identityAllowed(identityKey: string): boolean {
    return this.#config.auth.mode === "dev-localhost"
      ? identityKey === "dev-localhost"
      : this.#config.auth.allowedLogins.includes(identityKey);
  }

  #acceptRegistryEvent(event: SessionEvent): void {
    if (this.#stopped || event.type === "snapshot") return;
    if (event.type === "session_remove") {
      const previous = this.#attention.get(event.instanceId);
      if (previous?.generation !== event.generation) return;
      this.#attention.delete(event.instanceId);
      if (previous.active) this.#queueMessage("resolved", event.instanceId, event.generation);
      return;
    }

    const { session } = event;
    const previous = this.#attention.get(session.instanceId);
    const active = session.inputRequired && session.canControl;
    if (previous !== undefined && previous.generation !== session.generation && previous.active) {
      this.#queueMessage("resolved", session.instanceId, previous.generation);
    }
    if (previous?.generation !== session.generation) {
      if (active) this.#queueMessage("attention", session.instanceId, session.generation);
    } else if (previous.active !== active) {
      this.#queueMessage(active ? "attention" : "resolved", session.instanceId, session.generation);
    }
    this.#attention.set(session.instanceId, { generation: session.generation, active });
  }

  #queueMessage(
    type: AttentionPushMessage["type"],
    instanceId: string,
    generation: number,
    subscriptions?: readonly StoredPushSubscription[],
  ): void {
    const key = `${instanceId}\0${generation}`;
    const prior = this.#deliveryChains.get(key) ?? Promise.resolve();
    const delivery = prior
      .then(() => this.#deliver({ version: PUSH_API_VERSION, type, instanceId, generation }, subscriptions))
      .catch(() => {
        this.#logger.event("warn", "push.delivery_failed");
      })
      .finally(() => {
        if (this.#deliveryChains.get(key) === delivery) this.#deliveryChains.delete(key);
      });
    this.#deliveryChains.set(key, delivery);
  }

  async #deliver(
    message: AttentionPushMessage,
    selectedSubscriptions?: readonly StoredPushSubscription[],
  ): Promise<void> {
    const subscriptions = (selectedSubscriptions ?? this.#subscriptions).filter(subscription =>
      this.#identityAllowed(subscription.identityKey),
    );
    if (subscriptions.length === 0) return;
    const payload = JSON.stringify(message);
    const topic = createHash("sha256")
      .update(message.instanceId)
      .update("\0")
      .update(String(message.generation))
      .digest("base64url")
      .slice(0, 32);
    const stale = new Set<string>();
    await Promise.all(
      subscriptions.map(async subscription => {
        try {
          await this.#transport.send(subscription, payload, {
            subject: "mailto:security@omp-session-gateway.invalid",
            publicKey: this.#vapid.publicKey,
            privateKey: this.#vapid.privateKey,
            ttlSeconds: PUSH_TTL_SECONDS,
            topic,
          });
        } catch (error) {
          const code = statusCode(error);
          if (code === 404 || code === 410) stale.add(subscription.endpoint);
          else this.#logger.event("warn", "push.delivery_failed", { ...(code === undefined ? {} : { status: code }) });
        }
      }),
    );
    if (stale.size > 0) {
      await this.#mutateSubscriptions(current => current.filter(subscription => !stale.has(subscription.endpoint)));
    }
  }

  async #mutateSubscriptions(
    mutate: (current: readonly StoredPushSubscription[]) => readonly StoredPushSubscription[],
  ): Promise<void> {
    const operation = this.#mutationTail.then(async () => {
      const next = mutate(this.#subscriptions);
      const state: PushState = { version: PUSH_STATE_VERSION, vapid: this.#vapid, subscriptions: next };
      await writePrivateTextFile(this.#path, `${JSON.stringify(state, null, 2)}\n`);
      this.#subscriptions = next;
    });
    this.#mutationTail = operation.catch(() => undefined);
    await operation;
  }
}
