/**
 * Decides whether a published session may be used as a destructive test fixture.
 *
 * This module exists because of a specific, avoidable loss. `scripts/android-acceptance.ts` fires
 * real `view`, `control`, and stale-generation launches at whatever session it is pointed at. Three
 * runs were pointed at `omp-soak2`, which was an 8-hour relay endurance soak's own host session,
 * chosen only because it was the first published label that looked familiar. Its collaboration host
 * faulted at 7h40m and the endurance result was lost.
 *
 * The rule "do not target a session you do not own" was known and still broken, so it is encoded
 * here rather than left to memory. It lives in its own module so it can be tested without a device
 * and without executing the harness's top-level argument parsing.
 */

/** Labels that can never be a target, at any age, with or without an override. */
const PROTECTED_LABEL_PATTERN = /soak|relay|monorepo|dotfiles|alpha-founder/iu;

/**
 * Checked before any network lookup, so a protected label is refused whether or not it is currently
 * published. The refusal must not depend on the state of the thing it is protecting.
 */
export function isProtectedLabel(label: string): boolean {
  return PROTECTED_LABEL_PATTERN.test(label);
}

/** A session running longer than this is somebody's real work, not a disposable fixture. */
export const DISPOSABLE_MAX_AGE_MS = 30 * 60 * 1000;

export interface TargetEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

/**
 * Pure and deliberately fail-closed: an absent or unparseable start time is treated as too old
 * rather than assumed fresh, because the wrong default here destroys someone's running work.
 */
export function targetEligibility(
  label: string,
  startedAt: string | undefined,
  now: number,
  acknowledgedDisposable: boolean,
): TargetEligibility {
  if (PROTECTED_LABEL_PATTERN.test(label)) {
    return { eligible: false, reason: `"${label}" matches a protected pattern and can never be a target` };
  }
  const started = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const ageMs = Number.isFinite(started) ? now - started : Number.POSITIVE_INFINITY;
  if (ageMs > DISPOSABLE_MAX_AGE_MS && !acknowledgedDisposable) {
    const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 60000)} minutes old` : "of unknown age";
    return {
      eligible: false,
      reason: `"${label}" is ${age}, so it is probably real work; pass --disposable-target to override`,
    };
  }
  return { eligible: true };
}
