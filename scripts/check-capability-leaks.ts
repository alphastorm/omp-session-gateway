import { readFile } from "node:fs/promises";
import { basename, extname, relative } from "node:path";
import { CAPABILITY_TEXT_EXTENSIONS, findCapabilityLeaks } from "./capability-leak-rules.ts";
import { repositoryFiles } from "./repository-files.ts";

const rootPath = new URL("../", import.meta.url).pathname;
const exempt = new Set(["scripts/check-capability-leaks.ts"]);

const findings: string[] = [];
for (const file of await repositoryFiles(rootPath)) {
  const rel = relative(rootPath, file);
  if (exempt.has(rel)) continue;
  if (!CAPABILITY_TEXT_EXTENSIONS.has(extname(file)) && !["LICENSE", "readiness-token"].includes(basename(rel))) continue;
  const text = await readFile(file, "utf8");
  for (const finding of findCapabilityLeaks(text)) {
    findings.push(`${rel}: possible ${finding.label} at byte ${finding.byteOffset}`);
  }
}

if (findings.length > 0) {
  console.error("Possible capability/token leaks detected:\n" + findings.map(item => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("capability leak scan passed");