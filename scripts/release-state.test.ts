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

describe("GitHub release state", () => {
  test("accepts a complete not-Latest stable draft and a published Latest release", () => {
    expect(() =>
      assertReleaseState(release(), null, { tag: TAG, draft: true, prerelease: false, latest: false }),
    ).not.toThrow();
    expect(() =>
      assertReleaseState(release({ draft: false }), TAG, {
        tag: TAG,
        draft: false,
        prerelease: false,
        latest: true,
      }),
    ).not.toThrow();
  });

  test("rejects wrong flags, premature Latest, and missing assets", () => {
    expect(() =>
      assertReleaseState(release(), TAG, { tag: TAG, draft: true, prerelease: false, latest: false }),
    ).toThrow("GitHub release flags do not match the validated policy");
    expect(() =>
      assertReleaseState(release({ prerelease: true }), null, {
        tag: TAG,
        draft: true,
        prerelease: false,
        latest: false,
      }),
    ).toThrow("GitHub release flags do not match the validated policy");
    expect(() =>
      assertReleaseState(release({ assets: assets().slice(1) }), null, {
        tag: TAG,
        draft: true,
        prerelease: false,
        latest: false,
      }),
    ).toThrow("GitHub release does not contain exactly six assets");
  });

  test("rejects processing assets and unexpected names", () => {
    const processing = assets();
    processing[0] = { ...processing[0]!, state: "new" };
    expect(() =>
      assertReleaseState(release({ assets: processing }), null, {
        tag: TAG,
        draft: true,
        prerelease: false,
        latest: false,
      }),
    ).toThrow("GitHub release contains an incomplete asset");
    const renamed = assets();
    renamed[0] = { ...renamed[0]!, name: "unexpected" };
    expect(() =>
      assertReleaseState(release({ assets: renamed }), null, {
        tag: TAG,
        draft: true,
        prerelease: false,
        latest: false,
      }),
    ).toThrow("GitHub release asset names do not match the stable contract");
  });
});
