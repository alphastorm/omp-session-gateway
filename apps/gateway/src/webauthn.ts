import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { assertPrivateDirectory, ensureRuntimeDirectories, readPrivateTextFile, writePrivateTextFile, type GatewayConfig } from "./config.ts";

const SESSION_COOKIE = "__Host-omp-session";
const AUTH_COOKIE = "__Host-omp-auth";
const SESSION_MS = 60 * 60_000;
const CEREMONY_MS = 2 * 60_000;
const ENROLLMENT_MS = 5 * 60_000;
const MAX_CREDENTIALS = 16;
const MAX_SESSIONS = 256;
const MAX_CEREMONIES = 128;
const MAX_STATE_BYTES = 128 * 1_024;
const ALGORITHMS = [-7, -257];

interface Credential {
  readonly id: string;
  readonly label: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
}
interface CredentialState {
  readonly version: 1;
  readonly origin: string;
  readonly userId: string;
  readonly credentials: readonly Credential[];
}
interface Ceremony {
  readonly kind: "login" | "enroll";
  readonly challenge: string;
  readonly expiresAt: number;
  readonly label?: string;
  readonly previousSession?: string;
  consumed: boolean;
}
interface Session {
  readonly identityKey: string;
  readonly expiresAt: number;
  readonly listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout>;
}

/** Only a live authority handle crosses into HTTP; cookie values never leave this module. */
export interface WebAuthnSession {
  readonly identityKey: string;
  readonly expiresAt: number;
  isActive(): boolean;
  onInvalidated(listener: () => void): () => void;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid authentication data");
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error("invalid authentication data");
  }
  return record;
}

function base64url(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) {
    throw new Error("invalid authentication data");
  }
  return value;
}

function credentialLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 80 || /[\p{C}]/u.test(value)) {
    throw new Error("invalid credential label");
  }
  return value;
}

function parseState(value: unknown, origin: string): CredentialState {
  const record = exactRecord(value, ["version", "origin", "userId", "credentials"]);
  if (record.version !== 1 || typeof record.origin !== "string" || !Array.isArray(record.credentials) || record.credentials.length > MAX_CREDENTIALS) {
    throw new Error("invalid credential state");
  }
  const storedOrigin = new URL(record.origin);
  // Revoking every credential permits explicit local re-enrollment at a new origin.
  // A nonempty allowlist never migrates, and an empty one cannot start a normal daemon.
  if (storedOrigin.protocol !== "https:" || storedOrigin.origin !== record.origin || (record.origin !== origin && record.credentials.length !== 0)) {
    throw new Error("invalid credential state");
  }
  const userId = base64url(record.userId, 43, 43);
  const credentials = record.credentials.map(value => {
    const item = exactRecord(value, ["id", "label", "credentialId", "publicKey", "counter"]);
    const publicKey = base64url(item.publicKey, 16, 4_096);
    const decoded = decodeCredentialPublicKey(Buffer.from(publicKey, "base64url"));
    if (!ALGORITHMS.includes(decoded.get(3) as number) || !Number.isSafeInteger(item.counter) || (item.counter as number) < 0 || (item.counter as number) > 0xffff_ffff) {
      throw new Error("invalid credential state");
    }
    return { id: base64url(item.id, 22, 22), label: credentialLabel(item.label), credentialId: base64url(item.credentialId, 1, 1_366), publicKey, counter: item.counter as number };
  });
  if (new Set(credentials.map(item => item.id)).size !== credentials.length || new Set(credentials.map(item => item.credentialId)).size !== credentials.length) {
    throw new Error("invalid credential state");
  }
  return { version: 1, origin, userId, credentials };
}

async function loadState(config: GatewayConfig): Promise<CredentialState | undefined> {
  try {
    await assertPrivateDirectory(config.paths.stateDir, false);
    const raw = await readPrivateTextFile(join(config.paths.stateDir, "webauthn-credentials.json"), MAX_STATE_BYTES);
    return raw === undefined ? undefined : parseState(JSON.parse(raw), config.http.publicOrigin);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("WebAuthn credential state is invalid or unsafe");
  }
}

/** The caller holds the ordinary gateway listener, excluding stopped-daemon maintenance. */
async function saveState(config: GatewayConfig, state: CredentialState, beforeCommit?: () => void): Promise<void> {
  await ensureRuntimeDirectories(config);
  const path = join(config.paths.stateDir, "webauthn-credentials.json");
  await readPrivateTextFile(path, MAX_STATE_BYTES);
  await writePrivateTextFile(path, `${JSON.stringify(state)}\n`, beforeCommit);
}

