import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "./config.ts";

export const GATEWAY_VERSION = "0.1.0";
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const VERSION_NAME_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?-[0-9a-f]{12}$/u;

export interface InstalledRuntime {
  readonly directory: string;
  readonly cliPath: string;
  readonly readinessProtocol: "legacy" | "instance-v1";
}

export interface StagedRuntime extends InstalledRuntime {
  readonly previous: InstalledRuntime | undefined;
}

interface RuntimeSourceOptions {
  readonly sourceRoot?: string;
  readonly cliSource?: string;
}

function installationRoot(config: GatewayConfig): string {
  return join(config.paths.stateDir, "installation");
}

function versionsRoot(config: GatewayConfig): string {
  return join(installationRoot(config), "versions");
}

function currentPointerPath(config: GatewayConfig): string {
  return join(installationRoot(config), "current.json");
}

function defaultSourceRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function defaultCliSource(): string {
  return resolve(process.argv[1] ?? fileURLToPath(new URL("./cli.ts", import.meta.url)));
}

async function copyRequiredFile(sourceRoot: string, staging: string, path: string): Promise<void> {
  const source = join(sourceRoot, path);
  const destination = join(staging, path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination);
}

async function copyOptionalFile(sourceRoot: string, staging: string, path: string): Promise<void> {
  try {
    await copyRequiredFile(sourceRoot, staging, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function prepareCli(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (extname(source) === ".ts") {
    const build = await Bun.build({
      entrypoints: [source],
      outdir: dirname(destination),
      naming: basename(destination),
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "none",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!build.success) throw new AggregateError(build.logs, "failed to build installed gateway CLI");
  } else {
    await cp(source, destination);
  }
  await chmod(destination, 0o700);
}

async function payloadDigest(directory: string): Promise<string> {
  const paths: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (relative(directory, path) !== "installation.json") paths.push(path);
      } else throw new Error(`installed payload contains unsupported entry: ${entry.name}`);
    }
  };
  await visit(directory);
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(directory, path).replaceAll(sep, "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeCurrentPointer(config: GatewayConfig, versionDirectory: string): Promise<void> {
  const root = installationRoot(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.current-${randomUUID()}.json`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ versionDirectory })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, currentPointerPath(config));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function validatedRuntime(directory: string): Promise<InstalledRuntime> {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("unsafe installed runtime directory");
  }
  const manifestPath = join(directory, "installation.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1_024) {
    throw new Error("unsafe installed runtime manifest");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const version = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
  const sha256 = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "sha256") : undefined;
  const readinessProtocolValue =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "readinessProtocol") : undefined;
  if (
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    basename(directory) !== `${version}-${sha256.slice(0, 12)}`
  ) {
    throw new Error("invalid installed runtime manifest");
  }
  if (readinessProtocolValue !== undefined && readinessProtocolValue !== "instance-v1") {
    throw new Error("invalid installed runtime readiness protocol");
  }
  const cliPath = join(directory, "apps", "gateway", "src", "cli.js");
  const cliInfo = await lstat(cliPath);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error("unsafe installed gateway CLI");
  if ((await payloadDigest(directory)) !== sha256) throw new Error("installed runtime payload failed its content hash");
  return {
    directory,
    cliPath,
    readinessProtocol: readinessProtocolValue === "instance-v1" ? "instance-v1" : "legacy",
  };
}

export async function currentInstalledRuntime(config: GatewayConfig): Promise<InstalledRuntime | undefined> {
  let parsed: unknown;
  try {
    const pointer = currentPointerPath(config);
    const info = await lstat(pointer);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_024) throw new Error("unsafe installed runtime pointer");
    parsed = JSON.parse(await readFile(pointer, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const versionDirectory =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "versionDirectory") : undefined;
  if (typeof versionDirectory !== "string" || !VERSION_NAME_PATTERN.test(versionDirectory)) {
    throw new Error("invalid installed runtime pointer");
  }
  const directory = join(versionsRoot(config), versionDirectory);
  return validatedRuntime(directory);
}

export async function stageRuntimePayload(
  config: GatewayConfig,
  options: RuntimeSourceOptions = {},
): Promise<StagedRuntime> {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot());
  const cliSource = resolve(options.cliSource ?? defaultCliSource());
  const versions = versionsRoot(config);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const staging = join(versions, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await prepareCli(cliSource, join(staging, "apps", "gateway", "src", "cli.js"));
    await cp(join(sourceRoot, "apps", "web", "dist"), join(staging, "apps", "web", "dist"), {
      recursive: true,
    });
    await cp(join(sourceRoot, "patches", "oh-my-pi"), join(staging, "patches", "oh-my-pi"), {
      recursive: true,
    });
    await cp(join(sourceRoot, "licenses"), join(staging, "licenses"), { recursive: true });
    await mkdir(join(staging, "licenses", "collab-web"), { recursive: true, mode: 0o700 });
    await copyOptionalFile(sourceRoot, staging, "licenses/collab-web/LICENSE");
    try {
      await lstat(join(staging, "licenses", "collab-web", "LICENSE"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await copyRequiredFile(sourceRoot, staging, "packages/collab-client/upstream/LICENSE");
      await rename(
        join(staging, "packages", "collab-client", "upstream", "LICENSE"),
        join(staging, "licenses", "collab-web", "LICENSE"),
      );
      await rm(join(staging, "packages"), { recursive: true, force: true });
    }
    for (const path of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.lock.json", "bun.lock"]) {
      await copyRequiredFile(sourceRoot, staging, path);
    }
    for (const path of ["package.json", "release-info.json", "SBOM.spdx.json"]) {
      await copyOptionalFile(sourceRoot, staging, path);
    }

    const digest = await payloadDigest(staging);
    const versionDirectory = `${GATEWAY_VERSION}-${digest.slice(0, 12)}`;
    await writeFile(
      join(staging, "installation.json"),
      `${JSON.stringify({ version: GATEWAY_VERSION, sha256: digest, readinessProtocol: "instance-v1" })}\n`,
      { mode: 0o600 },
    );
    const directory = join(versions, versionDirectory);
    try {
      await rename(staging, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const targetIsDirectory = await lstat(directory).then(
        info => info.isDirectory(),
        () => false,
      );
      if (!targetIsDirectory || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
      await rm(staging, { recursive: true, force: true });
    }
    const installed = await validatedRuntime(directory);
    return { ...installed, previous: await currentInstalledRuntime(config) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function activateRuntime(config: GatewayConfig, runtime: InstalledRuntime): Promise<void> {
  const versionDirectory = basename(runtime.directory);
  if (!VERSION_NAME_PATTERN.test(versionDirectory) || dirname(runtime.directory) !== versionsRoot(config)) {
    throw new Error("refusing to activate an untrusted runtime path");
  }
  const validated = await validatedRuntime(runtime.directory);
  if (validated.cliPath !== runtime.cliPath) throw new Error("refusing to activate an untrusted gateway CLI path");
  await writeCurrentPointer(config, versionDirectory);
}
