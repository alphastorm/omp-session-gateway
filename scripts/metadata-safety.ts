import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";
import { SYNTHETIC_CAPABILITY_MARKER } from "./synthetic-hosts.ts";

const FORBIDDEN_FIELDS: Readonly<Record<string, true>> = {
  viewLink: true, controlLink: true, capability: true, token: true, secret: true,
};

/** Check raw JSON before a protocol parser projects away anything. Never include input in errors. */
export function assertMetadataSafe(body: string, secrets: ReadonlySet<string> | readonly string[]): unknown {
  if (body.length > 1_048_576 || findCapabilityLeaks(body).length || body.includes(SYNTHETIC_CAPABILITY_MARKER)) {
    throw new Error("metadata leak or oversized body");
  }
  // Inspect every JSON string token before parsing can discard duplicate members. Decode strings
  // so escaping a key or canary does not evade the same checks used for plain JSON.
  for (const match of body.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
    const value = JSON.parse(match[0]) as string;
    let following = match.index + match[0].length;
    while (/\s/u.test(body[following] ?? "")) following++;
    if (body[following] === ":" && Object.hasOwn(FORBIDDEN_FIELDS, value)) throw new Error("metadata secret field");
    if (value.includes(SYNTHETIC_CAPABILITY_MARKER) || findCapabilityLeaks(value).length) throw new Error("metadata leak");
    for (const secret of secrets) if (secret && value.includes(secret)) throw new Error("metadata leak");
  }
  return JSON.parse(body) as unknown;
}

if (import.meta.main) {
  try {
    const directory = process.argv[2];
    if (!directory || process.argv.length !== 3) throw new Error("invalid arguments");
    const names = (await readdir(directory)).filter(name => name.endsWith(".json"));
    if (names.length > 100) throw new Error("too many discovery entries");
    const secrets: string[] = [];
    for (const name of names) {
      const entry: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (typeof entry !== "object" || entry === null || !("token" in entry) || typeof entry.token !== "string") {
        throw new Error("invalid discovery entry");
      }
      secrets.push(entry.token);
    }
    assertMetadataSafe(await Bun.stdin.text(), secrets);
  } catch {
    // The workflow supplies a fixed error message; neither bodies nor discovery values are echoed.
    process.exitCode = 1;
  }
}
