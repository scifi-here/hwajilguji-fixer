export type Format =
	| "jpeg"
	| "png"
	| "gif"
	| "webp-lossy"
	| "webp-lossless"
	| "avif"
	| "heic"
	| "jxl"
	| "unknown";

const latin1 = (text: string): number[] =>
	Array.from(text, (char) => char.charCodeAt(0));

const SIGNATURES: readonly (readonly [Format, readonly number[]])[] = [
	["jpeg", [0xff, 0xd8, 0xff]],
	["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
	["gif", latin1("GIF87a")],
	["gif", latin1("GIF89a")],
	["jxl", [0xff, 0x0a]],
	["jxl", [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]],
];

const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "mif1", "heif"]);

function fourcc(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function webpBitstreamAfterHeader(bytes: Uint8Array): string | null {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = fourcc(bytes, offset);
		if (id === "VP8 " || id === "VP8L") return id;
		if (id === "ANMF") {
			offset += 8 + 16;
			continue;
		}
		const size = data.getUint32(offset + 4, true);
		offset += 8 + size + (size % 2);
	}
	return null;
}

function sniffWebp(bytes: Uint8Array): Format {
	const first = fourcc(bytes, 12);
	if (first === "VP8 ") return "webp-lossy";
	if (first === "VP8L") return "webp-lossless";
	if (first !== "VP8X") return "unknown";
	return webpBitstreamAfterHeader(bytes) === "VP8L"
		? "webp-lossless"
		: "webp-lossy";
}

function sniffIsoBrands(bytes: Uint8Array): Format {
	const end = Math.min(
		new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0),
		bytes.length,
	);
	const brands = [fourcc(bytes, 8)];
	for (let offset = 16; offset + 4 <= end; offset += 4)
		brands.push(fourcc(bytes, offset));
	if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "avif";
	if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "heic";
	return "unknown";
}

export function sniffFormat(bytes: Uint8Array): Format {
	const signature = SIGNATURES.find(([, magic]) =>
		magic.every((byte, index) => bytes[index] === byte),
	);
	if (signature) return signature[0];
	if (fourcc(bytes, 0) === "RIFF" && fourcc(bytes, 8) === "WEBP")
		return sniffWebp(bytes);
	if (fourcc(bytes, 4) === "ftyp") return sniffIsoBrands(bytes);
	return "unknown";
}
