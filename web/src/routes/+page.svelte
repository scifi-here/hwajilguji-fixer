<script lang="ts">
import { onMount, tick } from "svelte";
import type {
	ContentKind,
	DamageClass,
	GateReport,
} from "#lib/pipeline/gate.ts";
import { MAX_OUTPUT_PIXELS } from "#lib/pipeline/limits.ts";
import type { RestoreMode, Scale } from "#lib/pipeline/restore.ts";
import type { Backend } from "#lib/pipeline/session.ts";
import type { Format } from "#lib/pipeline/sniff.ts";
import type {
	RunBackend,
	WorkerRequest,
	WorkerResponse,
} from "#lib/pipeline/worker.ts";

type Inspection = {
	readonly report: GateReport;
	readonly format: Format;
	readonly backend: Backend;
	readonly width: number;
	readonly height: number;
	readonly preview: ImageBitmap;
};
type Phase = "empty" | "inspecting" | "ready" | "running" | "done";

const FORMAT_NAMES: Record<Format, string> = {
	jpeg: "JPEG",
	png: "PNG",
	gif: "GIF",
	"webp-lossy": "WebP (손실)",
	"webp-lossless": "WebP (무손실)",
	avif: "AVIF",
	heic: "HEIC",
	jxl: "JPEG XL",
	unknown: "알 수 없음",
};
const DAMAGE_NAMES: Record<DamageClass, string> = {
	clean: "깨끗함",
	blocky8: "JPEG 블록",
	smeared: "뭉개짐",
	palette: "팔레트",
};
const CONTENT_NAMES: Record<ContentKind, string> = {
	photo: "사진",
	graphic: "글자·그림",
};
const BACKEND_NAMES: Record<RunBackend, string> = {
	webgpu: "WebGPU",
	mixed: "WebGPU + WASM",
	wasm: "WASM",
};
const SCALES: readonly Scale[] = [1, 2, 4];
const DAMAGE_CHOICES: readonly DamageClass[] = [
	"blocky8",
	"smeared",
	"palette",
];
const CONTENT_CHOICES: readonly ContentKind[] = ["photo", "graphic"];

let worker: Worker | null = null;
let phase = $state<Phase>("empty");
let stem = $state("image");
let inspection = $state.raw<Inspection | null>(null);
let scale = $state<Scale>(2);
let mode = $state<RestoreMode>("restore");
const upscaleOnly = $derived(scale > 1 && mode === "upscaleOnly");
const actionLabel = $derived(upscaleOnly ? "확대" : "복원");
let damageChoice = $state<DamageClass | "auto">("auto");
let contentChoice = $state<ContentKind | "auto">("auto");
let progress = $state({ done: 0, total: 0 });
let elapsedTime = $state(0);
let resultWidth = $state(0);
let resultHeight = $state(0);
let resultSize = $state(0);
let locatingText = $state(false);
let textCoverage = $state<number | null>(null);
let startTime = 0;

$effect(() => {
	if (phase !== "running") return;

	const timer = setInterval(() => {
		elapsedTime = (performance.now() - startTime) / 1000;
	}, 100);

	return () => clearInterval(timer);
});
let failure = $state<string | null>(null);
let resultUrl = $state<string | null>(null);
let usedBackend = $state<RunBackend | null>(null);
let divider = $state(50);
let dragging = $state(false);
let beforeCanvas = $state<HTMLCanvasElement>();
let afterCanvas = $state<HTMLCanvasElement>();

const busy = $derived(phase === "inspecting" || phase === "running");

function invalidateResult(): void {
	if (phase === "done") {
		clearResult();
		phase = "ready";
	}
}

function fits(candidate: Scale): boolean {
	return (
		inspection !== null &&
		inspection.width * inspection.height * candidate * candidate <=
			MAX_OUTPUT_PIXELS
	);
}

function send(request: WorkerRequest, transfer: Transferable[] = []): void {
	worker?.postMessage(request, transfer);
}

function clearResult(): void {
	if (resultUrl !== null) URL.revokeObjectURL(resultUrl);
	resultUrl = null;
	textCoverage = null;
	locatingText = false;
	usedBackend = null;
	progress = { done: 0, total: 0 };
}

