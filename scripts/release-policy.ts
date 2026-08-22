export type ReleaseChannel = "pre-alpha" | "alpha" | "beta" | "stable";

export interface ReleasePolicy {
  readonly channel: ReleaseChannel;
  readonly prerelease: boolean;
  readonly latest: boolean;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const POSITIVE_INTEGER = "[1-9][0-9]*";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const QUALIFICATION_KEYS = [
  "$schema",
  "approvedAt",
  "candidateArchiveSha256",
  "candidateSourceCommit",
  "candidateTag",
  "evidence",
  "releaseSourceCommit",
  "releaseTag",
  "runtimeByteComparison",
  "schemaVersion",
  "status",
  "version",
] as const;
const EVIDENCE_KEYS = ["android", "debian", "macos", "ompPublication", "provenance", "secretSinks"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(label + " has unexpected fields");
  }
}

/** Stable tags are authorized only by a commit-bound, fully passed qualification manifest. */
export function assertStableReleaseQualification(
  value: unknown,
  tag: string,
  version: string,
  sourceCommit: string,
): void {
  const qualification = record(value, "stable release qualification");
  exactKeys(qualification, QUALIFICATION_KEYS, "stable release qualification");
  if (qualification.$schema !== "./schemas/stable-release.schema.json" || qualification.schemaVersion !== 1) {
    throw new Error("stable release qualification schema is unsupported");
  }
  if (qualification.version !== version || qualification.releaseTag !== tag) {
    throw new Error("stable release qualification does not match the requested tag");
  }
  if (qualification.status !== "qualified") {
    throw new Error("stable release qualification is pending");
  }
  if (qualification.releaseSourceCommit !== sourceCommit || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("stable release qualification is not bound to GITHUB_SHA");
  }
  const candidatePattern = new RegExp(
    "^v" + version.replaceAll(".", "\\.") + "-prealpha\\." + POSITIVE_INTEGER + "$",
    "u",
  );
  if (
    typeof qualification.candidateTag !== "string" ||
    !candidatePattern.test(qualification.candidateTag) ||
    typeof qualification.candidateSourceCommit !== "string" ||
    !COMMIT_PATTERN.test(qualification.candidateSourceCommit) ||
    typeof qualification.candidateArchiveSha256 !== "string" ||
    !SHA256_PATTERN.test(qualification.candidateArchiveSha256) ||
    qualification.runtimeByteComparison !== "passed"
  ) {
    throw new Error("stable release candidate evidence is incomplete");
  }
  const evidence = record(qualification.evidence, "stable release evidence");
  exactKeys(evidence, EVIDENCE_KEYS, "stable release evidence");
  if (EVIDENCE_KEYS.some(key => evidence[key] !== "passed")) {
    throw new Error("stable release evidence is incomplete");
  }
  if (typeof qualification.approvedAt !== "string" || !Number.isFinite(Date.parse(qualification.approvedAt))) {
    throw new Error("stable release qualification has no approval timestamp");
  }
}

/** Exact tag-to-publication policy. Unknown shapes fail before a release build starts. */
export function releasePolicy(tag: string, version: string): ReleasePolicy {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`package version must be numeric major.minor.patch, not ${JSON.stringify(version)}`);
  }

  const base = `v${version}`;
  if (tag === base) return { channel: "stable", prerelease: false, latest: true };
  if (new RegExp(`^${base.replaceAll(".", "\\.")}-prealpha\\.${POSITIVE_INTEGER}$`, "u").test(tag)) {
    return { channel: "pre-alpha", prerelease: true, latest: false };
  }
  if (new RegExp(`^${base.replaceAll(".", "\\.")}-alpha(?:\\.${POSITIVE_INTEGER})?$`, "u").test(tag)) {
    return { channel: "alpha", prerelease: true, latest: false };
  }
  if (new RegExp(`^${base.replaceAll(".", "\\.")}-beta(?:\\.${POSITIVE_INTEGER})?$`, "u").test(tag)) {
    return { channel: "beta", prerelease: true, latest: false };
  }
  if (new RegExp(`^provenance-test-${base.replaceAll(".", "\\.")}\\.${POSITIVE_INTEGER}$`, "u").test(tag)) {
    return { channel: "pre-alpha", prerelease: true, latest: false };
  }

  throw new Error(
    `tag must be ${base}, ${base}-prealpha.<n>, ${base}-alpha[.<n>], ${base}-beta[.<n>], or provenance-test-${base}.<n> (n >= 1)`,
  );
}

if (import.meta.main) {
  const [tag, version, sourceCommit, qualificationPath] = Bun.argv.slice(2);
  if (tag === undefined || version === undefined || sourceCommit === undefined || qualificationPath === undefined) {
    console.error(
      "usage: bun scripts/release-policy.ts <tag> <package-version> <source-commit> <qualification-manifest>",
    );
    process.exit(2);
  }
  try {
    const policy = releasePolicy(tag, version);
    if (policy.channel === "stable") {
      assertStableReleaseQualification(await Bun.file(qualificationPath).json(), tag, version, sourceCommit);
    }
    console.log("OMP_RELEASE_CHANNEL=" + policy.channel);
    console.log("RELEASE_IS_PRERELEASE=" + String(policy.prerelease));
    console.log("RELEASE_IS_LATEST=" + String(policy.latest));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
