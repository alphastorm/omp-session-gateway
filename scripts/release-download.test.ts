import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadReleaseAssets } from "./release-download.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omp-release-download-"));
}

test("retries a transient release download into an emptied directory", async () => {
  const root = await scratch();
  try {
    const directory = join(root, "assets");
    const seenBeforeEachAttempt: string[][] = [];
    const delays: number[] = [];
    let attempt = 0;
    await downloadReleaseAssets(
      directory,
      async () => {
        seenBeforeEachAttempt.push((await readdir(directory)).sort());
        attempt += 1;
        // A failed attempt can leave a partial asset behind, as `gh release download` does.
        await writeFile(join(directory, `partial-${attempt}`), "partial");
        if (attempt < 3) throw new Error("HTTP 500");
      },
      { sleep: async milliseconds => void delays.push(milliseconds) },
    );
    expect(seenBeforeEachAttempt).toEqual([[], [], []]);
    expect(delays).toEqual([2_000, 4_000]);
    expect(await readdir(directory)).toEqual(["partial-3"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("surfaces the last failure after the bounded attempts without sleeping afterwards", async () => {
  const root = await scratch();
  try {
    const delays: number[] = [];
    let calls = 0;
    const download = downloadReleaseAssets(
      join(root, "assets"),
      async () => {
        calls += 1;
        throw new Error(`HTTP 500 attempt ${calls}`);
      },
      { sleep: async milliseconds => void delays.push(milliseconds) },
    );
    await expect(download).rejects.toThrow("HTTP 500 attempt 3");
    expect(calls).toBe(3);
    expect(delays).toEqual([2_000, 4_000]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
