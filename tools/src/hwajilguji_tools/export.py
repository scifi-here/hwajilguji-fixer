import hashlib
import json
import shutil
import urllib.request
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

import onnx
import torch


from hwajilguji_tools.span import Span
from hwajilguji_tools.text_detector import export_detector
from hwajilguji_tools.srvgg import GraphicBackProjection, SRVGGNetCompact

type Role = Literal[
    "deblock",
    "upscalePhoto",
    "photo2x",
    "photo4x",
    "textDetector",
    "upscaleGraphic",
    "upscaleGraphicBackProjection",
]
type Entry = dict[str, str | int | list[int]]

LICENSES = Path(__file__).parent / "licenses"
REALESRGAN = "https://github.com/xinntao/Real-ESRGAN"
DEJPEG = "https://github.com/Miosp/dejpeg"
ELEMENT_TYPES = {
    int(onnx.TensorProto.FLOAT): "float32",
    int(onnx.TensorProto.FLOAT16): "float16",
}


@dataclass(frozen=True)
class Asset:
    url: str
    size: int
    sha256: str | None

    @property
    def name(self) -> str:
        return self.url.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class ShippedModel:
    role: Role
    file: str
    upstream: Asset
    license: str
    scale: int
    multiple_of: int
    num_conv: int | None


GRAPHIC = ShippedModel(
    "upscaleGraphic",
    "realesr-animevideov3.onnx",
    Asset(
        f"{REALESRGAN}/releases/download/v0.2.5.0/realesr-animevideov3.pth",
        2_504_012,
        None,
    ),
    "BSD-3-Clause",
    4,
    1,
    16,
)

