import { join } from "node:path";

async function gitListing(root: string, args: readonly string[]): Promise<Set<string>> {
  const subprocess = Bun.spawn(["git", "-C", root, "ls-files", "-z", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ls-files ${args.join(" ")} failed: ${stderr.trim()}`);
  return new Set(stdout.split("\0").filter(entry => entry.length > 0));
}

/**
 * Every file a commit from this checkout could carry: tracked files plus untracked files that no
 * ignore rule excludes, as git itself resolves them. The leak scanners guard what reaches the
 * repository, so ignored build output and local tooling exports are outside their scope; the
 * release builder scans shipped bytes separately. Nested repositories surface as one `dir/`
 * entry and are skipped, and a tracked file deleted from the working tree is not readable.
 */
export async function repositoryFiles(root: string): Promise<string[]> {
  const [present, deleted] = await Promise.all([
    gitListing(root, ["--cached", "--others", "--exclude-standard"]),
    gitListing(root, ["--deleted"]),
  ]);
  const files: string[] = [];
  for (const entry of present) {
    if (entry.endsWith("/") || deleted.has(entry)) continue;
    files.push(join(root, entry));
  }
  return files;
}
