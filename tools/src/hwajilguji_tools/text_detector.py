from pathlib import Path

import onnx
from onnx import TensorProto, helper


def export_detector(source: Path, path: Path) -> None:
    model = onnx.ModelProto.FromString(source.read_bytes())
    graph = model.graph
    raw_input = graph.input[0].name
    raw_output = graph.output[0].name
    graph.input[0].name = "rgb"
    constants = [
        helper.make_tensor("bgr_order", TensorProto.INT64, [3], [2, 1, 0]),
        helper.make_tensor(
            "mean", TensorProto.FLOAT, [1, 3, 1, 1], [0.485, 0.456, 0.406]
        ),
        helper.make_tensor(
            "std", TensorProto.FLOAT, [1, 3, 1, 1], [0.229, 0.224, 0.225]
        ),
        helper.make_tensor("batch_channel", TensorProto.INT64, [2], [0, 1]),
    ]
    graph.initializer.extend(constants)
    ops = [
        helper.make_node("Gather", ["rgb", "bgr_order"], ["bgr"], axis=1),
        helper.make_node("Sub", ["bgr", "mean"], ["centered"]),
        helper.make_node("Div", ["centered", "std"], [raw_input]),
    ]
    for op in reversed(ops):
        graph.node.insert(0, op)
    graph.node.extend(
        [
            helper.make_node(
                "Unsqueeze", [raw_output, "batch_channel"], ["probability"]
            ),
            helper.make_node("Concat", ["probability"] * 3, ["mask"], axis=1),
        ]
    )
    graph.output[0].CopyFrom(
        helper.make_tensor_value_info(
            "mask", TensorProto.FLOAT, [1, 3, "height", "width"]
        )
    )
    path.write_bytes(model.SerializeToString())
