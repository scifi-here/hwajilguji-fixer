<script lang="ts">
import { onMount, tick } from "svelte";
import type {
	ContentKind,
	DamageClass,
	GateReport,
} from "#lib/pipeline/gate.ts";
import { MAX_OUTPUT_PIXELS } from "#lib/pipeline/limits.ts";
import type { Scale } from "#lib/pipeline/restore.ts";
import type { Backend } from "#lib/pipeline/session.ts";
import type { Format } from "#lib/pipeline/sniff.ts";
import type { WorkerRequest, WorkerResponse } from "#lib/pipeline/worker.ts";

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
const BACKEND_NAMES: Record<Backend, string> = {
	webgpu: "WebGPU",
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
let damageChoice = $state<DamageClass | "auto">("auto");
let contentChoice = $state<ContentKind | "auto">("auto");
let progress = $state({ done: 0, total: 0 });
let failure = $state<string | null>(null);
let resultUrl = $state<string | null>(null);
let usedBackend = $state<Backend | null>(null);
let divider = $state(50);
let dragging = $state(false);
let beforeCanvas = $state<HTMLCanvasElement>();
let afterCanvas = $state<HTMLCanvasElement>();

const busy = $derived(phase === "inspecting" || phase === "running");

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

async function showInspection(next: Inspection): Promise<void> {
	inspection = next;
	scale =
		SCALES.filter((candidate) => candidate <= 2 && fits(candidate)).at(-1) ?? 1;
	damageChoice = "auto";
	contentChoice = "auto";
	phase = "ready";
	await tick();
	if (beforeCanvas === undefined) return;
	beforeCanvas.width = next.width;
	beforeCanvas.height = next.height;
	beforeCanvas.getContext("2d")?.drawImage(next.preview, 0, 0);
}

async function showResult(png: Blob, backend: Backend): Promise<void> {
	clearResult();
	usedBackend = backend;
	resultUrl = URL.createObjectURL(png);
	phase = "done";
	const bitmap = await createImageBitmap(png);
	await tick();
	if (afterCanvas === undefined) return;
	afterCanvas.width = bitmap.width;
	afterCanvas.height = bitmap.height;
	afterCanvas.getContext("2d")?.drawImage(bitmap, 0, 0);
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
		case "progress":
			progress = { done: message.done, total: message.total };
			break;
		case "done":
			showResult(message.png, message.backend).catch((error: unknown) =>
				fail("Error", String(error)),
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
	phase = "running";
	send({
		type: "restore",
		choice: {
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
		<section class="panel" aria-label="입력과 설정">
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
				<p class="status">이미지를 분석하는 중…</p>
			{/if}

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
					<div class="segments">
						{#each SCALES as option (option)}
							<label class="segment">
								<input type="radio" name="scale" value={option} bind:group={scale} disabled={busy || !fits(option)} />
								<span>{option}x</span>
							</label>
						{/each}
					</div>
				</fieldset>

				<fieldset>
					<legend>손상 유형</legend>
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
					<button type="button" class="primary" onclick={run} disabled={busy}>복원 시작</button>
					<button type="button" onclick={() => send({ type: "cancel" })} disabled={phase !== "running"}>취소</button>
				</div>

				{#if phase === "running"}
					<div class="progress">
						<progress aria-label="타일 진행률" max={Math.max(progress.total, 1)} value={progress.done}></progress>
						<span>타일 {progress.done} / {progress.total}</span>
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
