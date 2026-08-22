interface GitReference {
  readonly ref: unknown;
  readonly object: unknown;
}

interface GitTagObject {
  readonly tag: unknown;
  readonly object: unknown;
  readonly verification: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

/** Require one verified annotated tag that still points at the event commit. */
export function assertReleaseTagState(
  referenceValue: GitReference,
  tagValue: GitTagObject,
  expectedTag: string,
  expectedCommit: string,
): void {
  const reference = record(referenceValue, "GitHub tag reference");
  if (reference.ref !== "refs/tags/" + expectedTag) throw new Error("GitHub tag reference name changed");
  const referenceObject = record(reference.object, "GitHub tag reference object");
  if (referenceObject.type !== "tag" || typeof referenceObject.sha !== "string") {
    throw new Error("release tag must be an annotated tag");
  }

  const tag = record(tagValue, "GitHub annotated tag");
  const target = record(tag.object, "GitHub annotated tag target");
  const verification = record(tag.verification, "GitHub annotated tag verification");
  if (tag.tag !== expectedTag || target.type !== "commit" || target.sha !== expectedCommit) {
    throw new Error("release tag is not bound to GITHUB_SHA");
  }
  if (verification.verified !== true || verification.reason !== "valid") {
    throw new Error("release tag signature is not verified by GitHub");
  }
}

async function githubJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error("GitHub tag lookup failed with status " + response.status);
  return response.json();
}

if (import.meta.main) {
  const [repository, tag, expectedCommit] = Bun.argv.slice(2);
  const token = process.env.GH_TOKEN;
  if (repository === undefined || tag === undefined || expectedCommit === undefined || token === undefined) {
    console.error("usage: GH_TOKEN=... bun scripts/release-tag-state.ts <owner/repo> <tag> <expected-commit>");
    process.exit(2);
  }
  try {
    const base = "https://api.github.com/repos/" + repository;
    const reference = (await githubJson(
      base + "/git/ref/tags/" + encodeURIComponent(tag),
      token,
    )) as GitReference;
    const referenceObject = record(reference.object, "GitHub tag reference object");
    const tagObjectSha = referenceObject.sha;
    if (typeof tagObjectSha !== "string") throw new Error("GitHub tag reference has no object SHA");
    const annotatedTag = (await githubJson(base + "/git/tags/" + tagObjectSha, token)) as GitTagObject;
    assertReleaseTagState(reference, annotatedTag, tag, expectedCommit);
    console.log("verified signed release tag " + tag + " at " + expectedCommit);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
