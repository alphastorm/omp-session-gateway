import { describe, expect, test } from "bun:test";
import { assertReleaseState } from "./release-state.ts";

const TAG = "v0.1.0";
function assets(): { name: string; state: string; digest: string }[] {
  const names = [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    "omp-session-gateway-0.1.0-bun.tar",
    "omp-session-gateway-0.1.0-bun.tar.sigstore.json",
    "omp-session-gateway-0.1.0.spdx.json",
    "omp-session-gateway-0.1.0.spdx.json.sigstore.json",
  ];
  return names.map((name, index) => ({ name, state: "uploaded", digest: "sha256:" + String(index + 1).repeat(64) }));
}
const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: TAG,
  draft: true,
  prerelease: false,
  assets: assets(),
  ...overrides,
});

function expectedState(draft: boolean, prerelease: boolean, latest: boolean) {
  const assetDigests = Object.fromEntries(assets().map(asset => [asset.name, asset.digest]));
  return { tag: TAG, draft, prerelease, latest, assetDigests };
}

describe("GitHub release state", () => {
  test("accepts a complete not-Latest stable draft and a published Latest release", () => {
    expect(() => assertReleaseState(release(), null, expectedState(true, false, false))).not.toThrow();
    expect(() => assertReleaseState(release({ draft: false }), TAG, expectedState(false, false, true))).not.toThrow();
  });

  test("rejects wrong flags, premature Latest, and missing assets", () => {
    expect(() => assertReleaseState(release(), TAG, expectedState(true, false, false))).toThrow(
      "GitHub release flags do not match the validated policy",
    );
    expect(() =>
      assertReleaseState(release({ prerelease: true }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release flags do not match the validated policy");
    expect(() =>
      assertReleaseState(release({ assets: assets().slice(1) }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release does not contain exactly six assets");
  });

  test("rejects processing assets, unexpected names, and changed bytes", () => {
    const processing = assets();
    processing[0] = { ...processing[0]!, state: "new" };
    expect(() =>
      assertReleaseState(release({ assets: processing }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release contains an incomplete asset");
    const renamed = assets();
    renamed[0] = { ...renamed[0]!, name: "unexpected" };
    expect(() =>
      assertReleaseState(release({ assets: renamed }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release asset digest does not match the signed local file");
    const changed = assets();
    changed[0] = { ...changed[0]!, digest: "sha256:" + "f".repeat(64) };
    expect(() =>
      assertReleaseState(release({ assets: changed }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release asset digest does not match the signed local file");
  });
});
