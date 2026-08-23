import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowPath = join(import.meta.dir, "../../../.github/workflows/ci.yml");

function validationScripts(source: string): string[] {
  return [...source.matchAll(/      - name: Validate bounded gateway dispatch[\s\S]*?        run: \|\n((?:          .*\n)+)/g)].map(
    (match) => match[1] ?? "",
  );
}

test("every fleet lane fails closed and admits either qualified site", async () => {
  const source = await readFile(workflowPath, "utf8");
  const scripts = validationScripts(source);

  expect(scripts).toHaveLength(3);
  for (const script of scripts) {
    const predicates = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("[["));
    expect(predicates).toHaveLength(4);
    expect(predicates.every((line) => /\]\] \|\| fail [a-z_]+$/.test(line))).toBe(true);
    expect(script).toContain('^gateway-ci-(nyc|sf)-[1-3]$');
    expect(script).not.toContain("gateway-ci-nyc-[1-3]");
  }
});
