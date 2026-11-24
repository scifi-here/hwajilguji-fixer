import type { TextMask } from "./text-preserve.ts";
import type { RgbImage } from "./tiles.ts";

type Color = readonly [number, number, number];
type Box = { left: number; right: number; top: number; bottom: number };
type Strip = { bytes: Uint8ClampedArray; stride: number; top: number };

function difference(bytes: Uint8ClampedArray, a: number, b: number) {
	return Math.max(
		Math.abs(bytes[a] - bytes[b]),
		Math.abs(bytes[a + 1] - bytes[b + 1]),
		Math.abs(bytes[a + 2] - bytes[b + 2]),
	);
}

function flatBackground(
	strip: Strip,
	region: Box,
	step: number,
	histogram: Uint16Array,
): Color | null {
	const { bytes, stride, top } = strip;
	histogram.fill(0);
	let winner = 0,
		samples = 0;
	for (let y = region.top; y < region.bottom - 1; y += step) {
		for (let x = region.left; x < region.right - 1; x += step) {
			const i = (y - top) * stride + 3 * x;
			samples++;
			if (
				difference(bytes, i, i + 3) > 6 ||
				difference(bytes, i, i + stride) > 6
			)
				continue;
			const bin =
				((bytes[i] >> 4) << 8) |
				((bytes[i + 1] >> 4) << 4) |
				(bytes[i + 2] >> 4);
			histogram[bin]++;
			if (histogram[bin] > histogram[winner]) winner = bin;
		}
	}
	if (!samples || histogram[winner] < samples * 0.18) return null;
	const r = (winner >> 8) * 16 + 7.5,
		g = ((winner >> 4) & 15) * 16 + 7.5,
		b = (winner & 15) * 16 + 7.5;
	let red = 0,
		green = 0,
		blue = 0,
		count = 0,
		competingSamples = 0;
	for (let y = region.top; y < region.bottom - 1; y += step) {
		for (let x = region.left; x < region.right - 1; x += step) {
			const i = (y - top) * stride + 3 * x;
			if (
				difference(bytes, i, i + 3) > 6 ||
				difference(bytes, i, i + stride) > 6
			)
				continue;
			const delta = Math.max(
				Math.abs(bytes[i] - r),
				Math.abs(bytes[i + 1] - g),
				Math.abs(bytes[i + 2] - b),
			);
			if (delta > 14) {
				if (delta >= 20 && delta <= 54) competingSamples++;
				continue;
			}
			red += bytes[i];
			green += bytes[i + 1];
			blue += bytes[i + 2];
			count++;
		}
	}
	return competingSamples < samples * 0.18 && count >= samples * 0.31
		? [red / count, green / count, blue / count]
		: null;
}

function inkDistances(
	strip: Strip,
	region: Box,
	background: Color,
	distance: Uint8Array,
) {
	const w = region.right - region.left,
		h = region.bottom - region.top;
	let contrast = 0;
	for (let y = 0; y < h; y++) {
		let i = (region.top - strip.top + y) * strip.stride + 3 * region.left;
		for (let x = 0; x < w; x++, i += 3) {
			const diff = Math.max(
				Math.abs(strip.bytes[i] - background[0]),
				Math.abs(strip.bytes[i + 1] - background[1]),
				Math.abs(strip.bytes[i + 2] - background[2]),
			);
			distance[y * w + x] = Math.round(diff);
			contrast = Math.max(contrast, diff);
		}
	}
	if (contrast < 52) return 0;
	const strong = Math.max(44, contrast * 0.55);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const at = y * w + x;
			distance[at] =
				distance[at] >= strong
					? 0
					: Math.min(
							x ? distance[at - 1] + 1 : 255,
							y ? distance[at - w] + 1 : 255,
							255,
						);
		}
	for (let y = h - 1; y >= 0; y--) {
		for (let x = w - 1; x >= 0; x--) {
			const at = y * w + x;
			distance[at] = Math.min(
				distance[at],
				x + 1 < w ? distance[at + 1] + 1 : 255,
				y + 1 < h ? distance[at + w] + 1 : 255,
			);
		}
	}
	return contrast;
}

