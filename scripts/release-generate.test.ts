import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRelease, RELEASE_TEXT, runReleaseGenerate, type ReleaseGenerateOptions } from "./release-generate.ts";
import { historicalTrees, normalizeHistoricalTree } from "./fixtures/release-generate/historical.ts";


test("normalized v0.7.4 generated sections equal the committed current claim surfaces", async () => {
  const expected = { ...approved, ...recorded };
  for (const path of ["docs/RELEASE_STATUS.md", "docs/COMPATIBILITY.md", "docs/UPGRADE_ROLLBACK.md", "docs/ANDROID.md", "docs/ATTENTION_SPEC.md", "docs/LIFECYCLE_BRANCH_RESUME.md", "docs/BACKLOG.md", "site/llms.txt", "site/status/index.html"]) {
    const committed = await readFile(join(root, path), "utf8");
    for (const match of expected[path]!.matchAll(/<!-- release-generate:([a-z-]+):start -->[\s\S]*?<!-- release-generate:\1:end -->/gu)) {
      expect(committed, path + ":" + match[1]).toContain(match[0]);
    }
  }
});
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = new URL("./fixtures/release-generate/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}
const originals = historicalTrees();
const receipt = await fixture("v0.7.4.receipt.json");
const smoke = await fixture("v0.7.4.smoke.json");
const status = await fixture("v0.7.4.status.json");
const publication = await fixture("v0.7.4.publication.json");
const releaseText = await readFile(new URL("v0.7.4.release-text.json", fixtures), "utf8");
const prepareOptions: ReleaseGenerateOptions = { command: "prepare", version: "0.7.4", date: "2026-10-03" };
const approveOptions: ReleaseGenerateOptions = { command: "approve", version: "v0.7.4", date: "2026-10-03", candidateTag: "v0.7.4-prealpha.1", receipt };
const recordOptions: ReleaseGenerateOptions = { command: "record", version: "v0.7.4", date: "2026-10-03", smoke, status, publication };
const prepareBefore: Record<string, string> = { ...normalizeHistoricalTree(originals["dcfa0b3^"]!, { emptyLedger: true }), [RELEASE_TEXT]: releaseText };
const prepared = generateRelease(prepareBefore, prepareOptions);
const approveBefore: Record<string, string> = { ...normalizeHistoricalTree(originals["39e3d57^"]!), [RELEASE_TEXT]: prepared[RELEASE_TEXT]! };
const approved = generateRelease(approveBefore, approveOptions);
// The parent has handwritten approval prose. Normalize those same surfaces to the generated
// approval form; all other parent bytes (including backlog tasks and dated history) stay intact.
const recordBefore: Record<string, string> = { ...normalizeHistoricalTree(originals["9c0d790^"]!), ...approved };
const recorded = generateRelease(recordBefore, recordOptions);
const cases = { prepare: { before: prepareBefore, options: prepareOptions, result: prepared }, approve: { before: approveBefore, options: approveOptions, result: approved }, record: { before: recordBefore, options: recordOptions, result: recorded } };
const goldens = await fixture("golden.json") as Record<string, Record<string, string>>;

test("the visible historical archive preserves every replaced v0.7.4 operator fact and link", async () => {
  const changes = await fixture("v0.7.4.prose-changes.json") as { before: string }[];
  const ledger = (await readFile(join(root, "docs/RELEASE_STATUS.md"), "utf8")).replace(/\s+/gu, " ");
  for (const change of changes) if (change.before !== "") expect(ledger).toContain(change.before.replace(/\s+/gu, " "));
});

for (const [name, scenario] of Object.entries(cases)) {
  test(`${name}: real v0.7.4 parent produces every full-file golden byte hash`, () => {
    const actual = Object.fromEntries(Object.entries(scenario.result).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]));
    expect(actual).toEqual(goldens[name]!);
    expect(generateRelease(scenario.before, scenario.options)).toEqual(scenario.result);
  });
}

