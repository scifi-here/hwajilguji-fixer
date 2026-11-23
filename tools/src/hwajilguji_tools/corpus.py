import io
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from PIL import Image, features
import pillow_heif

pillow_heif.register_heif_opener()  # pyright: ignore[reportUnknownMemberType]

type Label = Literal["clean", "blocky8", "smeared", "palette"]
LABELS: tuple[Label, ...] = ("clean", "blocky8", "smeared", "palette")
type Encoder = Callable[[Image.Image], Image.Image]

KODAK_COMMIT = "d9dcd537bdac3ae5b753296cd675db8a303c8f72"
KODAK_URL = f"https://raw.githubusercontent.com/cszn/IRCNN/{KODAK_COMMIT}/testsets/Set24/kodim{{:02d}}.png"
KODAK_BYTES = (
    736501,
    617995,
    502888,
    637432,
    785610,
    618959,
    566322,
    788470,
    582899,
    593463,
    621023,
    531024,
    822712,
    692201,
    612582,
    534247,
    602078,
    780947,
    671476,
    492462,
    637051,
    701970,
    557596,
    706397,
)
KODAK_SIDES = [512, 768]
MIN_CLEAN = 20
GENERATION_CROP = (3, 5)
GENERATION_GRID = ((8 - GENERATION_CROP[0]) % 8, (8 - GENERATION_CROP[1]) % 8)


@dataclass(frozen=True)
class Case:
    path: Path
    source: Path
    codec: str
    quality: int
    label: Label
    grid_offset: tuple[int, int] | None
    origin: tuple[int, int]


@dataclass(frozen=True)
class Variant:
    codec: str
    quality: int
    label: Label
    grid_offset: tuple[int, int] | None
    encode: Encoder
    origin: tuple[int, int] = (0, 0)


def fetch_clean(dest: Path) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(len(KODAK_BYTES)) as pool:
        return list(
            pool.map(
                download_kodak,
                range(1, len(KODAK_BYTES) + 1),
                [dest] * len(KODAK_BYTES),
            )
        )


def download_kodak(index: int, dest: Path) -> Path:
    path = dest / f"kodim{index:02d}.png"
    expected = KODAK_BYTES[index - 1]
    if not path.exists():
        try:
            with urllib.request.urlopen(
                KODAK_URL.format(index), timeout=60
            ) as response:
                body: bytes = response.read()
        except urllib.error.URLError as error:
            raise RuntimeError(
                f"Kodak set unreachable ({error.reason}); "
                f"pass --clean-dir with {MIN_CLEAN}+ lossless PNGs"
            ) from error
        if len(body) != expected:
            raise RuntimeError(f"{path.name}: {len(body)} bytes, expected {expected}")
        partial = path.with_suffix(".part")
        partial.write_bytes(body)
        partial.replace(path)
    with Image.open(path) as image:
        if (
            path.stat().st_size != expected
            or image.format != "PNG"
            or sorted(image.size) != KODAK_SIDES
        ):
            raise RuntimeError(
                f"{path.name}: not the {expected}-byte 768x512 Kodak PNG"
            )
    return path


def list_clean(directory: Path) -> list[Path]:
    pngs = sorted(directory.glob("*.png"))
    if len(pngs) < MIN_CLEAN:
        raise RuntimeError(f"{directory}: {len(pngs)} PNGs, need {MIN_CLEAN}+")
    return pngs


def reencode(image: Image.Image, format: str, quality: int) -> Image.Image:
    buffer = io.BytesIO()
    image.save(buffer, format=format, quality=quality)
    buffer.seek(0)
    with Image.open(buffer) as decoded:
        if decoded.format != format:
            raise RuntimeError(f"{format} round trip decoded as {decoded.format}")
        return decoded.convert("RGB")


def jpeg_generations(image: Image.Image) -> Image.Image:
    third = reencode(reencode(reencode(image, "JPEG", 30), "JPEG", 30), "JPEG", 30)
    return third.crop((*GENERATION_CROP, third.width, third.height))


def gif(image: Image.Image, colours: int, dither: Image.Dither) -> Image.Image:
    palette = image.quantize(colors=colours, dither=Image.Dither.NONE)
    indexed = image.quantize(palette=palette, dither=dither)
    buffer = io.BytesIO()
    indexed.save(buffer, format="GIF")
    buffer.seek(0)
    with Image.open(buffer) as decoded:
        return decoded.convert("RGB")


def lossy(codec: str, format: str, quality: int, label: Label) -> Variant:
    grid = (0, 0) if label == "blocky8" else None
    return Variant(
        codec, quality, label, grid, lambda image: reencode(image, format, quality)
    )


VARIANTS: list[Variant] = [
    *(lossy("jpeg", "JPEG", quality, "blocky8") for quality in (10, 20, 30, 40)),
    lossy("jpeg", "JPEG", 90, "clean"),
    Variant(
        "jpeg-gen3", 30, "blocky8", GENERATION_GRID, jpeg_generations, GENERATION_CROP
    ),
    *(lossy("webp", "WEBP", quality, "smeared") for quality in (10, 30, 50)),
    *(lossy("avif", "AVIF", quality, "smeared") for quality in (20, 40)),
    *(lossy("heic", "HEIF", quality, "smeared") for quality in (20, 40)),
    Variant(
        "gif",
        256,
        "palette",
        None,
        lambda image: gif(image, 256, Image.Dither.FLOYDSTEINBERG),
    ),
    Variant(
        "gif", 64, "palette", None, lambda image: gif(image, 64, Image.Dither.NONE)
    ),
]


def require_codecs() -> None:
    missing = [name for name in ("jpg", "webp", "avif") if not features.check(name)]
    if "HEIF" not in Image.SAVE:
        missing.append("heif")
    if missing:
        raise RuntimeError(f"missing codec: {', '.join(missing)}")


def degrade(clean: Path, dest: Path) -> list[Case]:
    require_codecs()
    with Image.open(clean) as opened:
        image = opened.convert("RGB")
    dest.mkdir(parents=True, exist_ok=True)
    cases: list[Case] = []
    for variant in VARIANTS:
        path = dest / f"{clean.stem}-{variant.codec}-q{variant.quality}.png"
        variant.encode(image).save(path, compress_level=1)
        cases.append(
            Case(
                path,
                clean,
                variant.codec,
                variant.quality,
                variant.label,
                variant.grid_offset,
                variant.origin,
            )
        )
    return cases


def save_manifest(cases: list[Case], path: Path) -> None:
    rows = [
        asdict(case) | {"path": str(case.path), "source": str(case.source)}
        for case in cases
    ]
    path.write_text(json.dumps(rows, indent=1))


def load_manifest(path: Path) -> list[Case]:
    rows: list[dict[str, object]] = json.loads(path.read_text())
    return [parse_case(row) for row in rows]


def parse_case(row: dict[str, object]) -> Case:
    match row:
        case {
            "path": str(path),
            "source": str(source),
            "codec": str(codec),
            "quality": int(quality),
            "label": label,
            "grid_offset": grid,
            "origin": origin,
        }:
            return Case(
                Path(path),
                Path(source),
                codec,
                quality,
                parse_label(label),
                None if grid is None else parse_pair(grid),
                parse_pair(origin),
            )
        case _:
            raise ValueError(f"malformed case row: {row}")


def parse_label(label: object) -> Label:
    for known in LABELS:
        if label == known:
            return known
    raise ValueError(f"unknown label: {label}")


def parse_pair(pair: object) -> tuple[int, int]:
    match pair:
        case [int(x), int(y)]:
            return (x, y)
        case _:
            raise ValueError(f"malformed coordinate pair: {pair}")
