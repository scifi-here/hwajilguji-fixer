from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

type Weights = dict[str, torch.Tensor]


def convolution(weight: torch.Tensor, bias: torch.Tensor) -> nn.Conv2d:
    out_channels, in_channels, height, width = weight.shape
    layer = nn.Conv2d(in_channels, out_channels, (height, width), padding=height // 2)
    with torch.no_grad():
        layer.weight.copy_(weight)
        assert layer.bias is not None
        layer.bias.copy_(bias)
    return layer


def fold_convolution(weights: Weights, name: str) -> nn.Conv2d:
    kernel = weights[f"{name}.conv.0.weight"]
    bias = weights[f"{name}.conv.0.bias"]
    for layer, padding in ((1, 2), (2, 0)):
        weight = weights[f"{name}.conv.{layer}.weight"]
        reversed_kernel = kernel.flip((2, 3)).transpose(0, 1)
        kernel = F.conv2d(reversed_kernel, weight, padding=padding)
        kernel = kernel.flip((2, 3)).transpose(0, 1)
        bias = (weight * bias.view(1, -1, 1, 1)).sum((1, 2, 3))
        bias = bias + weights[f"{name}.conv.{layer}.bias"]
    skip = F.pad(weights[f"{name}.sk.weight"], (1, 1, 1, 1))
    return convolution(kernel + skip, bias + weights[f"{name}.sk.bias"])


class AttentionBlock(nn.Module):
    def __init__(self, weights: Weights, name: str) -> None:
        super().__init__()
        self.first = fold_convolution(weights, f"{name}.c1_r")
        self.middle = fold_convolution(weights, f"{name}.c2_r")
        self.last = fold_convolution(weights, f"{name}.c3_r")

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        first = F.silu(self.first(x))
        last = self.last(F.silu(self.middle(first)))
        return (last + x) * (torch.sigmoid(last) - 0.5), first


class Span(nn.Module):
    def __init__(self, path: Path, scale: int) -> None:
        super().__init__()
        weights: Weights = torch.load(path, map_location="cpu", weights_only=True)
        self.input = fold_convolution(weights, "conv_1")
        self.blocks = nn.ModuleList(
            AttentionBlock(weights, f"block_{i}") for i in range(1, 7)
        )
        self.output = fold_convolution(weights, "conv_2")
        self.collect = convolution(weights["conv_cat.weight"], weights["conv_cat.bias"])
        self.expand = convolution(
            weights["upsampler.0.weight"], weights["upsampler.0.bias"]
        )
        self.scale = scale
        self.mean = torch.tensor([0.4488, 0.4371, 0.4040]).reshape(1, 3, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        stem = self.input((x - self.mean) * 255)
        first, _ = self.blocks[0](stem)
        current = first
        for block in self.blocks[1:-1]:
            current, _ = block(current)
        last, detail = self.blocks[-1](current)
        features = self.collect(torch.cat((stem, self.output(last), first, detail), 1))
        return F.pixel_shuffle(self.expand(features), self.scale)
