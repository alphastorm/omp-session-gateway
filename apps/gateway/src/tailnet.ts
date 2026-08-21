import { networkInterfaces } from "node:os";

/**
 * What this host's interface table says about Tailscale.
 *
 * This module exists because the gateway's identity trust is topological, not cryptographic.
 * `tailscale-serve` mode accepts `Tailscale-User-Login` from any loopback peer, and that is only
 * sound because Tailscale Serve overwrites caller-supplied identity headers and nothing else can
 * reach a loopback listener. Tailscale offers the backend no secret, signature, or channel binding
 * that Serve alone could present, so there is nothing to verify per request: the only thing the
 * gateway can check is whether the deployment topology still makes Serve the sole path in.
 *
 * `tailscaled --tun=userspace-networking` breaks that topology. With no TUN device its netstack
 * terminates inbound tailnet connections in-process and dials `localhost` to reach local services,
 * so any tailnet peer reaches a listener bound strictly to `127.0.0.1` and arrives as a genuine
 * loopback peer carrying whatever identity header it chose. That is a remote authentication bypass,
 * demonstrated on 2026-08-21 and tracked as #98.
 *
 * The distinguishing signal is whether a real interface owns a tailnet address. It has to be read
 * this way round: probing our own tailnet address cannot tell the two apart, because in userspace
 * mode the host has no route to that address either, so the probe fails identically on a safe host
 * and an exposed one. Absence is therefore treated as unsafe rather than inconclusive — a detection
 * miss must not silently re-open the bypass.
 */

/** Tailscale's CGNAT allocation for tailnet IPv4 addresses: `100.64.0.0/10`. */
const TAILNET_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u;

/** Tailscale's tailnet ULA prefix, used for the IPv6 half of every node's address pair. */
const TAILNET_IPV6_PREFIX = "fd7a:115c:a1e0:";

export interface InterfaceAddress {
  readonly address: string;
}

export type InterfaceTable = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;

/**
 * True for an address inside Tailscale's own allocations. Deliberately decided from the address text
 * rather than the reported family, because `family` is `"IPv4"` in current Node and Bun but `4` in
 * older runtimes, and a security control must not depend on which of those it is handed.
 */
export function isTailnetAddress(address: string): boolean {
  if (TAILNET_IPV4.test(address)) return true;
  const zoneless = address.toLowerCase().split("%")[0] ?? "";
  return zoneless.startsWith(TAILNET_IPV6_PREFIX);
}

/** True when some local interface owns a tailnet address, i.e. tailscaled has a real TUN device. */
export function tailnetInterfacePresent(interfaces: InterfaceTable = networkInterfaces()): boolean {
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (isTailnetAddress(entry.address)) return true;
    }
  }
  return false;
}

/**
 * True when a specific address — this node's own tailnet address as reported by `tailscale status` —
 * is configured on a local interface. Stricter than {@link tailnetInterfacePresent} because it
 * proves the address belongs to us, and correspondingly dependent on the CLI having answered, so it
 * suits `doctor` rather than the request path.
 */
export function tailnetAddressIsLocallyBound(
  tailscaleIp: string | undefined,
  interfaces: InterfaceTable = networkInterfaces(),
): boolean {
  if (tailscaleIp === undefined) return false;
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.address === tailscaleIp) return true;
    }
  }
  return false;
}

/**
 * A cached view of {@link tailnetInterfacePresent} for the request path.
 *
 * The condition changes only when an operator restarts tailscaled, so re-reading the interface table
 * per request would be pure waste; caching it for a few seconds bounds both the syscall rate and how
 * long a stale answer can survive. The cache is per-probe rather than module-global so that tests
 * and callers own their own state instead of sharing hidden state across a process.
 */
export function createTailnetPresenceProbe(options: {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly present?: () => boolean;
} = {}): () => boolean {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? (() => performance.now());
  const present = options.present ?? (() => tailnetInterfacePresent());
  let cached: boolean | undefined;
  let observedAt = 0;
  return () => {
    const at = now();
    if (cached === undefined || at - observedAt >= ttlMs) {
      cached = present();
      observedAt = at;
    }
    return cached;
  };
}
