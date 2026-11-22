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

1. `palette`: the image has at most 256 distinct RGB values and at least 4096 pixels.
2. `blocky8`: the blockiness score is at least `BLOCKINESS_MIN` (1.20). Images with a side under 32 pixels MUST skip this rule.
3. `smeared`: the format is lossy WebP, AVIF, or HEIC, or the format is JPEG with an estimated quality below `JPEG_QUALITY_SMEAR_MAX` (85).
4. `clean`: none of the above.

The blockiness score is computed from luma. For each column offset `o` in 0 to 7, `B_o` is the mean horizontal gradient at columns where `x mod 8 = o`. `N_o` is the mean at the other columns. `ratioH` is the maximum of `B_o / N_o`. The product MUST compute `ratioV` in the same way on rows. The score is `sqrt(ratioH * ratioV)`. The grid offset is the pair of offsets that gave the two maxima. Pixels decide this rule, so a low-quality JPEG saved again as PNG is still detected.

Rule 3 uses the container as a prior. No reliable pixel-only detector for smear exists. The user MUST be able to override the damage class in the UI.

The JPEG quality estimate reads the first quantisation table. The scale is `100 * sum(table) / sum(table K.1 luma)` as in ITU-T T.81. The quality is `(200 - scale) / 2` when the scale is 100 or less, else `5000 / scale`, clamped to 1 to 100. The product MUST return no estimate for truncated input. The product MUST NOT estimate WebP or AVIF quality from headers.

Content rule: the product splits luma into 8x8 cells. The content is `graphic` when at least `FLAT_FRACTION_GRAPHIC` (0.5) of the cells have a variance below `FLAT_VARIANCE_MAX` (4). Otherwise the content is `photo`.

All gate constants MUST live in one file, `thresholds.ts`.

### Restore

The user chooses a scale of 1x, 2x, or 4x. The default is 2x. The user MAY override the damage class and the content kind. The defaults are the gate values.

| Damage | Steps |
|---|---|
| `clean` | At 1x return the input unchanged. Otherwise upscale. |
| `blocky8` | Align the 8x8 grid. Run the deblock model at 1x. Undo the alignment. Upscale if the scale is above 1. |
| `smeared` | Upscale. At 1x reduce the 4x result back to size. |
| `palette` | Reduce dither with a bilateral filter. Upscale. At 1x reduce the 4x result back to size. |

The grid alignment reflect-pads the left side by `(8 - offsetX) mod 8` and the top by `(8 - offsetY) mod 8`. Block edges then sit on multiples of 8.

The upscale step MUST use the graphic model for `graphic` content and the photo model otherwise. Both models scale by 4. The product MUST resize each 4x tile to the requested scale before it writes the tile into the output.

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
2. For `smeared` and `palette` only: apply a bilateral filter (diameter 5, sigmaColor 12, sigmaSpace 5) where the luma gradient magnitude is below 8.
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
| `deblock` | `dejpeg-v2.onnx` | `Miosp/dejpeg` release `v2.0.0` | Apache-2.0 | 15,376,612 bytes, fp16, opset 17, dynamic axes, sides a multiple of 16, blind |
| `upscalePhoto` | `realesr-general-x4v3.onnx` | Exported by `tools` from the official `realesr-general-x4v3.pth` (4,885,111 bytes) of `xinntao/Real-ESRGAN` | BSD-3-Clause | About 4.6 MB, fp32, x4 |
| `upscaleGraphic` | `realesr-animevideov3.onnx` | Exported by `tools` from the official `realesr-animevideov3.pth` (2,504,012 bytes) | BSD-3-Clause | About 2.4 MB, fp32, x4 |

`Miosp/dejpeg` is young: 6 stars, one author, self-reported benchmarks, and unpublished v2 training code. The team MUST measure the model before it ships. The adoption gate is in the acceptance criteria. If the model fails the gate, the team MUST replace it with FBCNN colour (`jiaxi-jiang/FBCNN`, Apache-2.0, `fbcnn_color.pth`, 287,755,111 bytes). The replacement is about 143 MB in fp32, so the UI MUST state the download size before first use.

