import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const fixturePath = (name: string): string =>
	new URL(`../tests/fixtures/e2e/${name}`, import.meta.url).pathname;

async function decodeInPage(page: Page, name: string): Promise<number[]> {
	return page.evaluate(
		async (bytes) => {
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const context = canvas.getContext("2d");
			if (context === null) throw new Error("2d context unavailable");
			context.drawImage(bitmap, 0, 0);
			return Array.from(
				context.getImageData(0, 0, bitmap.width, bitmap.height).data,
			);
		},
		Array.from(readFileSync(fixturePath(name))),
	);
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
			const context = canvas.getContext("2d");
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
	expect(models).toEqual(["/models/realesr-general-x4v3.onnx"]);
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
