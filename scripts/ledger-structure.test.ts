import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Structural guards for the two documents that carry the release decision.
 *
 * These exist because a whitespace-normalising substitution once matched newlines and collapsed
 * both files: `COMPATIBILITY.md` fell from 176 lines to 98 with a single surviving heading, and
 * `RELEASE_STATUS.md` lost all but two of its sections. It reached `main` because the only
 * validation in use counted table delimiters, and table rows happened to survive. Table shape says
 * nothing about whether the surrounding document still exists.
 *
 * Sections are asserted by name rather than by count so that deleting one is a failure even if
 * another is added, and so the failure message names what went missing.
 */

const REQUIRED_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  "docs/RELEASE_STATUS.md": [
    "# Release status",
    "## Status rules",
    "## Recorded implementation evidence",
    "## Alpha gate ledger",
    "## Alpha qualification blockers (historical)",
    "## Known limitations",
    "## Updating this ledger",
  ],
  "docs/COMPATIBILITY.md": [
    "# Compatibility and support policy",
    "## Current claim",
    "## Status vocabulary",
    "## Exact OMP baseline",
    "## Versioned interfaces",
    "## Host and client matrix",
    "## Deployment dependency matrix",
    "## Upstream refresh procedure",
    "## Protocol evolution",
  ],
};

function read(path: string): string[] {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split("\n");
}

describe("release document structure", () => {
  for (const [path, sections] of Object.entries(REQUIRED_SECTIONS)) {
    test(`${path} keeps every required section`, () => {
      const lines = read(path);
      const missing = sections.filter(heading => !lines.includes(heading));
      expect(missing).toEqual([]);
    });

    test(`${path} keeps its tables well formed`, () => {
      // A delimiter row fixes the column count; every body row until the table ends must match it.
      const malformed: string[] = [];
      let expected: number | undefined;
      for (const [index, line] of read(path).entries()) {
        if (!line.startsWith("|")) {
          expected = undefined;
          continue;
        }
        const cells = line.split("|").length;
        if (/^\|[\s:|-]+\|$/u.test(line)) {
          expected = cells;
          continue;
        }
        if (expected !== undefined && cells !== expected) malformed.push(`line ${index + 1}: ${cells} vs ${expected}`);
      }
      expect(malformed).toEqual([]);
    });

    test(`${path} is not collapsed onto a handful of lines`, () => {
      // The specific failure mode: paragraphs merged, so the file shrinks dramatically while
      // remaining valid Markdown. A floor catches it without pinning an exact length.
      const lines = read(path);
      expect(lines.length).toBeGreaterThan(90);
      const overlong = lines.filter(line => !line.startsWith("|") && line.length > 900);
      expect(overlong).toEqual([]);
    });
  }
});

/**
 * Row well-formedness, which the section guards above deliberately do not cover.
 *
 * A programmatic append that targeted a cell by splitting on `" | "` once wrote its text *past* the
 * row's closing pipe, turning a four-column row into five cells with no terminator. Two rows were
 * corrupted that way and reached `main`, because every section heading still existed and the table
 * still rendered plausibly. `scripts/check-evidence.ts` caught it only because the damaged row then
 * became invisible to its parser, which is a lucky second-order symptom rather than a check.
 */
describe("release table rows are well formed", () => {
  for (const path of ["docs/RELEASE_STATUS.md", "docs/COMPATIBILITY.md"]) {
    test(`${path} has no unterminated or over-wide table rows`, () => {
      const malformed: string[] = [];
      // Width is taken from each table's own delimiter row rather than a fixed number, because these
      // documents legitimately contain tables of different widths.
      let expectedCells: number | undefined;
      for (const [index, raw] of readFileSync(path, "utf8").split("\n").entries()) {
        const line = raw.trimEnd();
        if (!line.startsWith("|")) {
          expectedCells = undefined;
          continue;
        }
        if (!line.endsWith("|")) {
          malformed.push(`${path}:${index + 1} unterminated: ${line.slice(0, 48)}`);
          continue;
        }
        const cells = line.split("|").slice(1, -1);
        if (cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))) {
          expectedCells = cells.length;
          continue;
        }
        if (expectedCells !== undefined && cells.length !== expectedCells) {
          malformed.push(`${path}:${index + 1} ${cells.length} cells, table is ${expectedCells}: ${line.slice(0, 48)}`);
        }
      }
      expect(malformed).toEqual([]);
    });
  }
});
