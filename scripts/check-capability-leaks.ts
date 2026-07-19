import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const rootPath = new URL("../", import.meta.url).pathname;
const textExtensions = new Set([".md", ".json", ".jsonc", ".hujson", ".ts", ".tsx", ".js", ".yml", ".yaml", ".toml", ".txt"]);
const exempt = new Set(["scripts/check-capability-leaks.ts"]);

// Conservative patterns for accidentally pasted live OMP capabilities or long bearer values.
// Placeholders containing angle brackets or obvious words do not match.
const patterns: Array<[string, RegExp]> = [
  ["OMP browser capability", /https?:\/\/[^\s"'<>]+\/#(?:[^\s"'<>]*\/)?[A-Za-z0-9_-]{12,}[.#][A-Za-z0-9_-]{32,}/g],
  ["OMP relay capability", /(?:wss?:\/\/)?[^\s"'<>]+\/r\/[A-Za-z0-9_-]{12,}[.#][A-Za-z0-9_-]{32,}/g],
  ["long Bearer token", /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{40,}/gi],
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
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
  if (!textExtensions.has(extname(file)) && !["LICENSE"].includes(rel)) continue;
  const text = await readFile(file, "utf8");
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) findings.push(`${rel}: possible ${label} at byte ${match.index}`);
  }
}

if (findings.length > 0) {
  console.error("Possible capability/token leaks detected:\n" + findings.map(item => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("capability leak scan passed");
