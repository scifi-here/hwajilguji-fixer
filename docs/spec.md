# 화질구지 개선기 specification

This document defines the product. The keywords MUST, MUST NOT, SHOULD, and MAY have the meaning given in RFC 2119.

## Problem

Internet images lose quality each time a user saves them again with a lossy codec. The damage has four main forms: 8x8 block edges (JPEG), smeared detail (WebP, AVIF, HEIC), colour banding and dither noise (GIF palettes), and a mix of these after many re-saves.

The product MUST reduce this damage and MAY enlarge the result. The product MUST run fully in the browser. The product MUST NOT send image data to a server.

The team MUST NOT train a model. The team MUST use pretrained models and OpenCV.

No published model fixes JPEG, WebP, AVIF, HEIC, and GIF damage together. The product MUST route each image by damage class. This document states that limit in "Known limits".

## Formats

Input formats:

- JPEG
- WebP, lossy
- AVIF
- HEIC and HEIF
- GIF
- PNG, for a damaged image that was saved again as PNG
- JPEG XL, only if the browser decodes it natively

The product MUST NOT ship a WebAssembly JPEG XL decoder.

Animated GIF and animated WebP MUST be decoded as the first frame only.

Output format MUST be PNG only. The product MUST NOT offer a lossy export, because a second lossy save adds the damage the product removes.

The product MUST identify the format from the file bytes. The product MUST NOT use the file extension or the MIME type.

## Pipeline

The pipeline has four stages: decode, gate, restore, finish.

### Decode

1. The product MUST try `createImageBitmap` first.
2. If decoding fails and the format is HEIC, the product MUST load `heic-to` with a dynamic import and decode through it.
3. If decoding fails for any other format, the product MUST show "This browser cannot decode <format>." in the UI language.

### Gate

The gate is a heuristic. It uses OpenCV.js and header probes. It produces a report with the fields `damage`, `content`, `blockiness`, `gridOffset`, `uniqueColors`, and `jpegQuality`.

Damage classes: `clean`, `blocky8`, `smeared`, `palette`. Content kinds: `photo`, `graphic`.

The gate MUST apply these rules in order. The first match wins.

1. `palette`: the image has at most 256 distinct RGB values, is not gray, and has at least 4096 pixels.
2. `blocky8`: the blockiness score is at least `BLOCKINESS_MIN` (1.20). Images with a side under 32 pixels MUST skip this rule.
3. `smeared`: the format is lossy WebP, AVIF, or HEIC, or the format is JPEG with an estimated quality below `JPEG_QUALITY_SMEAR_MAX` (85).
4. `clean`: none of the above.

The blockiness score is computed from luma. The horizontal profile is the mean absolute difference between neighbouring columns. For each phase `p` in 0 to 7, `B_p` is the mean of the profile at the steps that land on phase `p` of the 8-pixel grid. `ratioH` is the largest `B_p` divided by the second largest `B_p`. The product MUST floor that divisor at 0.001. The product MUST compute `ratioV` in the same way on rows. The score is `sqrt(ratioH * ratioV)`. The grid offset is the pair of phases that gave the two largest values. Pixels decide this rule, so a low-quality JPEG saved again as PNG is still detected.

Rule 3 uses the container as a prior. No reliable pixel-only detector for smear exists. The user MUST be able to override the damage class in the UI.

The JPEG quality estimate reads the first luma quantisation table. For each quality `q` from 1 to 100, the product computes the sum of ITU-T T.81 table K.1 scaled the way libjpeg scales it, with each entry clamped to 1 and to the largest entry the table can hold. The estimate is the `q` whose sum is closest to the sum of the file's table. The product MUST return no estimate for truncated input. The product MUST NOT estimate WebP or AVIF quality from headers.

Content rule: the product splits luma into 8x8 cells. The content is `graphic` when at least `FLAT_FRACTION_GRAPHIC` (0.5) of the cells have a variance below `FLAT_VARIANCE_MAX` (4). Otherwise the content is `photo`.

All gate constants MUST live in one file, `thresholds.ts`.

### Restore

