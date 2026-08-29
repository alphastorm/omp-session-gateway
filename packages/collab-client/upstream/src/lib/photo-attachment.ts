import type { ImageContent } from "@oh-my-pi/pi-wire";

export const MAX_PHOTO_ATTACHMENTS = 4;
const MAX_PHOTO_BYTES = 1_024 * 1_024;

const MAX_SOURCE_BYTES = 24 * 1_024 * 1_024;
const MAX_SOURCE_EDGE_PX = 8_192;
const MAX_SOURCE_PIXELS = 20_000_000;
const MAX_EDGE_PX = 2_048;
const MIN_EDGE_PX = 512;
const JPEG_QUALITIES = [0.86, 0.76, 0.66] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const ACCEPTED_MIME_TYPES: Record<string, true> = {
	"image/jpeg": true,
	"image/png": true,
	"image/webp": true,
};

export interface PreparedPhoto {
	readonly content: ImageContent;
}

export class PhotoAttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PhotoAttachmentError";
	}
}

interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
	if (offset + expected.length > bytes.length) return false;
	for (let index = 0; index < expected.length; index += 1) {
		if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
	}
	return true;
}

function jpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		while (bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset];
		offset += 1;
		if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) return null;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
		if (offset + 2 > bytes.length) return null;
		const length = view.getUint16(offset, false);
		if (length < 2 || offset + length > bytes.length) return null;
		const startOfFrame =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (startOfFrame) {
			if (length < 7) return null;
			return { height: view.getUint16(offset + 3, false), width: view.getUint16(offset + 5, false) };
		}
		offset += length;
	}
	return null;
}

function pngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
	if (bytes.length < 24) return null;
	for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
		if (bytes[index] !== PNG_SIGNATURE[index]) return null;
	}
	if (view.getUint32(8, false) !== 13 || !asciiAt(bytes, 12, "IHDR")) return null;
	return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
	if (bytes.length < 20 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) return null;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const size = view.getUint32(offset + 4, true);
		const dataOffset = offset + 8;
		if (dataOffset + size > bytes.length) return null;
		if (asciiAt(bytes, offset, "VP8X") && size >= 10) {
			return {
				width: uint24LittleEndian(bytes, dataOffset + 4) + 1,
				height: uint24LittleEndian(bytes, dataOffset + 7) + 1,
			};
		}
		if (
			asciiAt(bytes, offset, "VP8 ") &&
			size >= 10 &&
			bytes[dataOffset + 3] === 0x9d &&
			bytes[dataOffset + 4] === 0x01 &&
			bytes[dataOffset + 5] === 0x2a
		) {
			return {
				width: view.getUint16(dataOffset + 6, true) & 0x3fff,
				height: view.getUint16(dataOffset + 8, true) & 0x3fff,
			};
		}
		if (asciiAt(bytes, offset, "VP8L") && size >= 5 && bytes[dataOffset] === 0x2f) {
			const byte1 = bytes[dataOffset + 1] ?? 0;
			const byte2 = bytes[dataOffset + 2] ?? 0;
			const byte3 = bytes[dataOffset + 3] ?? 0;
			const byte4 = bytes[dataOffset + 4] ?? 0;
			return {
				width: 1 + byte1 + ((byte2 & 0x3f) << 8),
				height: 1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
			};
		}
		offset = dataOffset + size + (size & 1);
	}
	return null;
}

async function assertSafeSourceDimensions(file: File): Promise<void> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dimensions =
		file.type === "image/jpeg"
			? jpegDimensions(bytes, view)
			: file.type === "image/png"
				? pngDimensions(bytes, view)
				: webpDimensions(bytes, view);
	if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
		throw new PhotoAttachmentError("This photo could not be read. Try JPEG, PNG, or WebP.");
	}
	if (
		dimensions.width > MAX_SOURCE_EDGE_PX ||
		dimensions.height > MAX_SOURCE_EDGE_PX ||
		dimensions.width > Math.floor(MAX_SOURCE_PIXELS / dimensions.height)
	) {
		throw new PhotoAttachmentError("That photo is too large to process safely. Use a lower-resolution image.");
	}
}

function fitWithin(width: number, height: number, maximumEdge: number): { width: number; height: number } {
	const scale = Math.min(1, maximumEdge / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
	const { promise, resolve, reject } = Promise.withResolvers<Blob>();
	canvas.toBlob(blob => {
		if (blob) resolve(blob);
		else reject(new PhotoAttachmentError("This photo could not be prepared. Try another image."));
	}, "image/jpeg", quality);
	return promise;
}

async function encodeBoundedJpeg(bitmap: ImageBitmap): Promise<Blob> {
	let dimensions = fitWithin(bitmap.width, bitmap.height, MAX_EDGE_PX);

	for (let attempt = 0; attempt < 4; attempt += 1) {
		const canvas = document.createElement("canvas");
		canvas.width = dimensions.width;
		canvas.height = dimensions.height;
		try {
			const context = canvas.getContext("2d", { alpha: false });
			if (!context) throw new PhotoAttachmentError("This browser could not prepare the photo.");
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = "high";
			context.fillStyle = "#fff";
			context.fillRect(0, 0, dimensions.width, dimensions.height);
			context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);

			let lastBlob: Blob | undefined;
			for (const quality of JPEG_QUALITIES) {
				lastBlob = await canvasJpeg(canvas, quality);
				if (lastBlob.size <= MAX_PHOTO_BYTES) {
					return lastBlob;
				}
			}

			if (!lastBlob) break;
			const currentEdge = Math.max(dimensions.width, dimensions.height);
			if (currentEdge <= MIN_EDGE_PX) break;
			const reduction = Math.min(0.85, Math.sqrt(MAX_PHOTO_BYTES / lastBlob.size) * 0.92);
			dimensions = fitWithin(bitmap.width, bitmap.height, Math.max(MIN_EDGE_PX, Math.floor(currentEdge * reduction)));
		} finally {
			canvas.width = 1;
			canvas.height = 1;
		}
	}

	throw new PhotoAttachmentError("This photo is too detailed to send safely. Crop it and try again.");
}

async function encodeBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
	}
	return btoa(chunks.join(""));
}

/**
 * Normalizes a user-selected image to a bounded JPEG before it enters collaboration memory.
 * Canvas re-encoding strips EXIF and location metadata; the original file is never uploaded.
 */
export async function preparePhotoAttachment(file: File): Promise<PreparedPhoto> {
	if (!Object.hasOwn(ACCEPTED_MIME_TYPES, file.type)) {
		throw new PhotoAttachmentError("Choose a JPEG, PNG, or WebP photo.");
	}
	if (file.size === 0) throw new PhotoAttachmentError("That photo is empty. Choose another image.");
	if (file.size > MAX_SOURCE_BYTES) {
		throw new PhotoAttachmentError("That photo is over 24 MB. Choose a smaller image.");
	}
	await assertSafeSourceDimensions(file);

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		throw new PhotoAttachmentError("This photo could not be read. Try JPEG, PNG, or WebP.");
	}

	try {
		if (bitmap.width < 1 || bitmap.height < 1) {
			throw new PhotoAttachmentError("That photo has invalid dimensions.");
		}
		const prepared = await encodeBoundedJpeg(bitmap);
		const data = await encodeBase64(prepared);
		return {
			content: { type: "image", data, mimeType: "image/jpeg" },
		};
	} finally {
		bitmap.close();
	}
}
