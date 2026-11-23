import { InputTooLargeError, MAX_INPUT_PIXELS } from "./limits.ts";
import type { Format } from "./sniff.ts";

export class UnsupportedFormatError extends Error {
	override readonly name = "UnsupportedFormatError";

	constructor(readonly format: Format) {
		super(`이 브라우저는 ${format} 형식을 디코딩할 수 없습니다.`);
	}
}

async function decodeBitmap(blob: Blob, format: Format): Promise<ImageBitmap> {
	try {
		return await createImageBitmap(blob);
	} catch {
		if (format !== "heic") throw new UnsupportedFormatError(format);
	}
	const { heicTo } = await import("heic-to/next");
	try {
		return await heicTo({ blob, type: "bitmap" });
	} catch {
		throw new UnsupportedFormatError(format);
	}
}

export async function decodeImage(
	bytes: Uint8Array<ArrayBuffer>,
	format: Format,
): Promise<ImageData> {
	const bitmap = await decodeBitmap(new Blob([bytes]), format);
	try {
		const pixels = bitmap.width * bitmap.height;
		if (pixels > MAX_INPUT_PIXELS) throw new InputTooLargeError(pixels);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (context === null) throw new Error("2d context unavailable");
		context.drawImage(bitmap, 0, 0);
		return context.getImageData(0, 0, bitmap.width, bitmap.height);
	} finally {
		bitmap.close();
	}
}
