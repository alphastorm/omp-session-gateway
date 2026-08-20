import { describe, expect, test } from "bun:test";
import { targetEligibility } from "./acceptance-target.ts";

const NOW = Date.parse("2026-08-20T16:00:00.000Z");
const fresh = new Date(NOW - 60_000).toISOString();
const old = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();

describe("acceptance target eligibility", () => {
  test("refuses a protected label even when fresh and acknowledged", () => {
    // The concrete incident: `omp-soak2` was an 8-hour relay soak's own host session, and three runs
    // fired real launches into its relay room until its collab host faulted at 7h40m. A protected
    // label must be unusable, not merely discouraged, so the acknowledgement must not rescue it.
    for (const label of ["omp-soak2", "relay-endurance", "omp-monorepo", ".dotfiles-private", "alpha-founder"]) {
      const verdict = targetEligibility(label, fresh, NOW, true);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain("protected pattern");
    }
  });

  test("accepts a fresh disposable fixture", () => {
    expect(targetEligibility("omp-accept-scratch", fresh, NOW, false)).toEqual({ eligible: true });
  });

  test("refuses a long-lived session unless explicitly acknowledged", () => {
    const refused = targetEligibility("omp-accept-scratch", old, NOW, false);
    expect(refused.eligible).toBe(false);
    expect(refused.reason).toContain("--disposable-target");
    expect(targetEligibility("omp-accept-scratch", old, NOW, true)).toEqual({ eligible: true });
  });

  test("treats a missing or unparseable start time as too old", () => {
    // Fail closed. An absent timestamp previously would have read as age zero, which is exactly the
    // wrong default for a destructive fixture.
    for (const startedAt of [undefined, "not-a-date"]) {
      const verdict = targetEligibility("omp-accept-scratch", startedAt, NOW, false);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain("unknown age");
    }
  });
});
