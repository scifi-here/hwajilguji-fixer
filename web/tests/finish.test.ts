import cvModule from "@techstark/opencv-js";
import { describe, expect, it } from "vitest";
import { finish } from "#lib/pipeline/finish.ts";
import type { RgbImage } from "#lib/pipeline/tiles.ts";

const cv = await cvModule;

function image(
	width: number,
	height: number,
	value: (x: number, y: number, channel: number) => number,
): RgbImage {
	const data = new Uint8ClampedArray(width * height * 3);
	for (let index = 0; index < data.length; index++) {
		const pixel = Math.floor(index / 3);
		data[index] = value(pixel % width, Math.floor(pixel / width), index % 3);
	}
	return { width, height, data };
}

const texture = image(
	96,
	64,
	(x, y, channel) => 115 + 60 * Math.sin(x / 4 + channel) * Math.cos(y / 6),
);

function channelMeans(picture: RgbImage): number[] {
	const sums = [0, 0, 0];
	picture.data.forEach((value, index) => {
		sums[index % 3] += value;
	});
	return sums.map((sum) => sum / (picture.width * picture.height));
}

function nearest(picture: RgbImage, scale: number): RgbImage {
	return image(
		picture.width * scale,
		picture.height * scale,
		(x, y, channel) => {
			const source =
				(Math.floor(y / scale) * picture.width + Math.floor(x / scale)) * 3 +
				channel;
			return picture.data[source];
		},
	);
}

function shifted(picture: RgbImage, delta: number): RgbImage {
	return { ...picture, data: picture.data.map((value) => value + delta) };
}

function standardDeviation(picture: RgbImage): number {
	const mean =
		picture.data.reduce((sum, value) => sum + value, 0) / picture.data.length;
	const variance =
		picture.data.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		picture.data.length;
	return Math.sqrt(variance);
}

describe("finish colour match", () => {
	it.each([1, 2, 4])(
		"pulls a +20 drift on every channel back to the input mean at scale %i",
		(scale) => {
			const drifted = shifted(nearest(texture, scale), 20);
			const result = finish(cv, drifted, texture, "blocky8");
			const expected = channelMeans(texture);
			channelMeans(result).forEach((mean, channel) => {
				expect(Math.abs(mean - expected[channel])).toBeLessThanOrEqual(2);
			});
		},
	);
});

describe("finish flat-region smoothing", () => {
	const stripes = (ink: number) =>
		image(64, 48, (x) => (x % 6 === 2 ? ink : 255));

	it.each([
		["black-on-white", 0],
		["faint grey-on-white", 249],
	])("leaves a %s 1 px stripe pattern unchanged", (_name, ink) => {
		const page = stripes(ink);
		const result = finish(cv, page, page, "smeared");
		expect(Buffer.from(result.data).equals(Buffer.from(page.data))).toBe(true);
	});

	const dither = image(64, 48, (x, y) => ((x + y) % 2 === 0 ? 120 : 124));

	it.each(["smeared", "palette"] as const)(
		"damps fine dither in a flat region for %s",
		(damage) => {
			expect(
				standardDeviation(finish(cv, dither, dither, damage)),
			).toBeLessThan(standardDeviation(dither) / 1.5);
		},
	);

	it.each(["blocky8", "clean"] as const)(
		"keeps fine dither for %s",
		(damage) => {
			expect(
				Buffer.from(finish(cv, dither, dither, damage).data).equals(
					Buffer.from(dither.data),
				),
			).toBe(true);
		},
	);
});
