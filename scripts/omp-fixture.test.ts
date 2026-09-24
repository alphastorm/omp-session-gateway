import { expect, test } from "bun:test";
import { fixtureModelError, OMP_FIXTURE_MODEL } from "./omp-fixture.ts";

// OMP 18.3.0 published a fixture host with no model when it could not resolve the fixture's model,
// then rejected the Control prompt; the lanes only noticed a minute later at the prompt stage.
test("a published fixture without a resolved model is refused with the model it could not resolve", () => {
  for (const session of [{}, { model: null }, { model: "" }]) {
    expect(fixtureModelError(session)).toContain(OMP_FIXTURE_MODEL);
  }
  expect(fixtureModelError({ model: "openai/gpt-5.4-mini" })).toBeUndefined();
});
