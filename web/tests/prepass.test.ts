import cvModule from "@techstark/opencv-js";
import { describe, expect, it } from "vitest";
import { alignGrid, cropImage } from "#lib/pipeline/prepass.ts";
import type { RgbImage } from "#lib/pipeline/tiles.ts";

const cv = await cvModule;

function noise(width: number, height: number): RgbImage {
	const data = new Uint8ClampedArray(width * height * 3);
	let state = 4242;
	for (let index = 0; index < data.length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		data[index] = state >>> 24;
	}
	return { width, height, data };
}

function blockGrid(
	width: number,
	height: number,
	offsetX: number,
	offsetY: number,
): RgbImage {
	const data = new Uint8ClampedArray(width * height * 3);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const cellX = Math.floor(((pixel % width) + 8 - offsetX) / 8);
		const cellY = Math.floor((Math.floor(pixel / width) + 8 - offsetY) / 8);
		data.fill((cellX * 37 + cellY * 91) % 256, pixel * 3, pixel * 3 + 3);
	}
	return { width, height, data };
}

describe("alignGrid", () => {
	it.each([
		[0, 0],
		[3, 5],
		[7, 1],
	])(
		"round-trips through the returned crop for grid offset (%i, %i)",
		(offsetX, offsetY) => {
			const source = noise(45, 37);
			const { image, crop } = alignGrid(cv, source, [offsetX, offsetY]);
			const restored = cropImage(image, crop);
			expect(restored.width).toBe(source.width);
			expect(restored.height).toBe(source.height);
			expect(Buffer.from(restored.data).equals(Buffer.from(source.data))).toBe(
				true,
			);
		},
	);

	it("moves every block edge of a grid at offset (3, 5) onto a multiple of 8", () => {
		const { image } = alignGrid(cv, blockGrid(64, 48, 3, 5), [3, 5]);
		const misaligned: [number, number][] = [];
		for (let y = 8; y < image.height; y++) {
			for (let x = 8; x < image.width; x++) {
				const cellOrigin = ((y - (y % 8)) * image.width + (x - (x % 8))) * 3;
				if (image.data[(y * image.width + x) * 3] !== image.data[cellOrigin])
					misaligned.push([x, y]);
			}
		}
		expect(misaligned).toEqual([]);
	});
});
