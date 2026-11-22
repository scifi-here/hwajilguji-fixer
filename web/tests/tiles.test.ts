import cvModule from "@techstark/opencv-js";
import { describe, expect, it } from "vitest";
import {
	type RgbImage,
	runTiled,
	type TileModel,
} from "#lib/pipeline/tiles.ts";

const cv = await cvModule;

const SIZES: readonly (readonly [number, number])[] = [
	[1, 1],
	[17, 300],
	[224, 224],
	[225, 449],
	[500, 333],
];
const SETTINGS = [
	{ name: "WebGPU", core: 224, pad: 16 },
	{ name: "WASM", core: 96, pad: 16 },
];

function noise(width: number, height: number): RgbImage {
	const data = new Uint8ClampedArray(width * height * 3);
	let state = width * 7919 + height;
	for (let index = 0; index < data.length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		data[index] = state >>> 24;
	}
	return { width, height, data };
}

function reflect101(index: number, length: number): number {
	if (length === 1) return 0;
	const period = 2 * (length - 1);
	const folded = ((index % period) + period) % period;
	return folded < length ? folded : period - folded;
}

function remap(
	image: RgbImage,
	scale: number,
	source: (x: number, y: number) => [number, number],
): RgbImage {
	const width = image.width * scale;
	const height = image.height * scale;
	const data = new Uint8ClampedArray(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [sx, sy] = source(x, y);
			const from = (sy * image.width + sx) * 3;
			data.set(image.data.subarray(from, from + 3), (y * width + x) * 3);
		}
	}
	return { width, height, data };
}

const identity = (image: RgbImage): RgbImage =>
	remap(image, 1, (x, y) => [x, y]);
const nearestX4 = (image: RgbImage): RgbImage =>
	remap(image, 4, (x, y) => [Math.floor(x / 4), Math.floor(y / 4)]);
const readsPadAway = (pad: number) => (image: RgbImage) =>
	remap(image, 1, (x, y) => [
		reflect101(x - pad, image.width),
		reflect101(y + pad, image.height),
	]);

function contractModel(
	scale: number,
	multipleOf: number,
	maxSide: number,
	operator: (tile: RgbImage) => RgbImage,
): TileModel {
	return {
		scale,
		multipleOf,
		run: async (tile) => {
			if (tile.width % multipleOf !== 0 || tile.height % multipleOf !== 0)
				throw new Error("tile not aligned");
			if (tile.width > maxSide || tile.height > maxSide)
				throw new Error("tile larger than one cell");
			return operator(tile);
		},
	};
}

const neverAborted = new AbortController().signal;
const roundUp = (value: number, step: number): number =>
	Math.ceil(value / step) * step;

describe("runTiled output equals the whole-image result", () => {
	for (const { name, core, pad } of SETTINGS) {
		const maxSide = roundUp(core + 2 * pad, 16);
		const models: [string, TileModel, (image: RgbImage) => RgbImage][] = [
			["identity", contractModel(1, 1, core + 2 * pad, identity), identity],
			["nearest x4", contractModel(4, 16, maxSide, nearestX4), nearestX4],
			[
				"operator reading pixels pad away",
				contractModel(1, 16, maxSide, readsPadAway(pad)),
				readsPadAway(pad),
			],
		];
		for (const [modelName, model, wholeImage] of models) {
			it.each(SIZES)(
				`${name} core ${core}, ${modelName}, %ix%i`,
				async (width, height) => {
					const source = noise(width, height);
					const tiled = await runTiled(cv, source, model, {
						core,
						pad,
						signal: neverAborted,
						onProgress: () => {},
					});
					const expected = wholeImage(source);
					expect(tiled.width).toBe(expected.width);
					expect(tiled.height).toBe(expected.height);
					expect(
						Buffer.from(tiled.data).equals(Buffer.from(expected.data)),
					).toBe(true);
				},
			);
		}
	}
});

describe("runTiled progress and cancellation", () => {
	it("reports progress once per cell, ending at the cell count", async () => {
		const reports: [number, number][] = [];
		const model = contractModel(1, 1, 256, identity);
		await runTiled(cv, noise(225, 449), model, {
			core: 224,
			pad: 16,
			signal: neverAborted,
			onProgress: (done, total) => reports.push([done, total]),
		});
		expect(reports).toEqual([
			[1, 6],
			[2, 6],
			[3, 6],
			[4, 6],
			[5, 6],
			[6, 6],
		]);
	});

	it("rejects with AbortError and runs no tile after the signal fires", async () => {
		const controller = new AbortController();
		let tilesAfterAbort = 0;
		const model: TileModel = {
			scale: 1,
			multipleOf: 1,
			run: async (tile) => {
				if (controller.signal.aborted) tilesAfterAbort++;
				controller.abort();
				return identity(tile);
			},
		};
		const run = runTiled(cv, noise(500, 333), model, {
			core: 96,
			pad: 16,
			signal: controller.signal,
			onProgress: () => {},
		});
		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(tilesAfterAbort).toBe(0);
	});

	it("rejects with AbortError before any tile when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const model = contractModel(1, 1, 256, () => {
			throw new Error("model ran after abort");
		});
		const run = runTiled(cv, noise(64, 64), model, {
			core: 96,
			pad: 16,
			signal: controller.signal,
			onProgress: () => {},
		});
		await expect(run).rejects.toMatchObject({ name: "AbortError" });
	});
});