SPAN_FILES = "https://objectstorage.us-phoenix-1.oraclecloud.com/n/ax6ygfvpvzka/b/open-modeldb-files/o"
ZOO = "https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/text_detection_ppocr"
SHIPPED = (
    ShippedModel(
        "photo2x",
        "span-x2.onnx",
        Asset(
            f"{SPAN_FILES}/2x-spanx2-ch48.pth",
            8942586,
            "0b20caeea7af5507ec3bdc63ff5a141a28506279d2cfec909c417ecb308d3f93",
        ),
        "Apache-2.0",
        2,
        1,
        None,
    ),
    ShippedModel(
        "photo4x",
        "span-x4.onnx",
        Asset(
            f"{SPAN_FILES}/4x-spanx4-ch48.pth",
            9004922,
            "c79e716b8eb24182c1d7fcc74fa10ae074bdb34fee7c6e67c73053ff5498c667",
        ),
        "Apache-2.0",
        4,
        1,
        None,
    ),
    ShippedModel(
        "textDetector",
        "ppocr-text-mask.onnx",
        Asset(
            f"{ZOO}/text_detection_cn_ppocrv3_2023may.onnx",
            2423490,
            "03f550c6b406fda8bf54bd8327815f6c7e2edd98cea02348c93d879254366587",
        ),
        "Apache-2.0",
        1,
        32,
        None,
    ),
    ShippedModel(
        "deblock",
        "dejpeg-v2.onnx",
        Asset(
            f"{DEJPEG}/releases/download/v2.0.0/dejpeg-v2.onnx",
            15_376_612,
            "cc345b6ce3a4b70856358911fed69ccebe939c1381aa94d969f15e2d81394690",
        ),
        "Apache-2.0",
        1,
        16,
        None,
    ),
    ShippedModel(
        "upscalePhoto",
        "realesr-general-x4v3.onnx",
        Asset(
            f"{REALESRGAN}/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
            4_885_111,
            None,
        ),
        "BSD-3-Clause",
        4,
        1,
        32,
    ),
    GRAPHIC,
    replace(
        GRAPHIC,
        role="upscaleGraphicBackProjection",
        file="realesr-animevideov3-backprojection.onnx",
    ),
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download(asset: Asset, cache: Path) -> Path:
    path = cache / asset.name
    if not path.exists() or path.stat().st_size != asset.size:
        cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(asset.url, timeout=120) as response:
            body: bytes = response.read()
        if len(body) != asset.size:
            raise RuntimeError(
                f"{asset.name}: {len(body)} bytes, expected {asset.size}"
            )
        partial = path.with_suffix(".part")
        partial.write_bytes(body)
        partial.replace(path)
    if asset.sha256 is not None and sha256(path) != asset.sha256:
        raise RuntimeError(
            f"{asset.name}: SHA-256 differs from the upstream release digest"
        )
    return path


def load_upscaler(weights: Path, num_conv: int) -> SRVGGNetCompact:
    checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
    params = (
        checkpoint["params"] if "params" in checkpoint else checkpoint["params_ema"]
    )
    network = SRVGGNetCompact(
        num_in_ch=3,
        num_out_ch=3,
        num_feat=64,
        num_conv=num_conv,
        upscale=4,
        act_type="prelu",
    )
    network.load_state_dict(params, strict=True)
    return network.eval()


def export_upscaler(network: torch.nn.Module, path: Path) -> None:
    program = torch.onnx.export(  # pyright: ignore[reportUnknownMemberType]
        network.eval(),
        (torch.rand(1, 3, 64, 64),),
        input_names=["input"],
        output_names=["output"],
        dynamo=True,
        dynamic_shapes={
            "x": {2: torch.export.Dim("height"), 3: torch.export.Dim("width")}
        },
        verbose=False,
    )
    if program is None:
        raise RuntimeError("ONNX export did not return a model")
    for node in program.model.graph.all_nodes():
        node.metadata_props.pop("pkg.torch.onnx.stack_trace", None)
    path.write_bytes(program.model_proto.SerializeToString())


def describe(path: Path, model: ShippedModel) -> Entry:
    proto = onnx.ModelProto.FromString(path.read_bytes())
    onnx.checker.check_model(proto, full_check=True)  # pyright: ignore[reportUnknownMemberType]
    first_input, first_output = proto.graph.input[0], proto.graph.output[0]
    element = first_input.type.tensor_type.elem_type
    channels = [dim.dim_value for dim in first_input.type.tensor_type.shape.dim][1]
    if (
        element not in ELEMENT_TYPES
        or first_output.type.tensor_type.elem_type != element
        or channels != 3
    ):
        raise RuntimeError(
            f"{model.file}: input is not a 3-channel float tensor matching the output"
        )
    return {
        "file": model.file,
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "inputName": first_input.name,
        "outputName": first_output.name,
        "elementType": ELEMENT_TYPES[element],
        "scale": model.scale,
        "multipleOf": model.multiple_of,
        "license": model.license,
        "source": model.upstream.url,
        "range": [0, 1],
        "layout": "NCHW-RGB",
    }


def notice(entries: dict[Role, Entry], upstream: dict[Role, str]) -> str:
    rows = [
        f"| `{entry['file']}` | {model.upstream.url} | {entry['license']} "
        f"| `{entry['sha256']}` | `{upstream[model.role]}` |"
        for model in SHIPPED
        for entry in (entries[model.role],)
    ]
    licenses = [
        f"## {name}\n\n```text\n{(LICENSES / f'{name}.txt').read_text().strip()}\n```\n"
        for name in ("Apache-2.0", "BSD-3-Clause")
    ]
    return "\n".join(
        [
            "# Third-party models\n",
            "SPAN (Hongyuan Yu et al.): https://github.com/hongyuanyu/SPAN. "
            "The export folds the 48-channel EMA convolutions from OpenModelDB.\n",
            "PP-OCRv3 (PaddleOCR / OpenCV Zoo): https://github.com/opencv/opencv_zoo/"
            "tree/main/models/text_detection_ppocr. "
            "RGB input and a three-channel probability map are added on export. "
            "Copyright (c) 2016 PaddlePaddle Authors. All Rights Reserved.\n",
            "| File | Source | License | SHA-256 | Upstream SHA-256 |",
            "|---|---|---|---|---|",
            *rows,
            "",
            "`realesr-*.onnx` are exported from the upstream `.pth` weights"
            " by `hwajilguji-tools export`.",
            "`realesr-animevideov3-backprojection.onnx` adds one back-projection step.",
            "`dejpeg-v2.onnx` ships as published.\n",
            *licenses,
        ]
    )


def export_models(models: Path, cache: Path) -> dict[Role, Entry]:
    models.mkdir(parents=True, exist_ok=True)
    entries: dict[Role, Entry] = {}
    upstream: dict[Role, str] = {}
    for model in SHIPPED:
        source = download(model.upstream, cache)
        upstream[model.role] = sha256(source)
        shipped = models / model.file
        if model.role in ("photo2x", "photo4x"):
            export_upscaler(Span(source, model.scale), shipped)
        elif model.role == "textDetector":
            export_detector(source, shipped)
        elif model.num_conv is None:
            shutil.copyfile(source, shipped)
        else:
            network = load_upscaler(source, model.num_conv)
            export_upscaler(
                GraphicBackProjection(network)
                if model.role == "upscaleGraphicBackProjection"
                else network,
                shipped,
            )
        entries[model.role] = describe(shipped, model)
    (models / "models.json").write_text(json.dumps(entries, indent=2) + "\n")
    (models / "NOTICE.md").write_text(notice(entries, upstream))
    return entries
