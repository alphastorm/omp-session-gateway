import { expect, test } from "bun:test";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";

const room = "R".repeat(16);
const key = "K".repeat(43);

test("detects synthetic browser, relay, and authorization leaks", () => {
  const browserLink = ["https://my.omp.sh/", "#", room, ".", key].join("");
  const relayLink = ["wss://my.omp.sh/r/", room, ".", key].join("");
  const bearer = ["Authorization", ": Bearer ", "T".repeat(48)].join("");
  expect(findCapabilityLeaks([browserLink, relayLink, bearer].join("\n")).map(finding => finding.label)).toEqual([
    "OMP browser capability",
    "OMP relay capability",
    "long Bearer token",
  ]);
});

test("does not flag documented placeholders or ordinary URLs", () => {
  expect(findCapabilityLeaks("https://host.tailnet.ts.net <roomId>.<key> Authorization: Bearer <token>")).toEqual([]);
});