The user chooses a scale of 1x, 2x, or 4x. The default is 2x. The user MAY override the damage class and the content kind. The defaults are the gate values. At 2x and 4x the user MAY choose **확대만** to skip grid alignment, deblocking, depalettization, and flat-area smoothing. This mode keeps the selected content type, colour matching, alpha handling, and tile limits. At 1x only the existing repair path is available.

| Damage | Steps |
|---|---|
| `clean` | At 1x return the input unchanged. Otherwise upscale. |
| `blocky8` | Align the 8x8 grid. Run the deblock model at 1x. Undo the alignment. Upscale if the scale is above 1. |
| `smeared` | Run the deblock model at 1x without grid alignment. Upscale if the scale is above 1. |
| `palette` | Reduce dither with a bilateral filter. Upscale. At 1x reduce the 4x result back to size. |

The grid alignment reflect-pads the left side by `(8 - offsetX) mod 8` and the top by `(8 - offsetY) mod 8`. Block edges then sit on multiples of 8.

The upscale step MUST use the graphic model for `graphic` content and the photo model otherwise. For graphics in **확대만**, the model MUST clamp the pretrained 4x prediction to [0, 1], average non-overlapping 4×4 cells, subtract these averages from the input RGB, then add the half-pixel bilinear 4x enlargement of that difference to the clamped prediction. All upscalers scale by 4. The product MUST resize each 4x tile to the requested scale before it writes the tile into the output.

Models see RGB only. The product MUST resize the alpha plane with cubic interpolation and reattach it.

### Tiling

The product MUST run every model through one tiling function. The product MUST NOT build a whole-image tensor.

The tiler walks a fixed grid of `core` by `core` cells. For each cell it cuts the cell plus `pad` pixels of context on every side. It reflect-pads past the image edge and up to the next multiple the model needs. It runs the model. It copies only the cell region into the output.

| Backend | `core` | `pad` |
|---|---|---|
| WebGPU | 224 | 16 |
| WebAssembly | 96 | 16 |

The tiler MUST throw an `AbortError` between tiles when the abort signal is set. The tiler MUST report progress after each tile.

### Finish

1. Colour match: resize the input to the output size. Blur both with a Gaussian of sigma `3 * scale`. Add the difference to the output.
2. In automatic repair mode, for `smeared` and `palette` only: apply a bilateral filter (diameter 5, sigmaColor 12, sigmaSpace 5) where the luma gradient magnitude is below 8.
3. Clamp the output to 8 bits.

## Constraints

Hosting. A static host such as GitHub Pages sends no COOP or COEP headers. Threaded WebAssembly is therefore unavailable. The product MUST work without cross-origin isolation. The product MUST set `numThreads` to 1 and MUST NOT use `SharedArrayBuffer`. WebGPU is the primary backend. Single-thread WebAssembly is the fallback.

Memory. Every model run MUST be tiled. The input is capped at 8,000,000 pixels. The output is capped at 32,000,000 pixels. The product MUST reject an input over the cap with a message that states both numbers. The product MUST disable a scale whose output would exceed the output cap.

Models. The product MUST verify the SHA-256 of each model file against `models.json` before it creates a session. A mismatch MUST raise an integrity error.

Responsiveness. OpenCV.js and ONNX Runtime MUST run in a module worker. One job runs at a time. A cancel message MUST abort the current job.

UI. The UI text is Korean. The UI has one screen. Colours, spacing, and radii MUST come from CSS custom properties. The page MUST NOT use gradients or `transition: all`.

## Models and licenses

| Role | File | Source | License | Size |
|---|---|---|---|---|
| `deblock` | `dejpeg-v2.onnx` | `Miosp/dejpeg` release `v2.0.0` | Apache-2.0 | 15,376,612 bytes, float32 input and output (computes in fp16 inside), opset 17, dynamic axes, sides a multiple of 16, blind |
| `upscalePhoto` | `realesr-general-x4v3.onnx` | Exported by `tools` from the official `realesr-general-x4v3.pth` (4,885,111 bytes) of `xinntao/Real-ESRGAN` | BSD-3-Clause | 4,949,877 bytes, fp32, x4 |
| `upscaleGraphic` | `realesr-animevideov3.onnx` | Exported by `tools` from the official `realesr-animevideov3.pth` (2,504,012 bytes) | BSD-3-Clause | 2,537,781 bytes, fp32, x4 |
| `upscaleGraphicBackProjection` | `realesr-animevideov3-backprojection.onnx` | Same graphic weights with one back-projection step for **확대만** | BSD-3-Clause | 2,535,743 bytes, fp32, x4 |

