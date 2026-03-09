from __future__ import annotations

from pathlib import Path

from src.lexer.lexer import Lexer
from src.parser.parser import Parser
from src.parser.ast_nodes import ModuleDecl, Program
from src.errors import VelaError


class ModuleResolver:
    """Resolves import pkg1::pkg2::{mod1, mod2} declarations.

    Resolution rule:
        import stdlib::types::{int} -> <project_root>/stdlib/types/int.vl
    Wildcard:
        import stdlib::types::{*} -> all .vl files in <project_root>/stdlib/types/
    """

    def __init__(self, project_root: Path) -> None:
        self.root = project_root
        self._cache: dict[tuple[tuple[str, ...], str], ModuleDecl] = {}
        self._resolving: set[tuple[tuple[str, ...], str]] = set()

    def _build_path(self, package: list[str], module_name: str) -> Path:
        base = self.root
        for seg in package:
            base = base / seg
        return base / f"{module_name}.vl"

    def _parse_file(self, vl_path: Path) -> ModuleDecl:
        source = vl_path.read_text(encoding="utf-8")
        lexer = Lexer(source, str(vl_path))
        tokens = lexer.tokenize()
        parser = Parser(tokens, str(vl_path))
        program: Program = parser.parse()
        if not program.modules:
            raise VelaError(
                f"imported file {vl_path} does not contain a module"
            )
        return program.modules[0]

    def resolve(self, package: list[str], module_name: str) -> ModuleDecl:
        """Return the parsed ``ModuleDecl`` for a specific module."""
        key = (tuple(package), module_name)

        if key in self._cache:
            return self._cache[key]

        if key in self._resolving:
            pkg_str = "::".join(package)
            raise VelaError(
                f"circular import detected: {pkg_str}::{module_name}"
            )

        self._resolving.add(key)

        vl_path = self._build_path(package, module_name)
        if not vl_path.exists():
            pkg_str = "::".join(package)
            raise VelaError(
                f"cannot resolve import {pkg_str}::{module_name}: "
                f"file not found: {vl_path}"
            )

        mod = self._parse_file(vl_path)
        self._cache[key] = mod
        self._resolving.discard(key)
        return mod

    def resolve_all(self, package: list[str]) -> list[ModuleDecl]:
        """Wildcard import: resolve every .vl file in the package directory."""
        base = self.root
        for seg in package:
            base = base / seg

        if not base.is_dir():
            pkg_str = "::".join(package)
            raise VelaError(
                f"cannot resolve wildcard import {pkg_str}::{{*}}: "
                f"directory not found: {base}"
            )

        modules: list[ModuleDecl] = []
        for vl_file in sorted(base.glob("*.vl")):
            mod = self.resolve(package, vl_file.stem)
            modules.append(mod)
        return modules
