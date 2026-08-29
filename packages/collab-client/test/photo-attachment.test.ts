import { describe, expect, test } from "bun:test";
import { assertSafeSourceDimensions } from "../upstream/src/lib/photo-attachment";

function jpegFile(width: number, height: number): File {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  return new File([bytes], "fixture.jpg", { type: "image/jpeg" });
}

function pngFile(width: number, height: number): File {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return new File([bytes], "fixture.png", { type: "image/png" });
}

function setUint24LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

function webpFile(width: number, height: number): File {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 10, true);
  setUint24LittleEndian(bytes, 24, width - 1);
  setUint24LittleEndian(bytes, 27, height - 1);
  return new File([bytes], "fixture.webp", { type: "image/webp" });
}

describe("photo source dimension guard", () => {
  test("accepts bounded JPEG, PNG, and WebP headers", async () => {
    await Promise.all([
      assertSafeSourceDimensions(jpegFile(4_032, 3_024)),
      assertSafeSourceDimensions(pngFile(2_400, 1_200)),
      assertSafeSourceDimensions(webpFile(2_048, 1_365)),
    ]);
  });

  test("rejects every accepted format above the source edge bound", async () => {
    for (const file of [jpegFile(8_193, 1), pngFile(1, 8_193), webpFile(8_193, 1)]) {
      await expect(assertSafeSourceDimensions(file)).rejects.toThrow(
        "That photo is too large to process safely. Use a lower-resolution image.",
      );
    }
  });

  test("rejects a source above the decoded-pixel bound", async () => {
    await expect(assertSafeSourceDimensions(pngFile(5_000, 5_000))).rejects.toThrow(
      "That photo is too large to process safely. Use a lower-resolution image.",
    );
  });

  test("rejects malformed accepted-MIME input before browser decode", async () => {
    await expect(
      assertSafeSourceDimensions(new File(["not a jpeg"], "broken.jpg", { type: "image/jpeg" })),
    ).rejects.toThrow("This photo could not be read. Try JPEG, PNG, or WebP.");
  });
});
