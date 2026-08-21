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
 * The signal has to be read as "is Tailscale's tunnel device here", and absence has to be treated as
 * unsafe rather than inconclusive. Probing our own tailnet address cannot tell the two topologies
 * apart, because in userspace mode the host has no route to that address either, so the probe fails
 * identically on a safe host and an exposed one. Detecting whether tailscaled is running is worse:
 * its socket path is platform-specific and overridable, so a detection miss would fail open.
 */

/**
 * Tailscale's tailnet ULA prefix. Unlike the IPv4 range this is Tailscale's own allocation, so an
 * interface carrying an address inside it is decisive on its own.
 */
const TAILNET_IPV6_PREFIX = "fd7a:115c:a1e0:";

/**
 * `100.64.0.0/10` is **not** Tailscale's to own. RFC 6598 assigns it as shared address space, and
 * carriers, mobile hotspots and container networks allocate out of it routinely, so a CGNAT address
 * proves nothing by itself. Treating it as proof of a TUN device restored the whole of #98 on any
 * userspace-mode host whose ordinary interface happened to hold one — a container with a CGNAT pod
 * CIDR being the obvious case, and containers being exactly where userspace networking is used.
 *
 * What distinguishes Tailscale's own IPv4 address is its shape and its owner: a host route rather
 * than a subnet lease, on the tunnel device. Measured 2026-08-21 on macOS 26.6.1 (`utun0` carrying
 * `100.x.x.x` at `255.255.255.255` plus the ULA at `/128`) and under Linux libuv (`tailscale0`, the
 * same two netmask shapes).
 */
const TAILNET_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u;
const IPV4_HOST_ROUTE_NETMASK = "255.255.255.255";

/**
 * Names Tailscale's tunnel device takes: `tailscale0` on Linux, `utun<n>` on macOS, `Tailscale` on
 * Windows. `--tun` can override the Linux name, which is why this is only ever the weaker of the two
 * accepted signals and never the only one.
 */
const TAILSCALE_INTERFACE = /^(?:tailscale|utun|ts)\d*$/iu;

export interface InterfaceAddress {
  readonly address: string;
  readonly netmask?: string;
}

export type InterfaceTable = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;

/**
 * True when some interface looks like Tailscale's tunnel device, rather than merely like a machine
 * that happens to sit on shared address space.
 *
 * Accepts either an address in Tailscale's own IPv6 allocation, or a CGNAT IPv4 host route on an
 * interface named like a tunnel device. An IPv6-disabled host whose device is renamed by `--tun`
 * therefore fails closed and visibly, which is the safe direction for the error.
 */
export function tailscaleTunDevicePresent(interfaces: InterfaceTable = networkInterfaces()): boolean {
  for (const [name, addresses] of Object.entries(interfaces)) {
    const tunnel = TAILSCALE_INTERFACE.test(name);
    for (const entry of addresses ?? []) {
      if ((entry.address.toLowerCase().split("%")[0] ?? "").startsWith(TAILNET_IPV6_PREFIX)) return true;
      if (tunnel && entry.netmask === IPV4_HOST_ROUTE_NETMASK && TAILNET_IPV4.test(entry.address)) return true;
    }
  }
  return false;
}

/**
 * True when a specific address — this node's own tailnet address as reported by `tailscale status` —
 * is configured on a local interface. Narrower than {@link tailscaleTunDevicePresent} in one way,
 * because it proves the address belongs to us, and correspondingly dependent on the CLI having
 * answered, so it suits `doctor` rather than the request path.
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
 * A cached view of {@link tailscaleTunDevicePresent} for the request path.
 *
 * The condition changes only when an operator restarts tailscaled, so re-reading the interface table
 * per request would be pure waste; caching it for a few seconds bounds both the syscall rate and how
 * long a stale answer can survive. The cache is per-probe rather than module-global so that tests and
 * callers own their own state instead of sharing hidden state across a process.
 */
export function createTailnetPresenceProbe(options: {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly present?: () => boolean;
} = {}): () => boolean {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? (() => performance.now());
  const present = options.present ?? (() => tailscaleTunDevicePresent());
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
