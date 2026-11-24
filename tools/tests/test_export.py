import math
from pathlib import Path

import numpy as np
import onnxruntime
import pytest
import torch
from torch.nn import functional

from hwajilguji_tools.export import export_upscaler
from hwajilguji_tools.srvgg import GraphicBackProjection, SRVGGNetCompact


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
    assert b"pkg.torch.onnx.stack_trace" not in path.read_bytes()
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


def test_graphic_back_projection_corrects_a_constant_prediction_bias() -> None:
    network = SRVGGNetCompact(num_conv=1)
    with torch.no_grad():
        for parameter in network.parameters():
            parameter.zero_()
        last = network.body[-1]
        assert isinstance(last, torch.nn.Conv2d) and last.bias is not None
        last.bias.fill_(0.125)
    image = torch.full((1, 3, 3, 2), 0.25)
    prediction = GraphicBackProjection(network)(image)
    torch.testing.assert_close(prediction, torch.full((1, 3, 12, 8), 0.25))


def test_shipped_model_corrects_input_error_at_odd_tile_sizes() -> None:
    models = Path(__file__).resolve().parents[2] / "web" / "static" / "models"
    providers = ["CPUExecutionProvider"]
    original = onnxruntime.InferenceSession(
        models / "realesr-animevideov3.onnx", providers=providers
    )
    projected = onnxruntime.InferenceSession(
        models / "realesr-animevideov3-backprojection.onnx", providers=providers
    )
    generator = torch.Generator().manual_seed(19)
    for height, width in [(23, 31), (35, 17)]:
        image = torch.rand(1, 3, height, width, generator=generator)
        feeds = {"input": image.numpy()}
        (prediction,) = original.run(None, feeds)
        rgb = np.clip(prediction, 0, 1)
        reduced = rgb.reshape(1, 3, height, 4, width, 4).mean(axis=(3, 5))
        correction = functional.interpolate(
            image - torch.tensor(reduced),
            scale_factor=4,
            mode="bilinear",
            align_corners=False,
        )
        (actual,) = projected.run(None, feeds)
        np.testing.assert_allclose(actual, rgb + correction.numpy(), atol=1e-4)
