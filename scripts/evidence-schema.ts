/**
 * The machine-readable evidence record a qualification lane emits, plus its validator.
 *
 * Every number in `docs/RELEASE_STATUS.md` is transcribed by hand out of a lane's scrollback. That
 * is how the reboot-persistence lane came to print `sessions for qualified user: 1` and then
 * assert, a line below, that the proof held "only because the session count is zero". Both
 * statements were on the same screen and nothing compared them, because nothing could: the claim
 * was English prose and the measurement was a number in a different column of a different line.
 *
 * A record fixes the pairing. Each assertion carries the sentence that will reach the ledger next
 * to the value that was actually measured, so `check-evidence.ts` can compare the two.
 *
 * Validation is strict and rejects unknown fields. A silently ignored field is exactly how a claim
 * drifts from its evidence: a lane renames `measured` to `value`, a permissive validator shrugs,
 * and the record now carries no measurement at all while still reading like proof. There is no
 * schema library among this repository's dependencies and this file is not a reason to add one —
 * the shape is seven fields deep and hand-checking it costs less than a dependency review.
 */

/**
 * Bumped only when the record shape changes incompatibly. A record states the version it was
 * written against so an old record fails loudly instead of being read under new rules.
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** Outcomes a lane may record. Anything else is a lane bug, not a third kind of result. */
export const ASSERTION_OUTCOMES = ["pass", "fail"] as const;
export type AssertionOutcome = (typeof ASSERTION_OUTCOMES)[number];

export interface EvidenceAssertion {
  /** Stable name of the invariant, matching what the lane prints in its own INVARIANT column. */
  readonly name: string;
  /** The sentence intended for the ledger. May carry one `{count=N}` claim; see below. */
  readonly narrative: string;
  /** Exactly one measured value, verbatim as the lane observed it. */
  readonly measured: string;
  readonly outcome: AssertionOutcome;
}

export interface EvidenceRecord {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  /** The ledger row this record bears on, spelled as the row's first cell. */
  readonly row: string;
  /** Candidate artifact tag or build id the measurement was taken against. */
  readonly candidate: string;
  /** Host platform, e.g. `linux-x86_64` or `darwin-arm64`. */
  readonly platform: string;
  /** Host OS version string, e.g. `Debian 13 (trixie) kernel 6.12.94`. */
  readonly osVersion: string;
  /** ISO 8601 UTC instant the measurement was taken. */
  readonly recordedAt: string;
  readonly assertions: readonly EvidenceAssertion[];
}

/**
 * The one narrative claim a checker can verify mechanically.
 *
 * Arbitrary English cannot be parsed, so the convention is narrow: a lane states its claim about
 * its own measured value as a single token `{count=N}`, N a non-negative decimal integer, anywhere
 * in the narrative. `check-evidence.ts` compares N with the measured value and ignores every other
 * numeral in the sentence, so prose stays prose. The persistence lane's sentence would have been
 * written `"... holds only because the session count is zero {count=0}"` with measured `"1"`, and
 * the contradiction becomes arithmetic instead of a reading-comprehension exercise.
 *
 * An assertion measures exactly one value, so it may carry at most one token; the validator
 * rejects a second, because two claims against one measurement have no defined meaning.
 */
export const COUNT_CLAIM_PATTERN = /\{count=(\d+)\}/gu;

/** Every count this narrative claims, in order. Empty when the narrative makes no claim. */
export function claimedCounts(narrative: string): number[] {
  return [...narrative.matchAll(COUNT_CLAIM_PATTERN)].map(match => Number(match[1]));
}

export type EvidenceValidation =
  | { readonly ok: true; readonly record: EvidenceRecord }
  | { readonly ok: false; readonly errors: readonly string[] };

const RECORD_FIELDS = ["schemaVersion", "row", "candidate", "platform", "osVersion", "recordedAt", "assertions"] as const;
const ASSERTION_FIELDS = ["name", "narrative", "measured", "outcome"] as const;

