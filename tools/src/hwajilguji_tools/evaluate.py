import json
import time
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import fmean

import cv2
import numpy as np
import onnxruntime
from numpy.typing import NDArray
from PIL import Image
from skimage.metrics import structural_similarity

from hwajilguji_tools.corpus import Case

type Rgb = NDArray[np.uint8]

PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]
DEBLOCK_MULTIPLE = 16
GATE_QUALITIES = (10, 20, 30, 40)
GATE_MIN_GAIN = 1.0
GATE_MAX_LOSS_AT_90 = 0.1


@dataclass(frozen=True)
class Sessions:
    deblock: onnxruntime.InferenceSession
    upscale: onnxruntime.InferenceSession


@dataclass(frozen=True)
class Score:
    codec: str
    quality: int
    label: str
    route: str
    psnr_in: float
    psnr_out: float
    ssim_in: float
    ssim_out: float


@dataclass(frozen=True)
class Row:
    codec: str
    quality: int
    label: str
    route: str
    images: int
    psnr_in: float
    psnr_out: float
    gain: float
    ssim_in: float
    ssim_out: float


def read_rgb(path: Path) -> Rgb:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)


def infer(session: onnxruntime.InferenceSession, image: Rgb) -> Rgb:
    planar = image.transpose(2, 0, 1)[None] / 255
    tensor = np.ascontiguousarray(planar, dtype=np.float32)
    (output,) = session.run(None, {session.get_inputs()[0].name: tensor})
    planes = np.clip(output[0].transpose(1, 2, 0), 0, 1)
    return np.rint(planes * 255).astype(np.uint8)


def deblock(
    session: onnxruntime.InferenceSession, image: Rgb, grid: tuple[int, int]
) -> Rgb:
    left, top = (8 - grid[0]) % 8, (8 - grid[1]) % 8
    height, width = image.shape[:2]
    right, bottom = (
        -(left + width) % DEBLOCK_MULTIPLE,
        -(top + height) % DEBLOCK_MULTIPLE,
    )
    padded = cv2.copyMakeBorder(image, top, bottom, left, right, cv2.BORDER_REFLECT_101)
    restored = infer(session, np.asarray(padded, dtype=np.uint8))
    return restored[top : top + height, left : left + width]


def upscale_at_1x(session: onnxruntime.InferenceSession, image: Rgb) -> Rgb:
    height, width = image.shape[:2]
    reduced = cv2.resize(
        infer(session, image), (width, height), interpolation=cv2.INTER_AREA
    )
    return np.asarray(reduced, dtype=np.uint8)


def restore(case: Case, image: Rgb, sessions: Sessions) -> tuple[str, Rgb]:
    match case.label:
        case "blocky8" | "clean":
            return "deblock", deblock(
                sessions.deblock, image, case.grid_offset or (0, 0)
            )
        case "smeared":
            return "upscalePhoto", upscale_at_1x(sessions.upscale, image)
        case "palette":
            smoothed = np.asarray(cv2.bilateralFilter(image, 5, 35, 5), dtype=np.uint8)
            return "depalette+upscalePhoto", upscale_at_1x(sessions.upscale, smoothed)


def score(case: Case, sessions: Sessions) -> Score:
    degraded = read_rgb(case.path)
    height, width = degraded.shape[:2]
    x, y = case.origin
    clean = read_rgb(case.source)[y : y + height, x : x + width]
    route, restored = restore(case, degraded, sessions)
    return Score(
        case.codec,
        case.quality,
        case.label,
        route,
        cv2.PSNR(degraded, clean),
        cv2.PSNR(restored, clean),
        float(structural_similarity(degraded, clean, channel_axis=2, data_range=255)),
        float(structural_similarity(restored, clean, channel_axis=2, data_range=255)),
    )


def summarize(scores: list[Score]) -> list[Row]:
    groups: defaultdict[tuple[str, int], list[Score]] = defaultdict(list)
    for item in scores:
        groups[item.codec, item.quality].append(item)
    rows: list[Row] = []
    for (codec, quality), items in groups.items():
        psnr_in = fmean(item.psnr_in for item in items)
        psnr_out = fmean(item.psnr_out for item in items)
        rows.append(
            Row(
                codec,
                quality,
                items[0].label,
                items[0].route,
                len(items),
                psnr_in,
                psnr_out,
                psnr_out - psnr_in,
                fmean(item.ssim_in for item in items),
                fmean(item.ssim_out for item in items),
            )
        )
    return rows


def adoption_failures(rows: list[Row]) -> list[str]:
    jpeg = {row.quality: row for row in rows if row.codec == "jpeg"}
    failures = [
        f"QF{quality} gain {jpeg[quality].gain:+.2f} dB < +{GATE_MIN_GAIN:.2f}"
        for quality in GATE_QUALITIES
        if jpeg[quality].gain < GATE_MIN_GAIN
    ]
    if jpeg[90].gain < -GATE_MAX_LOSS_AT_90:
        failures.append(f"QF90 gain {jpeg[90].gain:+.2f} dB < -{GATE_MAX_LOSS_AT_90}")
    return failures


def markdown(rows: list[Row]) -> str:
    lines = [
        "| codec | quality | label | route | n | PSNR in | PSNR out | gain dB "
        "| SSIM in | SSIM out |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    lines += [
        f"| {row.codec} | {row.quality} | {row.label} | {row.route} | {row.images} "
        f"| {row.psnr_in:.2f} | {row.psnr_out:.2f} | {row.gain:+.2f} "
        f"| {row.ssim_in:.4f} | {row.ssim_out:.4f} |"
        for row in rows
    ]
    return "\n".join(lines)


def evaluate(cases: list[Case], models: Path, out: Path, limit: int | None) -> bool:
    sources = sorted({case.source for case in cases})[:limit]
    selected = [case for case in cases if case.source in sources]
    sessions = Sessions(
        onnxruntime.InferenceSession(models / "dejpeg-v2.onnx", providers=PROVIDERS),
        onnxruntime.InferenceSession(
            models / "realesr-general-x4v3.onnx", providers=PROVIDERS
        ),
    )
    provider = sessions.deblock.get_providers()[0]
    started = time.perf_counter()
    scores = [score(case, sessions) for case in selected]
    seconds_per_image = (time.perf_counter() - started) / len(sources)
    rows = summarize(scores)
    failures = adoption_failures(rows)
    verdict = "PASS" if not failures else "FAIL: " + "; ".join(failures)
    scope = "all" if limit is None else f"first {len(sources)} (deterministic subset)"
    print(f"provider {provider}; clean images {len(sources)}, {scope}")
    print(f"{seconds_per_image:.1f} s per clean image across {len(scores)} cases")
    print(
        "clean rows run the deblock route to measure the cost of a false blocky8 call"
    )
    print(markdown(rows))
    print(f"adoption gate for dejpeg-v2.onnx: {verdict}")
    out.mkdir(parents=True, exist_ok=True)
    report = {
        "provider": provider,
        "cleanImages": [source.name for source in sources],
        "secondsPerImage": seconds_per_image,
        "rows": [asdict(row) for row in rows],
        "adoption": {"pass": not failures, "failures": failures},
    }
    (out / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    return not failures
