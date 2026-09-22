import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { installSilentWebSocket, relaySocketCount } from "./fixture-server.ts";

const code = "synthetic-enrollment-code-0000000000000001";
const sessionId = "synthetic-webauthn-session-0001";

test.use({ ignoreHTTPSErrors: true, trace: "off", video: "off", screenshot: "off" });

interface RealGateway {
  readonly origin: string;
  command(action: string, millis?: number): Promise<{ launchCount: number }>;
  stop(): Promise<void>;
}

async function startGateway(): Promise<RealGateway> {
  const child = spawn("bun", [fileURLToPath(new URL("./webauthn-gateway.ts", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_096); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, unknown>> => {
    const line = await lines.next();
    if (line.done) throw new Error("Real gateway fixture exited: " + stderr);
    return JSON.parse(line.value) as Record<string, unknown>;
  };
  const ready = await next();
  if (typeof ready.origin !== "string") throw new Error("Real gateway did not report its origin");
  let id = 0;
  return {
    origin: ready.origin,
    async command(action, millis) {
      child.stdin.write(JSON.stringify({ action, id: ++id, ...(millis === undefined ? {} : { millis }) }) + "\n");
      const reply = await next();
      if (reply.id !== id || typeof reply.launchCount !== "number") throw new Error("Fixture command failed");
      return { launchCount: reply.launchCount };
    },
    async stop() {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.stdin.end(JSON.stringify({ action: "stop" }) + "\n");
      await exited;
    },
  };
}

async function authenticator(context: BrowserContext, page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  return { cdp, authenticatorId };
}

async function enroll(page: Page, fixture: RealGateway): Promise<void> {
  await page.goto(fixture.origin);
  await expect(page.getByRole("button", { name: "Sign in with a passkey", exact: true })).toBeVisible();
  // Exercise native browser conversions, not a handwritten codec or mocked crypto endpoint.
  expect(await page.evaluate(() => [
    typeof PublicKeyCredential.parseCreationOptionsFromJSON,
    typeof PublicKeyCredential.parseRequestOptionsFromJSON,
    typeof PublicKeyCredential.prototype.toJSON,
  ])).toEqual(["function", "function", "function"]);
  await page.getByText("Enroll with a local code", { exact: true }).click();
  await page.getByLabel("Enrollment code", { exact: true }).fill(code);
  await page.getByLabel("Passkey label", { exact: true }).fill("Synthetic phone");
  await page.getByRole("button", { name: "Enroll passkey", exact: true }).click();
  await expect(page.locator("#auth-message")).toContainText("Start the gateway daemon");
  await expect(page.locator("#enrollment-code")).toHaveValue("");
  await fixture.command("restart");
}

async function signIn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
  await expect(page.locator("#sign-in")).toBeHidden();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}

async function jsonPost(page: Page, path: string, body: unknown): Promise<number> {
  return page.evaluate(async ({ path, body }) => (await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    cache: "no-store", credentials: "same-origin",
  })).status, { path, body });
}

async function restore(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
}

async function suspend(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
}

async function openView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "View Synthetic passkey session", exact: true }).click();
  await expect(page.locator("#root > .sh-app")).toHaveCount(1);
}

