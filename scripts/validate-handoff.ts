import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const rootPath = root.pathname;

const required = [
  "README.md",
  "AGENTS.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "ROADMAP.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
  "AGENT_BRIEF.md",
  "HANDOFF_MANIFEST.md",
  "UPSTREAM.lock.json",
  "docs/ARCHITECTURE.md",
  "docs/SECURITY.md",
  "docs/PROTOCOL.md",
  "docs/OMP_INTEGRATION.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/TEST_PLAN.md",
  "docs/COMPATIBILITY.md",
  "docs/ISSUE_PLAN.md",
  "schemas/registry-message.schema.json",
  "schemas/session-list.schema.json",
  "schemas/launch-request.schema.json",
  "schemas/launch-response.schema.json",
  "schemas/sse-event.schema.json",
  "schemas/upstream-lock.schema.json",
] as const;

const forbiddenLegacy = [
  "OMP Mobile Hub",
  "omp-mobile-hub",
  "gitgateway.com",
  "tag:omp-hub",
] as const;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const errors: string[] = [];
for (const rel of required) {
  try {
    await readFile(join(rootPath, rel));
  } catch {
    errors.push(`missing required file: ${rel}`);
  }
}

for (const file of await walk(rootPath)) {
  const rel = relative(rootPath, file);
  if (rel === "scripts/validate-handoff.ts") continue;
  if (!/\.(?:md|json|jsonc|hujson|ts|tsx|yml|yaml|toml)$/.test(file) && !["LICENSE", "NOTICE"].includes(rel)) {
    continue;
  }
  const text = await readFile(file, "utf8");
  for (const old of forbiddenLegacy) {
    if (text.includes(old)) errors.push(`${rel}: contains legacy identifier ${JSON.stringify(old)}`);
  }
}

for (const rel of [
  "package.json",
  "UPSTREAM.lock.json",
  "schemas/registry-message.schema.json",
  "schemas/session-list.schema.json",
  "schemas/launch-request.schema.json",
  "schemas/launch-response.schema.json",
  "schemas/sse-event.schema.json",
  "schemas/upstream-lock.schema.json",
]) {
  try {
    JSON.parse(await readFile(join(rootPath, rel), "utf8"));
  } catch (error) {
    errors.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : "unknown error"})`);
  }
}

const packageJson = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8")) as { name?: string };
if (packageJson.name !== "omp-session-gateway") {
  errors.push(`package.json: expected name omp-session-gateway, got ${String(packageJson.name)}`);
}

if (errors.length > 0) {
  console.error(errors.map(error => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`handoff validation passed (${(await walk(rootPath)).length} files scanned)`);
