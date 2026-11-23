const STD_LUMA = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
	24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
	103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
	72, 92, 95, 98, 112, 100, 103, 99,
];

const MARKER_DQT = 0xdb;
const MARKER_SOS = 0xda;
const MARKER_EOI = 0xd9;

type LumaTable = { readonly sum: number; readonly maxEntry: number };

function readLumaTable(
	bytes: Uint8Array,
	start: number,
	end: number,
): LumaTable | null {
	let offset = start;
	while (offset < end) {
		const width = bytes[offset] >> 4 === 0 ? 1 : 2;
		const tableEnd = offset + 1 + 64 * width;
		if (tableEnd > end) return null;
		if ((bytes[offset] & 0x0f) === 0) {
			let sum = 0;
			for (let at = offset + 1; at < tableEnd; at += width)
				sum += width === 1 ? bytes[at] : (bytes[at] << 8) | bytes[at + 1];
			return { sum, maxEntry: width === 1 ? 255 : 32767 };
		}
		offset = tableEnd;
	}
	return null;
}

function ijgLumaSum(quality: number, maxEntry: number): number {
	const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
	return STD_LUMA.reduce(
		(total, value) =>
			total +
			Math.min(maxEntry, Math.max(1, Math.floor((value * scale + 50) / 100))),
		0,
	);
}

function qualityFromTable(table: LumaTable): number {
	let best = 1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let quality = 1; quality <= 100; quality++) {
		const distance = Math.abs(ijgLumaSum(quality, table.maxEntry) - table.sum);
		if (distance < bestDistance) {
			best = quality;
			bestDistance = distance;
		}
	}
	return best;
}

export function estimateJpegQuality(bytes: Uint8Array): number | null {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let lumaTable: LumaTable | null = null;
	let offset = 2;
	while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
		const marker = bytes[offset + 1];
		if (marker === MARKER_SOS)
			return lumaTable === null ? null : qualityFromTable(lumaTable);
		if (marker === MARKER_EOI) return null;
		const end = offset + 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
		if (end > bytes.length) return null;
		if (marker === MARKER_DQT)
			lumaTable = readLumaTable(bytes, offset + 4, end) ?? lumaTable;
		offset = end;
	}
	return null;
}
