import { describe, expect, test } from "bun:test";
import { findIdentifierLeaks } from "./identifier-leak-rules.ts";

const labels = (text: string): string[] => findIdentifierLeaks(text).map(f => f.label).sort();

describe("identifier leak detection", () => {
  test("catches every class that actually leaked from this repository", () => {
    // Each of these was published for real and had to be removed by rewriting history and
    // deleting releases. Synthetic stand-ins here, same shapes.
    expect(labels("connect to 203.0.113.45 now")).toContain("public IPv4 address");
    expect(labels("origin https://somebody-macbook.tailabc123.ts.net/")).toContain("tailnet hostname");
    expect(labels("node nQ7XyzAbCd42CNTRL joined")).toContain("tailnet node id");
    expect(labels("cd /Users/somebody/Development")).toContain("absolute home path");
    expect(labels("serial 48219FGHJ773KL attached")).toContain("device serial");
  });

  test("does not fire on loopback, private ranges, or the CGNAT range", () => {
    // The gateway binds loopback by design and Tailscale uses CGNAT; flagging those would make the
    // check noise, and a check people silence is worse than no check.
    for (const text of ["127.0.0.1:4317", "10.0.0.5", "192.168.1.10", "172.16.4.2", "100.64.1.1", "0.0.0.0"]) {
      expect(findIdentifierLeaks(text)).toEqual([]);
    }
  });

  test("does not fire on documentation placeholders", () => {
    for (const text of ["gateway.example.ts.net", "host.tailnet.ts.net", "/Users/test/x", "/home/runner/work"]) {
      expect(findIdentifierLeaks(text)).toEqual([]);
    }
  });

  test("does not mistake version strings or system paths for identifiers", () => {
    // Regressions observed while building this: Chrome's UA reports 151.0.0.0, and $HOME/Library is
    // a system directory rather than an account name.
    expect(findIdentifierLeaks("Chrome/151.0.0.0 Mobile Safari")).toEqual([]);
    expect(findIdentifierLeaks("$HOME/Library/LaunchAgents")).toEqual([]);
    expect(findIdentifierLeaks("%2FUPSTREAM.lock.json")).toEqual([]);
    expect(findIdentifierLeaks("sha256 ABCDEF0123456789")).toEqual([]);
  });

  test("honours an explicit reviewed opt-out", () => {
    expect(findIdentifierLeaks("203.0.113.45 // identifier-leak-allow")).toEqual([]);
  });
});
