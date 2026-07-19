import type { GatewayConfig } from "./config.ts";

export interface RequestPeer {
  readonly address: string;
}

export type AuthorizationResult =
  | { readonly allowed: true; readonly identityKey: string }
  | { readonly allowed: false };

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function normalizeTailscaleLogin(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\0\r\n,]/u.test(normalized)) return undefined;
  return normalized;
}

export function authorizeHttpRequest(
  request: Request,
  peer: RequestPeer | undefined,
  config: GatewayConfig,
): AuthorizationResult {
  if (peer === undefined || !isLoopbackAddress(peer.address)) return { allowed: false };
  if (config.auth.mode === "dev-localhost") return { allowed: true, identityKey: "dev-localhost" };
  const header = request.headers.get("Tailscale-User-Login");
  if (header === null) return { allowed: false };
  const login = normalizeTailscaleLogin(header);
  if (login === undefined || !config.auth.allowedLogins.includes(login)) return { allowed: false };
  return { allowed: true, identityKey: login };
}

export function requestHasValidMutationContext(request: Request, expectedOrigin: string): boolean {
  if (request.headers.get("Origin") !== expectedOrigin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite === "same-origin";
}
