/**
 * Compares machine-readable qualification evidence against the claims the release ledger makes.
 *
 * The ledger is written by hand from lane output, and a hand-copied number can contradict its own
 * source without anyone noticing: the reboot-persistence lane printed
 * `sessions for qualified user: 1` and then asserted, a line below, that its proof held "only
 * because the session count is zero". Nothing mechanical caught it, because nothing held both
 * halves at once. `evidence-schema.ts` makes a lane emit both halves together; this checker is the
 * comparison.
 *
 * Four disagreements are detected:
 *   1. a record naming a ledger row that does not exist — the row was renamed or the lane guessed;
 *   2. a row claiming PASS while its most recent record contains a failed assertion;
 *   3. a record citing a candidate the row's text never mentions — the row was not updated;
 *   4. an assertion whose `{count=N}` narrative claim disagrees with its measured value.
 *
 * Deliberately not wired into `bun run check`; whether a red checker may block the build is the
 * lead's call, not this file's.
 *
 * usage: bun scripts/check-evidence.ts [--ledger docs/RELEASE_STATUS.md] <record.json> [...]
 */
import { readFile } from "node:fs/promises";
import { claimedCounts, validateEvidenceRecord, type EvidenceRecord } from "./evidence-schema.ts";

/**
 * Every status the ledger's own "Status rules" table defines, not only the three currently in use.
 * A row set to `NOT RUN` tomorrow must still parse as a row: an unparsed row reads as a missing
 * row, which would report the lane's evidence as bearing on nothing.
 */
export const LEDGER_STATUSES = ["PASS", "PARTIAL", "NOT RUN", "BLOCKED", "N/A"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerRow {
  /** The row's first cell, verbatim, Markdown and all. */
  readonly name: string;
  readonly status: LedgerStatus;
  /** Every cell after the status, joined; the row's whole prose claim. */
  readonly text: string;
  /** 1-based line in the ledger, so a disagreement can be opened where it lives. */
  readonly line: number;
}

/**
 * Reads every table row whose second cell is a status. That shape is what a ledger row is, in both
 * the "Recorded implementation evidence" and "Alpha gate ledger" tables, and it excludes the
 * "Status rules" vocabulary table, whose statuses sit in the first cell with prose beside them.
 */
export function parseLedger(markdown: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const [index, raw] of markdown.split("\n").entries()) {
    const line = raw.trimEnd();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    const name = cells[0];
    const second = cells[1];
    if (name === undefined || second === undefined || cells.length < 3) continue;
    const status = LEDGER_STATUSES.find(known => second === known || second === `**${known}**`);
    if (status === undefined) continue;
    rows.push({ name, status, text: cells.slice(2).join(" "), line: index + 1 });
  }
  return rows;
}

/**
 * Row names are compared with Markdown punctuation dropped, whitespace collapsed, and case
 * folded, because the ledger spells a row `Physical Android \`v0.1.0-prealpha.4\` trial` while a
 * lane's JSON would carry the plain words. A lane that mis-capitalises a row name should be
 * corrected by review, not told its row does not exist.
 */
