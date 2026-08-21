import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MEDIA_DIRECTORY = resolve(REPOSITORY_ROOT, "docs/media");

export const BINARY_MEDIA_NAMES = [
  "omp-session-gateway-demo.gif",
  "omp-session-gateway-demo.mp4",
  "omp-session-gateway-demo-poster.png",
  "omp-session-gateway-product-flow.png",
  "01-all-clear.png",
  "02-needs-you.png",
  "03-open-request.png",
  "04-notification-settings.png",
] as const;

export type BinaryMediaName = (typeof BINARY_MEDIA_NAMES)[number];

export const MEDIA_DIRECTORY_NAMES = [
  ...BINARY_MEDIA_NAMES,
  "README.md",
  "manifest.json",
] as const;
export const OPTIONAL_MEDIA_DIRECTORY_NAMES = ["LAUNCH_COPY.md"] as const;

export const PNG_DIMENSIONS: Readonly<Record<Extract<BinaryMediaName, `${string}.png`>, readonly [number, number]>> = {
  "omp-session-gateway-demo-poster.png": [960, 540],
  "omp-session-gateway-product-flow.png": [1600, 980],
  "01-all-clear.png": [780, 1688],
  "02-needs-you.png": [780, 1688],
  "03-open-request.png": [780, 1688],
  "04-notification-settings.png": [780, 1688],
};

export const MAX_BYTES: Readonly<Record<BinaryMediaName, number>> = {
  "omp-session-gateway-demo.gif": 6 * 1024 * 1024,
  "omp-session-gateway-demo.mp4": 12 * 1024 * 1024,
  "omp-session-gateway-demo-poster.png": 8 * 1024 * 1024,
  "omp-session-gateway-product-flow.png": 12 * 1024 * 1024,
  "01-all-clear.png": 8 * 1024 * 1024,
  "02-needs-you.png": 8 * 1024 * 1024,
  "03-open-request.png": 8 * 1024 * 1024,
  "04-notification-settings.png": 8 * 1024 * 1024,
};

export const GIF_TARGET_BYTES = 3 * 1024 * 1024;
export const DEMO_WIDTH = 960;
export const DEMO_HEIGHT = 540;
export const DEMO_FRAME_COUNT = 130;
export const DEMO_FPS = 10;
export const DEMO_DURATION_SECONDS = 13;
export const POSTER_FRAME_INDEX = 60;

export const FORBIDDEN_PNG_CHUNKS: Readonly<Record<string, true>> = {
  eXIf: true,
  tEXt: true,
  zTXt: true,
  iTXt: true,
  tIME: true,
};

export type MediaProvenance =
  | "built-pwa-runtime"
  | "built-pwa-runtime-with-pinned-collab-client"
  | "capture-only-presentation-composite";

export interface CompositeInput {
  readonly id: string;
  readonly sha256: string;
}

export interface MediaAssetManifestRecord {
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly provenance: MediaProvenance;
  readonly frameCount?: number;
  readonly durationSeconds?: number;
  readonly fps?: number;
  readonly loopCount?: number;
  readonly codec?: string;
  readonly pixelFormat?: string;
  readonly sourceFrame?: number;
  readonly compositeInputs?: readonly CompositeInput[];
}

export interface MediaManifest {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly upstreamClient: {
    readonly tag: string;
    readonly commit: string;
    readonly packageVersion: string;
  };
  readonly generatedBy: {
    readonly command: "bun run media:capture";
    readonly bun: string;
    readonly typescript: string;
    readonly playwright: string;
    readonly chromium: string;
    readonly ffmpeg: string;
    readonly ffprobe: string;
  };
  readonly capture: {
    readonly clock: "2026-08-21T12:10:00.000Z";
    readonly locale: "en-US";
    readonly timezone: "UTC";
    readonly colorScheme: "dark";
    readonly reducedMotion: "reduce";
    readonly viewportCss: readonly [390, 844];
    readonly deviceScaleFactor: 2;
    readonly runtimeNetworkPolicy: "same-origin-fixture-only";
    readonly compositorNetworkPolicy: "offline-data-urls-only";
    readonly unexpectedRuntimeRequests: 0;
    readonly unexpectedCompositorRequests: 0;
  };
  readonly assets: Readonly<Record<BinaryMediaName, MediaAssetManifestRecord>>;
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly chunks: readonly string[];
}

export interface GifInfo {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly delaysCentiseconds: readonly number[];
  readonly durationSeconds: number;
  readonly loopCount?: number;
  readonly commentExtensions: number;
}