function hasText(mask: TextMask, box: Box, output: RgbImage) {
	const left = Math.floor((box.left * mask.width) / output.width),
		right = Math.ceil((box.right * mask.width) / output.width);
	const top = Math.floor((box.top * mask.height) / output.height),
		bottom = Math.ceil((box.bottom * mask.height) / output.height);
	for (let y = top; y < bottom; y++) {
		for (let x = left; x < right; x++)
			if (mask.data[y * mask.width + x]) return true;
	}
	return false;
}

function cleanCell(
	output: RgbImage,
	mask: TextMask,
	strip: Strip,
	cell: Box,
	scale: number,
	histogram: Uint16Array,
	distance: Uint8Array,
) {
	if (!hasText(mask, cell, output)) return;
	const radius = 3 * scale;
	const region = {
		left: Math.max(0, cell.left - radius),
		right: Math.min(output.width, cell.right + radius),
		top: Math.max(0, cell.top - radius),
		bottom: Math.min(output.height, cell.bottom + radius),
	};
	const search = 8 * scale;
	const surroundings = {
		left: Math.max(0, cell.left - search),
		right: Math.min(output.width, cell.right + search),
		top: Math.max(0, cell.top - search),
		bottom: Math.min(output.height, cell.bottom + search),
	};
	const background = flatBackground(
		strip,
		surroundings,
		2 * scale - 1,
		histogram,
	);
	if (!background) return;
	const peak = inkDistances(strip, region, background, distance);
	if (!peak) return;
	const maxResidual = Math.min(80, peak * (scale === 4 ? 0.28 : 0.4)),
		fade = maxResidual * 0.45;
	const strength = scale === 4 ? 0.45 : 0.9;
	const w = region.right - region.left;
	for (let y = cell.top; y < cell.bottom; y++) {
		const maskRow =
			Math.floor(((y + 0.5) * mask.height) / output.height) * mask.width;
		for (let x = cell.left; x < cell.right; x++) {
			const d = distance[(y - region.top) * w + x - region.left];
			if (!d || d > radius) continue;
			const opacity =
				mask.data[
					maskRow + Math.floor(((x + 0.5) * mask.width) / output.width)
				] / 255;
			if (!opacity) continue;
			const i = y * strip.stride + 3 * x;
			const buf = output.data;
			const diff = Math.max(
				Math.abs(buf[i] - background[0]),
				Math.abs(buf[i + 1] - background[1]),
				Math.abs(buf[i + 2] - background[2]),
			);
			if (diff < 2 || diff >= maxResidual) continue;
			const weight =
				strength *
				opacity *
				Math.min(1, (maxResidual - diff) / fade) *
				Math.min(1, (radius + 1 - d) / scale) *
				(d === 1 ? 0.6 : 1);
			for (let c = 0; c < 3; c++)
				buf[i + c] += weight * (background[c] - buf[i + c]);
		}
	}
}

export async function suppressTextHalos(
	output: RgbImage,
	mask: TextMask,
	scale: number,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const cell = 4 * scale,
		pad = 8 * scale,
		span = cell + 2 * pad;
	const stride = 3 * output.width;
	const strip: Strip = {
		bytes: new Uint8ClampedArray(stride * Math.min(span, output.height)),
		stride,
		top: 0,
	};
	const histogram = new Uint16Array(4096),
		distance = new Uint8Array(span * span);
	let lastEnd = 0,
		lastYield = performance.now();
	for (let y = 0; y < output.height; y += cell) {
		const top = Math.max(0, y - pad),
			end = Math.min(output.height, y + cell + pad);
		strip.bytes.copyWithin(
			0,
			(top - strip.top) * stride,
			(lastEnd - strip.top) * stride,
		);
		strip.bytes.set(
			output.data.subarray(lastEnd * stride, end * stride),
			(lastEnd - top) * stride,
		);
		strip.top = top;
		lastEnd = end;
		for (let x = 0; x < output.width; x += cell) {
			if (performance.now() - lastYield > 24) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				signal.throwIfAborted();
				lastYield = performance.now();
			}
			cleanCell(
				output,
				mask,
				strip,
				{
					left: x,
					right: Math.min(output.width, x + cell),
					top: y,
					bottom: Math.min(output.height, y + cell),
				},
				scale,
				histogram,
				distance,
			);
		}
	}
}
