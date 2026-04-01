"""Data section layout: constant pool, vtable emission, global variables."""

from __future__ import annotations

from dataclasses import dataclass

from src.semantic.type_checker import TypeChecker
from src.semantic.types import FloatType, IntType, PtrType_, VelaType, I16, U16, U8, I8, F16


@dataclass
class DataEntry:
    label: str
    size: int  # bytes
    init_value: str  # assembly-format initializer


class MemoryLayout:
    """Builds the `space:` data section for the output .de1 file."""

    def __init__(self, checker: TypeChecker) -> None:
        self._tc = checker
        self._entries: list[DataEntry] = []
        self._constant_pool: dict[int, str] = {}  # value -> label
        self._string_pool: dict[str, str] = {}     # text -> label
        self._float_pool: dict[float, str] = {}    # value -> label
        self._uid = 0
        self._uses_heap_runtime = True
        self._uses_syscall_runtime = True

    def configure_runtime_usage(self, *, uses_heap: bool, uses_syscall: bool) -> None:
        self._uses_heap_runtime = uses_heap
        self._uses_syscall_runtime = uses_syscall

    def _next_uid(self) -> int:
        self._uid += 1
        return self._uid

    def build(self) -> list[str]:
        """Return assembly lines for the space: section."""
        self._emit_runtime_vars()
        self._emit_globals()
        self._emit_vtables()
        self._emit_string_literals()
        self._emit_constant_pool()
        self._emit_float_pool()
        return self._render()

    def get_constant_label(self, value: int) -> str:
        """Get or create a constant pool entry for values > 4095."""
        if value in self._constant_pool:
            return self._constant_pool[value]
        label = f"__const_{self._next_uid()}"
        self._constant_pool[value] = label
        return label

    def get_string_label(self, text: str) -> str:
        if text in self._string_pool:
            return self._string_pool[text]
        label = f"__str_{self._next_uid()}"
        self._string_pool[text] = label
        return label

    def get_float_label(self, value: float) -> str:
        if value in self._float_pool:
            return self._float_pool[value]
        label = f"__fp16_{self._next_uid()}"
        self._float_pool[value] = label
        return label

    def needs_constant_pool(self, value: int) -> bool:
        return value > 4095 or value < -4095

    def _emit_runtime_vars(self) -> None:
        """Emit runtime support variables."""
        if self._uses_heap_runtime:
            self._entries.append(DataEntry("__heap_start", 2, ": 2"))
            self._entries.append(DataEntry("__free_list_head", 2, ": 2"))
        if self._uses_syscall_runtime:
            self._entries.append(DataEntry("__syscall_param", 2, ": 2"))
            self._entries.append(DataEntry("__syscall_id", 2, ": 2"))

    def _emit_globals(self) -> None:
        for name, ty, init_expr in self._tc.globals:
            size = max(ty.size(), 1)
            if isinstance(ty, FloatType) and init_expr:
                from src.parser.ast_nodes import FloatLiteral
                if isinstance(init_expr, FloatLiteral):
                    self._entries.append(DataEntry(name, 2, f"= F{init_expr.value}"))
                    continue
            if size == 1:
                init_val = "00000000"
                if init_expr:
                    from src.parser.ast_nodes import IntLiteral
                    if isinstance(init_expr, IntLiteral):
                        init_val = format(init_expr.value & 0xFF, '08b')
                self._entries.append(DataEntry(name, 1, f"= {init_val}"))
            else:
                init_val = "0000000000000000"
                if init_expr:
                    from src.parser.ast_nodes import IntLiteral
                    if isinstance(init_expr, IntLiteral):
                        init_val = format(init_expr.value & 0xFFFF, '016b')
                self._entries.append(DataEntry(name, 2, f"= {init_val}"))

    def _emit_vtables(self) -> None:
        for cls_name, vt in self._tc.vtables.items():
            # Vtable: [class_size (2B)] [OnFree ptr (2B)] [method_0 ptr (2B)] ...
            total = 2 + 2 + len(vt.entries) * 2
            self._entries.append(DataEntry(f"__vtable_{cls_name}", total, f": {total}"))

    def _emit_string_literals(self) -> None:
        for text, label in self._string_pool.items():
            escaped = text.replace('"', '\\"')
            self._entries.append(DataEntry(label, len(text) + 1, f'= "{escaped}"'))

    def _emit_constant_pool(self) -> None:
        for value, label in self._constant_pool.items():
            # store as 16-bit binary
            bits = format(value & 0xFFFF, '016b')
            self._entries.append(DataEntry(label, 2, f"= {bits}"))

    def _emit_float_pool(self) -> None:
        for value, label in self._float_pool.items():
            self._entries.append(DataEntry(label, 2, f"= F{value}"))

    def _render(self) -> list[str]:
        lines = ["space:"]
        for entry in self._entries:
            lines.append(f"    {entry.label} {entry.init_value}")
        return lines