export interface ProbeStream {
  readonly codec_name?: string;
  readonly codec_type?: string;
  readonly pix_fmt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly r_frame_rate?: string;
  readonly nb_frames?: string;
  readonly nb_read_frames?: string;
  readonly duration?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface ProbeResult {
  readonly streams?: readonly ProbeStream[];
  readonly format?: {
    readonly duration?: string;
    readonly tags?: Readonly<Record<string, string>>;
  };
}

export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

export function parsePng(bytes: Uint8Array): PngInfo {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertCondition(
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "invalid PNG signature",
  );
  let offset = 8;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  const chunks: string[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + length;
    assertCondition(nextOffset <= buffer.length, `truncated PNG ${type} chunk`);
    chunks.push(type);
    if (type === "IHDR") {
      assertCondition(length === 13, "invalid PNG IHDR length");
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      bitDepth = buffer[offset + 16];
      colorType = buffer[offset + 17];
    }
    offset = nextOffset;
    if (type === "IEND") break;
  }
  assertCondition(width !== undefined && height !== undefined, "PNG is missing IHDR");
  assertCondition(bitDepth !== undefined && colorType !== undefined, "PNG IHDR is incomplete");
  assertCondition(chunks.at(-1) === "IEND", "PNG is missing IEND");
  return { width, height, bitDepth, colorType, chunks };
}

function readGifSubBlocks(buffer: Buffer, start: number): { readonly bytes: Buffer; readonly next: number } {
  const blocks: Buffer[] = [];
  let offset = start;
  while (true) {
    assertCondition(offset < buffer.length, "truncated GIF sub-block length");
    const length = buffer[offset] ?? 0;
    offset += 1;
    if (length === 0) break;
    assertCondition(offset + length <= buffer.length, "truncated GIF sub-block");
    blocks.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  return { bytes: Buffer.concat(blocks), next: offset };
}

export function parseGif(bytes: Uint8Array): GifInfo {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = buffer.toString("ascii", 0, 6);
  assertCondition(signature === "GIF89a" || signature === "GIF87a", "invalid GIF signature");
  assertCondition(buffer.length >= 13, "truncated GIF header");
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10] ?? 0;
  let offset = 13;
  if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
  assertCondition(offset <= buffer.length, "truncated GIF global color table");

  const delaysCentiseconds: number[] = [];
  let pendingDelay: number | undefined;
  let loopCount: number | undefined;
  let commentExtensions = 0;
  let foundTrailer = false;

  while (offset < buffer.length) {
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x3b) {
      foundTrailer = true;
      break;
    }
    if (marker === 0x2c) {
      assertCondition(offset + 9 <= buffer.length, "truncated GIF image descriptor");
      const imagePacked = buffer[offset + 8] ?? 0;
      offset += 9;
      if ((imagePacked & 0x80) !== 0) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
      assertCondition(offset < buffer.length, "truncated GIF image data");
      offset += 1;
      const imageData = readGifSubBlocks(buffer, offset);
      offset = imageData.next;
      delaysCentiseconds.push(pendingDelay ?? 0);
      pendingDelay = undefined;
      continue;
    }
    assertCondition(marker === 0x21, "unexpected GIF block marker");
    assertCondition(offset < buffer.length, "truncated GIF extension");
    const label = buffer[offset];
    offset += 1;
    if (label === 0xf9) {
      assertCondition(buffer[offset] === 4 && offset + 6 <= buffer.length, "invalid GIF graphics control extension");
      pendingDelay = buffer.readUInt16LE(offset + 2);
      assertCondition(buffer[offset + 5] === 0, "invalid GIF graphics control terminator");
      offset += 6;
      continue;
    }
    if (label === 0xff) {
      assertCondition(offset < buffer.length, "truncated GIF application extension");
      const idLength = buffer[offset] ?? 0;
      offset += 1;
      assertCondition(offset + idLength <= buffer.length, "truncated GIF application identifier");
      const identifier = buffer.toString("ascii", offset, offset + idLength);
      offset += idLength;
      const applicationData = readGifSubBlocks(buffer, offset);
      offset = applicationData.next;
      if ((identifier === "NETSCAPE2.0" || identifier === "ANIMEXTS1.0") && applicationData.bytes.length >= 3) {
        assertCondition(applicationData.bytes[0] === 1, "invalid GIF loop extension");
        loopCount = applicationData.bytes.readUInt16LE(1);
      }
      continue;
    }
    if (label === 0xfe) commentExtensions += 1;
    if (label === 0x01) {
      assertCondition(offset < buffer.length, "truncated GIF plain-text extension");
      const headerLength = buffer[offset] ?? 0;
      offset += 1 + headerLength;
      assertCondition(offset <= buffer.length, "truncated GIF plain-text header");
    }
    const extensionData = readGifSubBlocks(buffer, offset);
    offset = extensionData.next;
  }

  assertCondition(foundTrailer, "GIF is missing trailer");
  const durationSeconds = delaysCentiseconds.reduce((sum, delay) => sum + delay, 0) / 100;
  return {
    width,
    height,
    frameCount: delaysCentiseconds.length,
    delaysCentiseconds,
    durationSeconds,
    ...(loopCount === undefined ? {} : { loopCount }),
    commentExtensions,
  };
}

export function parseTopLevelMp4Atoms(bytes: Uint8Array): readonly string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const atoms: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      assertCondition(offset + 16 <= buffer.length, "truncated extended MP4 atom");
      const extended = buffer.readBigUInt64BE(offset + 8);
      assertCondition(extended <= BigInt(Number.MAX_SAFE_INTEGER), "oversized MP4 atom");
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    assertCondition(size >= headerSize && offset + size <= buffer.length, `invalid MP4 ${type} atom`);
    atoms.push(type);
    offset += size;
  }
  assertCondition(offset === buffer.length, "trailing bytes after MP4 atoms");
  return atoms;
}

export async function runProcess(command: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const summary = stderr.trim().split("\n").slice(-4).join("\n");
    throw new Error(`${command} failed with exit code ${exitCode}${summary === "" ? "" : `: ${summary}`}`);
  }
  return stdout;
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  const output = await runProcess("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(output) as ProbeResult;
}

export function parseRate(rate: string | undefined): number {
  assertCondition(rate !== undefined, "media rate is missing");
  const match = /^(\d+)\/(\d+)$/u.exec(rate);
  assertCondition(match !== null, "invalid media rate");
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  assertCondition(Number.isFinite(numerator) && denominator > 0, "invalid media rate values");
  return numerator / denominator;
}

export function normalizedVersion(output: string, tool: "ffmpeg" | "ffprobe"): string {
  const match = new RegExp(`^${tool} version (\\d+(?:\\.\\d+)*)`, "u").exec(output.trim());
  assertCondition(match !== null, `unable to read ${tool} version`);
  return match[1] as string;
}

export function jsonWithFinalNewline(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
