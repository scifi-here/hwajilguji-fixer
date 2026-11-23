import argparse
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from hwajilguji_tools.corpus import (
    degrade,
    fetch_clean,
    list_clean,
    load_manifest,
    save_manifest,
)
from hwajilguji_tools.evaluate import evaluate
from hwajilguji_tools.export import export_models
from hwajilguji_tools.fixtures import write_fixtures

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "tools" / "data"
MANIFEST = DATA / "cases.json"
OUT = REPO / "tools" / "out"
FIXTURES = REPO / "web" / "tests" / "fixtures"
MODELS = REPO / "web" / "static" / "models"
DOWNLOADS = DATA / "downloads"


def run_corpus(clean_dir: Path | None) -> None:
    clean = fetch_clean(DATA / "clean") if clean_dir is None else list_clean(clean_dir)
    degraded = DATA / "degraded"
    with ProcessPoolExecutor() as pool:
        batches = list(pool.map(degrade, clean, [degraded] * len(clean)))
    cases = [case for batch in batches for case in batch]
    save_manifest(cases, MANIFEST)
    print(f"{len(cases)} cases from {len(clean)} clean images in {MANIFEST}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="hwajilguji-tools")
    commands = parser.add_subparsers(dest="command", required=True)
    corpus = commands.add_parser(
        "corpus", help="download clean images and build degraded variants"
    )
    corpus.add_argument(
        "--clean-dir",
        type=Path,
        help="use these lossless PNGs instead of the Kodak set",
    )
    commands.add_parser(
        "export", help="download, export and describe the shipped ONNX models"
    )
    evaluation = commands.add_parser(
        "evaluate", help="measure PSNR and SSIM of each route and the dejpeg gate"
    )
    evaluation.add_argument(
        "--limit", type=int, help="evaluate only the first N clean images"
    )
    commands.add_parser("fixtures", help="write browser test fixtures from the corpus")
    args = parser.parse_args()
    match args.command:
        case "corpus":
            run_corpus(args.clean_dir)
        case "export":
            for role, entry in export_models(MODELS, DOWNLOADS).items():
                print(
                    f"{role}: {entry['file']} {entry['bytes']} B "
                    f"{entry['elementType']} sha256 {entry['sha256']}"
                )
        case "evaluate":
            passed = evaluate(load_manifest(MANIFEST), MODELS, OUT, args.limit)
            raise SystemExit(0 if passed else 1)
        case "fixtures":
            write_fixtures(load_manifest(MANIFEST), FIXTURES)
        case _:
            parser.error(f"unknown command {args.command}")
