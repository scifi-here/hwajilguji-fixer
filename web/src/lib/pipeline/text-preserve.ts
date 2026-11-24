import type { CV } from "@techstark/opencv-js";
import type { LoadedModel } from "./session.ts";
import { type RgbImage, runTiled } from "./tiles.ts";

function cubic(distance: number): number {
	const x = Math.abs(distance);
	return x <= 1
		? (1.5 * x - 2.5) * x * x + 1
		: ((-0.5 * x + 2.5) * x - 4) * x + 2;
}

function interpolationAxis(length: number, scale: number) {
	const indices = new Int32Array(length * scale * 4);
	const weights = new Float32Array(indices.length);
	for (let i = 0; i < length * scale; i++) {
		const center = (i + 0.5) / scale - 0.5;
		const start = Math.floor(center) - 1;
		let total = 0;
		for (let k = 0; k < 4; k++) {
			const original = start + k;
			if (original < 0 || original >= length) continue;
			indices[4 * i + k] = original;
			const weight = cubic(original - center);
			weights[4 * i + k] = weight;
			total += weight;
		}
		for (let k = 0; k < 4; k++) weights[4 * i + k] /= total;
	}
	return { indices, weights };
}

export async function blendText(
	input: RgbImage,
	output: RgbImage,
	mask: Uint8Array,
	width: number,
	height: number,
	scale: number,
	signal: AbortSignal,
): Promise<void> {
	const xs = interpolationAxis(input.width, scale),
		ys = interpolationAxis(input.height, scale);
	let lastYield = performance.now();
	for (let y = 0; y < output.height; y++) {
		if (y % 32 === 0 && performance.now() - lastYield > 24) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			signal.throwIfAborted();
			lastYield = performance.now();
		}
		const my = Math.min(
			height - 1,
			Math.max(0, ((y + 0.5) * height) / output.height - 0.5),
		);
		const row = Math.floor(my) * width,
			nextRow = Math.min(height - 1, Math.floor(my) + 1) * width;
		const fy = my - Math.floor(my);
		for (let x = 0; x < output.width; x++) {
			const mx = Math.min(
				width - 1,
				Math.max(0, ((x + 0.5) * width) / output.width - 0.5),
			);
			const col = Math.floor(mx),
				nextCol = Math.min(width - 1, col + 1),
				fx = mx - col;
			const a = mask[row + col] * (1 - fx) + mask[row + nextCol] * fx;
			const b = mask[nextRow + col] * (1 - fx) + mask[nextRow + nextCol] * fx;
			const weight = (a * (1 - fy) + b * fy) / 255;
			if (weight === 0) continue;
			let red = 0,
				green = 0,
				blue = 0;
			for (let j = 0; j < 4; j++) {
				const line = ys.indices[4 * y + j] * input.width,
					wy = ys.weights[4 * y + j];
				for (let i = 0; i < 4; i++) {
					const at = (line + xs.indices[4 * x + i]) * 3,
						w = wy * xs.weights[4 * x + i];
					red += input.data[at] * w;
					green += input.data[at + 1] * w;
					blue += input.data[at + 2] * w;
				}
			}
			const at = (y * output.width + x) * 3,
				keep = 1 - weight;
			output.data[at] = output.data[at] * keep + red * weight;
			output.data[at + 1] = output.data[at + 1] * keep + green * weight;
			output.data[at + 2] = output.data[at + 2] * keep + blue * weight;
		}
	}
}

function textMask(cv: CV, probability: RgbImage): Uint8Array | null {
	const { width, height, data } = probability;
	const binary = new cv.Mat(height, width, cv.CV_8UC1);
	const contours = new cv.MatVector(),
		hierarchy = new cv.Mat();
	const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
	try {
		const pixels = binary.data;
		for (let i = 0; i < pixels.length; i++)
			pixels[i] = data[3 * i] >= 128 ? 255 : 0;
		cv.findContours(
			binary,
			contours,
			hierarchy,
			cv.RETR_EXTERNAL,
			cv.CHAIN_APPROX_SIMPLE,
		);
		let found = false;
		const white = new cv.Scalar(255);
		for (let i = 0; i < contours.size(); i++) {
			const contour = contours.get(i);
			try {
				const area = cv.contourArea(contour);
				if (area < 9) continue;
				const radius = Math.max(
					2,
					Math.min(24, Math.round((2 * area) / cv.arcLength(contour, true))),
				);
				cv.drawContours(mask, contours, i, white, -1);
				cv.drawContours(mask, contours, i, white, 2 * radius);
				found = true;
			} finally {
				contour.delete();
			}
		}
		if (!found) return null;
		cv.GaussianBlur(mask, mask, new cv.Size(5, 5), 1);
		return mask.data.slice();
	} finally {
		mask.delete();
		contours.delete();
		hierarchy.delete();
		binary.delete();
	}
}

export type TextMask = {
	width: number;
	height: number;
	data: Uint8Array;
	fraction: number;
};

export async function detectText(
	cv: CV,
	input: RgbImage,
	loaded: LoadedModel,
	signal: AbortSignal,
	onProgress: (done: number, total: number) => void,
): Promise<TextMask | null> {
	const ratio = Math.min(
		3,
		1536 / Math.max(input.width, input.height),
		Math.sqrt(1200000 / (input.width * input.height)),
	);
	const width = Math.max(1, Math.round(input.width * ratio)),
		height = Math.max(1, Math.round(input.height * ratio));
	const source = cv.matFromArray(
		input.height,
		input.width,
		cv.CV_8UC3,
		input.data,
	);
	const preview = new cv.Mat();
	let data: Uint8ClampedArray<ArrayBuffer>;
	try {
		cv.resize(
			source,
			preview,
			new cv.Size(width, height),
			0,
			0,
			ratio < 1 ? cv.INTER_AREA : cv.INTER_CUBIC,
		);
		data = new Uint8ClampedArray(preview.data);
	} finally {
		source.delete();
		preview.delete();
	}
	const probability = await runTiled(
		cv,
		{ width, height, data },
		loaded.model,
		{ core: 384, pad: 32, signal, onProgress },
	);
	signal.throwIfAborted();
	const mask = textMask(cv, probability);
	if (!mask) return null;
	let sum = 0;
	for (const value of mask) sum += value;
	return { width, height, data: mask, fraction: sum / (255 * width * height) };
}

export function resizeMask(
	cv: CV,
	mask: TextMask,
	target: RgbImage,
): Uint8Array {
	const source = cv.matFromArray(
		mask.height,
		mask.width,
		cv.CV_8UC1,
		mask.data,
	);
	const result = new cv.Mat();
	try {
		cv.resize(
			source,
			result,
			new cv.Size(target.width, target.height),
			0,
			0,
			cv.INTER_LINEAR,
		);
		return result.data.slice();
	} finally {
		source.delete();
		result.delete();
	}
}
