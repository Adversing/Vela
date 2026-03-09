from __future__ import annotations


class VirtualRegisterAllocator:
    """Dispenses unique virtual register names for IR generation."""

    def __init__(self) -> None:
        self._counter = 0

    def next(self) -> str:
        self._counter += 1
        return f"t{self._counter}"

    def reset(self) -> None:
        self._counter = 0

    @property
    def count(self) -> int:
        return self._counter
