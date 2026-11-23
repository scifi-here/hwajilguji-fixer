import type { CV } from "@techstark/opencv-js";
import { finish } from "./finish.ts";
import type { ContentKind, DamageClass, GateReport } from "./gate.ts";
import { alignGrid, cropImage, depalette } from "./prepass.ts";
import type { Backend, LoadedModel, ModelRole } from "./session.ts";
import { type RgbImage, runTiled, type TileModel } from "./tiles.ts";

export type Scale = 1 | 2 | 4;
export type RestoreChoice = {
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
): Promise<RgbImage> {
	const options = {
		...TILE_SETTINGS[loaded.backend],
		signal: deps.signal,
		onProgress: deps.onProgress,
	};
	return runTiled(cv, image, loaded.model, options);
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
	choice: RestoreChoice,
	deps: RestoreDeps,
): Promise<RgbImage> {
	const loaded = await deps.loadModel(
		choice.content === "graphic" ? "upscaleGraphic" : "upscalePhoto",
	);
	if (loaded.model.scale < choice.scale)
		throw new Error(
			`upscaler is ${loaded.model.scale}x, ${choice.scale}x asked`,
		);
	const atRequestedScale: TileModel = {
		scale: choice.scale,
		multipleOf: loaded.model.multipleOf,
		run: async (tile) =>
			resizeTile(
				cv,
				await loaded.model.run(tile),
				tile.width * choice.scale,
				tile.height * choice.scale,
			),
	};
	return runModel(
		cv,
		image,
		{ model: atRequestedScale, backend: loaded.backend },
		deps,
	);
}

async function route(
	cv: CV,
	image: RgbImage,
	report: GateReport,
	choice: RestoreChoice,
	deps: RestoreDeps,
) {
	switch (choice.damage) {
		case "blocky8":
		case "smeared": {
			const offset = choice.damage === "blocky8" ? report.gridOffset : null;
			const deblocked = await deblock(cv, image, offset ?? [0, 0], deps);
			return choice.scale === 1
				? deblocked
				: upscale(cv, deblocked, choice, deps);
		}
		case "palette":
			return upscale(cv, depalette(cv, image), choice, deps);
		case "clean":
			return upscale(cv, image, choice, deps);
	}
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
	const routed = await route(cv, input, report, choice, deps);
	return attachAlpha(cv, finish(cv, routed, input, choice.damage), image);
}
