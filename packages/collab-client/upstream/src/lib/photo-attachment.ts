import type { ImageContent } from "@oh-my-pi/pi-wire";

export const MAX_PHOTO_ATTACHMENTS = 4;
const MAX_PHOTO_BYTES = 1_024 * 1_024;

const MAX_SOURCE_BYTES = 24 * 1_024 * 1_024;
const MAX_EDGE_PX = 2_048;
const MIN_EDGE_PX = 512;
const JPEG_QUALITIES = [0.86, 0.76, 0.66] as const;
const ACCEPTED_MIME_TYPES: Record<string, true> = {
	"image/jpeg": true,
	"image/png": true,
	"image/webp": true,
};

export interface PreparedPhoto {
	readonly content: ImageContent;
	readonly previewUrl: string;
}

export class PhotoAttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PhotoAttachmentError";
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
			previewUrl: URL.createObjectURL(prepared),
		};
	} finally {
		bitmap.close();
	}
}

export function disposePhotoAttachment(photo: PreparedPhoto): void {
	URL.revokeObjectURL(photo.previewUrl);
}
