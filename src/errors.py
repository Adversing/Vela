from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import NoReturn


class Severity(Enum):
    WARNING = auto()
    ERROR = auto()
    FATAL = auto()


@dataclass(frozen=True)
class SourceLocation:
    """Pinpoints a position in the source code."""
    file: str
    line: int
    column: int

    def __str__(self) -> str:
        return f"{self.file}:{self.line}:{self.column}"


@dataclass
class CompilerDiagnostic:
    severity: Severity
    message: str
    location: SourceLocation | None = None
    hint: str | None = None

    def __str__(self) -> str:
        prefix = self.severity.name.lower()
        loc = f" at {self.location}" if self.location else ""
        hint = f"\n  hint: {self.hint}" if self.hint else ""
        return f"{prefix}{loc}: {self.message}{hint}"


class VelaError(Exception):
    """Base class for all Vela compiler errors."""
    def __init__(self, message: str, location: SourceLocation | None = None) -> None:
        self.message = message
        self.location = location
        super().__init__(str(self))

    def __str__(self) -> str:
        loc = f" at {self.location}" if self.location else ""
        return f"error{loc}: {self.message}"


class LexerError(VelaError):
    """Raised during tokenization."""
    pass


class ParseError(VelaError):
    """Raised during parsing."""
    pass


class SemanticError(VelaError):
    """Raised during semantic analysis."""
    pass


class TypeError_(VelaError):
    """Raised for type mismatches (name avoids shadowing builtins)."""
    pass


class CodeGenError(VelaError):
    """Raised during code generation or register allocation."""
    pass


class ImportError_(VelaError):
    """Raised for import resolution failures."""
    pass


@dataclass
class DiagnosticCollector:
    """Accumulates diagnostics across compiler phases."""
    diagnostics: list[CompilerDiagnostic] = field(default_factory=list)

    def warn(self, message: str, location: SourceLocation | None = None, hint: str | None = None) -> None:
        self.diagnostics.append(CompilerDiagnostic(Severity.WARNING, message, location, hint))

    def error(self, message: str, location: SourceLocation | None = None, hint: str | None = None) -> None:
        self.diagnostics.append(CompilerDiagnostic(Severity.ERROR, message, location, hint))

    def fatal(self, message: str, location: SourceLocation | None = None) -> NoReturn:
        self.diagnostics.append(CompilerDiagnostic(Severity.FATAL, message, location))
        raise VelaError(message, location)

    @property
    def has_errors(self) -> bool:
        return any(d.severity in (Severity.ERROR, Severity.FATAL) for d in self.diagnostics)

    def dump(self) -> str:
        return "\n".join(str(d) for d in self.diagnostics)
