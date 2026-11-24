import { expect, it } from "vitest";
import { suppressTextHalos } from "#lib/pipeline/text-halo.ts";
import type { RgbImage } from "#lib/pipeline/tiles.ts";

type Color = [number, number, number];

function sample(
	width: number,
	height: number,
	color: (x: number, y: number) => Color,
): RgbImage {
	const data = new Uint8ClampedArray(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) data.set(color(x, y), 3 * (width * y + x));
	}
	return { width, height, data };
}

function detector(width: number, height: number) {
	return {
		width,
		height,
		data: new Uint8Array(width * height).fill(255),
		fraction: 1,
	};
}

function pixel(image: RgbImage, x: number, y: number) {
	const at = (y * image.width + x) * 3;
	return [...image.data.subarray(at, at + 3)];
}

it.each([
	[2, [232, 227, 201], [36, 38, 40], [211, 213, 193]],
	[4, [22, 31, 48], [204, 222, 239], [37, 47, 62]],
] as const)(
	"reduces the exterior ring at %ix while retaining the complete thin stroke",
	async (scale, background, ink, halo) => {
		const width = 72,
			height = 48;
		const img = sample(width, height, (x, y) => {
			const nearStroke = y >= 7 && y < height - 7;
			if (nearStroke && x === 36) return [...ink];
			if (nearStroke && Math.abs(x - 36) === scale) return [...halo];
			return [...background];
		});
		await suppressTextHalos(
			img,
			detector(36, 24),
			scale,
			new AbortController().signal,
		);
		const out = pixel(img, 36 + scale, 24);
		for (let c = 0; c < 3; c++)
			expect(Math.abs(out[c] - background[c])).toBeLessThan(
				Math.abs(halo[c] - background[c]) * 0.6,
			);
		for (let y = 7; y < height - 7; y++) expect(pixel(img, 36, y)).toEqual(ink);
		expect(pixel(img, 1, 1)).toEqual(background);
	},
);

it("keeps compressed texture outside the text mask and a faint edge far from ink", async () => {
	const img = sample(80, 32, (x) =>
		x === 41
			? [20, 20, 20]
			: x === 37 || x === 45 || x === 63
				? [208, 208, 208]
				: [227, 227, 227],
	);
	const mask = detector(80, 32);
	for (let y = 0; y < 32; y++) mask.data.fill(0, 80 * y, 80 * y + 40);
	await suppressTextHalos(img, mask, 2, new AbortController().signal);
	expect(pixel(img, 37, 16)).toEqual([208, 208, 208]);
	expect(pixel(img, 63, 16)).toEqual([208, 208, 208]);
	expect(pixel(img, 45, 16)[0]).toBeGreaterThan(216);
});

it("preserves two-tone background texture around a high contrast line", async () => {
	const img = sample(64, 40, (x, y) =>
		x === 32 ? [14, 14, 14] : (x + y) % 2 ? [187, 194, 190] : [216, 219, 213],
	);
	const before = img.data.slice();
	await suppressTextHalos(
		img,
		detector(32, 20),
		2,
		new AbortController().signal,
	);
	expect(img.data).toEqual(before);
});

it("observes cancellation without touching image pixels", async () => {
	const img = sample(13, 7, () => [180, 180, 180]);
	await expect(
		suppressTextHalos(img, detector(3, 2), 4, AbortSignal.abort()),
	).rejects.toMatchObject({ name: "AbortError" });
});

it("finds the surrounding paper colour even between crowded strokes", async () => {
	const image = sample(80, 64, (x, y) => {
		if (x >= 28 && x < 47 && y >= 25 && y < 39) {
			if (x === 37) return [211, 212, 212];
			if (x % 4 !== 0) return [47, 48, 48];
		}
		return [234, 235, 235];
	});
	await suppressTextHalos(
		image,
		detector(40, 32),
		2,
		new AbortController().signal,
	);
	expect(pixel(image, 37, 32)[0]).toBeGreaterThan(220);
	expect(pixel(image, 38, 32)).toEqual([47, 48, 48]);
});

it("removes a faint ripple near softened ink at 4x without bleaching a second stroke", async () => {
	const image = sample(96, 64, (x) =>
		x === 47
			? [153, 153, 153]
			: x === 51
				? [209, 209, 209]
				: x === 43
					? [194, 194, 194]
					: [222, 222, 222],
	);
	await suppressTextHalos(
		image,
		detector(48, 32),
		4,
		new AbortController().signal,
	);
	const corrected = pixel(image, 51, 32)[0];
	expect(corrected).toBeGreaterThan(209);
	expect(corrected).toBeLessThanOrEqual(215);
	expect(pixel(image, 43, 32)).toEqual([194, 194, 194]);
});

it("retains a repeating muted stripe under a contrasting character", async () => {
	const image = sample(96, 64, (x) =>
		x === 48
			? [17, 20, 22]
			: Math.floor(x / 4) % 2 === 0
				? [205, 211, 217]
				: [235, 239, 242],
	);
	const before = image.data.slice();
	await suppressTextHalos(
		image,
		detector(24, 16),
		4,
		new AbortController().signal,
	);
	expect(image.data).toEqual(before);
});
