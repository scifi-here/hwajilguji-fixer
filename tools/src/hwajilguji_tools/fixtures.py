import json
from pathlib import Path

from PIL import Image

from hwajilguji_tools.corpus import Case

ORIGIN = 64
GATE_SIDE = 128
E2E_SIDE = 256
GATE_SOURCES = ("kodim01", "kodim02")
JPEG_QUALITIES = (10, 30, 50, 75, 90)

type Row = dict[str, str | int | list[int] | None]


def crop(path: Path, side: int) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGB").crop((ORIGIN, ORIGIN, ORIGIN + side, ORIGIN + side))


def gate_row(image: Image.Image, dest: Path, name: str, case: Case | None) -> Row:
    (dest / name).write_bytes(image.tobytes())
    offset = (
        None if case is None or case.grid_offset is None else list(case.grid_offset)
    )
    label = "clean" if case is None else case.label
    return {
        "file": name,
        "width": image.width,
        "height": image.height,
        "label": label,
        "gridOffset": offset,
    }


def write_gate(cases: list[Case], sources: list[Path], dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    rows = [
        gate_row(crop(source, GATE_SIDE), dest, f"{source.stem}-original.rgb", None)
        for source in sources
    ]
    for case in cases:
        if case.source in sources:
            rows.append(
                gate_row(
                    crop(case.path, GATE_SIDE), dest, f"{case.path.stem}.rgb", case
                )
            )
    (dest / "cases.json").write_text(biome_json(rows))


def biome_json(rows: list[Row]) -> str:
    objects = [
        "\t{\n"
        + ",\n".join(
            f"\t\t{json.dumps(key)}: {json.dumps(value)}" for key, value in row.items()
        )
        + "\n\t}"
        for row in rows
    ]
    return "[\n" + ",\n".join(objects) + "\n]\n"


def write_jpeg(source: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    image = crop(source, GATE_SIDE)
    for quality in JPEG_QUALITIES:
        image.save(dest / f"qf{quality}.jpg", format="JPEG", quality=quality)


def write_e2e(source: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    image = crop(source, E2E_SIDE)
    image.save(dest / "clean.png")
    image.save(dest / "degraded-qf10.jpg", format="JPEG", quality=10)


def write_fixtures(cases: list[Case], dest: Path) -> None:
    sources = sorted(
        {case.source for case in cases if case.source.stem in GATE_SOURCES}
    )
    if len(sources) != len(GATE_SOURCES):
        raise RuntimeError(f"fixtures need {' and '.join(GATE_SOURCES)} in the corpus")
    write_gate(cases, sources, dest / "gate")
    write_jpeg(sources[0], dest / "jpeg")
    write_e2e(sources[0], dest / "e2e")
