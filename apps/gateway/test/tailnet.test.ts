import { describe, expect, test } from "bun:test";
import {
  createTailnetPresenceProbe,
  isTailnetAddress,
  tailnetAddressIsLocallyBound,
  tailnetInterfacePresent,
  type InterfaceTable,
} from "../src/tailnet.ts";

/**
 * These read an injected interface table rather than the host's own. The earlier versions of two of
 * these cases asserted against `networkInterfaces()` directly, which made them agree with whatever
 * machine happened to run them: on a developer workstation with Tailscale in TUN mode the unsafe
 * topology could not be expressed at all, which is the one case that matters. See #98.
 */
const userspaceMode: InterfaceTable = {
  lo0: [{ address: "127.0.0.1" }, { address: "::1" }],
  en0: [{ address: "192.168.1.24" }, { address: "fe80::1c9a:e0ff:fe32:1" }],
};

const tunMode: InterfaceTable = {
  ...userspaceMode,
  utun4: [{ address: "100.100.100.100" }, { address: "fd7a:115c:a1e0::1a2b:3c4d" }],
};

describe("tailnet address recognition", () => {
  test("accepts the whole CGNAT allocation and nothing adjacent to it", () => {
    expect(isTailnetAddress("100.64.0.0")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.100.100.100")).toBe(true);
    // The bounds matter: 100.63.x and 100.128.x are ordinary public space, and treating them as
    // tailnet addresses would let an unrelated interface vouch for a TUN device that is not there.
    // Both literals are range boundaries, not anyone's address. identifier-leak-allow
    expect(isTailnetAddress("100.63.255.255")).toBe(false); // identifier-leak-allow
    expect(isTailnetAddress("100.128.0.0")).toBe(false); // identifier-leak-allow
    expect(isTailnetAddress("10.0.100.64")).toBe(false);
    expect(isTailnetAddress("127.0.0.1")).toBe(false);
  });

  test("accepts the tailnet ULA prefix, including a zone-suffixed form", () => {
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("FD7A:115C:A1E0::1")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1%utun4")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailnetAddress("fe80::1")).toBe(false);
  });
});

describe("userspace-mode tailscaled detection", () => {
  test("a tailnet address on some interface means a real TUN device", () => {
    expect(tailnetInterfacePresent(tunMode)).toBe(true);
  });

  test("no tailnet address anywhere is userspace mode, so loopback trust is unsound", () => {
    // This is what the exposed host looked like: tailscaled reported the node's tailnet address, no
    // interface carried it, and inbound tailnet traffic still arrived on the loopback listener.
    expect(tailnetInterfacePresent(userspaceMode)).toBe(false);
  });

  test("an interface carrying only the tailnet ULA still counts", () => {
    expect(tailnetInterfacePresent({ utun4: [{ address: "fd7a:115c:a1e0::2c01:1" }] })).toBe(true);
  });

  test("an empty or hole-bearing table is not treated as safe", () => {
    expect(tailnetInterfacePresent({})).toBe(false);
    expect(tailnetInterfacePresent({ utun4: undefined })).toBe(false);
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
