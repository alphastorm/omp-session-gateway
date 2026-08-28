import { expect, test } from "bun:test";
import { PRODUCT_VERSION as DIAGNOSTICS_VERSION } from "../apps/gateway/src/diagnostics.ts";
import { GATEWAY_VERSION } from "../apps/gateway/src/installation.ts";
import { PRODUCT_VERSION as RELEASE_VERSION } from "./build-release.ts";

/**
 * Every runtime and release constant must move with the package version in one commit. The v0.2.0
 * campaign shipped an archive whose managed-installation metadata still reported 0.1.0 because
 * these constants lived outside the version sweep; this test makes the next bump fail closed in
 * `bun run check` instead of in a published artifact.
 */
test("runtime and release version constants match package.json", async () => {
  const packageJson = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  expect(GATEWAY_VERSION).toBe(packageJson.version);
  expect(DIAGNOSTICS_VERSION).toBe(packageJson.version);
  expect(RELEASE_VERSION).toBe(packageJson.version);
});