The `tools` package vendors the `SRVGGNetCompact` network class from `xinntao/Real-ESRGAN` with its BSD-3-Clause notice kept as the file header.

The repository MUST ship `web/static/models/NOTICE.md`. It lists each model file with its source URL, license name, SHA-256, and the full license text.

`models.json` is the contract between the Python export and the browser loader. Each entry has `file`, `sha256`, `bytes`, `inputName`, `outputName`, `elementType`, `scale`, `multipleOf`, `range`, `layout`, `license`, and `source`. The roles are `deblock`, `upscalePhoto`, and `upscaleGraphic`.

`heic-to` is LGPL-3.0. The product MUST load it only when the user opens a HEIC file. The README MUST state the HEVC patent note.

## Grounded versions

Grounded on 2026-11-23 from each release channel. The pins below MUST be used.

| Entry | Pin | Released | Note |
|---|---|---|---|
| Node.js | 26.13.1 | 2026-11-11 | LTS since 2026-10-28, end of life 2029-04-30 |
| pnpm | 12.21.0 | 2026-11-09 | Critical GHSA-jg5c-8mvg-5wph is fixed in 12.10.0 |
| TypeScript | 7.0.2 | 2026-07-08 | Native compiler. Fallback: newest 6.x if `svelte-check` or SvelteKit rejects it |
| Vite | 8.3.8 | 2026-11-06 | Advisories not swept |
| Svelte | 5.59.1 | 2026-11-21 | Runes only |
| @sveltejs/kit | 3.4.0 | 2026-11-19 | High GHSA-m9j8-jcmv-hp69 is fixed in 3.1.1 |
| @sveltejs/adapter-static | 4.0.1 | 2026-10-30 | |
| @biomejs/biome | 2.6.8 | 2026-11-15 | |
| vitest | 5.1.1 | 2026-11-18 | |
| @playwright/test | 1.65.1 | 2026-11-09 | |
| onnxruntime-web | 1.31.1 | 2026-10-26 | MIT, no advisory |
| @techstark/opencv-js | 5.0.0-release.1 | 2026-06-24 | Apache-2.0. OpenCV has no official npm package. `dist/opencv.js` is 13.3 MB in one file |
| heic-to | 1.6.7 | 2026-10-27 | LGPL-3.0, lazy-loaded, advisories not swept |
| lefthook | 2.2.2 | 2026-10-13 | Checked with the registry on 2026-11-23 (`time.modified`) |
| Python | 3.15.2 | 2026-10-25 | Security support to 2031-10-31. Fallback: 3.14.10 |
| uv | 0.13.9 | 2026-11-17 | The build host has 0.12.20. The pin is the target |
| torch | 2.15.0 | 2026-10-28 | Patched for GHSA-v32g-mr63-3j83 |
| onnx | 1.23.2 | 2026-10-06 | |
| onnxruntime-gpu | 1.32.0 | 2026-11-13 | |
| opencv-python-headless | 5.1.0.95 | 2026-11-17 | Measurement only. It does not encode |
| Pillow | 13.0.0 | 2026-10-16 | Encodes JPEG, WebP, AVIF, GIF |
| pillow-heif | 1.8.1 | 2026-10-11 | BSD-3-Clause. Encodes HEIC |
| ruff | 0.17.6 | 2026-11-19 | |
| pyright | 1.1.414 | 2026-09-09 | |
| pytest | 9.2.0 | 2026-10-27 | |

Dropped on purpose: `@huggingface/transformers` (ONNX Runtime Web is used directly), `onnxconverter-common` (stale; models ship as published), and the `basicsr` and `realesrgan` Python packages (the one needed network class is vendored).

Versions resolved at install time (numpy, scikit-image, pretendard) are recorded here after the first install.

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