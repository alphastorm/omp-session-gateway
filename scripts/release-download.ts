import { mkdir, rm } from "node:fs/promises";

const DOWNLOAD_ATTEMPTS = 3;

/**
 * GitHub's release-asset endpoint intermittently answers HTTP 5xx, which failed a qualification
 * run before any lane started. Retry the whole download a bounded number of times, each into a
 * freshly emptied private directory so a partial asset cannot survive. Every caller verifies
 * checksums, attestations, and signatures afterwards, so a retry can never admit different bytes.
 */
export async function downloadReleaseAssets(
  directory: string,
  download: () => Promise<unknown>,
  options: { readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = options.sleep ?? (async (milliseconds: number) => void (await Bun.sleep(milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await download();
      return;
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS) throw error;
      await sleep(2_000 * attempt);
    }
  }
}