test("real enrollment and login use HttpOnly cookies; replay and cross-origin requests fail", async ({ context, page }) => {
  const fixture = await startGateway();
  try {
    await authenticator(context, page);
    const authRequests: string[] = [];
    let loginProof: unknown;
    page.on("request", request => {
      if (request.url().includes("/api/v1/auth/")) authRequests.push(new URL(request.url()).pathname);
      if (request.url().endsWith("/api/v1/auth/login/verify")) loginProof = request.postDataJSON();
    });
    await page.goto(fixture.origin);
    await expect(page.locator("#sign-in")).toBeVisible();
    expect(authRequests).toEqual([]); // No conditional/automatic authentication.
    await page.getByText("Enroll with a local code", { exact: true }).click();
    await page.getByLabel("Enrollment code", { exact: true }).fill("wrong-local-code-0000000");
    await page.getByLabel("Passkey label", { exact: true }).fill("Synthetic phone");
    await page.getByRole("button", { name: "Enroll passkey", exact: true }).click();
    await expect(page.locator("#auth-message")).toContainText("Enrollment was not completed");
    await enroll(page, fixture);
    const verified = page.waitForResponse(response => response.url().endsWith("/api/v1/auth/login/verify"));
    await signIn(page);
    const loginResponse = await verified;
    expect(loginResponse.headers()["cache-control"]).toContain("no-store");
    const loginResult = await loginResponse.json();
    expect(Object.keys(loginResult).sort()).toEqual(["authenticated", "expiresAt"]);
    expect(loginResult.authenticated).toBe(true);
    expect(loginResult.expiresAt - Date.now()).toBeGreaterThan(3_500_000);
    expect(loginResult.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
    const sessionCookie = (await context.cookies()).find(cookie => cookie.name === "__Host-omp-session");
    expect(sessionCookie).toMatchObject({ httpOnly: true, secure: true, path: "/", sameSite: "Strict", expires: -1 });
    const browserState = await page.evaluate(() => JSON.stringify({
      href: location.href, history: history.state, local: { ...localStorage },
      session: { ...sessionStorage }, dom: document.documentElement.outerHTML,
    }));
    expect(sessionCookie).toBeDefined();
    expect(browserState.includes(sessionCookie!.value)).toBe(false);
    expect((await context.cookies()).some(cookie => cookie.name === "__Host-omp-auth")).toBe(false);
    expect(await page.evaluate(() => document.cookie)).not.toContain("__Host-omp");
    expect(await jsonPost(page, "/api/v1/auth/login/verify", loginProof)).toBe(400);
    // An old real signature also fails against a fresh challenge.
    expect(await jsonPost(page, "/api/v1/auth/login/options", {})).toBe(200);
    expect(await jsonPost(page, "/api/v1/auth/login/verify", loginProof)).toBe(400);
    expect(await jsonPost(page, "/api/v1/auth/enroll/options", { code, label: "Again" })).toBe(400);
    const crossOrigin = await context.request.post(fixture.origin + "/api/v1/auth/login/options", {
      headers: { Origin: "https://other.example", "Sec-Fetch-Site": "cross-site" }, data: {},
    });
    expect(crossOrigin.status()).toBe(403);
    // A reload with a still-valid cookie needs no ceremony and retains a reachable sign-out.
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  } finally { await fixture.stop(); }
});

test("expired bfcache resume authenticates first and reacquires only the same generation", async ({ context, page }) => {
  const fixture = await startGateway();
  try {
    await authenticator(context, page);
    await installSilentWebSocket(page);
    await enroll(page, fixture);
    await signIn(page);
    await openView(page);
    const firstSockets = await relaySocketCount(page);
    await suspend(page);
    await fixture.command("advance", 3_600_001);
    await restore(page);
    await expect(page.locator("#sign-in")).toBeVisible();
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    expect((await fixture.command("stats")).launchCount).toBe(1);
    expect(await jsonPost(page, `/api/v1/sessions/${sessionId}/launch`, { mode: "view", generation: 1 })).toBe(401);
    await signIn(page);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    expect((await fixture.command("stats")).launchCount).toBe(2);
    expect(await relaySocketCount(page)).toBeGreaterThan(firstSockets);
    await suspend(page);
    await fixture.command("advance", 3_600_001);
    await fixture.command("generation");
    await restore(page);
    await expect(page.locator("#sign-in")).toBeVisible();
    await signIn(page);
    await expect(page).toHaveURL(fixture.origin + "/");
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    expect((await fixture.command("stats")).launchCount).toBe(2);
  } finally { await fixture.stop(); }
});

test("expiry through SSE and daemon restart deny access until explicit login", async ({ context, page }) => {
  const fixture = await startGateway();
  try {
    await authenticator(context, page);
    await enroll(page, fixture);
    await signIn(page);
    await fixture.command("advance", 1_800_000);
    expect(await page.evaluate(async () => (await fetch("/api/v1/sessions", { cache: "no-store" })).status)).toBe(200);
    await fixture.command("advance", 1_800_001);
    await fixture.command("publish");
    await expect(page.locator("#sign-in")).toBeVisible({ timeout: 10_000 });
    await signIn(page);
    await fixture.command("restart");
    await page.reload();
    await expect(page.locator("#sign-in")).toBeVisible();
    await expect(page.locator(".working-row")).toHaveCount(0);
    await signIn(page);
    await expect(page.getByRole("button", { name: "View Synthetic passkey session", exact: true })).toBeVisible();
  } finally { await fixture.stop(); }
});

test("browser RP scoping and real verifier reject invalid signatures and missing UV", async ({ context, page }) => {
  const fixture = await startGateway();
  try {
    const { cdp, authenticatorId } = await authenticator(context, page);
    await enroll(page, fixture);
    const rpError = await page.evaluate(async () => {
      const response = await fetch("/api/v1/auth/login/options", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const { options } = await response.json();
      try {
        await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON({
          ...options, rpId: "other.example",
        }) });
        return "accepted";
      } catch (error) { return error instanceof DOMException ? error.name : "unexpected"; }
    });
    expect(rpError).toBe("SecurityError");
    for (const override of [{ isBogusSignature: true, isBadUV: false }, { isBogusSignature: false, isBadUV: true }]) {
      await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId, ...override });
      const verification = page.waitForResponse(response => response.url().endsWith("/api/v1/auth/login/verify"));
      await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
      expect((await verification).status()).toBe(400);
      await expect(page.locator("#auth-message")).toContainText("Sign-in was not completed");
      expect((await context.cookies()).some(cookie => cookie.name === "__Host-omp-session")).toBe(false);
    }
    await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId, isBogusSignature: false, isBadUV: false });
    await signIn(page);
  } finally { await fixture.stop(); }
});

