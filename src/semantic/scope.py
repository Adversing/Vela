from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from src.semantic.types import VelaType


@dataclass
class Symbol:
    name: str
    type: VelaType
    kind: str  # "var", "param", "func", "class", "type", "alias"
    scope_depth: int = 0
    # for variables: stack offset or global label
    offset: int | None = None
    is_global: bool = False
    # for functions
    params: list[VelaType] = field(default_factory=list)
    return_type: VelaType | None = None
    # for class methods
    class_name: str | None = None
    # visibility
    visible: bool = False


class Scope:
    """A single lexical scope containing symbol mappings."""

    def __init__(self, parent: Scope | None = None, name: str = "", depth: int = 0) -> None:
        self.parent = parent
        self.name = name
        self.depth = depth
        self._symbols: dict[str, Symbol] = {}

    def define(self, name: str, symbol: Symbol) -> None:
        symbol.scope_depth = self.depth
        self._symbols[name] = symbol

    def lookup_local(self, name: str) -> Symbol | None:
        return self._symbols.get(name)

    def lookup(self, name: str) -> Symbol | None:
        sym = self._symbols.get(name)
        if sym is not None:
            return sym
        if self.parent is not None:
            return self.parent.lookup(name)
        return None

    def all_symbols(self) -> dict[str, Symbol]:
        return dict(self._symbols)

    def visible_symbols(self) -> dict[str, Symbol]:
        symbols = self.parent.visible_symbols() if self.parent is not None else {}
        symbols.update(self._symbols)
        return symbols


class ScopeStack:
    """Manages a stack of nested scopes."""

    def __init__(self) -> None:
        self._global = Scope(name="global", depth=0)
        self._current = self._global

    @property
    def current(self) -> Scope:
        return self._current

    @property
    def global_scope(self) -> Scope:
        return self._global

    def push(self, name: str = "") -> Scope:
        child = Scope(parent=self._current, name=name, depth=self._current.depth + 1)
        self._current = child
        return child

    def pop(self) -> Scope:
        old = self._current
        if self._current.parent is not None:
            self._current = self._current.parent
        return old

    def define(self, name: str, symbol: Symbol) -> None:
        self._current.define(name, symbol)

    def lookup(self, name: str) -> Symbol | None:
        return self._current.lookup(name)

    def visible_names(self, *, kinds: set[str] | None = None) -> list[str]:
        symbols = self._current.visible_symbols()
        if kinds is None:
            return list(symbols)
        return [name for name, sym in symbols.items() if sym.kind in kinds]
