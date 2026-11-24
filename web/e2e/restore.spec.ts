import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";

const fixturePath = (name: string): string =>
	new URL(`../tests/fixtures/e2e/${name}`, import.meta.url).pathname;

async function decodeInPage(page: Page, name: string): Promise<number[]> {
	return page.evaluate(
		async (bytes) => {
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context === null) throw new Error("2d context unavailable");
			context.drawImage(bitmap, 0, 0);
			return Array.from(
				context.getImageData(0, 0, bitmap.width, bitmap.height).data,
			);
		},
		Array.from(readFileSync(fixturePath(name))),
	);
}

async function downloadedPixels(link: Locator): Promise<number[]> {
	return link.evaluate(async (el) => {
		const response = await fetch((el as HTMLAnchorElement).href);
		const bitmap = await createImageBitmap(await response.blob());
		try {
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) throw Error("missing 2d context");
			ctx.drawImage(bitmap, 0, 0);
			return Array.from(
				ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
			);
		} finally {
			bitmap.close();
		}
	});
}

function psnr(rgba: readonly number[], reference: readonly number[]): number {
	let squared = 0;
	let samples = 0;
	for (let index = 0; index < reference.length; index++) {
		if (index % 4 === 3) continue;
		squared += (rgba[index] - reference[index]) ** 2;
		samples++;
	}
	return 10 * Math.log10(255 ** 2 / (squared / samples));
}

test("a QF 10 JPEG gains at least 0.5 dB PSNR against its clean original after a 1x run", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const failedResponses: string[] = [];
	const loadedUrls: string[] = [];
	page.on("response", (response) => {
		if (response.status() >= 400)
			failedResponses.push(`${response.status()} ${response.url()}`);
		else loadedUrls.push(new URL(response.url()).pathname);
	});

	await page.goto("/");
	await page
		.locator('input[type="file"]')
		.setInputFiles(fixturePath("degraded-qf10.jpg"));
	await expect(page.getByTestId("damage")).toHaveText("JPEG 블록");

	await page.getByText("1x", { exact: true }).click();
	await expect(page.getByRole("radio", { name: "1x" })).toBeChecked();
	await page.getByRole("button", { name: "복원 시작" }).click();
	await expect(page.getByRole("link", { name: "PNG로 저장" })).toBeVisible({
		timeout: 110_000,
	});

	const restored = await page
		.getByTestId("after")
		.evaluate((canvas: HTMLCanvasElement) => {
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context === null) throw new Error("2d context unavailable");
			return Array.from(
				context.getImageData(0, 0, canvas.width, canvas.height).data,
			);
		});
	const clean = await decodeInPage(page, "clean.png");
	const degraded = await decodeInPage(page, "degraded-qf10.jpg");
	const backend = await page.getByTestId("backend").textContent();
	const gain = psnr(restored, clean) - psnr(degraded, clean);
	console.log(
		`backend ${backend}, degraded ${psnr(degraded, clean).toFixed(2)} dB, gain ${gain.toFixed(2)} dB`,
	);

	expect(failedResponses).toEqual([]);
	expect(loadedUrls).toContain("/ort/ort-wasm-simd-threaded.asyncify.wasm");
	expect(restored.length).toBe(clean.length);
	expect(gain).toBeGreaterThanOrEqual(0.5);
});

test("upscale only skips the deblock model and is unavailable at 1x", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const models: string[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith(".onnx"))
			models.push(new URL(request.url()).pathname);
	});
	await page.goto("/");
	await page
		.locator('input[type="file"]')
		.setInputFiles(fixturePath("degraded-qf10.jpg"));
	await expect(page.getByTestId("damage")).toHaveText("JPEG 블록");
	await expect(page.getByRole("radio", { name: "자동 복원" })).toBeChecked();
	await page.getByText("확대만", { exact: true }).click();
	await page.getByText("1x", { exact: true }).click();
	await expect(page.getByRole("radio", { name: "확대만" })).toHaveCount(0);
	await page.getByText("4x", { exact: true }).click();
	await page.getByText("확대만", { exact: true }).click();
	await page.getByRole("button", { name: "확대 시작" }).click();
	await expect(page.getByRole("link", { name: "PNG로 저장" })).toBeVisible({
		timeout: 90_000,
	});
	await expect(page.getByTestId("after")).toHaveAttribute("width", "1024");
	expect(models).toEqual(["/models/span-x4.onnx"]);
});

test("graphic upscale only loads the projected model and invalidates the download on a mode change", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const models: string[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith(".onnx"))
			models.push(new URL(request.url()).pathname);
	});
	await page.goto("/");
	await page
		.locator('input[type="file"]')
		.setInputFiles(fixturePath("clean.png"));
	await page
		.getByRole("group", { name: "내용" })
		.getByText("글자·그림", { exact: true })
		.click();
	await page.getByText("확대만", { exact: true }).click();
	await expect(page.getByRole("radio", { name: "2x" })).toBeChecked();
	await page.getByRole("button", { name: "확대 시작" }).click();
	await expect(page.getByText(/^확대 진행률 /)).toBeVisible();
	const download = page.getByRole("link", { name: "PNG로 저장" });
	await expect(download).toBeVisible({ timeout: 90_000 });
	await expect(page.getByTestId("after")).toHaveAttribute("width", "512");
	await expect(
		page.getByRole("heading", { name: "확대 결과 상세 정보" }),
	).toBeVisible();
	await expect(
		page.getByText("확대 해상도: 512 × 512", { exact: true }),
	).toBeVisible();
	expect(models).toEqual(["/models/realesr-animevideov3-backprojection.onnx"]);
	await page.getByText("자동 복원", { exact: true }).click();
	await expect(download).toHaveCount(0);
});

