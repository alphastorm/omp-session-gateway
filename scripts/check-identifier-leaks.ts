/**
 * Fails the build when a personal or infrastructure identifier reaches tracked files.
 *
 * Sibling of `check-capability-leaks.ts`: that one guards secrets, this one guards values that
 * identify a person, machine, or private network. See `identifier-leak-rules.ts` for why.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { findIdentifierLeaks, IDENTIFIER_TEXT_EXTENSIONS } from "./identifier-leak-rules.ts";

const rootPath = new URL("../", import.meta.url).pathname;
// The rules file and its tests necessarily contain example shapes.
const exempt = new Set([
  "scripts/identifier-leak-rules.ts",
  "scripts/check-identifier-leaks.ts",
  "scripts/identifier-leak-rules.test.ts",
]);
const skipDirs = new Set([".git", "node_modules", "build", "coverage", "dist", ".qualification"]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const findings: string[] = [];
for (const file of await walk(rootPath)) {
  const rel = relative(rootPath, file);
  if (exempt.has(rel)) continue;
  // Lockfiles and third-party licence text carry upstream authors' addresses, not ours.
  if (rel === "bun.lock" || rel.startsWith("licenses/") || rel.endsWith("THIRD_PARTY_NOTICES.md")) continue;
  if (!IDENTIFIER_TEXT_EXTENSIONS.has(extname(file))) continue;
  for (const finding of findIdentifierLeaks(await readFile(file, "utf8"))) {
    findings.push(`${rel}:${finding.line}: ${finding.label} "${finding.match}"`);
  }
}

if (findings.length > 0) {
  console.error("identifier leak scan failed:");
  for (const f of findings) console.error(`  ${f}`);
  console.error("\nUse a placeholder, or append 'identifier-leak-allow' to the line if the value is reviewed and necessary.");
  process.exit(1);
}
console.log("identifier leak scan passed");