async function open(file: File): Promise<void> {
	stem = file.name.replace(/\.[^.]+$/, "") || "image";
	failure = null;
	inspection = null;
	clearResult();
	phase = "inspecting";
	const bytes = await file.arrayBuffer();
	send({ type: "inspect", bytes }, [bytes]);
}

function openFirst(files: FileList | null | undefined): void {
	const file = files?.[0];
	if (file === undefined) return;
	open(file).catch((error: unknown) => {
		failure = error instanceof Error ? error.message : String(error);
		phase = "empty";
	});
}
async function loadExample(filename: string): Promise<void> {
	try {
		const response = await fetch(`/examples/${filename}`);
		if (!response.ok) throw new Error("예시 이미지를 불러올 수 없습니다.");
		const blob = await response.blob();
		const file = new File([blob], filename, { type: "image/jpeg" });
		await open(file);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		phase = "empty";
	}
}
async function showInspection(next: Inspection): Promise<void> {
	inspection = next;
	scale =
		SCALES.filter((candidate) => candidate <= 2 && fits(candidate)).at(-1) ?? 1;
	mode = "restore";
	damageChoice = "auto";
	contentChoice = "auto";
	phase = "ready";
	await tick();
	if (beforeCanvas === undefined) return;
	beforeCanvas.width = next.width;
	beforeCanvas.height = next.height;
	beforeCanvas
		.getContext("2d", { willReadFrequently: true })
		?.drawImage(next.preview, 0, 0);
}

async function showResult(
	png: Blob,
	backend: RunBackend,
	coverage: number | null,
): Promise<void> {
	clearResult();
	elapsedTime = (performance.now() - startTime) / 1000;
	usedBackend = backend;
	textCoverage = coverage;
	resultUrl = URL.createObjectURL(png);
	phase = "done";
	const bitmap = await createImageBitmap(png);
	resultWidth = bitmap.width;
	resultHeight = bitmap.height;
	resultSize = png.size;
	await tick();
	if (afterCanvas === undefined) return;
	afterCanvas.width = bitmap.width;
	afterCanvas.height = bitmap.height;
	afterCanvas
		.getContext("2d", { willReadFrequently: true })
		?.drawImage(bitmap, 0, 0);
	bitmap.close();
}

function fail(name: string, message: string): void {
	failure = name === "AbortError" ? "취소했습니다." : message;
	phase = inspection === null ? "empty" : "ready";
}

function receive(message: WorkerResponse): void {
	switch (message.type) {
		case "report":
			showInspection(message).catch((error: unknown) =>
				fail("Error", String(error)),
			);
			break;
		case "locateText":
			locatingText = true;
			progress = { done: 0, total: 0 };
			break;
		case "progress":
			progress = { done: message.done, total: message.total };
			break;
		case "done":
			showResult(message.png, message.backend, message.textCoverage).catch(
				(error: unknown) => fail("Error", String(error)),
			);
			break;
		case "error":
			fail(message.name, message.message);
			break;
	}
}

function run(): void {
	if (inspection === null) return;
	failure = null;
	clearResult();
	elapsedTime = 0;
	startTime = performance.now();
	phase = "running";
	send({
		type: "restore",
		choice: {
			mode: upscaleOnly ? "upscaleOnly" : "restore",
			scale,
			damage: damageChoice === "auto" ? inspection.report.damage : damageChoice,
			content:
				contentChoice === "auto" ? inspection.report.content : contentChoice,
		},
		assetBase: new URL("./", location.href).href,
	});
}

function onDrop(event: DragEvent): void {
	event.preventDefault();
	dragging = false;
	openFirst(event.dataTransfer?.files);
}

function onDragOver(event: DragEvent): void {
	event.preventDefault();
	dragging = true;
}

onMount(() => {
	const created = new Worker(
		new URL("../lib/pipeline/worker.ts", import.meta.url),
		{ type: "module" },
	);
	created.onmessage = (event: MessageEvent<WorkerResponse>) =>
		receive(event.data);
	created.onerror = (event: ErrorEvent) =>
		fail("Error", event.message || "작업자를 시작하지 못했습니다.");
	worker = created;
	return () => {
		created.terminate();
		clearResult();
	};
});
</script>

<svelte:window onpaste={(event) => openFirst(event.clipboardData?.files)} />

