from pathlib import Path

import pytest
from PIL import Image, features

from hwajilguji_tools.corpus import degrade


def write_clean(tmp_path: Path) -> Path:
    clean = tmp_path / "clean.png"
    Image.new("RGB", (32, 32), (120, 80, 40)).save(clean)
    return clean


@pytest.mark.parametrize("codec", ["avif", "webp"])
def test_degrade_refuses_to_build_without_a_pillow_codec(
    codec: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Property: a missing encoder stops the corpus before any file is written.

    Fault caught: the codec is skipped silently and the corpus lacks its rows.
    """
    available = features.check

    def check_without_codec(name: str) -> bool | None:
        return name != codec and available(name)

    monkeypatch.setattr(features, "check", check_without_codec)
    out = tmp_path / "out"

    with pytest.raises(RuntimeError, match=codec):
        degrade(write_clean(tmp_path), out)

    assert not out.exists() or not any(out.iterdir())


def test_degrade_refuses_to_build_without_the_heif_encoder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Property: losing the pillow-heif save handler stops the corpus.

    Fault caught: HEIC rows vanish because only the Pillow feature flags are checked.
    """
    monkeypatch.delitem(Image.SAVE, "HEIF")
    out = tmp_path / "out"

    with pytest.raises(RuntimeError, match="heif"):
        degrade(write_clean(tmp_path), out)

    assert not out.exists() or not any(out.iterdir())
