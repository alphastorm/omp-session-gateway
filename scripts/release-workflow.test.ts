import { describe, expect, test } from "bun:test";

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text()) as {
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
  test("checks main ancestry before executing tagged repository code", () => {
    const run = runStep("Validate signed release tag and derive its channel");
    ordered(
      run,
      "jq -er '.version' package.json",
      "git merge-base --is-ancestor",
      "bun scripts/release-tag-state.ts",
      "bun scripts/release-policy.ts",
      "STABLE_RELEASE.lock.json",
    );
  });

  test("revalidates signed tag state around the complete draft transition", () => {
    const run = runStep("Create complete draft release");
    ordered(run, "bun scripts/release-tag-state.ts", "gh release create", "draft_state=", "assets.length !== 6");
  });

  test("revalidates tag state before publishing and checks the resulting channel flags", () => {
    const run = runStep("Publish release once");
    ordered(
      run,
      "bun scripts/release-tag-state.ts",
      "gh release edit",
      "published_state=",
      "state.isLatest",
      "state.isPrerelease",
      "state.assets.length !== 6",
    );
  });
});
