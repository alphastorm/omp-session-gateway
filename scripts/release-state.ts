const EXPECTED_ASSETS = [
  "SHA256SUMS",
  "SHA256SUMS.sigstore.json",
  "omp-session-gateway-0.1.0-bun.tar",
  "omp-session-gateway-0.1.0-bun.tar.sigstore.json",
  "omp-session-gateway-0.1.0.spdx.json",
  "omp-session-gateway-0.1.0.spdx.json.sigstore.json",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

export function assertReleaseState(
  value: unknown,
  latestTag: string | null,
  expected: {
    readonly tag: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
    readonly latest: boolean;
  },
): void {
  const release = record(value, "GitHub release");
  if (
    release.tag_name !== expected.tag ||
    release.draft !== expected.draft ||
    release.prerelease !== expected.prerelease ||
    (latestTag === expected.tag) !== expected.latest
  ) {
    throw new Error("GitHub release flags do not match the validated policy");
  }
  if (!Array.isArray(release.assets) || release.assets.length !== EXPECTED_ASSETS.length) {
    throw new Error("GitHub release does not contain exactly six assets");
  }
  const names: string[] = [];
  for (const value of release.assets) {
    const asset = record(value, "GitHub release asset");
    if (
      typeof asset.name !== "string" ||
      asset.state !== "uploaded" ||
      typeof asset.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)
    ) {
      throw new Error("GitHub release contains an incomplete asset");
    }
    names.push(asset.name);
  }
  names.sort();
  if (names.some((name, index) => name !== EXPECTED_ASSETS[index])) {
    throw new Error("GitHub release asset names do not match the stable contract");
  }
}

async function githubJson(url: string, token: string, allowNotFound = false): Promise<unknown | null> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error("GitHub release lookup failed with status " + response.status);
  return response.json();
}

if (import.meta.main) {
  const [repository, tag, draft, prerelease, latest] = Bun.argv.slice(2);
  const token = process.env.GH_TOKEN;
  if (
    repository === undefined ||
    tag === undefined ||
    !["true", "false"].includes(draft ?? "") ||
    !["true", "false"].includes(prerelease ?? "") ||
    !["true", "false"].includes(latest ?? "") ||
    token === undefined
  ) {
    console.error(
      "usage: GH_TOKEN=... bun scripts/release-state.ts <owner/repo> <tag> <draft> <prerelease> <latest>",
    );
    process.exit(2);
  }
  try {
    const base = "https://api.github.com/repos/" + repository + "/releases";
    const releases = await githubJson(base + "?per_page=100", token);
    if (!Array.isArray(releases)) throw new Error("GitHub release list is invalid");
    const release = releases.find(value => record(value, "GitHub release").tag_name === tag);
    if (release === undefined) throw new Error("GitHub release tag was not found");
    const latestRelease = await githubJson(base + "/latest", token, true);
    const latestTag = latestRelease === null ? null : record(latestRelease, "GitHub latest release").tag_name;
    assertReleaseState(release, typeof latestTag === "string" ? latestTag : null, {
      tag,
      draft: draft === "true",
      prerelease: prerelease === "true",
      latest: latest === "true",
    });
    console.log("verified release state for " + tag);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
