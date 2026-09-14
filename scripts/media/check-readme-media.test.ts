import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePackagePins } from "./check-readme-media.ts";
import { REPOSITORY_ROOT, type MediaManifest } from "./readme-media-contract.ts";

test("capture pins accept the vendored browser client and reject another source with the same package version", async () => {
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  const client = JSON.parse(await readFile(join(REPOSITORY_ROOT, "packages/collab-client/upstream/UPSTREAM.json"), "utf8"));
  const manifest: Pick<MediaManifest, "upstreamClient" | "generatedBy"> = {
    upstreamClient: { tag: client.tag, commit: client.commit, packageVersion: client.packageVersion },
    generatedBy: {
      command: "bun run media:capture",
      bun: packageJson.packageManager.replace(/^bun@/u, ""),
      typescript: packageJson.devDependencies.typescript,
      playwright: packageJson.devDependencies["@playwright/test"],
      chromium: "0",
      ffmpeg: "0",
      ffprobe: "0",
    },
  };
  const accepted: string[] = [];
  await validatePackagePins(manifest, accepted);
  expect(accepted).toEqual([]);

  const rejected: string[] = [];
  await validatePackagePins({
    ...manifest,
    upstreamClient: { ...manifest.upstreamClient, tag: "v0.0.0", commit: "0".repeat(40) },
  }, rejected);
  expect(rejected).toHaveLength(1);
});
