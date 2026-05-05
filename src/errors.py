from __future__ import annotations

from src.diagnostics import (
    CompilerDiagnostic,
    DiagnosticCollector,
    DiagnosticLabel,
    Severity,
    SourceLocation,
    SourceMap,
    SourceSpan,
    closest_name,
    default_source_map,
    did_you_mean,
    register_source,
)


class VelaError(Exception):
    """Base class for all Vela compiler errors."""

    def __init__(
        self,
        message: str,
        location: SourceLocation | None = None,
        *,
        span: SourceSpan | None = None,
        hint: str | None = None,
        code: str | None = None,
        labels: list[DiagnosticLabel] | None = None,
        notes: list[str] | None = None,
        suggestions: list[str] | None = None,
        diagnostic: CompilerDiagnostic | None = None,
        source_map: SourceMap | None = None,
    ) -> None:
        if diagnostic is None:
            diagnostic = CompilerDiagnostic(
                severity=Severity.ERROR,
                message=message,
                location=location,
                hint=hint,
                span=span,
                code=code,
                labels=list(labels or []),
                notes=list(notes or []),
                suggestions=list(suggestions or []),
            )
        self.diagnostic = diagnostic
        self.message = diagnostic.message
        self.location = location or (diagnostic.span.location if diagnostic.span else None)
        self.source_map = source_map
        super().__init__(self.__str__())

    def __str__(self) -> str:
        return self.diagnostic.render(self.source_map or default_source_map)


class LexerError(VelaError):
    """Raised during tokenization."""


class ParseError(VelaError):
    """Raised during parsing."""


class SemanticError(VelaError):
    """Raised during semantic analysis."""


class TypeError_(VelaError):
    """Raised for type mismatches (name avoids shadowing builtins)."""


class CodeGenError(VelaError):
    """Raised during code generation or register allocation."""


class ImportError_(VelaError):
    """Raised for import resolution failures."""


__all__ = [
    "CodeGenError",
    "CompilerDiagnostic",
    "DiagnosticCollector",
    "DiagnosticLabel",
    "ImportError_",
    "LexerError",
    "ParseError",
    "SemanticError",
    "Severity",
    "SourceLocation",
    "SourceMap",
    "SourceSpan",
    "TypeError_",
    "VelaError",
    "closest_name",
    "default_source_map",
    "did_you_mean",
    "register_source",
]