`Miosp/dejpeg` is young: 6 stars, one author, self-reported benchmarks, and unpublished v2 training code. The team MUST measure the model before it ships. The adoption gate is in the acceptance criteria. If the model fails the gate, the team MUST replace it with FBCNN colour (`jiaxi-jiang/FBCNN`, Apache-2.0, `fbcnn_color.pth`, 287,755,111 bytes). The replacement is about 143 MB in fp32, so the UI MUST state the download size before first use.

The `tools` package vendors the `SRVGGNetCompact` network class from `xinntao/Real-ESRGAN` with its BSD-3-Clause notice kept as the file header.

The repository MUST ship `web/static/models/NOTICE.md`. It lists each model file with its source URL, license name, SHA-256, and the full license text.

`models.json` is the contract between the Python export and the browser loader. Each entry has `file`, `sha256`, `bytes`, `inputName`, `outputName`, `elementType`, `scale`, `multipleOf`, `range`, `layout`, `license`, and `source`. The roles are `deblock`, `upscalePhoto`, `upscaleGraphic`, and `upscaleGraphicBackProjection`.

`heic-to` is LGPL-3.0. The product MUST load it only when the user opens a HEIC file. The README MUST state the HEVC patent note.

## Grounded versions

Grounded on 2026-11-23. The pins below MUST be used. Each row records the pin, the release channel, the support window, the decision, the maintenance evidence, the API pattern, and the security result for the exact version.

How to read the sources. The Entry link is the release channel: the npm or PyPI page for the pin, or the project release page. Release dates come from the registry `time` field. Support windows come from `endoflife.date`. Security results come from OSV (`POST https://api.osv.dev/v1/query` with the package, ecosystem, and exact version). Maintenance data comes from the GitHub API and registry download counts. "None" means the query returned no advisory.

