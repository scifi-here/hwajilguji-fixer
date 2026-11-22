import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHIPPED_MODELS = new URL("../static/models/", import.meta.url).pathname;
const ABC_SHA256 =
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

type ManifestEntry = {
	readonly file: string;
	readonly sha256: string;
	readonly bytes: number;
};

function isManifestEntry(value: unknown): value is ManifestEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"file" in value &&
		typeof value.file === "string" &&
		"sha256" in value &&
		typeof value.sha256 === "string" &&
		"bytes" in value &&
		typeof value.bytes === "number"
	);
}

async function readManifest(dir: string): Promise<ManifestEntry[]> {
	const parsed: unknown = JSON.parse(
		await readFile(join(dir, "models.json"), "utf8"),
	);
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("models.json is not an object");
	const entries = Object.values(parsed);
	if (!entries.every(isManifestEntry))
		throw new Error("models.json has a malformed entry");
	return entries;
}

async function fileProblems(
	dir: string,
	entry: ManifestEntry,
	notice: string,
): Promise<string[]> {
	const bytes = await readFile(join(dir, entry.file));
	const problems: string[] = [];
	if (bytes.length !== entry.bytes)
		problems.push(
			`${entry.file}: size ${bytes.length}, manifest ${entry.bytes}`,
		);
	if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
		problems.push(`${entry.file}: hash mismatch`);
	if (!notice.includes(entry.file) || !notice.includes(entry.sha256))
		problems.push(`${entry.file}: missing from NOTICE.md`);
	return problems;
}

async function modelProblems(dir: string): Promise<string[]> {
	const entries = await readManifest(dir);
	const notice = await readFile(join(dir, "NOTICE.md"), "utf8");
	const listed = new Set(entries.map((entry) => entry.file));
	const unlisted = (await readdir(dir)).filter(
		(name) => name.endsWith(".onnx") && !listed.has(name),
	);
	const perFile = await Promise.all(
		entries.map((entry) => fileProblems(dir, entry, notice)),
	);
	return [
		...unlisted.map((name) => `${name}: not in models.json`),
		...perFile.flat(),
	];
}

async function modelDirectory(
	content: string,
	noticeSha: string,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "models-"));
	await writeFile(join(dir, "a.onnx"), content);
	await writeFile(
		join(dir, "models.json"),
		JSON.stringify({ role: { file: "a.onnx", sha256: ABC_SHA256, bytes: 3 } }),
	);
	await writeFile(join(dir, "NOTICE.md"), `| a.onnx | ${noticeSha} |`);
	return dir;
}

describe("model files", () => {
	it("match the manifest and the notice that ship in web/static/models", async () => {
		expect(await modelProblems(SHIPPED_MODELS)).toEqual([]);
	});

	it("accept a directory whose bytes, size and notice agree", async () => {
		expect(
			await modelProblems(await modelDirectory("abc", ABC_SHA256)),
		).toEqual([]);
	});

	it("reject a file that changed by one byte but kept its size", async () => {
		expect(
			await modelProblems(await modelDirectory("abd", ABC_SHA256)),
		).toEqual(["a.onnx: hash mismatch"]);
	});

	it("reject an onnx file that the manifest does not list", async () => {
		const dir = await modelDirectory("abc", ABC_SHA256);
		await writeFile(join(dir, "extra.onnx"), "abc");
		expect(await modelProblems(dir)).toEqual([
			"extra.onnx: not in models.json",
		]);
	});

	it("reject a model whose notice row carries another hash", async () => {
		const dir = await modelDirectory("abc", "0".repeat(64));
		expect(await modelProblems(dir)).toEqual([
			"a.onnx: missing from NOTICE.md",
		]);
	});
});