test("automatic photo restoration localizes a caption and recovers after cancellation", async ({
	page,
}) => {
	test.setTimeout(120000);
	const requests: string[] = [];
	page.context().on("request", (req) => {
		if (req.url().endsWith(".onnx")) requests.push(new URL(req.url()).pathname);
	});
	await page.goto("/");
	const bytes = await page.evaluate(async () => {
		await document.fonts.ready;
		const canvas = document.createElement("canvas");
		canvas.width = 320;
		canvas.height = 168;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) throw Error("missing canvas");
		const bg = ctx.createLinearGradient(0, 0, 320, 168);
		bg.addColorStop(0, "#568aab");
		bg.addColorStop(1, "#394f52");
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, 320, 168);
		ctx.fillStyle = "#182029";
		ctx.fillRect(8, 104, 300, 48);
		ctx.fillStyle = "white";
		ctx.font = `25px ${getComputedStyle(document.body).fontFamily}`;
		ctx.fillText("서울역 출발 15시 30분", 16, 138);
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(Error("PNG")))),
		);
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	await page.locator('input[type="file"]').setInputFiles({
		name: "caption.png",
		mimeType: "image/png",
		buffer: Buffer.from(bytes),
	});
	await page.getByTestId("damage").waitFor();
	await page
		.getByRole("group", { name: "내용" })
		.getByText("사진", { exact: true })
		.click();
	const run = page.getByRole("button", { name: "복원 시작" });
	await run.click();
	await page.getByRole("button", { name: "취소" }).click();
	await expect(page.getByRole("alert")).toHaveText("취소했습니다.", {
		timeout: 30000,
	});
	await run.click();
	await expect(page.getByRole("link", { name: "PNG로 저장" })).toBeVisible({
		timeout: 80000,
	});
	await expect(page.getByTestId("after")).toHaveAttribute("width", "640");
	const coverage = await page.getByTestId("text-coverage").textContent();
	const percent = Number(coverage?.match(/([\d.]+)%/)?.[1]);
	expect(percent).toBeGreaterThan(1);
	expect(percent).toBeLessThan(50);
	expect(requests).toContain("/models/span-x2.onnx");
	expect(requests).toContain("/models/ppocr-text-mask.onnx");
	const jpeg = await page.evaluate(async (input) => {
		const image = await createImageBitmap(new Blob([new Uint8Array(input)]));
		const canvas = new OffscreenCanvas(image.width, image.height);
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) throw Error("missing canvas");
		ctx.drawImage(image, 0, 0);
		return Array.from(
			new Uint8Array(
				await (
					await canvas.convertToBlob({ type: "image/jpeg", quality: 0.25 })
				).arrayBuffer(),
			),
		);
	}, bytes);
	await page.locator("input[type=file]").setInputFiles({
		name: "caption.jpg",
		mimeType: "image/jpeg",
		buffer: Buffer.from(jpeg),
	});
	await page
		.getByRole("group", { name: "내용" })
		.getByText("사진", { exact: true })
		.click();
	await run.click();
	await page
		.getByRole("link", { name: "PNG로 저장" })
		.waitFor({ timeout: 80000 });
	expect(requests).toContain("/models/dejpeg-v2.onnx");
	expect(requests).toContain("/models/realesr-general-x4v3.onnx");
});

test("the downloaded PNG and result preview both retain opaque photo pixels", async ({
	page,
}) => {
	await page.goto("/");
	await page
		.locator('input[type="file"]')
		.setInputFiles(fixturePath("clean.png"));
	await page.getByText("1x", { exact: true }).click();
	await page.getByRole("button", { name: "복원 시작" }).click();
	const link = page.getByRole("link", { name: "PNG로 저장" });
	await expect(link).toBeVisible({ timeout: 60_000 });
	const pixel = (await downloadedPixels(link)).slice(0, 4);
	expect(pixel[3]).toBe(255);
	await expect
		.poll(() =>
			page.getByTestId("after").evaluate((canvas: HTMLCanvasElement) => {
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				return Array.from(ctx?.getImageData(0, 0, 1, 1).data ?? []);
			}),
		)
		.toEqual(pixel);
});

test("cleans the compression fringe around a Korean heading at 2x", async ({
	page,
}) => {
	await page.goto("/");
	const ring = await decodeInPage(page, "korean-heading-background-ring.png");
	await page
		.locator('input[type="file"]')
		.setInputFiles(fixturePath("korean-heading-q25.jpg"));
	await page.getByText("2x", { exact: true }).click();
	await page.getByRole("button", { name: "복원 시작" }).click();
	const link = page.getByRole("link", { name: "PNG로 저장" });
	await expect(link).toBeVisible({ timeout: 90_000 });
	const restored = await downloadedPixels(link);
	expect(restored.length).toBe(ring.length);
	let error = 0,
		samples = 0;
	const background = [244, 243, 240];
	for (let p = 0; p < ring.length; p += 4) {
		if (!ring[p]) continue;
		for (const [c, value] of background.entries())
			error += Math.abs(restored[p + c] - value);
		samples += 3;
	}
	expect(samples).toBeGreaterThan(10_000);
	expect(error / samples).toBeLessThan(8);
});
