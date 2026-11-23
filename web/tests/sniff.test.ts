import { describe, expect, it } from "vitest";
import { type Format, sniffFormat } from "#lib/pipeline/sniff.ts";

type Part = string | readonly number[];

function bytes(...parts: Part[]): Uint8Array {
	const out: number[] = [];
	for (const part of parts) {
		if (typeof part === "string") {
			for (const char of part) out.push(char.charCodeAt(0));
		} else {
			out.push(...part);
		}
	}
	return Uint8Array.from(out);
}

function u32le(value: number): number[] {
	return [
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		value >>> 24,
	];
}

function u32be(value: number): number[] {
	return [
		value >>> 24,
		(value >> 16) & 0xff,
		(value >> 8) & 0xff,
		value & 0xff,
	];
}

function riffChunk(fourcc: string, payload: readonly number[]): Part[] {
	const pad = payload.length % 2 === 1 ? [0] : [];
	return [fourcc, u32le(payload.length), payload, pad];
}

function webp(...chunks: Part[][]): Uint8Array {
	const body = bytes("WEBP", ...chunks.flat());
	return bytes("RIFF", u32le(body.length), [...body]);
}

function ftyp(major: string, ...compatible: string[]): Uint8Array {
	const size = 16 + 4 * compatible.length;
	return bytes(u32be(size), "ftyp", major, [0, 0, 0, 0], ...compatible, "mdat");
}

const zeros = (count: number): number[] => new Array<number>(count).fill(0);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JXL_CONTAINER = [
	0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
];

describe("sniffFormat recognises each container by its magic bytes", () => {
	const positives: [string, Uint8Array, Format][] = [
		["JPEG SOI + marker", bytes([0xff, 0xd8, 0xff, 0xe0], zeros(12)), "jpeg"],
		["PNG signature", bytes(PNG_SIGNATURE, zeros(8)), "png"],
		["GIF87a", bytes("GIF87a", zeros(8)), "gif"],
		["GIF89a", bytes("GIF89a", zeros(8)), "gif"],
		["simple lossy WebP", webp(riffChunk("VP8 ", zeros(10))), "webp-lossy"],
		[
			"simple lossless WebP",
			webp(riffChunk("VP8L", zeros(5))),
			"webp-lossless",
		],
		[
			"extended WebP with alpha and lossy bitstream",
			webp(
				riffChunk("VP8X", zeros(10)),
				riffChunk("ALPH", zeros(3)),
				riffChunk("VP8 ", zeros(10)),
			),
			"webp-lossy",
		],
		[
			"extended WebP whose bitstream chunk is VP8L after an odd-sized chunk",
			webp(
				riffChunk("VP8X", zeros(10)),
				riffChunk("ICCP", zeros(7)),
				riffChunk("VP8L", zeros(5)),
			),
			"webp-lossless",
		],
		[
			"animated WebP whose first frame is VP8L",
			webp(
				riffChunk("VP8X", zeros(10)),
				riffChunk("ANIM", zeros(6)),
				riffChunk("ANMF", [
					...zeros(16),
					...bytes(...riffChunk("VP8L", zeros(5))),
				]),
			),
			"webp-lossless",
		],
		[
			"extended WebP with no bitstream chunk yet",
			webp(riffChunk("VP8X", zeros(10))),
			"webp-lossy",
		],
		["AVIF major brand", ftyp("avif", "mif1", "miaf"), "avif"],
		["AVIF sequence major brand", ftyp("avis", "msf1"), "avif"],
		[
			"AVIF listed only as a compatible brand",
			ftyp("mif1", "miaf", "avif"),
			"avif",
		],
		["HEIC major brand", ftyp("heic", "mif1", "heic"), "heic"],
		["HEIX major brand", ftyp("heix", "mif1"), "heic"],
		["generic HEIF brand", ftyp("mif1", "heic"), "heic"],
		["HEIF major brand", ftyp("heif"), "heic"],
		["JPEG XL codestream", bytes([0xff, 0x0a], zeros(14)), "jxl"],
		["JPEG XL container", bytes(JXL_CONTAINER, zeros(4)), "jxl"],
	];

	it.each(positives)("%s", (_name, input, expected) => {
		expect(sniffFormat(input)).toBe(expected);
	});
});

describe("sniffFormat rejects near misses as unknown", () => {
	const nearMisses: [string, Uint8Array][] = [
		[
			"JPEG SOI without a following marker byte",
			bytes([0xff, 0xd8, 0x00, 0xe0], zeros(12)),
		],
		[
			"PNG signature with the last byte wrong",
			bytes(PNG_SIGNATURE.slice(0, 7), [0x00], zeros(8)),
		],
		["GIF with an unknown version", bytes("GIF88a", zeros(8))],
		[
			"RIFF that is not WEBP",
			bytes("RIFF", u32le(12), "WAVE", "fmt ", zeros(8)),
		],
		["WEBP with an unknown first chunk", webp(riffChunk("VP8Z", zeros(10)))],
		["RIFF WEBP cut before the first chunk", bytes("RIFF", u32le(4), "WEBP")],
		["ISO-BMFF with an unrelated brand", ftyp("isom", "mp41", "avc1")],
		["ISO-BMFF with a brand one letter off AVIF", ftyp("avix", "mif2")],
		["ISO-BMFF with a brand one letter off HEIC", ftyp("heiz")],
		[
			"brand text without an ftyp box",
			bytes(u32be(16), "free", "avif", zeros(4)),
		],
		[
			"JPEG XL codestream with the wrong second byte",
			bytes([0xff, 0x0b], zeros(14)),
		],
		[
			"JPEG XL container with the last byte wrong",
			bytes(JXL_CONTAINER.slice(0, 11), [0x0b], zeros(4)),
		],
		["empty input", new Uint8Array(0)],
		["single 0xFF byte", bytes([0xff])],
	];

	it.each(nearMisses)("%s", (_name, input) => {
		expect(sniffFormat(input)).toBe("unknown");
	});
});
