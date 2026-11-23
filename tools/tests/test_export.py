import math
from pathlib import Path

import numpy as np
import onnxruntime
import pytest
import torch
from torch.nn import functional

from hwajilguji_tools.export import export_upscaler
from hwajilguji_tools.srvgg import SRVGGNetCompact


RESIDUAL_MIN_STD = 0.05


def randomized(num_conv: int) -> SRVGGNetCompact:
    generator = torch.Generator().manual_seed(num_conv)
    network = SRVGGNetCompact(num_conv=num_conv).eval()
    with torch.no_grad():
        for name, parameter in network.named_parameters():
            if parameter.ndim == 4:
                parameter.normal_(
                    0.0, math.sqrt(2.0 / parameter[0].numel()), generator=generator
                )
            elif name.endswith("bias"):
                parameter.normal_(0.0, 0.01, generator=generator)
            else:
                parameter.uniform_(0.0, 0.3, generator=generator)
    return network


@pytest.mark.parametrize("num_conv", [32, 16])
def test_exported_upscaler_keeps_dynamic_size_and_pixel_shuffle_order(
    num_conv: int, tmp_path: Path
) -> None:
    network = randomized(num_conv)
    path = tmp_path / "upscaler.onnx"
    export_upscaler(network, path)
    session = onnxruntime.InferenceSession(path, providers=["CPUExecutionProvider"])
    generator = torch.Generator().manual_seed(7)

    for height, width in ((64, 64), (96, 80)):
        image = torch.rand(1, 3, height, width, generator=generator)
        with torch.no_grad():
            expected = network(image)
        residual = expected - functional.interpolate(
            image, scale_factor=4, mode="nearest"
        )
        assert residual.std().item() > RESIDUAL_MIN_STD

        (actual,) = session.run(None, {"input": image.numpy()})

        assert actual.shape == (1, 3, height * 4, width * 4)
        assert np.abs(actual - expected.numpy()).max() < 1e-3
