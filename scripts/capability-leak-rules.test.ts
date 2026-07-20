import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";

const room = "R".repeat(16);
const key = "K".repeat(43);

test("detects URL, bare, legacy, percent-encoded, and authorization leaks", () => {
  const browserLink = ["https://my.omp.sh/", "#", room, ".", key].join("");
  const relayLink = ["wss://my.omp.sh/r/", room, ".", key].join("");
  const bareLink = [room, ".", key].join("");
  const legacyBareLink = [room, "#", key].join("");
  const encodedBrowserLink = ["https://my.omp.sh/", "#", room, "%23", key].join("");
  const encodedRelayLink = ["wss://my.omp.sh/r/", room, "%23", key].join("");
  const encodedBareLink = [room, "%23", key].join("");
  const bearer = ["Authorization", ": Bearer ", "T".repeat(48)].join("");
  expect(
    findCapabilityLeaks(
      [
        browserLink,
        relayLink,
        bareLink,
        legacyBareLink,
        encodedBrowserLink,
        encodedRelayLink,
        encodedBareLink,
        bearer,
      ].join("\n"),
    ).map(finding => finding.label),
  ).toEqual([
    "OMP browser capability",
    "OMP browser capability",
    "OMP relay capability",
    "OMP relay capability",
    "OMP bare capability",
    "OMP bare capability",
    "OMP bare capability",
    "long Bearer token",
  ]);
});

test("detects generated publisher tokens in IPC JSON and token-file diagnostics", () => {
  const token = randomBytes(32).toString("base64url");
  expect(
    findCapabilityLeaks([JSON.stringify({ type: "hello", token }), `publisher-token=${token}`].join("\n")).map(
      finding => finding.label,
    ),
  ).toEqual(["OMP publisher token", "OMP publisher token"]);
  expect(findCapabilityLeaks(token).map(finding => finding.label)).toEqual(["raw publisher token"]);
});

test("does not flag documented placeholders or ordinary URLs", () => {
  expect(findCapabilityLeaks("https://host.tailnet.ts.net <roomId>.<key> Authorization: Bearer <token>")).toEqual([]);
});
