export type ReleaseChannel = "pre-alpha" | "alpha" | "beta" | "stable";

export interface ReleasePolicy {
  readonly channel: ReleaseChannel;
  readonly prerelease: boolean;
  readonly latest: boolean;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const POSITIVE_INTEGER = "[1-9][0-9]*";

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
  const [tag, version] = Bun.argv.slice(2);
  if (tag === undefined || version === undefined) {
    console.error("usage: bun scripts/release-policy.ts <tag> <package-version>");
    process.exit(2);
  }
  try {
    const policy = releasePolicy(tag, version);
    console.log(`OMP_RELEASE_CHANNEL=${policy.channel}`);
    console.log(`RELEASE_IS_PRERELEASE=${String(policy.prerelease)}`);
    console.log(`RELEASE_IS_LATEST=${String(policy.latest)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
