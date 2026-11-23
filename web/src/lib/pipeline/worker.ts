import cvModule, { type CV } from "@techstark/opencv-js";
import { decodeImage } from "./decode.ts";
import { type GateReport, inspect } from "./gate.ts";
import { estimateJpegQuality } from "./headers.ts";
import { type RestoreChoice, type RgbaImage, restore } from "./restore.ts";
import { type Backend, createBackend, loadModel } from "./session.ts";
import { type Format, sniffFormat } from "./sniff.ts";

export type WorkerRequest =
	| { readonly type: "inspect"; readonly bytes: ArrayBuffer }
	| {
			readonly type: "restore";
			readonly choice: RestoreChoice;
			readonly assetBase: string;
	  }
	| { readonly type: "cancel" };

export type WorkerResponse =
	| {
			readonly type: "report";
			readonly report: GateReport;
			readonly format: Format;
			readonly backend: Backend;
			readonly width: number;
			readonly height: number;
			readonly preview: ImageBitmap;
	  }
	| { readonly type: "progress"; readonly done: number; readonly total: number }
	| { readonly type: "done"; readonly png: Blob; readonly backend: Backend }
	| { readonly type: "error"; readonly name: string; readonly message: string };

type Inspected = { readonly image: ImageData; readonly report: GateReport };

const cvReady: Promise<CV> = Promise.resolve(cvModule);
let backendReady: Promise<Backend> | null = null;
let inspected: Inspected | null = null;
let running: AbortController | null = null;
let queue: Promise<void> = Promise.resolve();

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
	self.postMessage(message, { transfer });
}

async function inspectFile(buffer: ArrayBuffer): Promise<void> {
	inspected = null;
	const bytes = new Uint8Array(buffer);
	const format = sniffFormat(bytes);
	backendReady ??= createBackend();
	const [cv, image, backend] = await Promise.all([
		cvReady,
		decodeImage(bytes, format),
		backendReady,
	]);
	const report = inspect(
		cv,
		image,
		format,
		format === "jpeg" ? estimateJpegQuality(bytes) : null,
	);
	inspected = { image, report };
	const preview = await createImageBitmap(image);
	const { width, height } = image;
	post({ type: "report", report, format, backend, width, height, preview }, [
		preview,
	]);
}

async function encodePng(image: RgbaImage): Promise<Blob> {
	const canvas = new OffscreenCanvas(image.width, image.height);
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("2d context unavailable");
	context.putImageData(
		new ImageData(image.data, image.width, image.height),
		0,
		0,
	);
	return canvas.convertToBlob({ type: "image/png" });
}

async function restoreInspected(
	choice: RestoreChoice,
	assetBase: URL,
): Promise<void> {
	if (inspected === null) throw new Error("no inspected image");
	const controller = new AbortController();
	running = controller;
	try {
		backendReady ??= createBackend();
		const [cv, preferred] = await Promise.all([cvReady, backendReady]);
		let used = preferred;
		const result = await restore(
			cv,
			inspected.image,
			inspected.report,
			choice,
			{
				loadModel: async (role) => {
					const loaded = await loadModel(role, preferred, assetBase);
					used = loaded.backend;
					return loaded;
				},
				signal: controller.signal,
				onProgress: (done, total) => post({ type: "progress", done, total }),
			},
		);
		post({ type: "done", png: await encodePng(result), backend: used });
	} finally {
		running = null;
	}
}

function perform(
	request: Exclude<WorkerRequest, { type: "cancel" }>,
): Promise<void> {
	return request.type === "inspect"
		? inspectFile(request.bytes)
		: restoreInspected(request.choice, new URL(request.assetBase));
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (request.type === "cancel") {
		running?.abort();
		return;
	}
	queue = queue
		.then(() => perform(request))
		.catch((error: unknown) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			post({ type: "error", name: failure.name, message: failure.message });
		});
};
