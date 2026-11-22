from pathlib import Path

import pytest
from PIL import Image, features

from hwajilguji_tools.corpus import degrade


def write_clean(tmp_path: Path) -> Path:
    clean = tmp_path / "clean.png"
    Image.new("RGB", (32, 32), (120, 80, 40)).save(clean)
    return clean


@pytest.mark.parametrize("codec", ["avif", "webp"])
def test_degrade_raises_for_a_missing_pillow_codec_instead_of_skipping_its_rows(
    codec: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    available = features.check

    def check_without_codec(name: str) -> bool | None:
        return name != codec and available(name)

    monkeypatch.setattr(features, "check", check_without_codec)
    out = tmp_path / "out"

    with pytest.raises(RuntimeError, match=codec):
        degrade(write_clean(tmp_path), out)

    assert not out.exists() or not any(out.iterdir())


def test_degrade_raises_for_a_missing_heif_saver_that_the_pillow_flags_hide(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delitem(Image.SAVE, "HEIF")
    out = tmp_path / "out"

    with pytest.raises(RuntimeError, match="heif"):
        degrade(write_clean(tmp_path), out)

    assert not out.exists() or not any(out.iterdir())
