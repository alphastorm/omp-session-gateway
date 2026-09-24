import fixture from "./omp-fixture.json";

/**
 * The model every disposable OMP host in the smoke, qualification, and canary lanes starts with.
 * It must resolve in every supported stock OMP with only the synthetic key below. OMP 18.3.0 no
 * longer offers `openai-codex/gpt-5.4-mini` without a signed-in Codex account, so a fixture using
 * it started with no model and rejected the Control prompt, which surfaced a minute later as a
 * prompt-stage timeout. The JSON file is the single source because the Debian lane reads it with
 * `jq` on a runner that has no Bun.
 */
export const OMP_FIXTURE_MODEL: string = fixture.model;

/** Never a real credential. Lanes also match it to find and stop only their own fixtures. */
export const OMP_FIXTURE_API_KEY = "qualification-synthetic-never-sent";

export const OMP_FIXTURE_ARGS: readonly string[] = [
  "--model",
  OMP_FIXTURE_MODEL,
  "--api-key",
  OMP_FIXTURE_API_KEY,
  "--no-extensions",
  "--no-skills",
  "--thinking",
  "low",
];

/**
 * A fixture that published without a model cannot run the Control prompt, so every lane refuses it
 * at publication with the reason instead of timing out at the prompt stage.
 */
export function fixtureModelError(session: { readonly model?: unknown }): string | undefined {
  if (typeof session.model === "string" && session.model !== "") return undefined;
  return `the OMP fixture published without a model: this OMP did not resolve ${OMP_FIXTURE_MODEL} with the synthetic key, so it would reject the Control prompt`;
}
