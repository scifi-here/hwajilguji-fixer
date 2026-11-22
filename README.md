# 화질구지 개선기 (Hwajilguji Restorer)

"화질구지" is Korean internet slang for an image that looks bad because it was saved, shared, and re-saved many times with lossy compression. Each save adds blocks, smears, and colour banding. This tool reduces that damage and can enlarge the image afterwards.

Everything runs in your browser. Your image never leaves your computer. There is no server.

## How it works

The app inspects the image first, then picks a repair path for the damage it finds.

1. **Gate.** Plain image analysis (OpenCV) reads the file header and the pixels. It decides whether the image has JPEG blocks, smeared detail, a reduced colour palette, or no visible damage. It also decides whether the content is a photo or a graphic with text.
2. **Model.** A small pretrained neural network (ONNX Runtime Web, WebGPU with a WebAssembly fallback) repairs the image. JPEG blocks go to a JPEG deblocking model. Everything else goes to a general upscaling model.
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
- No published model repairs JPEG, WebP, AVIF, HEIC, and GIF damage together. JPEG blocks have a dedicated model. The other formats use a general-purpose upscaling model. No published accuracy numbers exist for those formats. The measured numbers from this project's own test corpus are listed below once the evaluation has run.
- The browser must be able to decode the format. If it cannot, the app says so.
- Without WebGPU the app falls back to single-thread WebAssembly. It still works, but it is slower.

## Run locally

Prerequisites: Node 26.13.1, pnpm 12.21.0, uv, and `gh` logged in. An NVIDIA GPU speeds up the Python evaluation but is not required.

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