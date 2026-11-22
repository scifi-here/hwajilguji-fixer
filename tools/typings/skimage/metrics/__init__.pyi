from typing import Any

import numpy as np
from numpy.typing import NDArray

def structural_similarity(
    im1: NDArray[Any],
    im2: NDArray[Any],
    *,
    win_size: int | None = None,
    data_range: float | None = None,
    channel_axis: int | None = None,
    gaussian_weights: bool = False,
) -> np.float64: ...
