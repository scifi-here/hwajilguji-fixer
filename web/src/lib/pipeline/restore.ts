import type { CV } from "@techstark/opencv-js";
import { finish } from "./finish.ts";
import type { ContentKind, DamageClass, GateReport } from "./gate.ts";
import { alignGrid, cropImage, depalette } from "./prepass.ts";
import type { Backend, LoadedModel, ModelRole } from "./session.ts";
import { blendText, detectText, resizeMask } from "./text-preserve.ts";
import {
	type RgbImage,
	runTiled,
	type TileModel,
	type TileOverlay,
} from "./tiles.ts";

export type Scale = 1 | 2 | 4;
export type RestoreMode = "restore" | "upscaleOnly";
export type RestoreChoice = {
	readonly mode: RestoreMode;
	readonly scale: Scale;
	readonly damage: DamageClass;
	readonly content: ContentKind;
};
export type RgbaImage = {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray<ArrayBuffer>;
};
export type RestoreDeps = {
	loadModel(role: ModelRole): Promise<LoadedModel>;
	readonly signal: AbortSignal;
	onProgress(done: number, total: number): void;
	onTextCoverage?(fraction: number): void;
};

const TILE_SETTINGS: Record<
	Backend,
	{ readonly core: number; readonly pad: number }
> = {
	webgpu: { core: 224, pad: 16 },
	wasm: { core: 96, pad: 16 },
};

function runModel(
	cv: CV,
	image: RgbImage,
	loaded: LoadedModel,
	deps: RestoreDeps,
	overlay?: TileOverlay,
): Promise<RgbImage> {
	const options = {
		...TILE_SETTINGS[loaded.backend],
		signal: deps.signal,
		onProgress: deps.onProgress,
	};
	return runTiled(cv, image, loaded.model, options, overlay);
}

async function deblock(
	cv: CV,
	image: RgbImage,
	offset: readonly [number, number],
	deps: RestoreDeps,
) {
	const loaded = await deps.loadModel("deblock");
	if (loaded.model.scale !== 1) throw new Error("deblock model must be 1x");
	const aligned = alignGrid(cv, image, offset);
	return cropImage(
		await runModel(cv, aligned.image, loaded, deps),
		aligned.crop,
	);
}

function resizeTile(
	cv: CV,
	tile: RgbImage,
	width: number,
	height: number,
): RgbImage {
	if (tile.width === width && tile.height === height) return tile;
	const source = cv.matFromArray(
		tile.height,
		tile.width,
		cv.CV_8UC3,
		tile.data,
	);
	const resized = new cv.Mat();
	try {
		cv.resize(source, resized, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
		return { width, height, data: new Uint8ClampedArray(resized.data) };
	} finally {
		resized.delete();
		source.delete();
	}
}

async function upscale(
	cv: CV,
	image: RgbImage,
	scale: Scale,
	role: ModelRole,
	deps: RestoreDeps,
	overlay?: TileOverlay,
): Promise<RgbImage> {
	const loaded = await deps.loadModel(role);
	if (loaded.model.scale < scale)
		throw new Error(`upscaler is ${loaded.model.scale}x, ${scale}x asked`);
	const atRequestedScale: TileModel = {
		scale: scale,
		multipleOf: loaded.model.multipleOf,
		run: async (tile) =>
			resizeTile(
				cv,
				await loaded.model.run(tile),
				tile.width * scale,
				tile.height * scale,
			),
	};
	return runModel(
		cv,
		image,
		{ model: atRequestedScale, backend: loaded.backend },
		deps,
		overlay,
	);
}

function prepare(
	cv: CV,
	input: RgbImage,
	report: GateReport,
	choice: RestoreChoice,
	deps: RestoreDeps,
) {
	switch (choice.damage) {
		case "blocky8":
			return deblock(cv, input, report.gridOffset ?? [0, 0], deps);
		case "smeared":
			return deblock(cv, input, [0, 0], deps);
		case "palette":
			return depalette(cv, input);
		case "clean":
			return input;
	}
}

function upscaleRole(choice: RestoreChoice, only: boolean): ModelRole {
	if (choice.content === "graphic")
		return only ? "upscaleGraphicBackProjection" : "upscaleGraphic";
	const photos = { 1: "upscalePhoto", 2: "photo2x", 4: "photo4x" } as const;
	return photos[choice.scale];
}

function dropAlpha(image: ImageData): RgbImage {
	const data = new Uint8ClampedArray(image.width * image.height * 3);
	for (let pixel = 0; pixel < image.width * image.height; pixel++) {
		data.set(image.data.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
	}
	return { width: image.width, height: image.height, data };
}

function attachAlpha(cv: CV, rgb: RgbImage, original: ImageData): RgbaImage {
	const alpha = new Uint8ClampedArray(original.width * original.height);
	alpha.forEach((_, pixel) => {
		alpha[pixel] = original.data[pixel * 4 + 3];
	});
	const source = cv.matFromArray(
		original.height,
		original.width,
		cv.CV_8UC1,
		alpha,
	);
	const resized = new cv.Mat();
	try {
		cv.resize(
			source,
			resized,
			new cv.Size(rgb.width, rgb.height),
			0,
			0,
			cv.INTER_CUBIC,
		);
		const plane = resized.data;
		const data = new Uint8ClampedArray(rgb.width * rgb.height * 4);
		for (let pixel = 0; pixel < rgb.width * rgb.height; pixel++) {
			data.set(rgb.data.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
			data[pixel * 4 + 3] = plane[pixel];
		}
		return { width: rgb.width, height: rgb.height, data };
	} finally {
		resized.delete();
		source.delete();
	}
}

export async function restore(
	cv: CV,
	image: ImageData,
	report: GateReport,
	choice: RestoreChoice,
	deps: RestoreDeps,
): Promise<RgbaImage> {
	if (choice.damage === "clean" && choice.scale === 1) return image;
	const input = dropAlpha(image);
	const upscaleOnly = choice.scale > 1 && choice.mode === "upscaleOnly";
	const prepared = upscaleOnly
		? input
		: await prepare(cv, input, report, choice, deps);
	const routed =
		choice.scale > 1 || choice.damage === "palette"
			? await upscale(
					cv,
					prepared,
					choice.scale,
					upscaleRole(choice, upscaleOnly),
					deps,
				)
			: prepared;
	const automatic = !upscaleOnly && choice.scale > 1;
	const mask = automatic
		? await detectText(
				cv,
				input,
				await deps.loadModel("textDetector"),
				deps.signal,
				deps.onProgress,
			)
		: null;
	const compressedPhoto =
		choice.content === "photo" &&
		choice.scale === 2 &&
		(choice.damage === "blocky8" || choice.damage === "smeared");
	if (mask && compressedPhoto) {
		await upscale(cv, prepared, choice.scale, "upscalePhoto", deps, {
			target: routed,
			mask: resizeMask(cv, mask, routed),
		});
	}
	const result = finish(
		cv,
		routed,
		input,
		upscaleOnly ? "clean" : choice.damage,
	);
	if (mask && !compressedPhoto) {
		await blendText(
			input,
			result,
			mask.data,
			mask.width,
			mask.height,
			choice.scale,
			deps.signal,
		);
	}
	if (automatic) deps.onTextCoverage?.(mask?.fraction ?? 0);
	return attachAlpha(cv, result, image);
}