| Entry | Pin | Status and release | Support end | LTS or latest, and disposition | Maintenance | API pattern consulted | Security at this exact version |
|---|---|---|---|---|---|---|---|
| [Node.js](https://nodejs.org/en/about/previous-releases) | 26.13.1 (`.node-version`, `engines.node >=26.13.1`) | LTS since 2026-10-28. Newest 26.x. Released 2026-11-11 ([changelog](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V26.md)) | 2029-04-30 ([endoflife.date](https://endoflife.date/api/v1/products/nodejs/)) | Kept the plan pin. Newest LTS line. Rejected 24 LTS (24.22.3, ends 2028-04-30): shorter window. | [nodejs/node](https://github.com/nodejs/node). The release page is current. | Runtime. `engines.node` is the only contract. Node 26 runs the WebAssembly probes in vitest. | 26.13.1 is the 2026-11-11 security release. Its changelog lists the High CVEs it fixes ([vulnerability blog](https://nodejs.org/en/blog/vulnerability)). An NVD CPE search returned unrelated products and is not used. |
| [pnpm](https://github.com/pnpm/pnpm/releases) | 12.21.0 (`packageManager`) | npm `latest` tag. Released 2026-11-13 | No end date. Line 12 is maintained ([endoflife.date](https://endoflife.date/api/v1/products/pnpm/)) | Open channel conflict. 12.22.0 (2026-11-17) and 12.23.0 (2026-11-22) are GitHub non-prerelease releases and the npm tag `next-12`. npm `latest` is 12.21.0. Kept the plan pin. A human decides whether to raise it; it is a one-line change. | [pnpm/pnpm](https://github.com/pnpm/pnpm), 37,154 stars, pushed 2026-11-22, not archived; 358.4M/wk. | pnpm 12 denies dependency build scripts. `allowBuilds` in `pnpm-workspace.yaml` is `{lefthook: false, protobufjs: false}`. Observed from the CLI on 2026-11-23. | OSV: none for this version. The same holds for 12.22.0 and 12.23.0. The plan cites GHSA-jg5c-8mvg-5wph (fixed in 12.10.0). OSV and the GitHub advisory API do not list that identifier, so it is unconfirmed. OSV lists many advisories on 11.0.0 and none on 12.9.0 or later. |
| [typescript](https://www.npmjs.com/package/typescript/v/6.0.3) | 6.0.3 | Newest 6.x. Released 2026-04-16. `latest` is 7.0.2 (2026-07-08) | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Lowered from the plan pin 7.0.2 (plan contingency 1). SvelteKit 3.4.0 fails `svelte-kit sync` with `typescript_compiler_api_missing`. It requires `typescript@^6.0.0` and accepts TypeScript 7 only as a separate `@typescript/native` for type checking ([error page](https://svelte.dev/e/kit/typescript_compiler_api_missing)). Raise it when kit supports 7. | [microsoft/TypeScript](https://github.com/microsoft/TypeScript), 111,870 stars, pushed 2026-11-22, not archived; 451.5M/wk. | Compiler flags only. The kit error page in the previous column. | OSV: none for this version. |
| [vite](https://www.npmjs.com/package/vite/v/8.3.8) | 8.3.8 | `latest`. Released 2026-11-11 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. It equals `latest`. | [vitejs/vite](https://github.com/vitejs/vite), 84,033 stars, pushed 2026-11-20, not archived; 289.1M/wk. | `vite preview` serves on port 4173 by default (read in the installed `vite` dist). | OSV: none for this version. The plan left Vite advisories unswept. Swept on 2026-11-23. |
| [svelte](https://www.npmjs.com/package/svelte/v/5.59.1) | 5.59.1 | `latest`. Released 2026-11-20 | No end date for line 5 | Kept the plan pin. It equals `latest`. | [sveltejs/svelte](https://github.com/sveltejs/svelte), 89,901 stars, pushed 2026-11-22, not archived; 10.4M/wk. | Runes only. The page agent reads the installed `svelte` source in step 9. | OSV: none for this version. |
| [@sveltejs/kit](https://www.npmjs.com/package/@sveltejs/kit/v/3.4.0) | 3.4.0 | `latest`. Released 2026-11-18 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. It equals `latest`. Kit 3 has no `svelte.config.js`. | [sveltejs/kit](https://github.com/sveltejs/kit), 20,927 stars, pushed 2026-11-21, not archived; 5.1M/wk. | `sveltekit({adapter, compilerOptions})` inside `web/vite.config.ts`. Kit 3 removed `svelte.config.js` (`src/exports/vite/index.js:165` in the package). `#lib/*` subpath imports need a file extension for `svelte-check`; checked in a scratch copy. | OSV: none for this version. [GHSA-m9j8-jcmv-hp69](https://github.com/advisories/GHSA-m9j8-jcmv-hp69) (High) affects `>=3.0.0 <3.1.1`. It does not apply to 3.4.0. |
| [@sveltejs/adapter-static](https://www.npmjs.com/package/@sveltejs/adapter-static/v/4.0.1) | 4.0.1 | `latest`. Released 2026-10-29 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | Same repository as kit; 1.7M/wk. | Default export `plugin(options?)` with `pages`, `assets`, `fallback`, `precompress`, `strict` (`index.d.ts:33` in the package). | OSV: none for this version. |
| [@sveltejs/vite-plugin-svelte](https://www.npmjs.com/package/@sveltejs/vite-plugin-svelte/v/7.3.1) | 7.3.1 | `latest`. Released 2026-09-23 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Added by the scaffold. Not in the plan table. | [sveltejs/vite-plugin-svelte](https://github.com/sveltejs/vite-plugin-svelte), 1,044 stars, pushed 2026-11-21, not archived; 6.6M/wk. | Configured through `sveltekit({compilerOptions})`. No direct call. | OSV: none for this version. |
| [svelte-check](https://www.npmjs.com/package/svelte-check/v/4.7.8) | 4.7.8 | `latest`. Released 2026-11-01 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Added by the scaffold. Not in the plan table. | [sveltejs/language-tools](https://github.com/sveltejs/language-tools), 1,451 stars, pushed 2026-11-19, not archived; 4.9M/wk. | CLI flag `--fail-on-warnings` only. | OSV: none for this version. |
| [@biomejs/biome](https://www.npmjs.com/package/@biomejs/biome/v/2.6.8) | 2.6.8 | `latest`. Released 2026-11-15 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [biomejs/biome](https://github.com/biomejs/biome), 26,176 stars, pushed 2026-11-22, not archived; 30.3M/wk. | `biome.json` keys read from the 2.6.8 CLI output: `linter.rules.preset` replaces `recommended`. Biome formats Markdown by default, so `biome.json` excludes `**/*.md`. | OSV: none for this version. |
| [vitest](https://www.npmjs.com/package/vitest/v/5.1.1) | 5.1.1 | `latest`. Released 2026-11-18 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [vitest-dev/vitest](https://github.com/vitest-dev/vitest), 17,424 stars, pushed 2026-11-20, not archived; 194.6M/wk. | `defineConfig` from `vitest/config`; `test.include`; defaults `environment: node` and `globals: false` (`defaults.*.js:54-63` in the package). Tests importing `#lib/...` ran green under the scaffold config. | OSV: none for this version. |
| [@playwright/test](https://www.npmjs.com/package/@playwright/test/v/1.65.1) | 1.65.1 | `latest`. Released 2026-11-13 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [microsoft/playwright](https://github.com/microsoft/playwright), 100,797 stars, pushed 2026-11-21, not archived; 138.9M/wk. | `defineConfig` and `devices` from `@playwright/test`; `webServer {command, port}`; `page.setInputFiles`; `page.evaluate` (`types/test.d.ts` in the package). | OSV: none for this version. |
| [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web/v/1.31.1) | 1.31.1 | `latest`. Released 2026-10-26. The `dev` tag 1.33.0-dev is not used | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. The source repository `microsoft/onnxruntime` returned 404 (web) and 404 or 403 (API) on 2026-11-23. It has been reported missing since 2026-11-17 and the cause is unconfirmed ([onnx/onnx#8842](https://github.com/onnx/onnx/issues/8842)). The pinned release predates that date. The WASM files come from the npm tarball, not from GitHub. Recheck when the project explains. | 8.2M/wk. MIT. The upstream repository is unreachable, so no archive or push data exists. | `import * as ort from 'onnxruntime-web/webgpu'` loads `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` for both execution providers. The plan's jsep and plain pair is wrong for this import, so `sync-ort` copies the asyncify pair. Also `env.wasm.numThreads`, `proxy`, and `wasmPaths` (absolute prefix) (`env.d.ts:36-89` in `onnxruntime-common`). | OSV: none for this version. |
| [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js/v/5.0.0-release.1) | 5.0.0-release.1 | `latest`. Released 2026-06-24. The previous `latest` was 4.5.2 (2021) | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. OpenCV publishes no official npm package. | [TechStark/opencv-js](https://github.com/TechStark/opencv-js), 789 stars, pushed 2026-08-01, not archived; 416k/wk; Apache-2.0. | The default export is a Promise: `const cv = await cvModule`. It works in a module worker and in Node. `fastNlMeansDenoisingColored` and `detailEnhance` are absent from this build (probed). Bindings use embind in OpenCV 5. | OSV: none for this version. |
| [heic-to](https://www.npmjs.com/package/heic-to/v/1.6.7) | 1.6.7 | `latest`. Released 2026-10-27 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. LGPL-3.0. Loaded on demand only. | [hoppergee/heic-to](https://github.com/hoppergee/heic-to), 364 stars; 2.9M/wk. | `heicTo({blob, type: 'bitmap'})` returns an `ImageBitmap`; `isHeic(file)`; subpath `heic-to/csp` for strict CSP (`heic-to.d.ts:6-48` in the package). | OSV: none for this version. The plan left heic-to advisories unswept. Swept on 2026-11-23. |
| [lefthook](https://www.npmjs.com/package/lefthook/v/2.2.2) | 2.2.2 | `latest`. Released 2026-10-13 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | The plan left the pin open. Resolved with `npm view lefthook version time` on 2026-11-23. | [evilmartians/lefthook](https://github.com/evilmartians/lefthook), 9,052 stars, pushed 2026-11-16, not archived; 10.3M/wk. | `lefthook run pre-commit --all-files`. With no staged files lefthook skips every command; any `--file` runs all (observed). | OSV: none for this version. |
| [pretendard](https://www.npmjs.com/package/pretendard/v/1.3.9) | 1.3.9 | `latest`. Released 2023-11-05 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | The plan left the pin open (UI font, step 9). The last release is three years old. Accepted on adoption, a repository push on 2026-07-23, and a clean OSV result. No newer release exists. | [orioncactus/pretendard](https://github.com/orioncactus/pretendard), 3,664 stars, pushed 2026-07-23, not archived; 705k/wk; OFL-1.1. | CSS font files only. No code API. | OSV: none for this version. |
| [Python](https://www.python.org/downloads/release/python-31410/) | 3.14.10 (`requires-python >=3.14.10,<3.15`) | Security release of the 3.14 line, 2026-10-25. 3.15.2 is the newest stable (2026-10-25) | 3.14: 2030-10-31. 3.15: 2031-10-31 ([endoflife.date](https://endoflife.date/api/v1/products/python/)) | Lowered from the plan pin 3.15.2 (plan contingency 2). PyPI lists no cp315 wheel for onnxruntime-gpu 1.32.0 or scikit-image 0.26.0. Raise it when both publish cp315 wheels. | [python/cpython](https://github.com/python/cpython). | Interpreter. Every run goes through uv (`AGENTS.md`). | The release page lists the CVEs fixed in 3.14.10 (CVE-2026-115557, CVE-2026-114583). An NVD CPE search returned unrelated products and is not used. |
| [uv](https://pypi.org/project/uv/0.13.9/) | 0.13.9 (`uv_build >=0.13.9,<0.14.0`) | Newest. Released 2026-11-17 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. The host `/usr/bin/uv` is 0.12.20, which [GHSA-hq85-5cpj-mr62](https://github.com/advisories/GHSA-hq85-5cpj-mr62) (CRITICAL, fixed in 0.13.4) affects. The sandbox denies writes to `~/.local/bin`. A checksum-verified 0.13.9 runs from `~/.cache/uv-0.13.9/bin` (tarball SHA-256 `a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5`). The system uv MUST be upgraded. | [astral-sh/uv](https://github.com/astral-sh/uv), 92,602 stars, pushed 2026-11-22, not archived; 51.2M/wk. | `uv init --package` writes a `[build-system]`; `--python` sets the minimum Python ([CLI reference](https://docs.astral.sh/uv/reference/cli/)). `uv run --frozen --project tools` runs a command without touching the lock. | OSV: none for 0.13.9. PYSEC-2026-4321 (the same flaw) is introduced at 0 and fixed in 0.13.4. It applies to the host 0.12.20 only. |
| [torch](https://pypi.org/project/torch/2.15.0/) | 2.15.0 (resolves to `2.15.0+cu132`) | Newest. Released 2026-10-28 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [pytorch/pytorch](https://github.com/pytorch/pytorch), 105,811 stars, pushed 2026-11-22, not archived; 12.4M/wk. | `torch.onnx.export(model, args, input_names, output_names, dynamic_shapes=...)` returns an `ONNXProgram`. The dynamo exporter is the default since 2.9 ([docs 2.15](https://docs.pytorch.org/docs/2.15/onnx_export.html)). The default Linux wheel bundles CUDA 13.2 and cuDNN 9.26. | OSV: none for this version. The plan cites GHSA-v32g-mr63-3j83. The GitHub advisory API returns 404 and OSV lists no such identifier, so it is unconfirmed. |
| [onnx](https://pypi.org/project/onnx/1.23.2/) | 1.23.2 | Newest. Released 2026-10-06 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [onnx/onnx](https://github.com/onnx/onnx), 21,738 stars, pushed 2026-11-22, not archived; 4.0M/wk. | `onnx.checker.check_model` and graph introspection. Read from the installed package by the Python agent. | OSV: none for this version. |
| [onnxruntime-gpu](https://pypi.org/project/onnxruntime-gpu/1.32.0/) | 1.32.0 | Newest. Released 2026-11-13. Wheels cp311 to cp314; none for cp315 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. Same missing-repository caveat as `onnxruntime-web`. | 646k/wk. The upstream repository is unreachable. | `InferenceSession(path, providers=['CUDAExecutionProvider','CPUExecutionProvider'])` (`onnxruntime_inference_collection.py:629` in the 1.32.0 wheel). It shares CUDA 13 and cuDNN 9 with torch 2.15. | OSV: none for this version. |
| [onnxscript](https://pypi.org/project/onnxscript/0.7.2/) | 0.7.2 | Newest. Released 2026-09-09 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Added for `torch.onnx.export`. Not in the plan table. Listed in `tools/pyproject.toml`. | [microsoft/onnxscript](https://github.com/microsoft/onnxscript) returns 404 on 2026-11-23, like `microsoft/onnxruntime`. 778k/wk. It stands on adoption and a clean OSV result. Recheck with the onnxruntime incident. | Dependency of the torch dynamo exporter. No direct call. | OSV: none for this version. |
| [opencv-python-headless](https://pypi.org/project/opencv-python-headless/5.1.0.95/) | 5.1.0.95 | Newest. Released 2026-11-17 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. Measurement only. | [opencv/opencv-python](https://github.com/opencv/opencv-python), 5,458 stars, pushed 2026-11-17, not archived; 18.3M/wk. | `cv2.PSNR(src1, src2[, R])` and `cv2.resize` from the OpenCV 5.x headers. The OpenCV docs site was unreachable behind a bot challenge, so the Python stubs were not read (unverified). | OSV: none for this version. |
| [Pillow](https://pypi.org/project/Pillow/13.0.0/) | 13.0.0 | Newest. Released 2026-10-16 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [python-pillow/Pillow](https://github.com/python-pillow/Pillow), 14,007 stars, pushed 2026-11-22, not archived; 161.7M/wk. | `Image.save` per codec, `Image.quantize(colors, dither=...)`, `PIL.features.check` ([reference](https://pillow.readthedocs.io/en/stable/reference/Image.html)). | OSV: none for this version. |
| [pillow-heif](https://pypi.org/project/pillow-heif/1.8.1/) | 1.8.1 | Newest. Released 2026-10-11 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [bigcat88/pillow_heif](https://github.com/bigcat88/pillow_heif), 309 stars, pushed 2026-11-22, not archived; 8.8M/wk. | `register_heif_opener()` registers the opener always and the HEIC saver only when an x265 encoder is present (`as_plugin.py:240` in the wheel). AVIF saving comes from Pillow, because pillow-heif dropped AVIF in 1.0.0. | OSV: none for this version. |
| [numpy](https://pypi.org/project/numpy/2.5.5/) | 2.5.5 (resolved; floor `>=2.5.5`) | Newest. Released 2026-11-15 | 2028-06-22 for the 2.5 line ([endoflife.date](https://endoflife.date/api/v1/products/numpy/)) | The plan left the pin open. Resolved by uv. | [numpy/numpy](https://github.com/numpy/numpy), 33,454 stars, pushed 2026-11-22, not archived; 268.5M/wk. | Array interchange only. No direct pattern recorded. | OSV: none for this version. |
| [scikit-image](https://pypi.org/project/scikit-image/0.26.0/) | 0.26.0 (resolved) | Newest. Released 2025-12-20. No cp315 wheel | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | The plan left the pin open. Resolved by uv. It forces Python 3.14.10, as does onnxruntime-gpu. | [scikit-image/scikit-image](https://github.com/scikit-image/scikit-image), 6,640 stars, pushed 2026-11-21, not archived. The last release is 11 months old. Accepted as the standard SSIM implementation. | `structural_similarity(im1, im2, channel_axis=2, data_range=255)`. `data_range` MUST be passed for integer images ([API](https://scikit-image.org/docs/0.26.x/api/skimage.metrics.html)). | OSV: none for this version. |
| [ruff](https://pypi.org/project/ruff/0.17.6/) | 0.17.6 | Newest. Released 2026-11-19 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [astral-sh/ruff](https://github.com/astral-sh/ruff), 51,427 stars, pushed 2026-11-22, not archived; 107.0M/wk. | Config keys only (`tools/pyproject.toml`). Verified by running `ruff check`. | OSV: none for this version. |
| [pyright](https://pypi.org/project/pyright/1.1.414/) | 1.1.414 | Newest. Released 2026-09-10 (one day after the plan's date) | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [microsoft/pyright](https://github.com/microsoft/pyright), 15,755 stars, pushed 2026-11-20, not archived; 14.1M/wk. | `typeCheckingMode = strict`. Verified by running `pyright`. | OSV: none for this version. |
| [pytest](https://pypi.org/project/pytest/9.2.0/) | 9.2.0 | Newest. Released 2026-10-27 | None published; no [endoflife.date](https://endoflife.date/api/v1/products/) record | Kept the plan pin. | [pytest-dev/pytest](https://github.com/pytest-dev/pytest), 14,736 stars, pushed 2026-11-22, not archived; 240.0M/wk. | Test discovery only. | OSV: none for this version. |

Dropped on purpose: `@huggingface/transformers` (ONNX Runtime Web is used directly), `onnxconverter-common` (stale; models ship as published), and the `basicsr` and `realesrgan` Python packages (the one needed network class is vendored).

Open items:

- The pnpm channel conflict. A human decides between 12.21.0 (npm `latest`) and 12.23.0 (newest release).
- The `microsoft/onnxruntime` and `microsoft/onnxscript` repositories return 404. The cause is unconfirmed. Registry packages still install. Keep the lockfile hashes.
- The identifiers GHSA-jg5c-8mvg-5wph and GHSA-v32g-mr63-3j83 from the research notes are unconfirmed.
- The system uv is 0.12.20 and MUST be upgraded to 0.13.4 or newer.
- The manual WebGPU check (acceptance criterion 5) needs a browser with WebGPU. It has not run.

## Acceptance criteria

1. Spec upload. `git ls-remote origin main` prints the commit that contains `README.md` and `docs/spec.md`.
2. Gates. `pnpm install --frozen-lockfile && pnpm exec lefthook run pre-commit --all-files` exits 0. A deliberate type error in a staged file makes the same command exit nonzero.
3. Model adoption. `uv run --project tools hwajilguji-tools evaluate` prints the table. The `deblock` model MUST gain at least +1.0 dB mean PSNR over the JPEG input at each of QF 10, 20, 30, and 40. The mean PSNR at QF 90 MUST NOT drop by more than 0.1 dB. The WebP, AVIF, HEIC, and GIF rows are reported as measured. They are not a pass condition, because no published baseline exists.
4. End to end. `pnpm --dir web build && pnpm --dir web exec playwright install chromium && pnpm --dir web e2e` passes. A QF 10 JPEG gains at least 0.5 dB PSNR against its clean original after a 1x run in a real browser.
5. Manual check in Chrome with WebGPU. `pnpm --dir web preview`, then drop:
   - a low-quality JPEG saved again as PNG: the report shows `JPEG 블록`;
   - a lossy WebP: the report shows `뭉개짐`;
   - a GIF: the report shows `팔레트`;
   - a clean PNG photo: the report shows `clean` and 1x returns the image unchanged.

   Run 2x on a 3000x2000 photo. Progress advances per tile. The tab stays responsive. The download is a 6000x4000 PNG. Open the page in a browser without WebGPU and confirm the same file completes.

## Known limits

- No published model repairs all five codecs together. JPEG has a dedicated model. WebP, AVIF, and HEIC use the JPEG deblock model, which was not trained for them. It gained PSNR on every measured case. GIF uses a bilateral filter and the general upscaler, which lowered PSNR at 1x.
- The smear class depends on the container, not on the pixels. A smeared image that was re-saved as PNG is classed `clean` unless the user overrides the class.
- Only the first frame of an animation is processed.
- Header quality probes cover JPEG only.
- Alpha is resized, not restored.
- The default load carries a 13.3 MB OpenCV.js file and the model files. The HEIC decoder (about 26 MB) loads only on demand.
- Very large inputs are rejected. The caps are 8,000,000 input pixels and 32,000,000 output pixels.
- The `deblock` model needs the WebGPU `shader-f16` feature. Without it the session fails ("Program Transpose requires f16") and the loader retries that model on WebAssembly. Observed on 2026-11-23 on an NVIDIA Ampere adapter and on SwiftShader. The two float32 upscalers ran on WebGPU on both adapters and matched WebAssembly within 5.2e-6.
