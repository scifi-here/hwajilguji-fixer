import type { CV, Mat } from "@techstark/opencv-js";

export type RgbImage = {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray<ArrayBuffer>;
};

export type TileModel = {
	readonly scale: number;
	readonly multipleOf: number;
	run(tile: RgbImage): Promise<RgbImage>;
};

export type TileOptions = {
	readonly core: number;
	readonly pad: number;
	readonly signal: AbortSignal;
	onProgress(done: number, total: number): void;
};

type Cell = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

function cutTile(
	cv: CV,
	whole: Mat,
	cell: Cell,
	pad: number,
	multipleOf: number,
): RgbImage {
	const width = Math.ceil((cell.width + 2 * pad) / multipleOf) * multipleOf;
	const height = Math.ceil((cell.height + 2 * pad) / multipleOf) * multipleOf;
	const region = whole.roi(
		new cv.Rect(cell.x, cell.y, cell.width, cell.height),
	);
	const padded = new cv.Mat();
	try {
		const right = width - cell.width - pad;
		const bottom = height - cell.height - pad;
		cv.copyMakeBorder(
			region,
			padded,
			pad,
			bottom,
			pad,
			right,
			cv.BORDER_REFLECT_101,
		);
		return { width, height, data: new Uint8ClampedArray(padded.data) };
	} finally {
		padded.delete();
		region.delete();
	}
}

function pasteCell(
	target: RgbImage,
	result: RgbImage,
	cell: Cell,
	pad: number,
	scale: number,
): void {
	const rowBytes = cell.width * scale * 3;
	for (let row = 0; row < cell.height * scale; row++) {
		const from = ((pad * scale + row) * result.width + pad * scale) * 3;
		const to = ((cell.y * scale + row) * target.width + cell.x * scale) * 3;
		target.data.set(result.data.subarray(from, from + rowBytes), to);
	}
}

export async function runTiled(
	cv: CV,
	src: RgbImage,
	model: TileModel,
	options: TileOptions,
): Promise<RgbImage> {
	const { core, pad, signal, onProgress } = options;
	const { scale, multipleOf } = model;
	const target: RgbImage = {
		width: src.width * scale,
		height: src.height * scale,
		data: new Uint8ClampedArray(src.width * scale * src.height * scale * 3),
	};
	const columns = Math.ceil(src.width / core);
	const total = columns * Math.ceil(src.height / core);
	const whole = cv.matFromArray(src.height, src.width, cv.CV_8UC3, src.data);
	try {
		for (let index = 0; index < total; index++) {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			const x = (index % columns) * core;
			const y = Math.floor(index / columns) * core;
			const cell = {
				x,
				y,
				width: Math.min(core, src.width - x),
				height: Math.min(core, src.height - y),
			};
			const tile = cutTile(cv, whole, cell, pad, multipleOf);
			const result = await model.run(tile);
			if (
				result.width !== tile.width * scale ||
				result.height !== tile.height * scale
			) {
				throw new Error(
					`model returned ${result.width}x${result.height} for a ${tile.width}x${tile.height} tile`,
				);
			}
			pasteCell(target, result, cell, pad, scale);
			onProgress(index + 1, total);
		}
	} finally {
		whole.delete();
	}
	return target;
}
