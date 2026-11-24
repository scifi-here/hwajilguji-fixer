import * as ort from "onnxruntime-web/webgpu";
import type { RgbImage, TileModel } from "./tiles.ts";

export type Backend = "webgpu" | "wasm";
export type ModelRole =
	| "deblock"
	| "textDetector"
	| "photo2x"
	| "photo4x"
	| "upscalePhoto"
	| "upscaleGraphic"
	| "upscaleGraphicBackProjection";
export type LoadedModel = {
	readonly model: TileModel;
	readonly backend: Backend;
};

type ModelEntry = {
	readonly file: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly inputName: string;
	readonly outputName: string;
	readonly scale: number;
	readonly multipleOf: number;
	readonly range: readonly [number, number];
};

export class ModelIntegrityError extends Error {
	override readonly name = "ModelIntegrityError";

	constructor(readonly role: ModelRole) {
		super(`${role} 모델 파일이 models.json의 SHA-256과 다릅니다.`);
	}
}

export async function createBackend(): Promise<Backend> {
	if (!("gpu" in navigator)) return "wasm";
	const adapter = await navigator.gpu.requestAdapter().catch(() => null);
	return adapter === null ? "wasm" : "webgpu";
}

function parseEntry(manifest: unknown, role: ModelRole): ModelEntry {
	if (typeof manifest !== "object" || manifest === null)
		throw new Error("models.json is not an object");
	const raw = new Map<string, unknown>(Object.entries(manifest)).get(role);
	if (typeof raw !== "object" || raw === null)
		throw new Error(`models.json has no ${role} entry`);
	const fields = new Map<string, unknown>(Object.entries(raw));
	const text = (key: string): string => {
		const value = fields.get(key);
		if (typeof value !== "string" || value === "")
			throw new Error(`models.json ${role}.${key} is not a string`);
		return value;
	};
	const positive = (key: string): number => {
		const value = fields.get(key);
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
			throw new Error(`models.json ${role}.${key} is not a positive integer`);
		}
		return value;
	};
	if (fields.get("elementType") !== "float32")
		throw new Error(`models.json ${role}.elementType is not float32`);
	if (fields.get("layout") !== "NCHW-RGB")
		throw new Error(`models.json ${role}.layout is not NCHW-RGB`);
	const range = fields.get("range");
	if (
		!Array.isArray(range) ||
		range.length !== 2 ||
		!range.every((bound) => typeof bound === "number")
	) {
		throw new Error(`models.json ${role}.range is not [low, high]`);
	}
	const [low, high]: number[] = range;
	if (high <= low) throw new Error(`models.json ${role}.range is empty`);
	return {
		file: text("file"),
		sha256: text("sha256").toLowerCase(),
		bytes: positive("bytes"),
		inputName: text("inputName"),
		outputName: text("outputName"),
		scale: positive("scale"),
		multipleOf: positive("multipleOf"),
		range: [low, high],
	};
}

async function fetchOk(url: URL): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
	return response;
}

async function verifiedModelBytes(
	entry: ModelEntry,
	role: ModelRole,
	assetBase: URL,
): Promise<Uint8Array<ArrayBuffer>> {
	const bytes = new Uint8Array(
		await (
			await fetchOk(new URL(`models/${entry.file}`, assetBase))
		).arrayBuffer(),
	);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const hex = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (bytes.length !== entry.bytes || hex !== entry.sha256)
		throw new ModelIntegrityError(role);
	return bytes;
}

async function createSession(
	bytes: Uint8Array,
	backend: Backend,
): Promise<[ort.InferenceSession, Backend]> {
	try {
		return [
			await ort.InferenceSession.create(bytes, {
				executionProviders: [backend],
			}),
			backend,
		];
	} catch (error) {
		if (backend === "wasm") throw error;
	}
	return [
		await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }),
		"wasm",
	];
}

function toTensor(tile: RgbImage, entry: ModelEntry): ort.Tensor {
	const plane = tile.width * tile.height;
	const [low, high] = entry.range;
	const values = new Float32Array(3 * plane);
	for (let pixel = 0; pixel < plane; pixel++) {
		for (let channel = 0; channel < 3; channel++) {
			values[channel * plane + pixel] =
				low + (tile.data[pixel * 3 + channel] / 255) * (high - low);
		}
	}
	return new ort.Tensor("float32", values, [1, 3, tile.height, tile.width]);
}

function fromTensor(output: ort.Tensor, entry: ModelEntry): RgbImage {
	const [batch, channels, height, width] = output.dims;
	if (output.dims.length !== 4 || batch !== 1 || channels !== 3)
		throw new Error(`model output dims ${output.dims.join("x")}`);
	const planes = output.data;
	if (!(planes instanceof Float32Array))
		throw new Error("model output is not float32");
	const plane = width * height;
	const [low, high] = entry.range;
	const data = new Uint8ClampedArray(3 * plane);
	for (let pixel = 0; pixel < plane; pixel++) {
		for (let channel = 0; channel < 3; channel++) {
			data[pixel * 3 + channel] =
				((planes[channel * plane + pixel] - low) / (high - low)) * 255;
		}
	}
	return { width, height, data };
}

function tileModel(
	session: ort.InferenceSession,
	entry: ModelEntry,
): TileModel {
	return {
		scale: entry.scale,
		multipleOf: entry.multipleOf,
		run: async (tile) => {
			const input = toTensor(tile, entry);
			const outputs = await session
				.run({ [entry.inputName]: input })
				.finally(() => input.dispose());
			const output = outputs[entry.outputName];
			if (output === undefined)
				throw new Error(`model has no output ${entry.outputName}`);
			try {
				return fromTensor(output, entry);
			} finally {
				output.dispose();
			}
		},
	};
}

async function load(
	role: ModelRole,
	backend: Backend,
	assetBase: URL,
): Promise<LoadedModel> {
	ort.env.wasm.numThreads = 1;
	ort.env.wasm.proxy = false;
	ort.env.wasm.wasmPaths = new URL("ort/", assetBase).href;
	const manifest: unknown = await (
		await fetchOk(new URL("models/models.json", assetBase))
	).json();
	const entry = parseEntry(manifest, role);
	const bytes = await verifiedModelBytes(entry, role, assetBase);
	const [session, used] = await createSession(bytes, backend);
	return { model: tileModel(session, entry), backend: used };
}

const sessions = new Map<ModelRole, Promise<LoadedModel>>();

export function loadModel(
	role: ModelRole,
	backend: Backend,
	assetBase: URL,
): Promise<LoadedModel> {
	const cached = sessions.get(role);
	if (cached !== undefined) return cached;
	const loading = load(role, backend, assetBase);
	sessions.set(role, loading);
	loading.catch(() => sessions.delete(role));
	return loading;
}
