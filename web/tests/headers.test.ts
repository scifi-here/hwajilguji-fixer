import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimateJpegQuality } from "#lib/pipeline/headers.ts";

const STD_LUMA = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
	24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
	103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
	72, 92, 95, 98, 112, 100, 103, 99,
];

function libjpegTable(quality: number, maxValue: number): number[] {
	const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
	return STD_LUMA.map((value) =>
		Math.min(maxValue, Math.max(1, Math.floor((value * scale + 50) / 100))),
	);
}

function segment(marker: number, payload: readonly number[]): number[] {
	const length = payload.length + 2;
	return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function dqt8(tableId: number, values: readonly number[]): number[] {
	return [tableId, ...values];
}

function dqt16(tableId: number, values: readonly number[]): number[] {
	return [
		0x10 | tableId,
		...values.flatMap((value) => [value >> 8, value & 0xff]),
	];
}

function jpeg(...segments: number[][]): Uint8Array {
	const startOfScan = segment(0xda, [1, 1, 0, 0, 63, 0]);
	return Uint8Array.from([
		0xff,
		0xd8,
		...segments.flat(),
		...startOfScan,
		0x12,
		0x34,
		0xff,
		0xd9,
	]);
}

const fixture = (name: string): Uint8Array =>
	readFileSync(new URL(`./fixtures/jpeg/${name}`, import.meta.url));

describe("estimateJpegQuality on encoder output", () => {
	it.each([10, 30, 50, 75, 90])(
		"recovers the quality factor %i used to encode the fixture within 2",
		(quality) => {
			const estimate = estimateJpegQuality(fixture(`qf${quality}.jpg`));
			expect(estimate).not.toBeNull();
			expect(Math.abs((estimate ?? Number.NaN) - quality)).toBeLessThanOrEqual(
				2,
			);
		},
	);

	it("returns null when the file is cut before its header ends", () => {
		expect(
			estimateJpegQuality(fixture("qf50.jpg").subarray(0, 100)),
		).toBeNull();
	});
});

describe("estimateJpegQuality on hand-built headers", () => {
	it("reads 16-bit table entries when Pq is 1", () => {
		const header = jpeg(segment(0xdb, dqt16(0, libjpegTable(10, 32767))));
		expect(estimateJpegQuality(header)).toBe(10);
	});

	it("takes table 0 even when another table comes first in the same segment", () => {
		const flatTable = new Array<number>(64).fill(1);
		const header = jpeg(
			segment(0xdb, [...dqt8(1, flatTable), ...dqt8(0, libjpegTable(20, 255))]),
		);
		expect(estimateJpegQuality(header)).toBe(20);
	});

	it("walks segments by length instead of scanning for the DQT marker bytes", () => {
		const decoyTable = segment(0xdb, dqt8(0, new Array<number>(64).fill(1)));
		const header = jpeg(
			segment(0xe1, decoyTable),
			segment(0xdb, dqt8(0, libjpegTable(60, 255))),
		);
		expect(estimateJpegQuality(header)).toBe(60);
	});

	it("returns null when no table 0 is defined", () => {
		const header = jpeg(segment(0xdb, dqt8(1, libjpegTable(50, 255))));
		expect(estimateJpegQuality(header)).toBeNull();
	});

	it("returns null for bytes that are not a JPEG", () => {
		expect(
			estimateJpegQuality(
				Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			),
		).toBeNull();
	});
});
