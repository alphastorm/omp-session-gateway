import { describe, expect, test } from "bun:test";
import { assertReleaseTagReferenceStable, assertReleaseTagState } from "./release-tag-state.ts";

const TAG = "v0.1.0";
const COMMIT = "a".repeat(40);
const annotatedTag = (overrides: Record<string, unknown> = {}) => ({
  tag: TAG,
  object: { type: "commit", sha: COMMIT },
  verification: { verified: true, reason: "valid" },
  ...overrides,
});
const reference = (overrides: Record<string, unknown> = {}) => ({
  ref: "refs/tags/" + TAG,
  object: { type: "tag", sha: "b".repeat(40) },
  ...overrides,
});

describe("signed release tag state", () => {
  test("accepts a verified annotated tag bound to the event commit", () => {
    expect(() => assertReleaseTagState(reference(), annotatedTag(), TAG, COMMIT)).not.toThrow();
  });

  test("rejects lightweight, moved, nested, or unverified tags", () => {
    expect(() =>
      assertReleaseTagState(reference({ object: { type: "commit", sha: COMMIT } }), annotatedTag(), TAG, COMMIT),
    ).toThrow("release tag must be an annotated tag");
    expect(() =>
      assertReleaseTagState(reference(), annotatedTag({ object: { type: "commit", sha: "c".repeat(40) } }), TAG, COMMIT),
    ).toThrow("release tag is not bound to GITHUB_SHA");
    expect(() =>
      assertReleaseTagState(reference(), annotatedTag({ object: { type: "tag", sha: COMMIT } }), TAG, COMMIT),
    ).toThrow("release tag is not bound to GITHUB_SHA");
    expect(() =>
      assertReleaseTagState(
        reference(),
        annotatedTag({ verification: { verified: false, reason: "unsigned" } }),
        TAG,
        COMMIT,
      ),
    ).toThrow("release tag signature is not verified by GitHub");
  });

  test("rejects a reference name that no longer matches the event", () => {
    expect(() =>
      assertReleaseTagState(reference({ ref: "refs/tags/v0.1.1" }), annotatedTag(), TAG, COMMIT),
    ).toThrow("GitHub tag reference name changed");
  });

  test("rejects a tag reference that moves while its annotated object is inspected", () => {
    expect(() =>
      assertReleaseTagReferenceStable(reference(), reference({ object: { type: "tag", sha: "c".repeat(40) } })),
    ).toThrow("release tag changed during verification");
  });
});
