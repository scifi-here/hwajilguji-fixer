from collections.abc import Mapping, Sequence
from os import PathLike

import numpy as np
from numpy.typing import NDArray

class NodeArg:
    @property
    def name(self) -> str: ...

class InferenceSession:
    def __init__(
        self,
        path_or_bytes: str | bytes | PathLike[str],
        providers: Sequence[str] | None = None,
    ) -> None: ...
    def run(
        self,
        output_names: Sequence[str] | None,
        input_feed: Mapping[str, NDArray[np.float32]],
    ) -> list[NDArray[np.float32]]: ...
    def get_inputs(self) -> Sequence[NodeArg]: ...
    def get_outputs(self) -> Sequence[NodeArg]: ...
    def get_providers(self) -> Sequence[str]: ...

def get_available_providers() -> list[str]: ...