test("a capability response already in flight cannot mount after logout", async ({ context, page }) => {
  const fixture = await startGateway();
  const held = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  try {
    await authenticator(context, page);
    await installSilentWebSocket(page);
    await enroll(page, fixture);
    await signIn(page);
    await page.route("**/launch", async route => {
      const response = await route.fetch();
      arrived.resolve();
      await held.promise;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "View Synthetic passkey session", exact: true }).click();
    await arrived.promise;
    const logout = page.waitForResponse(response => response.url().endsWith("/api/v1/auth/logout"));
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await logout).status()).toBe(204);
    const launchResponse = page.waitForResponse(response => response.url().endsWith("/launch"));
    held.resolve();
    await launchResponse;
    await expect(page.locator("#sign-in")).toBeVisible();
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    expect(await relaySocketCount(page)).toBe(0);
    await signIn(page);
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
  } finally { held.resolve(); await fixture.stop(); }
});

test("notification routes authenticate before resolving the pending current request", async ({ context, page }) => {
  const fixture = await startGateway();
  try {
    await authenticator(context, page);
    await installSilentWebSocket(page);
    await enroll(page, fixture);
    await signIn(page);
    await fixture.command("ask");
    const requestId = await page.evaluate(async () => {
      const response = await fetch("/api/v1/sessions", { cache: "no-store" });
      return (await response.json()).sessions[0].ask.requestId as string;
    });
    const logout = page.waitForResponse(response => response.url().endsWith("/api/v1/auth/logout"));
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout;
    await page.goto(fixture.origin + "/collab/" + sessionId + "?request=" + requestId);
    await expect(page.locator("#sign-in")).toBeVisible();
    expect((await fixture.command("stats")).launchCount).toBe(0);
    await signIn(page);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    expect((await fixture.command("stats")).launchCount).toBe(1);
  } finally { await fixture.stop(); }
});

test("shell logout disposes other tabs, clears resume intent, and leaks no capability to browser sinks", async ({ context, page }) => {
  const fixture = await startGateway();
  const other = await context.newPage();
  const requestUrls: string[] = [];
  const logs: string[] = [];
  let capability = "";
  try {
    await authenticator(context, page);
    await installSilentWebSocket(page);
    await installSilentWebSocket(other);
    page.on("request", request => requestUrls.push(request.url()));
    page.on("console", entry => logs.push(entry.text()));
    page.on("response", async response => {
      if (response.url().endsWith("/launch") && response.status() === 200) capability = (await response.json()).capability;
    });
    await enroll(page, fixture);
    await signIn(page);
    await other.goto(fixture.origin);
    await expect(other.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await openView(page);
    await openView(other);
    await expect.poll(() => capability.length).toBeGreaterThan(0);
    const sinks = await page.evaluate(async () => ({
      href: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage },
      dom: document.documentElement.outerHTML,
      caches: await Promise.all((await caches.keys()).map(async name => {
        const cache = await caches.open(name);
        return Promise.all((await cache.keys()).map(async request => ({ url: request.url, text: await (await cache.match(request))?.text() })));
      })),
    }));
    expect(JSON.stringify(sinks)).not.toContain(capability);
    expect(requestUrls.join("\n")).not.toContain(capability);
    expect(logs.join("\n")).not.toContain(capability);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("#auth-message")).toContainText("Signed out");
    await expect(other.locator("#sign-in")).toBeVisible();
    await expect(other.locator(".gateway-shell")).toHaveCount(0);
    expect((await context.cookies()).some(cookie => cookie.name === "__Host-omp-session")).toBe(false);
    expect(await jsonPost(page, `/api/v1/sessions/${sessionId}/launch`, { mode: "view", generation: 1 })).toBe(401);
    await signIn(page);
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    await restore(page);
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    expect((await fixture.command("stats")).launchCount).toBe(2);
  } finally { await other.close(); await fixture.stop(); }
});
