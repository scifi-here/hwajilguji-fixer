import type { CV } from "@techstark/opencv-js";
import type { RgbImage } from "./tiles.ts";

export type CropRect = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};
export type AlignedImage = {
	readonly image: RgbImage;
	readonly crop: CropRect;
};

const BLOCK = 8;

export function alignGrid(
	cv: CV,
	image: RgbImage,
	offset: readonly [number, number],
): AlignedImage {
	const left = (BLOCK - offset[0]) % BLOCK;
	const top = (BLOCK - offset[1]) % BLOCK;
	const source = cv.matFromArray(
		image.height,
		image.width,
		cv.CV_8UC3,
		image.data,
	);
	const padded = new cv.Mat();
	try {
		cv.copyMakeBorder(source, padded, top, 0, left, 0, cv.BORDER_REFLECT_101);
		return {
			image: {
				width: padded.cols,
				height: padded.rows,
				data: new Uint8ClampedArray(padded.data),
			},
			crop: { x: left, y: top, width: image.width, height: image.height },
		};
	} finally {
		padded.delete();
		source.delete();
	}
}

export function cropImage(image: RgbImage, crop: CropRect): RgbImage {
	const data = new Uint8ClampedArray(crop.width * crop.height * 3);
	for (let row = 0; row < crop.height; row++) {
		const from = ((crop.y + row) * image.width + crop.x) * 3;
		data.set(
			image.data.subarray(from, from + crop.width * 3),
			row * crop.width * 3,
		);
	}
	return { width: crop.width, height: crop.height, data };
}

export function depalette(cv: CV, image: RgbImage): RgbImage {
	const source = cv.matFromArray(
		image.height,
		image.width,
		cv.CV_8UC3,
		image.data,
	);
	const filtered = new cv.Mat();
	try {
		cv.bilateralFilter(source, filtered, 5, 35, 5);
		return {
			width: image.width,
			height: image.height,
			data: new Uint8ClampedArray(filtered.data),
		};
	} finally {
		filtered.delete();
		source.delete();
	}
}
