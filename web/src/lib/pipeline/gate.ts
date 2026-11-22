import type { CV, Mat } from "@techstark/opencv-js";
import type { Format } from "./sniff.ts";
import {
	BLOCKINESS_MIN,
	FLAT_FRACTION_GRAPHIC,
	FLAT_VARIANCE_MAX,
	JPEG_QUALITY_SMEAR_MAX,
} from "./thresholds.ts";

export type DamageClass = "clean" | "blocky8" | "smeared" | "palette";
export type ContentKind = "photo" | "graphic";
export type GateReport = {
	readonly damage: DamageClass;
	readonly content: ContentKind;
	readonly blockiness: number;
	readonly gridOffset: readonly [number, number] | null;
	readonly uniqueColors: number;
	readonly jpegQuality: number | null;
};

const PALETTE_MAX_COLORS = 256;
const PALETTE_MIN_PIXELS = 4096;
const BLOCK_TEST_MIN_SIDE = 32;
const BLOCK = 8;
const REDUCE_AVG = 1;
const SMEAR_FORMATS: ReadonlySet<Format> = new Set<Format>([
	"webp-lossy",
	"avif",
	"heic",
]);

type GridPhase = { readonly ratio: number; readonly offset: number };
type Grid = {
	readonly blockiness: number;
	readonly gridOffset: readonly [number, number] | null;
};
type ColorCount = { readonly uniqueColors: number; readonly gray: boolean };

function countColors(data: Uint8ClampedArray): ColorCount {
	const colors = new Set<number>();
	let gray = true;
	for (
		let at = 0;
		at < data.length && colors.size <= PALETTE_MAX_COLORS;
		at += 4
	) {
		colors.add((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]);
		gray &&= data[at] === data[at + 1] && data[at + 1] === data[at + 2];
	}
	return { uniqueColors: colors.size, gray };
}

function strongestPhase(steps: Float32Array): GridPhase {
	const sums = new Float64Array(BLOCK);
	const counts = new Float64Array(BLOCK);
	steps.forEach((step, index) => {
		sums[(index + 1) % BLOCK] += step;
		counts[(index + 1) % BLOCK] += 1;
	});
	const means = Array.from(sums, (sum, phase) => sum / counts[phase]);
	const offset = means.indexOf(Math.max(...means));
	const runnerUp = Math.max(...means.filter((_, phase) => phase !== offset));
	return { ratio: means[offset] / Math.max(runnerUp, 1e-3), offset };
}

function columnPhase(cv: CV, luma: Mat): GridPhase {
	const left = luma.roi(new cv.Rect(0, 0, luma.cols - 1, luma.rows));
	const right = luma.roi(new cv.Rect(1, 0, luma.cols - 1, luma.rows));
	const steps = new cv.Mat();
	const profile = new cv.Mat();
	try {
		cv.absdiff(right, left, steps);
		cv.reduce(steps, profile, 0, REDUCE_AVG, cv.CV_32F);
		return strongestPhase(profile.data32F);
	} finally {
		for (const mat of [left, right, steps, profile]) mat.delete();
	}
}

function measureGrid(cv: CV, luma: Mat): Grid {
	if (luma.cols < BLOCK_TEST_MIN_SIDE || luma.rows < BLOCK_TEST_MIN_SIDE)
		return { blockiness: 0, gridOffset: null };
	const transposed = new cv.Mat();
	try {
		cv.transpose(luma, transposed);
		const horizontal = columnPhase(cv, luma);
		const vertical = columnPhase(cv, transposed);
		return {
			blockiness: Math.sqrt(horizontal.ratio * vertical.ratio),
			gridOffset: [horizontal.offset, vertical.offset],
		};
	} finally {
		transposed.delete();
	}
}

function flatCellFraction(cv: CV, luma: Mat): number {
	const columns = Math.floor(luma.cols / BLOCK);
	const rows = Math.floor(luma.rows / BLOCK);
	if (columns === 0 || rows === 0) return 0;
	const region = luma.roi(new cv.Rect(0, 0, columns * BLOCK, rows * BLOCK));
	const squares = new cv.Mat();
	const means = new cv.Mat();
	const squareMeans = new cv.Mat();
	try {
		cv.multiply(region, region, squares);
		cv.resize(region, means, new cv.Size(columns, rows), 0, 0, cv.INTER_AREA);
		cv.resize(
			squares,
			squareMeans,
			new cv.Size(columns, rows),
			0,
			0,
			cv.INTER_AREA,
		);
		const meanValues = means.data32F;
		const squareMeanValues = squareMeans.data32F;
		let flat = 0;
		meanValues.forEach((mean, cell) => {
			if (squareMeanValues[cell] - mean * mean < FLAT_VARIANCE_MAX) flat++;
		});
		return flat / (columns * rows);
	} finally {
		for (const mat of [region, squares, means, squareMeans]) mat.delete();
	}
}

type Evidence = {
	readonly pixels: number;
	readonly colors: ColorCount;
	readonly blockiness: number;
	readonly format: Format;
	readonly jpegQuality: number | null;
};

function classify({
	pixels,
	colors,
	blockiness,
	format,
	jpegQuality,
}: Evidence): DamageClass {
	if (
		!colors.gray &&
		colors.uniqueColors <= PALETTE_MAX_COLORS &&
		pixels >= PALETTE_MIN_PIXELS
	)
		return "palette";
	if (blockiness >= BLOCKINESS_MIN) return "blocky8";
	if (SMEAR_FORMATS.has(format)) return "smeared";
	if (
		format === "jpeg" &&
		jpegQuality !== null &&
		jpegQuality < JPEG_QUALITY_SMEAR_MAX
	)
		return "smeared";
	return "clean";
}

export function inspect(
	cv: CV,
	image: ImageData,
	format: Format,
	jpegQuality: number | null,
): GateReport {
	const colors = countColors(image.data);
	const rgba = cv.matFromImageData(image);
	const gray = new cv.Mat();
	const luma = new cv.Mat();
	try {
		cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
		gray.convertTo(luma, cv.CV_32F);
		const { blockiness, gridOffset } = measureGrid(cv, luma);
		return {
			damage: classify({
				pixels: image.width * image.height,
				colors,
				blockiness,
				format,
				jpegQuality,
			}),
			content:
				flatCellFraction(cv, luma) >= FLAT_FRACTION_GRAPHIC
					? "graphic"
					: "photo",
			blockiness,
			gridOffset,
			uniqueColors: colors.uniqueColors,
			jpegQuality,
		};
	} finally {
		for (const mat of [rgba, gray, luma]) mat.delete();
	}
}
