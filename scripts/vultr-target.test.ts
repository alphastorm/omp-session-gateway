import { describe, expect, test } from "bun:test";
import { instanceEligibility, QUAL_LABEL_PREFIX } from "./vultr-target.ts";

// Synthetic ids only. This repository is public, so no real instance identifier belongs in it.
const PROTECTED_ID = "00000000-0000-4000-8000-00000000dead";
const OWNED_ID = "11111111-1111-4111-8111-111111111111";
const env = { OMP_QUAL_PROTECTED_INSTANCES: PROTECTED_ID };

describe("vultr instance eligibility", () => {
  test("refuses a protected instance even when it carries this lane's own prefix", () => {
    // Belt and braces: the positive label rule would already refuse an unowned instance, but the id
    // check means a relabelling accident cannot expose a protected one either.
    const verdict = instanceEligibility(PROTECTED_ID, `${QUAL_LABEL_PREFIX}oops`, env);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("OMP_QUAL_PROTECTED_INSTANCES");
  });

  test("refuses any instance this lane did not create", () => {
    // The rule is positive on purpose. A denylist cannot anticipate instances added to the account
    // after this code was written, and those are exactly the ones most likely to be someone's work.
    for (const label of ["some-other-box", "prod-web", "", "   ", "winqual-typo"]) {
      expect(instanceEligibility(OWNED_ID, label, env).eligible).toBe(false);
    }
  });

  test("refuses an instance whose label cannot be read", () => {
    const verdict = instanceEligibility(OWNED_ID, undefined, env);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("ownership cannot be established");
  });

  test("accepts only an instance carrying this lane's prefix", () => {
    expect(instanceEligibility(OWNED_ID, `${QUAL_LABEL_PREFIX}2026-08-20`, env)).toEqual({ eligible: true });
  });

  test("an unset protected list still refuses everything unowned", () => {
    // The positive rule must stand alone; the environment list is defence in depth, not the control.
    expect(instanceEligibility(PROTECTED_ID, "some-other-box", {}).eligible).toBe(false);
  });
});
