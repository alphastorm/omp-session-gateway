import { loopbackHttpOrigin, type GatewayConfig } from "./config.ts";

export interface RequestPeer {
  readonly address: string;
}

export type AuthorizationResult =
  | { readonly allowed: true; readonly identityKey: string }
  | { readonly allowed: false; readonly reason: "unauthorized" | "identity_untrustworthy" };

export function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const unbracketed = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  const normalized = unbracketed.split("%")[0] ?? "";
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}


export function normalizeTailscaleLogin(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\0\r\n,]/u.test(normalized)) return undefined;
  return normalized;
}

/**
 * @param serveOwnsIdentityHeaders whether Tailscale Serve is still the only way a request can reach
 * this loopback listener. False means tailscaled has no TUN device, so its netstack forwards inbound
 * tailnet connections to localhost and any tailnet peer can present a forged identity as a loopback
 * peer (#98). Callers pass a measured value; there is no default, because a caller that forgot this
 * argument would be reintroducing the bypass.
 */
export function authorizeHttpRequest(
  request: Request,
  peer: RequestPeer | undefined,
  config: GatewayConfig,
  serveOwnsIdentityHeaders: boolean,
): AuthorizationResult {
  if (peer === undefined || !isLoopbackAddress(peer.address)) return { allowed: false, reason: "unauthorized" };
  if (config.auth.mode === "dev-localhost") {
    try {
      const origin = new URL(request.url).origin;
      return origin === config.http.publicOrigin && origin === loopbackHttpOrigin(config.http.hostname, config.http.port)
        ? { allowed: true, identityKey: "dev-localhost" }
        : { allowed: false, reason: "unauthorized" };
    } catch {
      return { allowed: false, reason: "unauthorized" };
    }
  }
  // Identity here is asserted only by Serve, which overwrites whatever the caller sent. That
  // guarantee is a property of the topology rather than of the request, so it is checked before the
  // header is read at all. Refusing costs nothing when the signal is absent: without a tailnet
  // interface, Serve cannot be routing tailnet requests to this process in the first place.
  if (!serveOwnsIdentityHeaders) return { allowed: false, reason: "identity_untrustworthy" };
  const header = request.headers.get("Tailscale-User-Login");
  if (header === null) return { allowed: false, reason: "unauthorized" };
  const login = normalizeTailscaleLogin(header);
  if (login === undefined || !config.auth.allowedLogins.includes(login)) {
    return { allowed: false, reason: "unauthorized" };
  }
  return { allowed: true, identityKey: login };
}

export function requestHasValidMutationContext(request: Request, expectedOrigin: string): boolean {
  if (request.headers.get("Origin") !== expectedOrigin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite === "same-origin";
}
