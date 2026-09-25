import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Development only. Stable qualification supplies its own in-process pixel() lease. */
export async function withDevelopmentPixelLease<T>(
  owner: string,
  action: () => Promise<T>,
  restored: () => boolean,
  directory = "/tmp/omp-gw-pixel.lock",
  recoverOwnLease = false,
): Promise<T> {
  const path = join(directory, "owner");
  const marker = JSON.stringify({ owner, startedAt: new Date().toISOString(), pid: process.pid });
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code !== "EEXIST" || !recoverOwnLease) throw error;
  }
  if (created) {
    try { await writeFile(path, marker, { mode: 0o600, flag: "wx" }); }
    catch (error) { await rm(directory, { recursive: true }); throw error; }
  } else {
    const previous = await readFile(path, "utf8");
    const record: unknown = JSON.parse(previous);
    if (typeof record !== "object" || record === null || !("owner" in record) || record.owner !== owner ||
      !("pid" in record) || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1) throw new Error("Pixel lease is not owned by this lane; refusing recovery");
    let alive = true;
    try { process.kill(record.pid, 0); }
    catch (error) { const processError = error as NodeJS.ErrnoException; if (processError.code === "ESRCH") alive = false; else throw error; }
    if (alive) throw new Error("Pixel lease owner is still running; refusing recovery");
    // Serializes two cleanup processes without releasing the device to another lane.
    const recovery = join(directory, "recovery");
    await mkdir(recovery, { mode: 0o700 });
    try {
      if (await readFile(path, "utf8") !== previous) throw new Error("Pixel lease ownership changed; refusing recovery");
      await writeFile(path, marker, { mode: 0o600 });
    } finally { await rm(recovery, { recursive: true }); }
  }
  try { return await action(); }
  finally {
    if (restored()) {
      if (await readFile(path, "utf8") !== marker) throw new Error("Pixel lease ownership changed; refusing release");
      await rm(directory, { recursive: true });
    }
  }
}
