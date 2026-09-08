import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

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

// Execute the shipped shell, substituting only external GitHub/git verification boundaries.
// Release policy and signature verification have their own behavioral suites.
async function exerciseGate(step: string, latest: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-release-gate-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
    await writeFile(join(root, "STABLE_RELEASE.lock.json"), JSON.stringify({
      candidateTag: "v0.3.0-prealpha.3",
      candidateSourceCommit: "a".repeat(40),
      candidateArchiveSha256: "b".repeat(64),
      previousTag: "v0.2.1",
    }));
    const child = Bun.spawn(["bash", "-c", `
git() { if [ "$1" = rev-parse ]; then printf '%s\\n' "$GITHUB_SHA"; fi; }
bun() { if [ "$1" = scripts/release-policy.ts ]; then printf 'OMP_RELEASE_CHANNEL=stable\\n'; fi; }
gh() {
  if [ "$1" = api ]; then printf '%s\\n' "$TEST_LATEST";
  elif [ "$1 $2" = 'release view' ]; then printf 'sha256:%s\\n' "$TEST_DIGEST";
  elif [ "$1 $2" = 'release edit' ]; then printf 'PUBLICATION_EFFECT\\n';
  else return 91; fi
}
${runStep(step)}
`], {
      cwd: root,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, "github-env"),
        GITHUB_SHA: "a".repeat(40),
        GITHUB_REPOSITORY: "example/gateway",
        GITHUB_REF_NAME: "v0.3.0",
        RELEASE_IS_LATEST: "true",
        RELEASE_IS_PRERELEASE: "false",
        QUALIFIED_PREVIOUS_TAG: "v0.2.1",
        TEST_LATEST: latest,
        TEST_DIGEST: "b".repeat(64),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")("stable admission accepts the qualified current predecessor, not a hardcoded release", async () => {
  const accepted = await exerciseGate("Validate signed release tag and derive its channel", "v0.2.1");
  expect(accepted.code).toBe(0);
  const stale = await exerciseGate("Validate signed release tag and derive its channel", "v0.2.2");
  expect(stale.code).not.toBe(0);
  expect(stale.stderr).toContain("Qualified rollback predecessor must match GitHub Latest");
});

test.skipIf(process.platform === "win32")("stable publication refuses predecessor drift before changing GitHub Latest", async () => {
  const drifted = await exerciseGate("Publish release once", "v0.2.2");
  expect(drifted.code).not.toBe(0);
  expect(drifted.stdout).not.toContain("PUBLICATION_EFFECT");
  const accepted = await exerciseGate("Publish release once", "v0.2.1");
  expect(accepted.code).toBe(0);
  expect(accepted.stdout).toContain("PUBLICATION_EFFECT");
});