test("v0.7.4 package/lock/constants exactly reproduce the manual prepare commit", () => {
  for (const path of Object.keys(prepared).filter(path => path.endsWith("package.json") || path.endsWith(".ts") || path === "bun.lock")) {
    expect(prepared[path], path).toBe(originals.dcfa0b3![path]);
  }
});
test("v0.7.3 second sample reproduces every version surface byte-for-byte", () => {
  const before = { ...prepareBefore };
  const paths = Object.keys(prepared).filter(path => path.endsWith("package.json") || path.endsWith(".ts") || path === "bun.lock");
  for (const path of paths) before[path] = originals["7a5f988^"]![path]!;
  const stable = JSON.parse(before["STABLE_RELEASE.lock.json"]!);
  stable.releaseTag = "v0.7.2";
  before["STABLE_RELEASE.lock.json"] = JSON.stringify(stable);
  before["CHANGELOG.md"] = "# Changelog\n\n## [Unreleased]\n\n- Qualification tooling.\n\n## [v0.7.2] — 2026-10-01\n";
  const result = generateRelease(before, { command: "prepare", version: "0.7.3", date: "2026-10-02" });
  for (const path of paths) expect(result[path], path).toBe(originals["7a5f988"]![path]);
});
test("approve reproduces the committed stable lock, not synthetic digests or approval times", () => {
  expect(approved["STABLE_RELEASE.lock.json"]).toBe(originals["39e3d57"]!["STABLE_RELEASE.lock.json"]);
});
test("record removes exactly the completed backlog tasks, preserving other work", () => {
  expect(recorded["docs/BACKLOG.md"]!.replace(/<!-- release-generate:release-task:start -->\n\n<!-- release-generate:release-task:end -->\n/u, "")).toBe(originals["9c0d790"]!["docs/BACKLOG.md"]!);
});
test("fresh attempts preserve the existing cut and incorporate new Unreleased fixes", () => {
  const tree = { ...prepareBefore, ...prepared };
  tree["CHANGELOG.md"] = tree["CHANGELOG.md"]!.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- A subsequent fix.\n");
  const options: ReleaseGenerateOptions = { command: "prepare", version: "0.7.4", date: "2026-10-04", candidateTag: "v0.7.4-prealpha.2" };
  const result = generateRelease(tree, options);
  expect(result["CHANGELOG.md"]!.match(/## \[v0.7.4\]/gu)).toHaveLength(1);
  expect(result["CHANGELOG.md"]).toContain("- A subsequent fix.");
  expect(result["CHANGELOG.md"]).toContain("bun scripts/upstream-pins.ts");
  expect(result["docs/RELEASE_STATUS.md"]).toContain("`v0.7.4-prealpha.2`");
  const repeated = generateRelease({ ...tree, ...result }, options);
  expect(repeated).toEqual(result);
});

describe("fail closed without producing partial edits", () => {
  test("missing/duplicate markers and date", () => {
    const broken = { ...approveBefore, "docs/COMPATIBILITY.md": approveBefore["docs/COMPATIBILITY.md"]!.replace("release-generate:platforms:start", "missing") };
    expect(() => generateRelease(broken, approveOptions)).toThrow("marker");
    expect(() => generateRelease(prepareBefore, { ...prepareOptions, date: "2026-02-30" })).toThrow("date");
    expect(() => generateRelease(prepareBefore, { ...prepareOptions, date: "" })).toThrow("date");
  });
  test("missing/failed lanes, wrong digest, wrong candidate, stale cleanup and mismatched upstream", () => {
    for (const [path, value] of [
      ["lanes.windows", undefined], ["lanes.relay.status", "failed"],
      ["candidate.archiveSha256", "0".repeat(64)], ["tag", "v0.7.4-prealpha.2"],
      ["lanes.windowsCleanup.evidence.epoch", "other-attempt"],
      ["lanes.windows.evidence.result.omp.version", "18.4.12"],
    ] as const) {
      const invalid = structuredClone(receipt) as Record<string, unknown>;
      const keys = path.split(".");
      let target = invalid;
      for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
      if (value === undefined) delete target[keys.at(-1)!];
      else target[keys.at(-1)!] = value;
      expect(() => generateRelease(approveBefore, { ...approveOptions, receipt: invalid })).toThrow();
    }
  });
  test("smoke failures, status divergence and publication/source mismatches", () => {
    const invalidSmoke = structuredClone(smoke) as { android: { samePageRecovery: boolean } };
    invalidSmoke.android.samePageRecovery = false;
    expect(() => generateRelease(recordBefore, { ...recordOptions, smoke: invalidSmoke })).toThrow("samePageRecovery");
    expect(() => generateRelease(recordBefore, { ...recordOptions, status: { ...status as object, diverged: true } })).toThrow("divergence");
    expect(() => generateRelease(recordBefore, { ...recordOptions, publication: { ...publication as object, sourceCommit: "a".repeat(40) } })).toThrow("sourceCommit");
  });
  test("private identities and arbitrary strings never reach the published projection", () => {
    const privateReceipt = structuredClone(receipt) as { lanes: { macos: { evidence: Record<string, unknown> }; windows: { evidence: { result: Record<string, unknown> } } } };
    privateReceipt.lanes.macos.evidence.privatePath = "/Users/alice/secret";
    privateReceipt.lanes.windows.evidence.result.privateNote = "token-do-not-publish";
    const bytes = JSON.stringify(generateRelease(approveBefore, { ...approveOptions, receipt: privateReceipt }));
    expect(bytes).not.toContain("/Users/alice/secret");
    expect(bytes).not.toContain("token-do-not-publish");
    expect(bytes).not.toContain("tailfb479a");
  });
});

async function materialize(tree: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-release-generate-"));
  for (const [path, bytes] of Object.entries(tree)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
  return directory;
}

// The release workflow's shell runs on Linux runners; Windows bash cannot execute the extracted script.
test.skipIf(process.platform === "win32")("workflow data extraction renders exactly the old v0.7.4 stable, candidate and provenance notes", async () => {
  const old = originals.dcfa0b3![".github/workflows/signed-release.yml"]!;
  const changed = await readFile(join(root, ".github/workflows/signed-release.yml"), "utf8");
  const directory = await materialize({ [RELEASE_TEXT]: releaseText });
  try {
    const render = async (workflow: string, channel: string, tag: string) => {
      const start = workflow.indexOf('          if [[ "$GITHUB_REF_NAME" == provenance-test-* ]]; then');
      const end = workflow.indexOf("\n          fi\n", start) + "\n          fi".length;
      const script = workflow.slice(start, end).replace(/^          /gmu, "");
      const process = Bun.spawn(["bash", "-euo", "pipefail", "-c", script + '\ncat "$notes"'], {
        cwd: directory, env: { ...globalThis.process.env, notes: join(directory, "notes.md"), GITHUB_REF_NAME: tag, OMP_RELEASE_CHANNEL: channel, PACKAGE_VERSION: "0.7.4", QUALIFIED_PREVIOUS_TAG: "v0.7.3", GITHUB_SHA: "dcfa0b32503ca83e71e15d2872eff920831b14ac", GITHUB_REPOSITORY: "alphastorm/omp-session-gateway", upstream_commit: "d0cc52397dc2a68d39cba49b0009b9e50ffd643e", upstream_tag: "v18.5.1" }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(process.stdout).text();
      expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
      return output;
    };
    for (const [channel, tag] of [["stable", "v0.7.4"], ["pre-alpha", "v0.7.4-prealpha.1"], ["pre-alpha", "provenance-test-v0.7.4.1"]]) {
      expect(await render(changed, channel!, tag!)).toBe(await render(old, channel!, tag!));
    }
    for (const phrase of ["v0.7.3", "v18.5.1", "Pixel 10 Pro"]) expect(changed).not.toContain(phrase);
    expect(changed).toContain("jq -e '[.highlights");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI writes only the computed files; missing inputs exit 1 without writes", async () => {
  const directory = await materialize(prepareBefore);
  try {
    const changed = await runReleaseGenerate(["prepare", "0.7.4", "--date", "2026-10-03"], directory);
    for (const path of changed) expect(await readFile(join(directory, path), "utf8")).toBe(prepared[path]!);
    const child = Bun.spawn([process.execPath, join(root, "scripts/release-generate.ts"), "record", "v0.7.4", "--date", "2026-10-03"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("missing required --smoke");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
