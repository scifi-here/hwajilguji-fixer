import cvModule from "@techstark/opencv-js";
import { describe, expect, it } from "vitest";
import type { GateReport } from "#lib/pipeline/gate.ts";
import { type RestoreDeps, restore } from "#lib/pipeline/restore.ts";
import type { LoadedModel, ModelRole } from "#lib/pipeline/session.ts";
import type { RgbImage, TileModel } from "#lib/pipeline/tiles.ts";

const cv = await cvModule;

function rgba(
	width: number,
	height: number,
	pixel: (x: number, y: number) => readonly number[],
): ImageData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index++) {
		data.set(pixel(index % width, Math.floor(index / width)), index * 4);
	}
	return { colorSpace: "srgb", width, height, data };
}

function nearest(tile: RgbImage, scale = 4): RgbImage {
	const width = tile.width * scale;
	const data = new Uint8ClampedArray(width * tile.height * scale * 3);
	for (let index = 0; index < data.length / 3; index++) {
		const source =
			(Math.floor(index / width / scale) * tile.width +
				Math.floor((index % width) / scale)) *
			3;
		data.set(tile.data.subarray(source, source + 3), index * 3);
	}
	return { width, height: tile.height * scale, data };
}

const models: Record<ModelRole, TileModel> = {
	textDetector: {
		scale: 1,
		multipleOf: 32,
		run: async (tile) => ({
			...tile,
			data: new Uint8ClampedArray(tile.data.length),
		}),
	},
	photo2x: { scale: 2, multipleOf: 1, run: async (tile) => nearest(tile, 2) },
	photo4x: { scale: 4, multipleOf: 1, run: async (tile) => nearest(tile) },
	deblock: { scale: 1, multipleOf: 16, run: async (tile) => tile },
	upscalePhoto: {
		scale: 4,
		multipleOf: 1,
		run: async (tile) => nearest(tile),
	},
	upscaleGraphicBackProjection: {
		scale: 4,
		multipleOf: 1,
		run: async (tile) => nearest(tile),
	},
	upscaleGraphic: {
		scale: 4,
		multipleOf: 1,
		run: async (tile) => nearest(tile),
	},
};

const deps: RestoreDeps = {
	loadModel: async (role): Promise<LoadedModel> => ({
		model: models[role],
		backend: "wasm",
	}),
	signal: new AbortController().signal,
	onProgress: () => {},
};

const report = (gridOffset: readonly [number, number] | null): GateReport => ({
	damage: "clean",
	content: "photo",
	blockiness: 1,
	gridOffset,
	uniqueColors: 257,
	jpegQuality: null,
});

let state = 77;
const noisy = rgba(53, 41, () => {
	state = (state * 1103515245 + 12345) >>> 0;
	return [state >>> 24, (state >>> 16) & 0xff, (state >>> 8) & 0xff, 255];
});

describe("restore routes", () => {
	it("returns a clean image unchanged at 1x", async () => {
		const result = await restore(
			cv,
			noisy,
			report(null),
			{ mode: "restore", scale: 1, damage: "clean", content: "photo" },
			deps,
		);
		expect(Buffer.from(result.data).equals(Buffer.from(noisy.data))).toBe(true);
	});

	it("undoes the grid alignment so an identity deblocker returns the input at 1x", async () => {
		const result = await restore(
			cv,
			noisy,
			report([3, 5]),
			{ mode: "restore", scale: 1, damage: "blocky8", content: "photo" },
			deps,
		);
		expect([result.width, result.height]).toEqual([noisy.width, noisy.height]);
		expect(Buffer.from(result.data).equals(Buffer.from(noisy.data))).toBe(true);
	});

	it("sends a smeared image through the deblocker at 1x without loading an upscaler", async () => {
		const deblockOnly: RestoreDeps = {
			...deps,
			loadModel: async (role): Promise<LoadedModel> => {
				if (role !== "deblock") throw new Error(`${role} must not load at 1x`);
				return { model: models.deblock, backend: "wasm" };
			},
		};
		const result = await restore(
			cv,
			noisy,
			report(null),
			{ mode: "restore", scale: 1, damage: "smeared", content: "photo" },
			deblockOnly,
		);
		expect([result.width, result.height]).toEqual([noisy.width, noisy.height]);
	});

	it("resizes an x4 upscaler to the requested 2x and keeps a flat colour flat", async () => {
		const flat = rgba(30, 20, () => [40, 120, 200, 255]);
		const result = await restore(
			cv,
			flat,
			report(null),
			{ mode: "restore", scale: 2, damage: "smeared", content: "graphic" },
			deps,
		);
		expect([result.width, result.height]).toEqual([60, 40]);
		const colours = new Set<string>();
		for (let index = 0; index < result.data.length; index += 4)
			colours.add(result.data.slice(index, index + 4).join());
		expect([...colours]).toEqual(["40,120,200,255"]);
	});

	it("carries a translucent alpha plane through a 4x upscale", async () => {
		const translucent = rgba(24, 16, (x) => [x * 10, 90, 160, 77]);
		const result = await restore(
			cv,
			translucent,
			report(null),
			{ mode: "restore", scale: 4, damage: "clean", content: "photo" },
			deps,
		);
		expect([result.width, result.height]).toEqual([96, 64]);
		const alphas = new Set(result.data.filter((_, index) => index % 4 === 3));
		expect([...alphas]).toEqual([77]);
	});
});

it.each([2, 4] as const)(
	"bypasses palette repair at %ix when only enlarging",
	async (scale) => {
		const input = rgba(22, 17, (x, y) =>
			(x + y) % 2 === 0 ? [80, 80, 80, 77] : [100, 100, 100, 77],
		);
		const result = await restore(
			cv,
			input,
			report(null),
			{
				mode: "upscaleOnly",
				scale,
				damage: "palette",
				content: "photo",
			},
			deps,
		);
		expect(result.width).toBe(22 * scale);
		expect(result.height).toBe(17 * scale);
		expect([...result.data.slice(0, 4)]).toEqual([80, 80, 80, 77]);
		expect([...result.data.slice(4 * scale, 4 * scale + 4)]).toEqual([
			100, 100, 100, 77,
		]);
	},
);