export async function listWebAuthnCredentials(config: GatewayConfig): Promise<readonly { id: string; label: string }[]> {
  const state = await loadState(config);
  if (state === undefined) return [];
  return state.credentials.map(({ id, label }) => ({ id, label }));
}

export async function revokeWebAuthnCredential(config: GatewayConfig, id: string): Promise<void> {
  base64url(id, 22, 22);
  const state = await loadState(config);
  // Deletion is idempotent so offline maintenance can retry a subsequent push-state failure.
  if (state === undefined || !state.credentials.some(item => item.id === id)) return;
  await saveState(config, { ...state, credentials: state.credentials.filter(item => item.id !== id) });
}

function cookieDigest(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("Cookie");
  if (cookies === null || cookies.length > 8_192) return undefined;
  let value: string | undefined;
  for (const field of cookies.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0 || field.slice(0, separator).trim() !== name) continue;
    if (value !== undefined) return undefined;
    value = field.slice(separator + 1).trim();
  }
  if (value === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
  return createHash("sha256").update(value).digest("hex");
}

function cookie(name: string, value: string): string {
  // Live cookies have no persistent lifetime or Domain; only deletion has Max-Age.
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${value === "" ? "; Max-Age=0" : ""}`;
}

function rejectEmbedding(response: unknown): void {
  const value = response as { response?: { clientDataJSON?: unknown } };
  const encoded = base64url(value?.response?.clientDataJSON, 1, 16_384);
  const data = decodeClientDataJSON(encoded);
  if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || Object.hasOwn(data, "topOrigin")) {
    throw new Error("embedded authentication refused");
  }
}

export class WebAuthnService {
  readonly #config: GatewayConfig;
  readonly #rpID: string;
  readonly #now: () => number;
  readonly #onEnrolled: (() => void) | undefined;
  #state: CredentialState;
  #grant: { digest: Buffer; expiresAt: number } | undefined;
  readonly #ceremonies = new Map<string, Ceremony>();
  readonly #sessions = new Map<string, Session>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #optionsWindow = 0;
  #optionsCount = 0;

  private constructor(options: { config: GatewayConfig; enrollmentCode?: string; onEnrolled?: () => void; now?: () => number }, state: CredentialState) {
    this.#config = options.config;
    this.#rpID = new URL(options.config.http.publicOrigin).hostname;
    this.#now = options.now ?? Date.now;
    this.#onEnrolled = options.onEnrolled;
    this.#state = state;
    if (options.enrollmentCode !== undefined) {
      this.#grant = { digest: createHash("sha256").update(options.enrollmentCode).digest(), expiresAt: this.#now() + ENROLLMENT_MS };
    }
  }

  static async open(options: { config: GatewayConfig; enrollmentCode?: string; onEnrolled?: () => void; now?: () => number }): Promise<WebAuthnService> {
    const origin = new URL(options.config.http.publicOrigin);
    if (options.config.auth.mode !== "webauthn" || origin.protocol !== "https:" || origin.origin !== options.config.http.publicOrigin || options.config.auth.allowedLogins.length !== 0 || options.config.auth.trustIdentityWithoutTailnetDevice === true) {
      throw new Error("WebAuthn requires an exact HTTPS origin and no header identity trust");
    }
    if (options.enrollmentCode !== undefined && (options.enrollmentCode.length < 16 || options.enrollmentCode.length > 256)) throw new Error("invalid enrollment grant");
    await ensureRuntimeDirectories(options.config);
    const loaded = await loadState(options.config);
    if ((loaded === undefined || loaded.credentials.length === 0) && options.enrollmentCode === undefined) throw new Error("WebAuthn credentials are not enrolled");
    const state = loaded ?? { version: 1, origin: origin.origin, userId: randomBytes(32).toString("base64url"), credentials: [] };
    return new WebAuthnService(options, state);
  }

  identityAllowed(identityKey: string): boolean {
    return !this.#closed && this.#state.credentials.some(item => `webauthn:${item.id}` === identityKey);
  }

  session(request: Request): WebAuthnSession | undefined {
    const digest = cookieDigest(request, SESSION_COOKIE);
    if (digest === undefined) return undefined;
    const entry = this.#sessions.get(digest);
    if (entry === undefined || !this.#sessionActive(digest, entry)) return undefined;
    return {
      identityKey: entry.identityKey,
      expiresAt: entry.expiresAt,
      isActive: () => this.#sessionActive(digest, entry),
      onInvalidated: listener => {
        if (!this.#sessionActive(digest, entry)) { listener(); return () => {}; }
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
      },
    };
  }

  #sessionActive(digest: string, entry: Session): boolean {
    if (this.#sessions.get(digest) !== entry) return false;
    if (entry.expiresAt <= this.#now() || !this.identityAllowed(entry.identityKey)) {
      this.#invalidate(digest);
      return false;
    }
    return true;
  }

  #invalidate(digest: string): void {
    const entry = this.#sessions.get(digest);
    if (entry === undefined) return;
    this.#sessions.delete(digest);
    clearTimeout(entry.timer);
    for (const [key, ceremony] of this.#ceremonies) {
      if (ceremony.previousSession === digest) this.#ceremonies.delete(key);
    }
    for (const listener of entry.listeners) listener();
    entry.listeners.clear();
  }

  #prune(): void {
    for (const [digest, entry] of this.#sessions) this.#sessionActive(digest, entry);
    for (const [digest, entry] of this.#ceremonies) {
      if (entry.expiresAt <= this.#now()) this.#ceremonies.delete(digest);
    }
  }

  async options(request: Request, kind: "login" | "enroll", body: unknown): Promise<Response> {
    this.#prune();
    if (this.#closed) throw new Error("authentication unavailable");
    const now = this.#now();
    if (this.#optionsWindow <= now) { this.#optionsWindow = now + 60_000; this.#optionsCount = 0; }
    if (++this.#optionsCount > 20 || this.#ceremonies.size >= MAX_CEREMONIES) throw new Error("authentication busy");
    let label: string | undefined;
    if (kind === "enroll") {
      const input = exactRecord(body, ["code", "label"]);
      label = credentialLabel(input.label);
      if (typeof input.code !== "string" || input.code.length > 256 || this.#grant === undefined || this.#grant.expiresAt <= now || !timingSafeEqual(createHash("sha256").update(input.code).digest(), this.#grant.digest) || this.#state.credentials.length >= MAX_CREDENTIALS) {
        throw new Error("enrollment unavailable");
      }
    } else {
      exactRecord(body, []);
      if (this.#state.credentials.length === 0) throw new Error("authentication unavailable");
    }
    const options = kind === "login"
      ? await generateAuthenticationOptions({ rpID: this.#rpID, userVerification: "required", timeout: CEREMONY_MS })
      : await generateRegistrationOptions({
          rpName: "OMP Sessions",
          rpID: this.#rpID,
          userName: "owner",
          userDisplayName: "Owner",
          userID: Buffer.from(this.#state.userId, "base64url"),
          attestationType: "none",
          supportedAlgorithmIDs: ALGORITHMS,
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          extensions: { credProps: true },
          timeout: CEREMONY_MS,
          excludeCredentials: this.#state.credentials.map(item => ({ id: item.credentialId })),
        });
    if (this.#closed || this.#ceremonies.size >= MAX_CEREMONIES || (kind === "enroll" && (this.#grant === undefined || this.#grant.expiresAt <= this.#now()))) throw new Error("authentication unavailable");
    const previous = cookieDigest(request, AUTH_COOKIE);
    if (previous !== undefined) this.#ceremonies.delete(previous);
    const token = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(token).digest("hex");
    const previousSession = cookieDigest(request, SESSION_COOKIE);
    this.#ceremonies.set(digest, { kind, challenge: options.challenge, expiresAt: now + CEREMONY_MS, consumed: false, ...(label === undefined ? {} : { label }), ...(previousSession !== undefined && this.#sessions.has(previousSession) ? { previousSession } : {}) });
    return Response.json({ options }, { headers: { "Set-Cookie": cookie(AUTH_COOKIE, token) } });
  }

  async verify(request: Request, kind: "login" | "enroll", body: unknown): Promise<Response> {
    const digest = cookieDigest(request, AUTH_COOKIE);
    const ceremony = digest === undefined ? undefined : this.#ceremonies.get(digest);
    if (digest === undefined || ceremony === undefined || ceremony.consumed || ceremony.kind !== kind) throw new Error("authentication rejected");
    // Consume before the first await: two requests must never verify the same challenge.
    ceremony.consumed = true;
    const run = this.#queue.then(async () => {
      this.#assertCeremony(digest, ceremony);
      const input = exactRecord(body, ["response"]);
      rejectEmbedding(input.response);
      if (kind === "enroll") {
        const response = input.response as RegistrationResponseJSON;
        const result = await verifyRegistrationResponse({
          response,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: this.#config.http.publicOrigin,
          expectedRPID: this.#rpID,
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS,
        });
        this.#assertCeremony(digest, ceremony);
        const info = result.registrationInfo;
        if (
          !result.verified || info === undefined || info.fmt !== "none" ||
          response.clientExtensionResults?.credProps?.rk !== true || info.credential.id !== response.id ||
          this.#state.credentials.length >= MAX_CREDENTIALS ||
          this.#state.credentials.some(item => item.credentialId === info.credential.id)
        ) throw new Error("registration rejected");
        const credential: Credential = {
          id: randomBytes(16).toString("base64url"),
          label: ceremony.label!,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
          counter: info.credential.counter,
        };
        const state = { ...this.#state, credentials: [...this.#state.credentials, credential] };
        await saveState(this.#config, state, () => {
          // Admission is the linearization point: staging may expire the grant, but an
          // admitted atomic rename must finish without later reporting a false refusal.
          this.#assertCeremony(digest, ceremony);
          this.#grant = undefined;
        });
        this.#state = state;
        // The foreground CLI owns delayed shutdown, so the successful response can flush first.
        this.#onEnrolled?.();
        return Response.json({ enrolled: true }, { headers: { "Set-Cookie": cookie(AUTH_COOKIE, "") } });
      }
      const response = input.response as AuthenticationResponseJSON;
      const credential = this.#state.credentials.find(item => item.credentialId === response.id);
      if (credential === undefined || response.response?.userHandle !== this.#state.userId) throw new Error("authentication rejected");
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.#config.http.publicOrigin,
        expectedRPID: this.#rpID,
        requireUserVerification: true,
        credential: { id: credential.credentialId, publicKey: Buffer.from(credential.publicKey, "base64url"), counter: credential.counter },
      });
      this.#assertCeremony(digest, ceremony);
      if (!result.verified || !this.#state.credentials.includes(credential)) throw new Error("authentication rejected");
      if (result.authenticationInfo.newCounter !== credential.counter) {
        const state = { ...this.#state, credentials: this.#state.credentials.map(item => item === credential ? { ...item, counter: result.authenticationInfo.newCounter } : item) };
        await saveState(this.#config, state, () => this.#assertCeremony(digest, ceremony));
        this.#state = state;
      }
      this.#assertCeremony(digest, ceremony);
      this.#prune();
      if (this.#sessions.size >= MAX_SESSIONS) throw new Error("authentication busy");
      if (ceremony.previousSession !== undefined) this.#invalidate(ceremony.previousSession);
      const token = randomBytes(32).toString("base64url");
      const sessionDigest = createHash("sha256").update(token).digest("hex");
      const expiresAt = this.#now() + SESSION_MS;
      const timer = setTimeout(() => this.#invalidate(sessionDigest), SESSION_MS);
      timer.unref();
      this.#sessions.set(sessionDigest, { identityKey: `webauthn:${credential.id}`, expiresAt, listeners: new Set(), timer });
      const headers = new Headers();
      headers.append("Set-Cookie", cookie(SESSION_COOKIE, token));
      headers.append("Set-Cookie", cookie(AUTH_COOKIE, ""));
      return Response.json({ authenticated: true, expiresAt }, { headers });
    });
    this.#queue = run.catch(() => undefined);
    try { return await run; } finally { this.#ceremonies.delete(digest); }
  }

  #assertCeremony(digest: string, ceremony: Ceremony): void {
    if (this.#closed || this.#ceremonies.get(digest) !== ceremony || ceremony.expiresAt <= this.#now() || (ceremony.kind === "enroll" && (this.#grant === undefined || this.#grant.expiresAt <= this.#now()))) throw new Error("authentication expired");
    if (ceremony.previousSession !== undefined) {
      const session = this.#sessions.get(ceremony.previousSession);
      if (session === undefined || !this.#sessionActive(ceremony.previousSession, session)) throw new Error("authentication revoked");
    }
  }

  logout(request: Request): Response {
    const digest = cookieDigest(request, SESSION_COOKIE);
    if (digest !== undefined) this.#invalidate(digest);
    const preauth = cookieDigest(request, AUTH_COOKIE);
    if (preauth !== undefined) this.#ceremonies.delete(preauth);
    const headers = new Headers();
    headers.append("Set-Cookie", cookie(SESSION_COOKIE, ""));
    headers.append("Set-Cookie", cookie(AUTH_COOKIE, ""));
    return new Response(null, { status: 204, headers });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#grant = undefined;
    this.#ceremonies.clear();
    for (const digest of this.#sessions.keys()) this.#invalidate(digest);
    await this.#queue;
  }
}
