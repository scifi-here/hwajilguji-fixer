# 화질구지 개선기 (Hwajilguji Restorer)

"화질구지" is Korean internet slang for an image that looks bad because it was saved, shared, and re-saved many times with lossy compression. Each save adds blocks, smears, and colour banding. This tool reduces that damage and can enlarge the image afterwards.

Everything runs in your browser. Your image never leaves your computer. There is no server.

## How it works

The app inspects the image first, then picks a repair path for the damage it finds.

1. **Gate.** Plain image analysis (OpenCV) reads the file header and the pixels. It decides whether the image has JPEG blocks, smeared detail, a reduced colour palette, or no visible damage. It also decides whether the content is a photo or a graphic with text.
2. **Model.** A small pretrained neural network (ONNX Runtime Web, WebGPU with a WebAssembly fallback) repairs the image. JPEG blocks and smeared detail (WebP, AVIF, HEIC) go to a JPEG deblocking model. Palette images (GIF) are smoothed and go to a general upscaling model. Scaling to 2x or 4x uses the general upscaling model for every kind of damage.
3. **Finish.** A light OpenCV pass restores the large-scale colour of the source and smooths leftover banding in flat areas. Text and edges stay untouched.
4. **Upscale.** You can keep the size (1x), double it (2x, the default), or quadruple it (4x). Every model runs on small tiles, so large images do not exhaust memory.

You can override the damage type and the content type if the automatic choice is wrong.

## Supported formats

Input:

- JPEG
- WebP (lossy)
- AVIF
- HEIC / HEIF
- GIF (first frame only)
- PNG (for a damaged image that was saved again as PNG)
- JPEG XL, only if your browser can decode it natively

Output: PNG only. Saving as JPEG or WebP again would add the damage this tool removes.

## Limits

- Animated GIF and animated WebP: only the first frame is processed.
- Size caps: an input image may have at most 8,000,000 pixels. An output image may have at most 32,000,000 pixels. The app disables a scale that would go over the output cap.
- No published model repairs JPEG, WebP, AVIF, HEIC, and GIF damage together. JPEG blocks have a dedicated model. WebP, AVIF, and HEIC reuse that model, which was not trained for them. GIF uses a general-purpose upscaling model. The table below lists what this project measured.
- The browser must be able to decode the format. If it cannot, the app says so.
- Without WebGPU the app falls back to single-thread WebAssembly. It still works, but it is slower.
- The JPEG deblocking model needs the WebGPU `shader-f16` feature. On a GPU without it, that model runs on WebAssembly while the upscaling models still use the GPU.

### Measured quality

The evaluation ran at 1x on the first 8 of 24 Kodak images, on a CPU. The gain is the PSNR of the output minus the PSNR of the damaged input, both against the clean original. A positive gain means the app improved the image. The evaluation does not run the colour-match finish step.

| Damage | Setting | PSNR gain (dB) | SSIM, input to output |
|---|---|---|---|
| JPEG | quality 10 | +2.70 | 0.745 to 0.816 |
| JPEG | quality 20 | +2.61 | 0.828 to 0.879 |
| JPEG | quality 30 | +2.62 | 0.865 to 0.907 |
| JPEG | quality 40 | +2.62 | 0.886 to 0.922 |
| JPEG | quality 90 | +1.98 | 0.967 to 0.977 |
| JPEG, three saves | quality 30 | +2.58 | 0.864 to 0.906 |
| WebP | quality 10, 30, 50 | +0.62, +0.84, +0.94 | 0.814 to 0.826, 0.882 to 0.892, 0.914 to 0.923 |
| AVIF | quality 20, 40 | +0.45, +0.72 | 0.775 to 0.787, 0.875 to 0.886 |
| HEIC | quality 20, 40 | +0.42, +0.78 | 0.791 to 0.803, 0.931 to 0.937 |
| GIF | 256 colours, dithered | -2.93 | 0.938 to 0.899 |
| GIF | 64 colours, no dither | -2.60 | 0.940 to 0.885 |

WebP, AVIF, and HEIC go through the JPEG deblocking model and gain PSNR in every measured case. Before that change they went through the general upscaler and lost 0.6 to 3.3 dB. The app's finish step lowers the gain a little. On 2 of the 8 images, run through the app's own routing code with the ONNX Runtime WebAssembly backend, the app route gained 0.33 to 0.57 dB, and the deblocking model alone gained 0.39 to 0.64 dB. GIF still loses PSNR at 1x, because it goes through a bilateral filter and the general upscaler, and the app does not promise a gain for GIF. PSNR does not measure sharpness.