export function normalizeRowName(name: string): string {
  return name.replace(/[`*]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * True when the text cites this exact candidate. A match glued to a longer identifier does not
 * count: the ledger mentioning `v0.1.0-prealpha.17` must not satisfy a record citing
 * `v0.1.0-prealpha.1`, which is a different artifact and a real transcription slip.
 */
export function mentionsCandidate(text: string, candidate: string): boolean {
  const boundary = /[0-9A-Za-z]/u;
  for (let at = text.indexOf(candidate); at !== -1; at = text.indexOf(candidate, at + 1)) {
    const before = text[at - 1];
    const after = text[at + candidate.length];
    if ((before === undefined || !boundary.test(before)) && (after === undefined || !boundary.test(after))) return true;
  }
  return false;
}

export interface EvidenceSource {
  /** Where the record came from, as named on the command line. */
  readonly source: string;
  readonly record: EvidenceRecord;
}

export interface Disagreement {
  readonly row: string;
  readonly expectation: string;
  readonly measured: string;
  readonly source: string;
}

export function checkEvidence(rows: readonly LedgerRow[], records: readonly EvidenceSource[]): Disagreement[] {
  const found: Disagreement[] = [];
  const byRow = new Map<string, EvidenceSource[]>();

  for (const entry of records) {
    const { source, record } = entry;
    const key = normalizeRowName(record.row);
    const matching = rows.filter(row => normalizeRowName(row.name) === key);
    const bucket = byRow.get(key);
    if (bucket === undefined) byRow.set(key, [entry]);
    else bucket.push(entry);

    if (matching.length === 0) {
      found.push({
        row: record.row,
        expectation: "a ledger row with this name",
        measured: "no row in the ledger carries it",
        source,
      });
    } else if (!matching.some(row => mentionsCandidate(row.text, record.candidate))) {
      // Reported per record rather than per row: the row may legitimately cite several candidates,
      // but a record whose candidate appears in none of them is evidence for something else.
      found.push({
        row: record.row,
        expectation: `row text (line ${matching.map(row => row.line).join(", ")}) to mention the candidate this record measured`,
        measured: `candidate ${record.candidate}, which the row text does not mention`,
        source,
      });
    }

    for (const assertion of record.assertions) {
      for (const claimed of claimedCounts(assertion.narrative)) {
        const measured = assertion.measured.trim();
        if (!/^\d+$/u.test(measured)) {
          found.push({
            row: record.row,
            expectation: `assertion "${assertion.name}" claims count ${claimed}, so its measured value must be a count`,
            measured: `${JSON.stringify(assertion.measured)}, which is not a count`,
            source,
          });
        } else if (Number(measured) !== claimed) {
          found.push({
            row: record.row,
            expectation: `assertion "${assertion.name}" claims count ${claimed}`,
            measured,
            source,
          });
        }
      }
    }
  }

  for (const [key, entries] of byRow) {
    const claimingPass = rows.filter(row => normalizeRowName(row.name) === key && row.status === "PASS");
    if (claimingPass.length === 0) continue;
    // Only the most recent record judges the row; an older failure that was since fixed is
    // history, not a disagreement. Ties all count, because picking one of two simultaneous records
    // would decide a release gate by file order.
    const newest = Math.max(...entries.map(entry => Date.parse(entry.record.recordedAt)));
    for (const entry of entries) {
      if (Date.parse(entry.record.recordedAt) !== newest) continue;
      for (const assertion of entry.record.assertions) {
        if (assertion.outcome !== "fail") continue;
        for (const row of claimingPass) {
          found.push({
            row: row.name,
            expectation: `line ${row.line} claims PASS, so assertion "${assertion.name}" of ${entry.record.recordedAt} must pass`,
            measured: `${assertion.measured} (outcome fail)`,
            source: entry.source,
          });
        }
      }
    }
  }
  return found;
}

/** Reads and validates one record file. Returns errors verbatim so the caller can print and count them. */
export async function loadRecord(path: string): Promise<{ readonly entry?: EvidenceSource; readonly errors: readonly string[] }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { errors: [`${path}: cannot be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { errors: [`${path}: is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const validation = validateEvidenceRecord(parsed);
  if (!validation.ok) return { errors: validation.errors.map(message => `${path}: ${message}`) };
  return { entry: { source: path, record: validation.record }, errors: [] };
}

const USAGE = "usage: bun scripts/check-evidence.ts [--ledger docs/RELEASE_STATUS.md] <record.json> [...]";

async function main(argv: readonly string[]): Promise<number> {
  const remaining = [...argv];
  const recordPaths: string[] = [];
  let ledger = { path: new URL("../docs/RELEASE_STATUS.md", import.meta.url).pathname, label: "docs/RELEASE_STATUS.md" };
  while (remaining.length > 0) {
    const arg = remaining.shift();
    if (arg === undefined) break;
    if (arg === "--ledger") {
      const given = remaining.shift();
      if (given === undefined) {
        console.error(`--ledger needs a path\n${USAGE}`);
        return 2;
      }
      ledger = { path: given, label: given };
    } else if (arg.startsWith("--")) {
      console.error(`unknown option ${arg}\n${USAGE}`);
      return 2;
    } else {
      recordPaths.push(arg);
    }
  }
  if (recordPaths.length === 0) {
    console.error(USAGE);
    return 2;
  }

  let rows: LedgerRow[];
  try {
    rows = parseLedger(await readFile(ledger.path, "utf8"));
  } catch (error) {
    console.error(`${ledger.label}: cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (rows.length === 0) {
    // Fail loudly: an empty row set would silently report every record as bearing on nothing.
    console.error(`${ledger.label}: no status rows found; this does not look like the ledger`);
    return 2;
  }

  const entries: EvidenceSource[] = [];
  const invalid: string[] = [];
  for (const path of recordPaths) {
    const loaded = await loadRecord(path);
    if (loaded.entry !== undefined) entries.push(loaded.entry);
    invalid.push(...loaded.errors);
  }

  const disagreements = checkEvidence(rows, entries);
  for (const message of invalid) console.error(`invalid evidence record: ${message}`);
  for (const item of disagreements) {
    console.error(`\ndisagreement on row: ${item.row}`);
    console.error(`  expected: ${item.expectation}`);
    console.error(`  measured: ${item.measured}`);
    console.error(`  evidence: ${item.source}`);
  }
  if (invalid.length > 0 || disagreements.length > 0) {
    console.error(
      `\nevidence check failed: ${disagreements.length} disagreement(s), ${invalid.length} invalid-record error(s) across ${recordPaths.length} record(s) and ${rows.length} ledger rows`,
    );
    return 1;
  }
  console.log(`evidence check passed: ${entries.length} record(s) agree with ${rows.length} ledger rows in ${ledger.label}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
