/**
 * Protects instances this project does not own from the Windows qualification lane.
 *
 * The lane creates, reboots, and destroys machines in an account that may also hold production
 * infrastructure, where a misdirected destroy is unrecoverable in a way a disposable machine is not.
 *
 * This exists because the same class of mistake already cost this project an 8-hour relay soak: a
 * harness was pointed at a session it did not create, chosen only because the name looked familiar.
 * The lesson taken was that a rule someone has to remember is not a control, so ownership is
 * enforced here rather than documented.
 *
 * The rule is positive, not a denylist: an instance is eligible only if this lane created it, proven
 * by the exact label prefix it assigns. Anything else — including instances added to the account
 * later, which a denylist could never anticipate — is refused.
 *
 * No infrastructure identifier is committed here. This repository is public, so addresses, instance
 * ids, and hostnames belong in the environment, never in source. `OMP_QUAL_PROTECTED_INSTANCES`
 * carries a comma-separated list of ids that must be refused outright; it is defence in depth behind
 * the positive rule, which already refuses anything this lane did not create.
 */

/** Every instance this lane creates carries this label prefix. Nothing else may be touched. */
export const QUAL_LABEL_PREFIX = "omp-winqual-";

export interface InstanceEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

function protectedIds(environment: Readonly<Record<string, string | undefined>>): ReadonlySet<string> {
  const raw = environment.OMP_QUAL_PROTECTED_INSTANCES ?? "";
  return new Set(
    raw
      .split(",")
      .map(value => value.trim())
      .filter(value => value !== ""),
  );
}

/**
 * Fail-closed: a missing or empty label is refused, because an instance whose label cannot be read
 * is precisely the one that must not be destroyed.
 */
export function instanceEligibility(
  id: string,
  label: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InstanceEligibility {
  if (protectedIds(environment).has(id)) {
    return { eligible: false, reason: "instance is listed in OMP_QUAL_PROTECTED_INSTANCES and can never be a target" };
  }
  if (label === undefined || label.trim() === "") {
    return { eligible: false, reason: "instance has no label, so ownership cannot be established" };
  }
  if (!label.startsWith(QUAL_LABEL_PREFIX)) {
    return {
      eligible: false,
      reason: `instance is labelled "${label}", which this lane did not create; only "${QUAL_LABEL_PREFIX}*" is eligible`,
    };
  }
  return { eligible: true };
}
