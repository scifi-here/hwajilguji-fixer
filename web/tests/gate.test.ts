import { readFileSync } from "node:fs";
import cvModule from "@techstark/opencv-js";
import { describe, expect, it } from "vitest";
import { type DamageClass, inspect } from "#lib/pipeline/gate.ts";
import type { Format } from "#lib/pipeline/sniff.ts";

const cv = await cvModule;

type GateCase = {
	readonly file: string;
	readonly width: number;
	readonly height: number;
	readonly label: DamageClass;
	readonly gridOffset: readonly [number, number] | null;
};

const fixtureDir = new URL("./fixtures/gate/", import.meta.url);
const LABELS: readonly DamageClass[] = [
	"clean",
	"blocky8",
	"smeared",
	"palette",
];

function parseCase(entry: unknown): GateCase {
	if (typeof entry !== "object" || entry === null)
		throw new Error("cases.json entry is not an object");
	const fields = new Map<string, unknown>(Object.entries(entry));
	const [file, width, height, label, offset] = [
		"file",
		"width",
		"height",
		"label",
		"gridOffset",
	].map((key) => fields.get(key));
	if (
		typeof file !== "string" ||
		typeof width !== "number" ||
		typeof height !== "number"
	) {
		throw new Error("cases.json entry lacks file, width or height");
	}
	const damage = LABELS.find((known) => known === label);
	if (damage === undefined)
		throw new Error(`cases.json ${file} has label ${String(label)}`);
	if (offset === null)
		return { file, width, height, label: damage, gridOffset: null };
	if (!Array.isArray(offset) || offset.length !== 2)
		throw new Error(`cases.json ${file} has a bad gridOffset`);
	return {
		file,
		width,
		height,
		label: damage,
		gridOffset: [Number(offset[0]), Number(offset[1])],
	};
}

const casesJson: unknown = JSON.parse(
	readFileSync(new URL("cases.json", fixtureDir), "utf8"),
);
if (!Array.isArray(casesJson)) throw new Error("cases.json is not an array");
const cases = casesJson.map(parseCase);

function rgbaFromRgb(
	rgb: Uint8Array,
	width: number,
	height: number,
): ImageData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		data.set(rgb.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
		data[pixel * 4 + 3] = 255;
	}
	return { colorSpace: "srgb", width, height, data };
}

function containerOf(file: string): [Format, number | null] {
	const [, codec, quality] =
		/-(jpeg|webp|avif|heic|gif)-q(\d+)\./.exec(file) ?? [];
	if (codec === "jpeg") return ["jpeg", Number(quality)];
	if (codec === "webp") return ["webp-lossy", null];
	if (codec === "avif" || codec === "heic" || codec === "gif")
		return [codec, null];
	return ["png", null];
}

const reports = cases.map((gateCase) => {
	const image = rgbaFromRgb(
		readFileSync(new URL(gateCase.file, fixtureDir)),
		gateCase.width,
		gateCase.height,
	);
	const [format, jpegQuality] = containerOf(gateCase.file);
	return { gateCase, report: inspect(cv, image, format, jpegQuality) };
});

describe("inspect on fixtures made by known degradations", () => {
	it("separates blocky8 from every other label with at least 90% accuracy", () => {
		const correct = reports.filter(
			({ gateCase, report }) =>
				(gateCase.label === "blocky8") === (report.damage === "blocky8"),
		);
		expect(correct.length / reports.length).toBeGreaterThanOrEqual(0.9);
	});

	it("classifies every palette case as palette", () => {
		const palette = reports.filter(
			({ gateCase }) => gateCase.label === "palette",
		);
		expect(palette.length).toBeGreaterThan(0);
		expect(palette.map(({ report }) => report.damage)).toEqual(
			palette.map(() => "palette"),
		);
	});

	it("reports the recorded grid offset for the multi-pass shifted JPEG", () => {
		const shifted = reports.filter(({ gateCase }) =>
			gateCase.file.includes("jpeg-gen3"),
		);
		expect(shifted.length).toBeGreaterThan(0);
		for (const { gateCase, report } of shifted) {
			expect(report.gridOffset, gateCase.file).toEqual(gateCase.gridOffset);
		}
	});
});

function smoothTexture(
	width: number,
	height: number,
): Uint8ClampedArray<ArrayBuffer> {
	const luma = new Uint8ClampedArray(width * height);
	let state = 12345;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			state = (state * 1103515245 + 12345) >>> 0;
			const grain = (state >>> 24) / 32 - 4;
			luma[y * width + x] =
				128 + 60 * Math.sin(x / 5.3) + 50 * Math.cos(y / 7.1) + grain;
		}
	}
	return luma;
}

function cellMeans(
	luma: Uint8ClampedArray<ArrayBuffer>,
	width: number,
	height: number,
	offsetX: number,
	offsetY: number,
) {
	const columns = Math.ceil(width / 8) + 1;
	const cellOf = (pixel: number): number =>
		Math.floor((Math.floor(pixel / width) + 8 - offsetY) / 8) * columns +
		Math.floor(((pixel % width) + 8 - offsetX) / 8);
	const sums = new Float64Array(columns * (Math.ceil(height / 8) + 1));
	const counts = new Float64Array(sums.length);
	luma.forEach((value, pixel) => {
		sums[cellOf(pixel)] += value;
		counts[cellOf(pixel)] += 1;
	});
	return luma.map((_, pixel) => sums[cellOf(pixel)] / counts[cellOf(pixel)]);
}

function grayImage(
	luma: Uint8ClampedArray,
	width: number,
	height: number,
): ImageData {
	const data = new Uint8ClampedArray(width * height * 4);
	luma.forEach((value, pixel) => {
		data.set([value, value, value, 255], pixel * 4);
	});
	return { colorSpace: "srgb", width, height, data };
}

describe("inspect on synthetic block grids", () => {
	const [width, height] = [160, 128];
	const texture = smoothTexture(width, height);

	it("finds an 8x8 mean-block grid shifted by (3, 5)", () => {
		const blocked = grayImage(
			cellMeans(texture, width, height, 3, 5),
			width,
			height,
		);
		const report = inspect(cv, blocked, "png", null);
		expect(report.damage).toBe("blocky8");
		expect(report.gridOffset).toEqual([3, 5]);
	});

	it("calls the same grey texture clean, neither blocky nor palette, before the cells are averaged", () => {
		expect(
			inspect(cv, grayImage(texture, width, height), "png", null).damage,
		).toBe("clean");
	});
});

describe("inspect content kind", () => {
	it("calls a flat page with thin dark strokes a graphic", () => {
		const [width, height] = [128, 96];
		const luma = new Uint8ClampedArray(width * height).fill(250);
		for (let y = 10; y < height; y += 24)
			luma.fill(20, y * width + 8, y * width + 120);
		expect(
			inspect(cv, grayImage(luma, width, height), "png", null).content,
		).toBe("graphic");
	});

	it("calls a textured image a photo", () => {
		expect(
			inspect(cv, grayImage(smoothTexture(128, 96), 128, 96), "png", null)
				.content,
		).toBe("photo");
	});
});
