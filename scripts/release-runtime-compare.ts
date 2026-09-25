import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Promotion metadata a stable build rewrites. Every other member of a stable archive must equal the
 * qualified candidate's by path, mode, and bytes (docs/RELEASE.md, "Promote it").
 */
const PROMOTION_METADATA: Record<string, true> = {
  "release-info.json": true,
  "SBOM.spdx.json": true,
  "STABLE_RELEASE.lock.json": true,
  "schemas/stable-release.schema.json": true,
};

interface ArchiveMember {
  readonly mode: number;
  readonly content: Buffer;
}

export interface RuntimeComparison {
  readonly compared: number;
  readonly differing: readonly string[];
}

/**
 * Reads the regular-file ustar archive build-release.ts writes. Modes come from the headers, so the
 * comparison never depends on an extracting umask or filesystem; any other entry kind is refused.
 */
function readReleaseArchive(archive: Buffer, label: string): Map<string, ArchiveMember> {
  const members = new Map<string, ArchiveMember>();
  for (let offset = 0; ; ) {
    if (offset + 512 > archive.byteLength) throw new Error(`${label} archive ends without its end-of-archive block`);
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return members;
    const text = (start: number, length: number) => header.toString("utf8", start, start + length).replace(/\0[\s\S]*$/u, "");
    const octal = (start: number, length: number) => Number.parseInt(text(start, length), 8);
    const path = text(0, 100);
    const size = octal(124, 12);
    if (text(257, 6) !== "ustar" || text(156, 1) !== "0" || text(345, 155) !== "" || path === "" || !Number.isSafeInteger(size)) {
      throw new Error(`${label} archive has an entry the release writer never produces at byte ${offset}`);
    }
    if (members.has(path)) throw new Error(`${label} archive repeats ${path}`);
    const start = offset + 512;
    if (start + size > archive.byteLength) throw new Error(`${label} archive truncates ${path}`);
    members.set(path, { mode: octal(100, 8), content: archive.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
}

/** Both archives must hold the same members; outside promotion metadata, each must match exactly. */
export function compareReleaseRuntime(candidate: Buffer, stable: Buffer): RuntimeComparison {
  const expected = readReleaseArchive(candidate, "candidate");
  const actual = readReleaseArchive(stable, "stable");
  const differing: string[] = [];
  let compared = 0;
  for (const path of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const left = expected.get(path);
    const right = actual.get(path);
    if (left === undefined || right === undefined) {
      differing.push(path);
    } else if (!Object.hasOwn(PROMOTION_METADATA, path.slice(path.indexOf("/") + 1))) {
      compared += 1;
      if (left.mode !== right.mode || !left.content.equals(right.content)) differing.push(path);
    }
  }
  return { compared, differing };
}

/** Refuses a candidate archive whose digest is not the qualified one before comparing anything. */
export async function compareReleaseArchives(
  candidatePath: string,
  candidateSha256: string,
  stablePath: string,
): Promise<RuntimeComparison> {
  const candidate = await readFile(candidatePath);
  const digest = createHash("sha256").update(candidate).digest("hex");
  if (digest !== candidateSha256) throw new Error(`candidate archive digest ${digest} is not the qualified ${candidateSha256}`);
  return compareReleaseRuntime(candidate, await readFile(stablePath));
}

if (import.meta.main) {
  const [candidatePath, candidateSha256, stablePath, ...extra] = process.argv.slice(2);
  if (candidatePath === undefined || stablePath === undefined || !/^[0-9a-f]{64}$/u.test(candidateSha256 ?? "") || extra.length > 0) {
    console.error("usage: bun run release:compare -- <candidate-archive> <candidate-sha256> <stable-archive>");
    process.exit(2);
  }
  const result = await compareReleaseArchives(candidatePath, candidateSha256 as string, stablePath);
  console.log(JSON.stringify({ candidateSha256, ...result }));
  if (result.differing.length > 0) process.exit(1);
}
