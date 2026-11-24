# SRVGGNetCompact is copied from xinntao/Real-ESRGAN realesrgan/archs/srvgg_arch.py
# (https://github.com/xinntao/Real-ESRGAN), adapted with type annotations.
#
# BSD 3-Clause License
#
# Copyright (c) 2021, Xintao Wang
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice, this
#    list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# 3. Neither the name of the copyright holder nor the names of its
#    contributors may be used to endorse or promote products derived from
#    this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
# FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
# DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
# SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
# CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
# OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
# OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

from typing import Literal

from torch import Tensor, nn
from torch.nn import functional

type Activation = Literal["relu", "prelu", "leakyrelu"]


def activation(kind: Activation, num_feat: int) -> nn.Module:
    match kind:
        case "relu":
            return nn.ReLU(inplace=True)
        case "prelu":
            return nn.PReLU(num_parameters=num_feat)
        case "leakyrelu":
            return nn.LeakyReLU(negative_slope=0.1, inplace=True)


class SRVGGNetCompact(nn.Module):
    def __init__(
        self,
        num_in_ch: int = 3,
        num_out_ch: int = 3,
        num_feat: int = 64,
        num_conv: int = 16,
        upscale: int = 4,
        act_type: Activation = "prelu",
    ) -> None:
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList(
            [nn.Conv2d(num_in_ch, num_feat, 3, 1, 1), activation(act_type, num_feat)]
        )
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(activation(act_type, num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x: Tensor) -> Tensor:
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        base = functional.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


class GraphicBackProjection(nn.Module):
    def __init__(self, network: SRVGGNetCompact) -> None:
        super().__init__()
        self.network = network

    def forward(self, x: Tensor) -> Tensor:
        scale = self.network.upscale
        prediction = self.network(x).clamp(0, 1)
        residual = x - functional.avg_pool2d(prediction, scale, stride=scale)
        correction = functional.interpolate(
            residual, scale_factor=scale, mode="bilinear", align_corners=False
        )
        return prediction + correction
