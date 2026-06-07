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

    def __init__(self, project_root: Path, stdlib_root: Path | None = None) -> None:
        self.root = project_root
        self.stdlib_root = stdlib_root or Path(__file__).resolve().parents[2]
        self._cache: dict[tuple[tuple[str, ...], str], ModuleDecl] = {}
        self._resolving: set[tuple[tuple[str, ...], str]] = set()

    def _build_path(self, package: list[str], module_name: str, root: Path | None = None) -> Path:
        base = root or self.root
        for seg in package:
            base = base / seg
        return base / f"{module_name}.vl"

    def _candidate_roots(self, package: list[str]) -> list[Path]:
        roots = [self.root]
        if package and package[0] == "stdlib" and self.stdlib_root not in roots:
            roots.append(self.stdlib_root)
        return roots

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
        try:
            vl_path = next(
                (path for root in self._candidate_roots(package)
                 if (path := self._build_path(package, module_name, root)).exists()),
                None,
            )
            if vl_path is None:
                pkg_str = "::".join(package)
                searched = ", ".join(str(root) for root in self._candidate_roots(package))
                raise VelaError(
                    f"cannot resolve import {pkg_str}::{module_name}: "
                    f"file not found under: {searched}"
                )

            mod = self._parse_file(vl_path)
            self._cache[key] = mod
            return mod
        finally:
            self._resolving.discard(key)

    def resolve_all(self, package: list[str]) -> list[ModuleDecl]:
        """Wildcard import: resolve every .vl file in the package directory."""
        base = None
        for root in self._candidate_roots(package):
            candidate = root
            for seg in package:
                candidate = candidate / seg
            if candidate.is_dir():
                base = candidate
                break

        if base is None:
            pkg_str = "::".join(package)
            searched = ", ".join(str(root) for root in self._candidate_roots(package))
            raise VelaError(
                f"cannot resolve wildcard import {pkg_str}::{{*}}: "
                f"directory not found under: {searched}"
            )

        modules: list[ModuleDecl] = []
        for vl_file in sorted(base.glob("*.vl")):
            mod = self.resolve(package, vl_file.stem)
            modules.append(mod)
        return modules
