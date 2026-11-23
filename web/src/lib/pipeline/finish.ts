import type { CV, Mat } from "@techstark/opencv-js";
import type { DamageClass } from "./gate.ts";
import type { RgbImage } from "./tiles.ts";

const DRIFT_SIGMA_AT_INPUT = 3;
const FLAT_GRADIENT_MAX = 8;
const BILATERAL_DIAMETER = 5;
const BILATERAL_SIGMA_COLOR = 12;
const BILATERAL_SIGMA_SPACE = 5;
const SMOOTHED_DAMAGE: ReadonlySet<DamageClass> = new Set<DamageClass>([
	"smeared",
	"palette",
]);

function colourDrift(cv: CV, output: Mat, input: Mat): Mat {
	const outputAtInput = new cv.Mat();
	const inputBlur = new cv.Mat();
	const outputBlur = new cv.Mat();
	const driftAtInput = new cv.Mat();
	const drift = new cv.Mat();
	try {
		cv.resize(
			output,
			outputAtInput,
			new cv.Size(input.cols, input.rows),
			0,
			0,
			cv.INTER_AREA,
		);
		input.convertTo(inputBlur, cv.CV_32F);
		outputAtInput.convertTo(outputBlur, cv.CV_32F);
		cv.GaussianBlur(
			inputBlur,
			inputBlur,
			new cv.Size(0, 0),
			DRIFT_SIGMA_AT_INPUT,
		);
		cv.GaussianBlur(
			outputBlur,
			outputBlur,
			new cv.Size(0, 0),
			DRIFT_SIGMA_AT_INPUT,
		);
		cv.subtract(inputBlur, outputBlur, inputBlur);
		inputBlur.convertTo(driftAtInput, cv.CV_16S);
		cv.resize(
			driftAtInput,
			drift,
			new cv.Size(output.cols, output.rows),
			0,
			0,
			cv.INTER_LINEAR,
		);
		return drift;
	} catch (error) {
		drift.delete();
		throw error;
	} finally {
		for (const mat of [outputAtInput, inputBlur, outputBlur, driftAtInput])
			mat.delete();
	}
}

function smoothFlatRegions(cv: CV, picture: Mat): void {
	const gray = new cv.Mat();
	const gradientX = new cv.Mat();
	const gradientY = new cv.Mat();
	const flat = new cv.Mat(picture.rows, picture.cols, cv.CV_8UC1);
	const window = cv.getStructuringElement(
		cv.MORPH_RECT,
		new cv.Size(BILATERAL_DIAMETER, BILATERAL_DIAMETER),
	);
	const filtered = new cv.Mat();
	try {
		cv.cvtColor(picture, gray, cv.COLOR_RGB2GRAY);
		cv.Sobel(gray, gradientX, cv.CV_16S, 1, 0, 3);
		cv.Sobel(gray, gradientY, cv.CV_16S, 0, 1, 3);
		const gx = gradientX.data16S;
		const gy = gradientY.data16S;
		const mask = flat.data;
		for (let pixel = 0; pixel < mask.length; pixel++) {
			mask[pixel] =
				gx[pixel] ** 2 + gy[pixel] ** 2 < FLAT_GRADIENT_MAX ** 2 ? 255 : 0;
		}
		cv.erode(flat, flat, window);
		cv.bilateralFilter(
			picture,
			filtered,
			BILATERAL_DIAMETER,
			BILATERAL_SIGMA_COLOR,
			BILATERAL_SIGMA_SPACE,
		);
		filtered.copyTo(picture, flat);
	} finally {
		for (const mat of [gray, gradientX, gradientY, flat, window, filtered])
			mat.delete();
	}
}

export function finish(
	cv: CV,
	output: RgbImage,
	input: RgbImage,
	damage: DamageClass,
): RgbImage {
	const restored = cv.matFromArray(
		output.height,
		output.width,
		cv.CV_8UC3,
		output.data,
	);
	const source = cv.matFromArray(
		input.height,
		input.width,
		cv.CV_8UC3,
		input.data,
	);
	const matched = new cv.Mat();
	const everywhere = new cv.Mat();
	const drift = colourDrift(cv, restored, source);
	try {
		cv.add(restored, drift, matched, everywhere, cv.CV_8U);
		if (SMOOTHED_DAMAGE.has(damage)) smoothFlatRegions(cv, matched);
		return {
			width: output.width,
			height: output.height,
			data: new Uint8ClampedArray(matched.data),
		};
	} finally {
		for (const mat of [restored, source, matched, everywhere, drift])
			mat.delete();
	}
}
