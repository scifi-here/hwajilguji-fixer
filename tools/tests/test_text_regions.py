import pytest
from PIL import Image

from hwajilguji_tools.text_regions import Word, patch_text, scale_factor, words_from_tsv


def test_only_a_better_korean_region_receives_source_pixels() -> None:
    original = Image.new("RGBA", (64, 32), (40, 80, 20, 101))
    candidate = Image.new("RGB", original.size, (200, 90, 80))
    first = (8, 8, 20, 20)
    second = (35, 8, 50, 20)
    restored, count = patch_text(
        original,
        candidate,
        [Word(first, "한글", 90), Word(second, "사진", 92)],
        [
            Word(first, "한글", 60),
            Word(second, "사전", 89),
            Word((25, 20, 35, 30), "123", 99),
        ],
    )
    assert count == 0
    assert restored.tobytes() == original.tobytes()
    restored, count = patch_text(original, candidate, [], [Word(first, "한글", 90)])
    assert count == 1
    assert restored.getpixel((14, 14)) == (200, 90, 80, 101)
    assert restored.getpixel((0, 0)) == original.getpixel((0, 0))
    assert restored.getchannel("A").tobytes() == original.getchannel("A").tobytes()


def test_split_words_with_good_coverage_preserve_the_existing_result() -> None:
    image = Image.new("RGB", (24, 16))
    _, count = patch_text(
        image,
        Image.new("RGB", image.size, "white"),
        [Word((0, 2, 10, 14), "한", 96), Word((10, 2, 20, 14), "글", 96)],
        [Word((0, 2, 20, 14), "한글", 97)],
    )
    assert count == 0


def test_tsv_boxes_cover_partial_pixels_in_the_output() -> None:
    rows = (
        "level\tleft\ttop\twidth\theight\tconf\ttext\n"
        "4\t0\t0\t60\t30\t-1\t\n"
        "5\t4\t8\t12\t13\t81.4\t한글\n"
    )
    assert words_from_tsv(rows, 3) == [Word((1, 2, 6, 7), "한글", 81.4)]


def test_rejects_a_candidate_with_a_different_crop() -> None:
    with pytest.raises(ValueError, match="2x or 4x"):
        scale_factor((50, 30), (100, 61))