The damage gate names the right damage class for 31 of 32 test fixtures (96.9%) and 359 of 384 corpus images (93.5%). On the corpus, 16 smeared images read as blocky, 7 blocky images read as smeared, and 2 clean images read as blocky. Both numbers come from running `inspect` on the images: the fixtures that `web/tests/gate.test.ts` reads (the test requires at least 90%), and every image that `hwajilguji-tools corpus` writes plus the 24 originals. Use the damage override in the page when the gate is wrong.

### Korean text after upscaling

The local `text-regions` tool takes the original input and a 2x or 4x PNG saved from the app. It compares Tesseract's Korean word boxes on the restored image and a bicubic enlargement. A word with at least two Hangul syllables needs confidence 75 and a 15-point lead over the existing pixels in its box. The tool blends the bicubic pixels at those boxes and preserves the restored alpha channel.

Install the Tesseract executable and its Korean language data to run it. Use `--tessdata-dir` if the data lives outside Tesseract's search path.

```sh
uv run --frozen --project tools hwajilguji-tools text-regions source.png restored.png text.png
```

We checked 190 reference characters across two screen crops (settings and a document) and three rendered samples (chat, receipt and subtitles). Each sample was box-downsampled at both scales. The table counts insertions, deletions and substitutions on transcribed lines, ignoring spaces and punctuation. Tesseract read all five originals without errors. The same recognizer supplied the word boxes and scored the lines.

| Output | 2x errors | 4x errors |
|---|---:|---:|
| Current automatic restoration | 56 | 199 |
| Automatic restoration with text regions patched | 45 | 197 |
| Bicubic alone | 26 | 168 |

The tool selected no regions on 32 inputs from eight Kodak photos enlarged at both scales, with and without JPEG compression. The small gain at 4x and the lower error count from bicubic alone are reasons to keep this as a local experiment.

## Run locally

Prerequisites: Node 26.13.1, pnpm 12.21.0, and uv 0.13.9 or newer (uv installs Python 3.14.10). The `corpus` and `export` commands download the Kodak images and the model weights, so they need network access. An NVIDIA GPU speeds up the Python evaluation but is not required. The Python tools run only through uv.

```sh
pnpm install --frozen-lockfile
pnpm exec lefthook run pre-commit --all-files        # lint, type check, unit tests

pnpm --dir web dev                                   # development server
pnpm --dir web build && pnpm --dir web preview       # production build, served locally

pnpm --dir web exec playwright install chromium
pnpm --dir web e2e                                   # browser test on a real QF 10 JPEG

uv run --project tools hwajilguji-tools corpus       # degrade the Kodak images
uv run --project tools hwajilguji-tools export       # build the ONNX models
uv run --project tools hwajilguji-tools evaluate     # PSNR and SSIM table
uv run --project tools hwajilguji-tools fixtures     # test fixtures for the web app
```

The full specification is in [`docs/spec.md`](docs/spec.md).

## Deploy on Render

The app is a static site, so it needs no server. `render.yaml` describes the site as a Render Blueprint. In the Render Dashboard, click **New > Blueprint** and select this repository. Render builds with the Node version in `.node-version` and the pnpm version in `package.json`, then publishes `web/build`. Each commit to the linked branch triggers a deploy.

## Third-party models and licenses

| Role | File | Source | License |
|---|---|---|---|
| JPEG deblocker | `dejpeg-v2.onnx` | [`Miosp/dejpeg`](https://github.com/Miosp/dejpeg) release `v2.0.0` | Apache-2.0 |
| Upscaler, photo | `realesr-general-x4v3.onnx` | Exported from the official `realesr-general-x4v3.pth` of [`xinntao/Real-ESRGAN`](https://github.com/xinntao/Real-ESRGAN) | BSD-3-Clause |
| Upscaler, graphic | `realesr-animevideov3.onnx` | Exported from the official `realesr-animevideov3.pth` of `xinntao/Real-ESRGAN` | BSD-3-Clause |

The license texts ship in `web/static/models/NOTICE.md`.

Other notable dependencies:

- **OpenCV.js** (`@techstark/opencv-js`, Apache-2.0) for image analysis and filters.
- **ONNX Runtime Web** (`onnxruntime-web`, MIT) for model inference.
- **heic-to** (LGPL-3.0) decodes HEIC files. The app loads it only when you open a HEIC or HEIF file. HEVC, the codec inside HEIC, is covered by patent pools. If that matters for your use, do not open HEIC files.

This repository has no project `LICENSE` file yet. The team has not chosen one.
