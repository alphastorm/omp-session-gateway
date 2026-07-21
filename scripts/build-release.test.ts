import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_VERSION,
  RUNTIME_LICENSES,
  createSpdxSbom,
  releaseSourceFromEpoch,
  resolveReleaseSource,
  runtimeDependenciesFromLock,
  validateThirdPartyNotices,
  type BunLockfile,
  type UpstreamLockfile,
} from "./build-release.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRuntimeDependencies = [
  "@oh-my-pi/pi-wire@17.0.6",
  "lucide-react@1.24.0",
  "marked@18.0.6",
  "react@19.2.7",
  "react-dom@19.2.7",
  "scheduler@0.27.0",
];
const deterministicSource = releaseSourceFromEpoch("a".repeat(40), "1700000000");

async function releaseInputs(): Promise<{ lock: BunLockfile; lockSha256: string; upstream: UpstreamLockfile }> {
  const [lockText, upstreamText] = await Promise.all([
    readFile(join(root, "bun.lock"), "utf8"),
    readFile(join(root, "UPSTREAM.lock.json"), "utf8"),
  ]);
  return {
    lock: Bun.JSONC.parse(lockText) as BunLockfile,
    lockSha256: createHash("sha256").update(lockText).digest("hex"),
    upstream: JSON.parse(upstreamText) as UpstreamLockfile,
  };
}

async function runReleaseBuilder(releaseDirectory: string): Promise<{ archivePath: string; sbomPath: string }> {
  const checkoutSource = await resolveReleaseSource({});
  const subprocess = Bun.spawn([process.execPath, "scripts/build-release.ts"], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_SHA: checkoutSource.commit,
      SOURCE_DATE_EPOCH: String(Date.parse(checkoutSource.created) / 1_000),
      RELEASE_OUTPUT_DIR: releaseDirectory,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`release builder failed: ${stderr.trim()}`);
  return {
    archivePath: join(releaseDirectory, `omp-session-gateway-${PRODUCT_VERSION}-bun.tar`),
    sbomPath: join(releaseDirectory, `omp-session-gateway-${PRODUCT_VERSION}.spdx.json`),
  };
}

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size)) throw new Error(`invalid tar size for ${name}: ${sizeText}`);
    offset += 512;
    entries.set(name, Buffer.from(archive.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("derives only the bundled runtime dependency closure from bun.lock", async () => {
  const { lock } = await releaseInputs();
  expect(runtimeDependenciesFromLock(lock).map(dependency => `${dependency.name}@${dependency.version}`)).toEqual(
    expectedRuntimeDependencies,
  );
});

test("third-party notices and checked-in license texts cover every bundled component", async () => {
  const { lock } = await releaseInputs();
  const dependencies = runtimeDependenciesFromLock(lock);
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  expect(() => validateThirdPartyNotices(notices, dependencies)).not.toThrow();
  expect(notices).not.toContain("No production dependencies");
  expect(notices).toContain("@oh-my-pi/collab-web@16.3.6");
  expect(notices).toContain("@oh-my-pi/pi-coding-agent patch@17.0.6");
  expect((await readFile(join(root, "licenses/oh-my-pi/LICENSE"), "utf8")).length).toBeGreaterThan(100);
  for (const dependency of dependencies) {
    const licensePath = RUNTIME_LICENSES[dependency.name]?.licensePath;
    expect(licensePath).toBeString();
    expect((await readFile(join(root, licensePath as string), "utf8")).length).toBeGreaterThan(100);
  }
});

test("SPDX namespace, lock digest, and creation time bind reproducibly to release source", async () => {
  const { lock, lockSha256, upstream } = await releaseInputs();
  expect(deterministicSource.created).toBe("2023-11-14T22:13:20Z");
  expect(
    await resolveReleaseSource({ GITHUB_SHA: "b".repeat(40), SOURCE_DATE_EPOCH: "1700000000" }),
  ).toEqual({ commit: "b".repeat(40), created: "2023-11-14T22:13:20Z" });

  const document = JSON.parse(createSpdxSbom(lock, deterministicSource, upstream, lockSha256)) as {
    documentNamespace: string;
    creationInfo: { created: string };
    packages: Array<{ name: string; versionInfo: string; licenseDeclared: string; sourceInfo?: string }>;
  };
  expect(document.documentNamespace).toBe(
    `https://github.com/alphastorm/omp-session-gateway/sbom/${PRODUCT_VERSION}/${"a".repeat(40)}`,
  );
  expect(document.creationInfo.created).toBe(deterministicSource.created);
  expect(document.packages.map(pkg => `${pkg.name}@${pkg.versionInfo}`)).toEqual([
    `omp-session-gateway@${PRODUCT_VERSION}`,
    "@oh-my-pi/collab-web@16.3.6",
    "@oh-my-pi/pi-coding-agent-patch@17.0.6",
    ...expectedRuntimeDependencies,
  ]);
  expect(document.packages[0]?.sourceInfo).toContain(lockSha256);
  expect(document.packages.find(pkg => pkg.name === "lucide-react")?.licenseDeclared).toBe("ISC");
  expect(document.packages.find(pkg => pkg.name === "react")?.licenseDeclared).toBe("MIT");

  const otherSourceDocument = JSON.parse(
    createSpdxSbom(lock, releaseSourceFromEpoch("c".repeat(40), "1700000000"), upstream, lockSha256),
  ) as { documentNamespace: string };
  expect(otherSourceDocument.documentNamespace).not.toBe(document.documentNamespace);
});

test(
  "repeated release builds are byte-identical, preserve unrelated output, and archive all provenance",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-release-test-"));
    const releaseDirectory = join(temporaryRoot, "release");
    try {
      const first = await runReleaseBuilder(releaseDirectory);
      const [firstArchive, firstSbom] = await Promise.all([readFile(first.archivePath), readFile(first.sbomPath)]);
      const sentinel = join(releaseDirectory, "unrelated-user-file.txt");
      await writeFile(sentinel, "preserve me");
      const second = await runReleaseBuilder(releaseDirectory);
      const [secondArchive, secondSbom] = await Promise.all([readFile(second.archivePath), readFile(second.sbomPath)]);
      expect(secondArchive.equals(firstArchive)).toBe(true);
      expect(secondSbom.equals(firstSbom)).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("preserve me");

      const entries = tarEntries(secondArchive);
      const archivePrefix = `omp-session-gateway-${PRODUCT_VERSION}-bun/`;
      expect(entries.get(`${archivePrefix}SBOM.spdx.json`)?.equals(secondSbom)).toBe(true);
      expect(entries.get(`${archivePrefix}THIRD_PARTY_NOTICES.md`)?.toString("utf8")).not.toContain(
        "No production dependencies",
      );
      expect(entries.has(`${archivePrefix}licenses/collab-web/LICENSE`)).toBe(true);
      expect(entries.has(`${archivePrefix}licenses/oh-my-pi/LICENSE`)).toBe(true);
      expect(entries.has(`${archivePrefix}bun.lock`)).toBe(true);
      for (const metadata of Object.values(RUNTIME_LICENSES)) {
        expect(entries.has(`${archivePrefix}${metadata.licensePath}`)).toBe(true);
      }
      const releaseInfo = JSON.parse(entries.get(`${archivePrefix}release-info.json`)?.toString("utf8") ?? "{}") as {
        bunLockSha256?: string;
      };
      const archivedLock = entries.get(`${archivePrefix}bun.lock`);
      expect(archivedLock).toBeDefined();
      expect(releaseInfo.bunLockSha256).toBe(createHash("sha256").update(archivedLock ?? "").digest("hex"));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  20_000,
);