<main>
	<header>
		<h1>화질구지 개선기</h1>
		<p>여러 번 압축되어 깨진 이미지를 브라우저 안에서 복원합니다. 파일은 어디에도 업로드되지 않습니다.</p>
	</header>

	<div class="layout">
		<section class="panel" aria-label="입력과 설정" onchange={invalidateResult}>
			<label
				class="drop"
				class:dragging
				ondragover={onDragOver}
				ondragleave={() => (dragging = false)}
				ondrop={onDrop}
			>
				<span>이미지를 끌어다 놓거나 붙여넣거나 눌러서 고르세요</span>
				<input
					type="file"
					accept="image/*,.heic,.heif,.avif,.jxl"
					onchange={(event) => openFirst(event.currentTarget.files)}
				/>
			</label>
{#if phase === "inspecting"}
    <p class="status">이미지를 분석하는 중...</p>
{/if}
<div class="examples">
    <h3>예시 이미지로 체험하기</h3>
    <p>이미지를 클릭하여 화질 복원을 체험해 보세요.</p>
<p>
    <a href="/examples/ATTRIBUTION.md" target="_blank" rel="noopener noreferrer">
        예시 이미지 출처 및 라이선스
    </a>
</p>
    <div style="display: flex; gap: 10px;">
        <button type="button" onclick={() => loadExample("dog-degraded.jpeg")} disabled={busy} style="flex: 1; min-width: 0;">
            <img src="/examples/dog-degraded.jpeg" alt="강아지 예시" style="width: 100%; height: 80px; object-fit: cover;" />
            <span>강아지</span>
        </button>

        <button type="button" onclick={() => loadExample("landscape-degraded.jpeg")} disabled={busy} style="flex: 1; min-width: 0;">
            <img src="/examples/landscape-degraded.jpeg" alt="풍경 예시" style="width: 100%; height: 80px; object-fit: cover;" />
            <span>풍경</span>
        </button>

        <button type="button" onclick={() => loadExample("illustration-degraded.jpeg")} disabled={busy} style="flex: 1; min-width: 0;">
            <img src="/examples/illustration-degraded.jpeg" alt="일러스트 예시" style="width: 100%; height: 80px; object-fit: cover;" />
            <span>일러스트</span>
        </button>
    </div>
</div>
			{#if inspection !== null}
				<dl class="report" aria-label="분석 결과">
					<dt>형식</dt>
					<dd data-testid="format">{FORMAT_NAMES[inspection.format]}</dd>
					<dt>크기</dt>
					<dd>{inspection.width} × {inspection.height}</dd>
					{#if inspection.report.jpegQuality !== null}
						<dt>JPEG 품질 추정</dt>
						<dd>{inspection.report.jpegQuality}</dd>
					{/if}
					<dt>손상 유형</dt>
					<dd data-testid="damage">{DAMAGE_NAMES[inspection.report.damage]}</dd>
					<dt>내용</dt>
					<dd>{CONTENT_NAMES[inspection.report.content]}</dd>
					<dt>블록 정도</dt>
					<dd>{inspection.report.blockiness.toFixed(2)}</dd>
					<dt>격자 오프셋</dt>
					<dd>
						{inspection.report.damage === "blocky8" && inspection.report.gridOffset !== null
							? inspection.report.gridOffset.join(", ")
							: "-"}
					</dd>
					<dt>실행 백엔드</dt>
					<dd data-testid="backend">{BACKEND_NAMES[usedBackend ?? inspection.backend]}</dd>
				</dl>

				<fieldset>
					<legend>배율</legend>
<details>
    <summary>배율 선택 도움말</summary>
    <p>1x: 원본 크기를 유지하며 화질을 개선합니다.</p>
    <p>2x: 가로와 세로 해상도를 2배로 확대합니다.</p>
    <p>4x: 가로와 세로 해상도를 4배로 확대합니다.</p>
    <p>배율이 높을수록 복원 시간이 길어질 수 있습니다.</p>
</details>
					<div class="segments">
						{#each SCALES as option (option)}
							<label class="segment">
								<input type="radio" name="scale" value={option} bind:group={scale} disabled={busy || !fits(option)} />
								<span>{option}x</span>
							</label>
						{/each}
					</div>
				</fieldset>

				{#if scale > 1}
					<fieldset>
						<legend>처리 방식</legend>
						<details>
							<summary>처리 방식 도움말</summary>
							<p>자동 복원은 손상을 보정한 뒤 확대하고, 글자 위치를 찾아 따로 처리합니다. 압축 손상이 있는 사진의 2배 확대에서는 글자 부분을 복원하고, 그 밖의 확대에서는 해당 영역의 원본 픽셀을 보간합니다. 압축된 글자 주위의 배경색이 고르면 획 주변의 얼룩도 줄입니다. 확대만은 압축 보정을 건너뛰고 선택한 사진 또는 글자·그림 모델로 확대합니다.</p>
						</details>
						<div class="segments">
							<label class="segment">
								<input type="radio" name="mode" value="restore" bind:group={mode} disabled={busy} />
								<span>자동 복원</span>
							</label>
							<label class="segment">
								<input type="radio" name="mode" value="upscaleOnly" bind:group={mode} disabled={busy} />
								<span>확대만</span>
							</label>
						</div>
					</fieldset>
				{/if}

				<fieldset disabled={upscaleOnly}>
					<legend>손상 유형</legend>
<details>
    <summary>손상 유형 도움말</summary>
    <p>자동: 이미지의 손상 유형을 자동으로 판단합니다.</p>
    <p>JPEG 블록: 이미지 압축으로 발생한 사각형 노이즈를 개선합니다.</p>
    <p>뭉개짐: 흐릿하거나 뭉개진 이미지에 사용합니다.</p>
    <p>팔레트: 색상 수가 제한된 이미지에 사용합니다.</p>
</details>
					<div class="segments">
						<label class="segment">
							<input type="radio" name="damage" value="auto" bind:group={damageChoice} disabled={busy} />
							<span>자동</span>
						</label>
						{#each DAMAGE_CHOICES as option (option)}
							<label class="segment">
								<input type="radio" name="damage" value={option} bind:group={damageChoice} disabled={busy} />
								<span>{DAMAGE_NAMES[option]}</span>
							</label>
						{/each}
					</div>
				</fieldset>

				<fieldset>
					<legend>내용</legend>
<details>
    <summary>내용 선택 도움말</summary>
    <p>자동: 이미지의 내용 유형을 자동으로 판단합니다.</p>
    <p>사진: 인물, 풍경, 동물 등의 일반 사진에 사용합니다.</p>
    <p>글자·그림: 문서, 만화, 일러스트 등에 사용합니다.</p>
</details>
					<div class="segments">
						<label class="segment">
							<input type="radio" name="content" value="auto" bind:group={contentChoice} disabled={busy} />
							<span>자동</span>
						</label>
						{#each CONTENT_CHOICES as option (option)}
							<label class="segment">
								<input type="radio" name="content" value={option} bind:group={contentChoice} disabled={busy} />
								<span>{CONTENT_NAMES[option]}</span>
							</label>
						{/each}
					</div>
				</fieldset>

				<div class="actions">
					<button type="button" class="primary" onclick={run} disabled={busy}>{actionLabel} 시작</button>
					<button type="button" onclick={() => send({ type: "cancel" })} disabled={phase !== "running"}>취소</button>
				</div>

				{#if phase === "running"}
					<div class="progress">
						<progress aria-label="타일 진행률" max={Math.max(progress.total, 1)} value={progress.done}></progress>
						<span>{locatingText ? "글자 영역 처리" : actionLabel} 진행률 {progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0}% ({progress.done} / {progress.total})</span>
<span>경과 시간: {elapsedTime.toFixed(1)}초</span>
					</div>
				{/if}
{#if phase === "done" && inspection !== null && resultWidth > 0}
    <div>
        <h3>{actionLabel} 결과 상세 정보</h3>
        <p>원본 해상도: {inspection.width} × {inspection.height}</p>
        <p>{actionLabel} 해상도: {resultWidth} × {resultHeight}</p>
        <p>확대 배율: {(resultWidth / inspection.width).toFixed(1)}배</p>
        <p>결과 파일 형식: PNG</p>
        {#if textCoverage !== null}
            <p data-testid="text-coverage">글자 영역 보정: {textCoverage === 0 ? "검출된 영역 없음" : textCoverage < 0.001 ? "0.1% 미만" : (100 * textCoverage).toFixed(1) + "%"}</p>
        {/if}
        <p>결과 파일 용량: {(resultSize / 1024 / 1024).toFixed(2)} MB</p>
        <p>{actionLabel} 소요 시간: {elapsedTime.toFixed(1)}초</p>
    </div>
{/if}
			{/if}

			{#if failure !== null}
				<p class="failure" role="alert">{failure}</p>
			{/if}
		</section>

		<section class="viewer" aria-label="비교">
			{#if inspection !== null}
				<div class="stage">
					<canvas bind:this={beforeCanvas} data-testid="before"></canvas>
					{#if phase === "done"}
						<canvas
							bind:this={afterCanvas}
							class="after"
							style:clip-path={`inset(0 0 0 ${divider}%)`}
							data-testid="after"
						></canvas>
						<div class="divider" style:left={`${divider}%`}></div>
					{/if}
				</div>
				{#if phase === "done" && resultUrl !== null}
					<div class="compare">
						<span>원본</span>
						<input type="range" min="0" max="100" step="0.5" bind:value={divider} aria-label="원본과 복원 결과 경계" />
						<span>복원</span>
					</div>
					<a class="download" href={resultUrl} download={`${stem}-restored.png`}>PNG로 저장</a>
				{/if}
			{:else}
				<p class="placeholder">이미지를 열면 여기에서 원본과 복원 결과를 비교합니다.</p>
			{/if}
		</section>
	</div>
</main>

<style>
	main {
		max-width: 1200px;
		margin: 0 auto;
		padding: var(--space-6) var(--space-5);
	}

	header {
		margin-bottom: var(--space-5);
	}

	h1 {
		margin: 0 0 var(--space-1);
		font-size: var(--text-l);
		font-weight: 700;
	}

	header p {
		margin: 0;
		color: var(--color-muted);
		font-size: var(--text-s);
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(280px, 340px) 1fr;
		gap: var(--space-5);
		align-items: start;
	}

	@media (max-width: 760px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-line);
		border-radius: var(--radius-m);
	}

	.drop {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-5) var(--space-4);
		border: 1px dashed var(--color-line);
		border-radius: var(--radius-m);
		color: var(--color-muted);
		font-size: var(--text-s);
		text-align: center;
		cursor: pointer;
	}

	.drop.dragging {
		border-color: var(--color-accent);
		color: var(--color-ink);
	}

	.drop input {
		font-size: var(--text-s);
	}

	.status,
	.failure,
	.placeholder {
		margin: 0;
		font-size: var(--text-s);
	}

	.failure {
		color: var(--color-danger);
	}

	.placeholder {
		color: var(--color-muted);
	}

	.report {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		font-size: var(--text-s);
	}

	.report dt {
		color: var(--color-muted);
	}

	.report dd {
		margin: 0;
	}

	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		margin-bottom: var(--space-1);
		padding: 0;
		color: var(--color-muted);
		font-size: var(--text-s);
	}

	.segments {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.segment input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.segment span {
		display: block;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--color-line);
		border-radius: var(--radius-s);
		font-size: var(--text-s);
		cursor: pointer;
	}

	.segment input:checked + span {
		border-color: var(--color-accent);
		background: var(--color-accent);
		color: var(--color-accent-ink);
	}

	.segment input:focus-visible + span {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.segment input:disabled + span {
		color: var(--color-muted);
		cursor: not-allowed;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}

	button {
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--color-line);
		border-radius: var(--radius-s);
		background: var(--color-surface);
		cursor: pointer;
	}

	button.primary {
		border-color: var(--color-accent);
		background: var(--color-accent);
		color: var(--color-accent-ink);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.progress {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-s);
	}

	.progress progress {
		flex: 1;
	}

	.viewer {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.stage {
		position: relative;
		background: var(--color-stage);
		border-radius: var(--radius-m);
		overflow: hidden;
	}

	.stage canvas {
		display: block;
		width: 100%;
		height: auto;
	}

	.stage canvas.after {
		position: absolute;
		inset: 0;
		height: 100%;
	}

	.divider {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--color-surface);
		pointer-events: none;
	}

	.compare {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--color-muted);
		font-size: var(--text-s);
	}

	.compare input {
		flex: 1;
	}

	.download {
		align-self: flex-start;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-s);
		background: var(--color-ink);
		color: var(--color-surface);
		font-size: var(--text-s);
		text-decoration: none;
	}
</style>
