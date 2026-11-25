import { expect, it } from "vitest";
import { blendText } from "#lib/pipeline/text-preserve.ts";

it("preserves photo pixels outside the detector mask and interpolates the source under text", async () => {
	const input = {
		width: 6,
		height: 2,
		data: new Uint8ClampedArray(36).fill(120),
	};
	const restored = {
		width: 12,
		height: 4,
		data: new Uint8ClampedArray(144).fill(20),
	};
	const mask = new Uint8Array([0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0]);
	await blendText(input, restored, mask, 6, 2, 2, new AbortController().signal);
	expect(restored.data[0]).toBe(20);
	expect(restored.data[5 * 3]).toBe(120);
	expect(restored.data[11 * 3]).toBe(20);
});
