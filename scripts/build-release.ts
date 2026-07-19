import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";

const PRODUCT_VERSION = "0.1.0";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(root, "dist", "release");
const archiveBase = `omp-session-gateway-${PRODUCT_VERSION}-bun`;

interface ArchiveFile {
  readonly path: string;
  readonly content: Buffer;
  readonly executable: boolean;
}


async function run(command: readonly string[]): Promise<void> {
  const subprocess = Bun.spawn([...command], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if ((await subprocess.exited) !== 0) throw new Error(`${command[0] ?? "release command"} failed`);
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) throw new Error(`archive path is too long: ${value}`);
  encoded.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  writeText(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarEntry(file: ArchiveFile): Buffer {
  const header = Buffer.alloc(512);
  writeText(header, 0, 100, file.path);
  writeOctal(header, 100, 8, file.executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return Buffer.concat([
    header,
    file.content,
    Buffer.alloc((512 - (file.content.byteLength % 512)) % 512),
  ]);
}

async function archiveFiles(directory: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const archivePath = `${archiveBase}/${relative(directory, path).replaceAll("\\", "/")}`;
        files.push({ path: archivePath, content: await readFile(path), executable: entry.name === "cli.js" });
      } else {
        throw new Error(`release staging contains an unsupported filesystem entry: ${entry.name}`);
      }
    }
  };
  await visit(directory);
  return files;
}

await run([process.execPath, "scripts/build-web.ts"]);
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "omp-session-gateway-release-"));
try {
  const cliDirectory = join(staging, "apps", "gateway", "src");
  await mkdir(cliDirectory, { recursive: true });
  const build = await Bun.build({
    entrypoints: [join(root, "apps", "gateway", "src", "cli.ts")],
    outdir: cliDirectory,
    naming: "cli.js",
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!build.success) throw new AggregateError(build.logs, "failed to bundle gateway CLI");
  await chmod(join(cliDirectory, "cli.js"), 0o755);
  await cp(join(root, "apps", "web", "dist"), join(staging, "apps", "web", "dist"), { recursive: true });
  await cp(join(root, "patches", "oh-my-pi"), join(staging, "patches", "oh-my-pi"), { recursive: true });
  await mkdir(join(staging, "licenses", "collab-web"), { recursive: true });
  await cp(join(root, "packages", "collab-client", "upstream", "LICENSE"), join(staging, "licenses", "collab-web", "LICENSE"));
  for (const name of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.lock.json"]) {
    await cp(join(root, name), join(staging, name));
  }
  await writeFile(
    join(staging, "package.json"),
    `${JSON.stringify(
      {
        name: "omp-session-gateway",
        version: PRODUCT_VERSION,
        private: true,
        type: "module",
        engines: { bun: ">=1.3.14" },
        bin: {
          "omp-gateway": "apps/gateway/src/cli.js",
          "omp-gatewayd": "apps/gateway/src/cli.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(staging, "release-info.json"),
    `${JSON.stringify(
      {
        product: "OMP Session Gateway",
        version: PRODUCT_VERSION,
        runtime: "Bun >=1.3.14",
        upstreamCommit: "39c95e5e29b1c8b082059f57421ce445c3dffdd4",
        qualification: "pre-alpha; cross-OS and real Android acceptance not yet completed",
      },
      null,
      2,
    )}\n`,
  );
  const files = await archiveFiles(staging);
  for (const file of files) {
    if (file.path.endsWith(".map")) throw new Error("release archive must not contain source maps");
    const text = file.content.toString("utf8");
    if (findCapabilityLeaks(text).length > 0) {
      throw new Error(`release archive contains a capability-shaped value: ${file.path}`);
    }
  }
  const archive = Buffer.concat([...files.map(tarEntry), Buffer.alloc(1_024)]);
  const archiveName = `${archiveBase}.tar`;
  await writeFile(join(releaseRoot, archiveName), archive);
  const digest = createHash("sha256").update(archive).digest("hex");
  await writeFile(join(releaseRoot, "SHA256SUMS"), `${digest}  ${archiveName}\n`);
  const archiveInfo = await stat(join(releaseRoot, archiveName));
  console.log(`built ${relative(root, join(releaseRoot, archiveName))} (${archiveInfo.size} bytes)`);
  console.log(`wrote ${relative(root, join(releaseRoot, "SHA256SUMS"))}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
