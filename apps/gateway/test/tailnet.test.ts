import { describe, expect, test } from "bun:test";
import {
  createTailnetPresenceProbe,
  tailnetAddressIsLocallyBound,
  tailscaleTunDevicePresent,
  type InterfaceTable,
} from "../src/tailnet.ts";

/**
 * These read an injected interface table rather than the host's own. Asserting against
 * `networkInterfaces()` made the outcome agree with whatever machine ran the test: on a workstation
 * with Tailscale in TUN mode the unsafe topology could not be expressed at all, which is the one case
 * that matters. See #98.
 *
 * The shapes below are measured, not invented. macOS 26.6.1 on 2026-08-21 reported `utun0` carrying a
 * CGNAT address at netmask `255.255.255.255` plus the tailnet ULA at `/128`; Linux under libuv
 * reported `tailscale0` with the same two shapes.
 */
const userspaceMode: InterfaceTable = {
  lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0" }, { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" }],
  en0: [{ address: "192.168.1.24", netmask: "255.255.255.0" }, { address: "fe80::1c9a:e0ff:fe32:1", netmask: "ffff:ffff:ffff:ffff::" }],
};

const tunMode: InterfaceTable = {
  ...userspaceMode,
  utun0: [
    { address: "100.100.100.100", netmask: "255.255.255.255" },
    { address: "fd7a:115c:a1e0::1a2b:3c4d", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  ],
};

describe("tailscale tunnel device detection", () => {
  test("a tunnel device carrying Tailscale's own address shapes is a TUN device", () => {
    expect(tailscaleTunDevicePresent(tunMode)).toBe(true);
    expect(tailscaleTunDevicePresent({ tailscale0: tunMode.utun0 })).toBe(true);
    expect(tailscaleTunDevicePresent({ Tailscale: tunMode.utun0 })).toBe(true);
  });

  test("nothing Tailscale-shaped anywhere is userspace mode, so loopback trust is unsound", () => {
    // What the exposed host looked like: tailscaled reported the node's tailnet address, no interface
    // carried it, and inbound tailnet traffic still arrived on the loopback listener.
    expect(tailscaleTunDevicePresent(userspaceMode)).toBe(false);
  });

  /**
   * The defect this predicate was rewritten for. `100.64.0.0/10` is RFC 6598 shared address space,
   * not Tailscale's, so a userspace-mode host on a carrier or container network holding an ordinary
   * CGNAT lease previously passed the gate and restored the whole bypass.
   */
  test("an ordinary interface on shared CGNAT space does not vouch for a TUN device", () => {
    expect(
      tailscaleTunDevicePresent({
        ...userspaceMode,
        eth0: [{ address: "100.96.4.7", netmask: "255.255.240.0" }],
      }),
    ).toBe(false);
    // A container pod address is a host route on an ordinary interface: the shape alone is not enough.
    expect(
      tailscaleTunDevicePresent({ ...userspaceMode, eth0: [{ address: "100.96.4.7", netmask: "255.255.255.255" }] }),
    ).toBe(false);
    // And a tunnel-shaped name alone is not enough either, without Tailscale's address shape.
    expect(
      tailscaleTunDevicePresent({ ...userspaceMode, utun3: [{ address: "100.96.4.7", netmask: "255.255.240.0" }] }),
    ).toBe(false);
  });

  test("Tailscale's IPv6 allocation is decisive on its own, whatever carries it", () => {
    // Nothing but Tailscale assigns out of fd7a:115c:a1e0::/48, so this needs no name or netmask help.
    expect(tailscaleTunDevicePresent({ wg0: [{ address: "fd7a:115c:a1e0::1" }] })).toBe(true);
    expect(tailscaleTunDevicePresent({ utun0: [{ address: "FD7A:115C:A1E0::1" }] })).toBe(true);
    expect(tailscaleTunDevicePresent({ utun0: [{ address: "fd7a:115c:a1e0::1%utun0" }] })).toBe(true);
    // An adjacent ULA prefix is somebody else's.
    expect(tailscaleTunDevicePresent({ utun0: [{ address: "fd7a:115c:a1e1::1" }] })).toBe(false);
  });

  test("the CGNAT bounds are exact where the shape and name do hold", () => {
    const tunnel = (address: string): InterfaceTable => ({ utun0: [{ address, netmask: "255.255.255.255" }] });
    expect(tailscaleTunDevicePresent(tunnel("100.64.0.0"))).toBe(true);
    expect(tailscaleTunDevicePresent(tunnel("100.127.255.255"))).toBe(true);
    // 100.63.x and 100.128.x are ordinary public space; both literals are range boundaries rather
    // than anyone's address. identifier-leak-allow
    expect(tailscaleTunDevicePresent(tunnel("100.63.255.255"))).toBe(false); // identifier-leak-allow
    expect(tailscaleTunDevicePresent(tunnel("100.128.0.0"))).toBe(false); // identifier-leak-allow
    expect(tailscaleTunDevicePresent(tunnel("10.0.100.64"))).toBe(false);
  });

  test("an empty or hole-bearing table is not treated as safe", () => {
    expect(tailscaleTunDevicePresent({})).toBe(false);
    expect(tailscaleTunDevicePresent({ utun0: undefined })).toBe(false);
    // A missing netmask cannot satisfy the host-route requirement.
    expect(tailscaleTunDevicePresent({ utun0: [{ address: "100.100.100.100" }] })).toBe(false);
  });
});

describe("exact self-address binding", () => {
  test("matches only the address tailscaled reported as ours", () => {
    expect(tailnetAddressIsLocallyBound("100.100.100.100", tunMode)).toBe(true);
    expect(tailnetAddressIsLocallyBound("100.100.100.101", tunMode)).toBe(false);
    expect(tailnetAddressIsLocallyBound("100.100.100.100", userspaceMode)).toBe(false);
  });

  test("an absent address is not treated as locally bound", () => {
    expect(tailnetAddressIsLocallyBound(undefined, tunMode)).toBe(false);
  });
});

describe("presence probe caching", () => {
  test("measures once per TTL rather than once per request", () => {
    let measurements = 0;
    let clock = 1_000;
    const probe = createTailnetPresenceProbe({
      ttlMs: 5_000,
      now: () => clock,
      present: () => {
        measurements += 1;
        return true;
      },
    });

    expect(probe()).toBe(true);
    expect(probe()).toBe(true);
    clock += 4_999;
    expect(probe()).toBe(true);
    expect(measurements).toBe(1);

    clock += 1;
    expect(probe()).toBe(true);
    expect(measurements).toBe(2);
  });

  test("observes a topology that becomes unsafe while the daemon runs", () => {
    let clock = 0;
    let present = true;
    const probe = createTailnetPresenceProbe({ ttlMs: 1_000, now: () => clock, present: () => present });

    expect(probe()).toBe(true);
    present = false;
    // Within the window the cached answer stands; the bound on staleness is the point of the TTL.
    expect(probe()).toBe(true);
    clock += 1_000;
    expect(probe()).toBe(false);
  });

  test("a probe caching false recovers when a TUN device appears", () => {
    let clock = 0;
    let present = false;
    const probe = createTailnetPresenceProbe({ ttlMs: 100, now: () => clock, present: () => present });

    expect(probe()).toBe(false);
    present = true;
    clock += 100;
    expect(probe()).toBe(true);
  });
});
