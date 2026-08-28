import { describe, expect, test } from "bun:test";

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/signed-release.yml", import.meta.url)).text()) as {
  jobs: { "build-attest-sign-release": { steps: WorkflowStep[] } };
};
const steps = workflow.jobs["build-attest-sign-release"].steps;

function runStep(name: string): string {
  const run = steps.find(step => step.name === name)?.run;
  if (run === undefined) throw new Error("missing workflow step: " + name);
  return run;
}

function ordered(run: string, ...needles: string[]): void {
  let previous = -1;
  for (const needle of needles) {
    const index = run.indexOf(needle);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("release workflow trust ordering", () => {
  test("uses only the hardened workflow path", async () => {
    expect(await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).exists()).toBe(false);
    expect(await Bun.file(new URL("../.github/workflows/signed-release.yml", import.meta.url)).exists()).toBe(true);
  });

  test("binds checkout and candidate evidence before executing release gates", () => {
    const run = runStep("Validate signed release tag and derive its channel");
    ordered(
      run,
      "git rev-parse HEAD",
      "git merge-base --is-ancestor",
      "bun scripts/release-tag-state.ts",
      "bun scripts/release-policy.ts",
      "candidateSourceCommit",
      "candidateArchiveSha256",
      "candidate_previous",
      "previousTag",
      "gh release view",
    );
  });

  test("byte-compares the stable managed runtime with the qualified candidate", () => {
    const validate = runStep("Validate signed release tag and derive its channel");
    expect(validate).toContain("QUALIFIED_CANDIDATE_TAG");
    expect(validate).toContain("QUALIFIED_CANDIDATE_SHA256");
    const run = runStep("Compare stable runtime with qualified candidate");
    ordered(run, "gh release download", "sha256sum --check", "tar -xf", "find .", "diff --unified", "cmp --silent");
    for (const expectedDifference of [
      "release-info.json",
      "SBOM.spdx.json",
      "STABLE_RELEASE.lock.json",
      "schemas/stable-release.schema.json",
    ]) {
      expect(run).toContain(expectedDifference);
    }
    expect(run).toContain("candidate-members.txt");
    expect(run).toContain("stable-members.txt");
  });

  test("revalidates the signed tag immediately before public provenance", () => {
    expect(runStep("Revalidate signed tag before public provenance")).toContain("bun scripts/release-tag-state.ts");
  });

  test("retries complete draft observation before deleting a failed draft", () => {
    const run = runStep("Create complete draft release");
    ordered(
      run,
      "bun scripts/release-tag-state.ts",
      "gh release create",
      "for delay in 0 2 4 8",
      "bun scripts/release-state.ts",
      "dist/release",
      "gh release delete",
    );
    expect(run).not.toContain("--json assets,isDraft,isLatest");
  });

  test("revalidates after publishing and retries before deletion compensation", () => {
    const run = runStep("Publish release once");
    expect(run.match(/bun scripts\/release-tag-state\.ts/gu)).toHaveLength(2);
    ordered(
      run,
      "gh release edit",
      "for delay in 0 2 4 8",
      "bun scripts/release-state.ts",
      "dist/release",
      "gh release delete",
    );
  });
});
