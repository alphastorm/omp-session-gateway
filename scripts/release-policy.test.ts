import { describe, expect, test } from "bun:test";
import { releasePolicy } from "./release-policy.ts";

const VERSION = "0.1.0";

describe("release tag policy", () => {
  test("publishes only the bare version as stable and latest", () => {
    expect(releasePolicy("v0.1.0", VERSION)).toEqual({
      channel: "stable",
      prerelease: false,
      latest: true,
    });
  });

  test("keeps every engineering, alpha, and beta shape out of Latest", () => {
    const expected = [
      ["v0.1.0-prealpha.1", "pre-alpha"],
      ["v0.1.0-prealpha.23", "pre-alpha"],
      ["v0.1.0-alpha", "alpha"],
      ["v0.1.0-alpha.2", "alpha"],
      ["v0.1.0-beta", "beta"],
      ["v0.1.0-beta.7", "beta"],
      ["provenance-test-v0.1.0.12", "pre-alpha"],
    ] as const;
    for (const [tag, channel] of expected) {
      expect(releasePolicy(tag, VERSION)).toEqual({ channel, prerelease: true, latest: false });
    }
  });

  test("rejects unknown, ambiguous, zero-indexed, and cross-version tags", () => {
    for (const tag of [
      "",
      "v0.1.0-rc.1",
      "v0.1.0-prealpha.0",
      "v0.1.0-prealpha.01",
      "v0.1.0-alpha.0",
      "v0.1.0-beta.0",
      "v0.1.0-stable",
      "v0.1.1",
      "V0.1.0",
      "v0.1.0 ",
    ]) {
      expect(() => releasePolicy(tag, VERSION)).toThrow(/^tag must be /);
    }
  });

  test("rejects a package version whose dots could widen tag matching", () => {
    for (const version of ["0.1", "0.1.0-beta", "0x1x0", "", " 0.1.0"]) {
      expect(() => releasePolicy("v0.1.0", version)).toThrow(/^package version must be numeric major\.minor\.patch/);
    }
  });

  test("CLI emits only validated GitHub environment values", async () => {
    const subprocess = Bun.spawn([process.execPath, "scripts/release-policy.ts", "v0.1.0", VERSION], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(subprocess.stdout).text();
    expect(await subprocess.exited).toBe(0);
    expect(output).toBe("OMP_RELEASE_CHANNEL=stable\nRELEASE_IS_PRERELEASE=false\nRELEASE_IS_LATEST=true\n");
  });
});
