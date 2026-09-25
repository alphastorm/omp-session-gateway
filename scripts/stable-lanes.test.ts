import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { remoteCommandLine, type RemoteExecutor } from "./stable-qualification.ts";
import { PUSH_FIXTURE_FILES, remoteHome, stageRemoteFile } from "./stable-lanes.ts";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

/** Runs the exact line ssh would hand the retained Mac's shell, locally, so quoting is proved end to end. */
const localShell: RemoteExecutor = async (argv, options = {}) => {
  const child = Bun.spawn(["/bin/sh", "-c", remoteCommandLine(argv)], {
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

async function relativeImports(file: string): Promise<string[]> {
  const source = await readFile(join(SCRIPTS, file), "utf8");
  return [...source.matchAll(/^import [^;]*? from "\.\/([^"]+)";/gmu)].map(match => {
    const target = match[1] ?? "";
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    return `${directory}${target}`;
  });
}

describe("retained-Mac Push fixture staging", () => {
  test("stages exactly the Push fixture's import closure", async () => {
    // The fixture runs on the retained Mac from these staged copies alone, so a new relative import
    // that is not staged would break the campaign there and nowhere else.
    const closure = new Set<string>();
    const pending = ["push-qualification-fixture.ts"];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (closure.has(file)) continue;
      closure.add(file);
      if (file.endsWith(".ts")) pending.push(...await relativeImports(file));
    }
    expect([...closure].sort()).toEqual([...PUSH_FIXTURE_FILES].sort());
  });

  test("writes the exact bytes to a path the remote shell never interprets", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-lanes-stage-"));
    try {
      const path = join(root, "nested $(touch pwned) dir", "file'; rm -rf ~ #.ts");
      const bytes = new TextEncoder().encode("export const staged = 'exact';\n");
      await stageRemoteFile(localShell, path, bytes);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes);
      expect(await Bun.file(join(root, "pwned")).exists()).toBe(false);
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts only a plain absolute home directory", async () => {
    const reporting = (home: string): RemoteExecutor => async () => ({ exitCode: 0, stdout: home, stderr: "" });
    expect(await remoteHome(reporting("/Users/m1"))).toBe("/Users/m1");
    for (const home of ["", "Users/m1", "/Users/m 1", "/Users/../root", "/Users/m1\n/etc"]) {
      await expect(remoteHome(reporting(home))).rejects.toThrow("home directory");
    }
  });
});
