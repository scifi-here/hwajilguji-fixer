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

export type TileOverlay = {
	readonly target: RgbImage;
	readonly mask: Uint8Array;
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

function intersects(
	mask: Uint8Array,
	width: number,
	cell: Cell,
	scale: number,
): boolean {
	for (let y = 0; y < cell.height * scale; y++) {
		const start = (cell.y * scale + y) * width + cell.x * scale;
		if (
			mask
				.subarray(start, start + cell.width * scale)
				.some((value) => value !== 0)
		)
			return true;
	}
	return false;
}

function pasteCell(
	target: RgbImage,
	result: RgbImage,
	cell: Cell,
	pad: number,
	scale: number,
	mask?: Uint8Array,
): void {
	const rowBytes = cell.width * scale * 3;
	for (let row = 0; row < cell.height * scale; row++) {
		const from = ((pad * scale + row) * result.width + pad * scale) * 3;
		const to = ((cell.y * scale + row) * target.width + cell.x * scale) * 3;
		if (!mask) {
			target.data.set(result.data.subarray(from, from + rowBytes), to);
			continue;
		}
		for (let byte = 0; byte < rowBytes; byte += 3) {
			const alpha = mask[(to + byte) / 3] / 255;
			if (alpha === 0) continue;
			for (let channel = 0; channel < 3; channel++) {
				const index = to + byte + channel;
				target.data[index] =
					target.data[index] * (1 - alpha) +
					result.data[from + byte + channel] * alpha;
			}
		}
	}
}

export async function runTiled(
	cv: CV,
	src: RgbImage,
	model: TileModel,
	options: TileOptions,
	overlay?: TileOverlay,
): Promise<RgbImage> {
	const { core, pad, signal, onProgress } = options;
	const { scale, multipleOf } = model;
	const target: RgbImage = overlay?.target ?? {
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
			if (!overlay || intersects(overlay.mask, target.width, cell, scale)) {
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
				pasteCell(target, result, cell, pad, scale, overlay?.mask);
			}
			onProgress(index + 1, total);
			if (index + 1 < total)
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	} finally {
		whole.delete();
	}
	return target;
}