/** Second-resolution UTC, optionally with milliseconds. A local offset would make ordering ambiguous. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function readText(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${path}: expected a string, got ${describe(value)}`);
    return undefined;
  }
  if (value.trim() === "") {
    errors.push(`${path}: must not be empty`);
    return undefined;
  }
  return value;
}

/**
 * Rejects a date that parses to a different instant than it names, such as `2026-02-31`, which
 * `Date.parse` happily rolls forward into March. A timestamp that silently moves is worse than one
 * that is refused, because record recency decides which evidence a gate is judged against.
 */
function readTimestamp(value: unknown, path: string, errors: string[]): string | undefined {
  const text = readText(value, path, errors);
  if (text === undefined) return undefined;
  if (!ISO_UTC_PATTERN.test(text)) {
    errors.push(`${path}: expected an ISO 8601 UTC instant such as 2026-08-21T09:30:00Z, got "${text}"`);
    return undefined;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || !new Date(parsed).toISOString().startsWith(text.slice(0, 19))) {
    errors.push(`${path}: "${text}" is not a real instant`);
    return undefined;
  }
  return text;
}

function readAssertion(value: unknown, path: string, errors: string[]): EvidenceAssertion | undefined {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected an object, got ${describe(value)}`);
    return undefined;
  }
  collectUnknownFields(value, ASSERTION_FIELDS, path, errors);
  const name = readText(value.name, `${path}.name`, errors);
  const narrative = readText(value.narrative, `${path}.narrative`, errors);
  const measured = readText(value.measured, `${path}.measured`, errors);
  // `find` rather than `includes` so the narrowed literal type falls out without a cast.
  const outcome = ASSERTION_OUTCOMES.find(known => known === value.outcome);
  if (outcome === undefined) {
    errors.push(`${path}.outcome: expected one of ${ASSERTION_OUTCOMES.join(", ")}, got ${JSON.stringify(value.outcome)}`);
  }
  const claims = narrative === undefined ? [] : claimedCounts(narrative);
  if (claims.length > 1) {
    errors.push(`${path}.narrative: states ${claims.length} count claims; an assertion measures one value, so it may state at most one`);
  }
  if (name === undefined || narrative === undefined || measured === undefined || outcome === undefined) return undefined;
  return { name, narrative, measured, outcome };
}

/**
 * Validates an already-parsed JSON value. Returns every error rather than the first, so a lane
 * author fixes a record in one pass instead of one field per run.
 */
export function validateEvidenceRecord(input: unknown): EvidenceValidation {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [`record: expected an object, got ${describe(input)}`] };
  }
  collectUnknownFields(input, RECORD_FIELDS, "record", errors);
  if (input.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    errors.push(`record.schemaVersion: expected ${EVIDENCE_SCHEMA_VERSION}, got ${JSON.stringify(input.schemaVersion)}`);
  }
  const row = readText(input.row, "record.row", errors);
  const candidate = readText(input.candidate, "record.candidate", errors);
  const platform = readText(input.platform, "record.platform", errors);
  const osVersion = readText(input.osVersion, "record.osVersion", errors);
  const recordedAt = readTimestamp(input.recordedAt, "record.recordedAt", errors);

  const assertions: EvidenceAssertion[] = [];
  if (!Array.isArray(input.assertions)) {
    errors.push(`record.assertions: expected an array, got ${describe(input.assertions)}`);
  } else if (input.assertions.length === 0) {
    // A record with no assertions measures nothing, and a gate must never be able to cite one.
    errors.push("record.assertions: must contain at least one assertion");
  } else {
    for (const [index, entry] of input.assertions.entries()) {
      const assertion = readAssertion(entry, `record.assertions[${index}]`, errors);
      if (assertion !== undefined) assertions.push(assertion);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (row === undefined || candidate === undefined || platform === undefined || osVersion === undefined || recordedAt === undefined) {
    return { ok: false, errors: ["record: incomplete"] };
  }
  return {
    ok: true,
    record: { schemaVersion: EVIDENCE_SCHEMA_VERSION, row, candidate, platform, osVersion, recordedAt, assertions },
  };
}
