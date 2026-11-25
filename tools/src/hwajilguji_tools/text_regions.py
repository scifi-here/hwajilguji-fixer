import csv
import io
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

type Box = tuple[int, int, int, int]
type Size = tuple[int, int]

MIN_WORD_CONFIDENCE = 75
MIN_CONFIDENCE_GAIN = 15


@dataclass(frozen=True)
class Word:
    box: Box
    text: str
    confidence: float


def scale_factor(source: Size, restored: Size) -> int:
    for scale in (2, 4):
        if restored == (source[0] * scale, source[1] * scale):
            return scale
    raise ValueError("restored PNG must be a 2x or 4x enlargement of the source")


def words_from_tsv(tsv: str, zoom: int) -> list[Word]:
    words: list[Word] = []
    for row in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row["level"] != "5" or not row["text"].strip():
            continue
        x, y, w, h = (int(row[key]) for key in ("left", "top", "width", "height"))
        if w > 0 and h > 0:
            box = (
                x // zoom,
                y // zoom,
                math.ceil((x + w) / zoom),
                math.ceil((y + h) / zoom),
            )
            words.append(Word(box, row["text"], float(row["conf"])))
    return words


def read_words(image: Image.Image, tessdata: Path | None) -> list[Word]:
    zoom = max(1, min(3, 2400 // max(image.size)))
    canvas = Image.new("RGBA", image.size, "white")
    canvas.alpha_composite(image.convert("RGBA"))
    gray = canvas.convert("L").resize(
        (image.width * zoom, image.height * zoom), Image.Resampling.LANCZOS
    )
    buffer = io.BytesIO()
    gray.save(buffer, format="PNG")
    command = [
        "tesseract",
        "stdin",
        "stdout",
        "-l",
        "kor",
        "--psm",
        "11",
        "--dpi",
        "210",
        "-c",
        "tessedit_create_tsv=1",
    ]
    if tessdata is not None:
        command.extend(("--tessdata-dir", str(tessdata)))
    proc = subprocess.run(command, input=buffer.getvalue(), capture_output=True)
    if proc.returncode:
        raise RuntimeError(proc.stderr.decode(errors="replace").strip())
    return words_from_tsv(proc.stdout.decode(), zoom)


def confidence_in(box: Box, words: list[Word]) -> float:
    x, y, right, bottom = box
    total = 0.0
    for word in words:
        left, top, end, base = word.box
        width = max(0, min(right, end) - max(x, left))
        height = max(0, min(bottom, base) - max(y, top))
        total += width * height * word.confidence
    return min(100.0, total / ((right - x) * (bottom - y)))


def patch_text(
    restored: Image.Image,
    candidate: Image.Image,
    current_words: list[Word],
    candidate_words: list[Word],
) -> tuple[Image.Image, int]:
    mask = Image.new("L", restored.size)
    draw = ImageDraw.Draw(mask)
    count = 0
    for word in candidate_words:
        if (
            word.confidence < MIN_WORD_CONFIDENCE
            or sum("가" <= char <= "힣" for char in word.text) < 2
            or word.confidence - confidence_in(word.box, current_words)
            < MIN_CONFIDENCE_GAIN
        ):
            continue
        x, y, right, bottom = word.box
        draw.rectangle((x - 1, y - 1, right, bottom), fill=255)
        count += 1
    if not count:
        return restored.copy(), 0
    result = Image.composite(
        candidate.convert("RGB"),
        restored.convert("RGB"),
        mask.filter(ImageFilter.GaussianBlur(0.8)),
    )
    if restored.has_transparency_data or restored.mode == "RGBA":
        result.putalpha(restored.convert("RGBA").getchannel("A"))
    return result, count


def restore_text_regions(
    source: Path, restored: Path, output: Path, tessdata: Path | None
) -> int:
    if output.resolve() in (source.resolve(), restored.resolve()):
        raise ValueError("choose an output separate from both input images")
    with Image.open(source) as source_image, Image.open(restored) as restored_image:
        if restored_image.format != "PNG":
            raise ValueError("expected a restored PNG")
        oriented = ImageOps.exif_transpose(source_image)
        scale_factor(oriented.size, restored_image.size)
        bicubic = oriented.convert("RGBA").resize(
            restored_image.size, Image.Resampling.BICUBIC
        )
        result, count = patch_text(
            restored_image,
            bicubic,
            read_words(restored_image, tessdata),
            read_words(bicubic, tessdata),
        )
        result.save(output, format="PNG")
    return count
