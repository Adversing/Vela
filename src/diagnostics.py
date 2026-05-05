from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Iterable, NoReturn


class Severity(Enum):
    WARNING = auto()
    ERROR = auto()
    FATAL = auto()

    def label(self) -> str:
        return self.name.lower()


@dataclass(frozen=True)
class SourceLocation:
    """One-based source position."""

    file: str
    line: int
    column: int

    def to_span(self, width: int = 1) -> SourceSpan:
        return SourceSpan.from_location(self, width)

    def __str__(self) -> str:
        return f"{self.file}:{self.line}:{self.column}"


@dataclass(frozen=True)
class SourceSpan:
    """Half-open source range: [start, end). Lines and columns are one-based."""

    file: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int

    @classmethod
    def from_location(cls, location: SourceLocation, width: int = 1) -> SourceSpan:
        width = max(1, width)
        return cls(
            file=location.file,
            start_line=max(1, location.line),
            start_column=max(1, location.column),
            end_line=max(1, location.line),
            end_column=max(2, location.column + width),
        )

    @property
    def location(self) -> SourceLocation:
        return SourceLocation(self.file, self.start_line, self.start_column)

    def normalized(self) -> SourceSpan:
        start_line = max(1, self.start_line)
        start_column = max(1, self.start_column)
        end_line = max(start_line, self.end_line)
        end_column = max(1, self.end_column)
        if end_line == start_line and end_column <= start_column:
            end_column = start_column + 1
        return SourceSpan(self.file, start_line, start_column, end_line, end_column)

    def __str__(self) -> str:
        span = self.normalized()
        return f"{span.file}:{span.start_line}:{span.start_column}"


class SourceMap:
    """Source registry used by diagnostics renderers.

    Compiler phases can receive an explicit instance, but the default process
    registry is enough for the current single-process compiler and tests.
    """

    def __init__(self) -> None:
        self._sources: dict[str, list[str]] = {}

    def add(self, filename: str, source: str) -> None:
        self._sources[filename] = source.splitlines()

    def has_file(self, filename: str) -> bool:
        return filename in self._sources

    def get_line(self, filename: str, line: int) -> str | None:
        lines = self._sources.get(filename)
        if not lines or line < 1 or line > len(lines):
            return None
        return lines[line - 1]


default_source_map = SourceMap()


def register_source(filename: str, source: str) -> None:
    default_source_map.add(filename, source)


@dataclass(frozen=True)
class DiagnosticLabel:
    span: SourceSpan
    message: str | None = None
    primary: bool = True


@dataclass
class CompilerDiagnostic:
    severity: Severity
    message: str
    location: SourceLocation | None = None
    hint: str | None = None
    span: SourceSpan | None = None
    code: str | None = None
    labels: list[DiagnosticLabel] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.span is None and self.location is not None:
            self.span = SourceSpan.from_location(self.location)
        if not self.labels and self.span is not None:
            self.labels.append(DiagnosticLabel(self.span))

    def __str__(self) -> str:
        return self.render()

    def render(self, source_map: SourceMap | None = None) -> str:
        source_map = source_map or default_source_map
        head = self.severity.label()
        if self.code:
            head = f"{head}[{self.code}]"

        lines = [f"{head}: {self.message}"]
        primary = self._primary_label()
        if primary is not None:
            span = primary.span.normalized()
            lines.append(f" --> {span.file}:{span.start_line}:{span.start_column}")
            source_lines = self._render_source_block(span.file, source_map)
            if source_lines:
                lines.extend(source_lines)
            else:
                lines.append(f"  at {span}")

        for note in self.notes:
            lines.append(f"note: {note}")
        if self.hint:
            lines.append(f"help: {self.hint}")
        for suggestion in self.suggestions:
            lines.append(f"help: {suggestion}")
        return "\n".join(lines)

    def _primary_label(self) -> DiagnosticLabel | None:
        for label in self.labels:
            if label.primary:
                return label
        return self.labels[0] if self.labels else None

    def _render_source_block(self, filename: str, source_map: SourceMap) -> list[str]:
        labels = [label for label in self.labels if label.span.file == filename]
        if not labels:
            return []

        first = min(label.span.normalized().start_line for label in labels)
        last = max(label.span.normalized().end_line for label in labels)
        max_lines = 8
        if last - first + 1 > max_lines:
            last = first + max_lines - 1

        width = max(2, len(str(last)))
        rendered = [f"{'':>{width}} |"]
        for line_no in range(first, last + 1):
            text = source_map.get_line(filename, line_no)
            if text is None:
                return []
            rendered.append(f"{line_no:>{width}} | {text}")
            underline = self._underline_for_line(labels, line_no, len(text))
            if underline:
                rendered.append(f"{'':>{width}} | {underline}")
        return rendered

    def _underline_for_line(
        self,
        labels: list[DiagnosticLabel],
        line_no: int,
        line_len: int,
    ) -> str | None:
        parts: list[tuple[int, int, str, str | None]] = []
        for label in labels:
            span = label.span.normalized()
            if line_no < span.start_line or line_no > span.end_line:
                continue
            start = span.start_column if line_no == span.start_line else 1
            if line_no == span.end_line:
                end = span.end_column
            else:
                end = max(line_len + 1, start + 1)
            start = max(1, start)
            end = max(start + 1, end)
            marker = "^" if label.primary else "-"
            parts.append((start, end, marker, label.message))

        if not parts:
            return None

        start, end, marker, message = sorted(parts, key=lambda p: (p[0], p[1]))[0]
        width = max(1, end - start)
        text = " " * (start - 1) + marker * width
        if message:
            text += f" {message}"
        return text


@dataclass
class DiagnosticCollector:
    """Accumulates diagnostics across compiler phases."""

    diagnostics: list[CompilerDiagnostic] = field(default_factory=list)

    def warn(
        self,
        message: str,
        location: SourceLocation | None = None,
        hint: str | None = None,
    ) -> None:
        self.diagnostics.append(CompilerDiagnostic(Severity.WARNING, message, location, hint))

    def error(
        self,
        message: str,
        location: SourceLocation | None = None,
        hint: str | None = None,
    ) -> None:
        self.diagnostics.append(CompilerDiagnostic(Severity.ERROR, message, location, hint))

    def fatal(self, message: str, location: SourceLocation | None = None) -> NoReturn:
        self.diagnostics.append(CompilerDiagnostic(Severity.FATAL, message, location))
        raise RuntimeError(message)

    @property
    def has_errors(self) -> bool:
        return any(d.severity in (Severity.ERROR, Severity.FATAL) for d in self.diagnostics)

    def dump(self, source_map: SourceMap | None = None) -> str:
        return "\n".join(d.render(source_map) for d in self.diagnostics)


def levenshtein_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)

    prev = list(range(len(right) + 1))
    for i, lch in enumerate(left, start=1):
        cur = [i]
        for j, rch in enumerate(right, start=1):
            cost = 0 if lch == rch else 1
            cur.append(min(
                cur[j - 1] + 1,
                prev[j] + 1,
                prev[j - 1] + cost,
            ))
        prev = cur
    return prev[-1]


def closest_name(name: str, candidates: Iterable[str], max_distance: int | None = None) -> str | None:
    unique = sorted({c for c in candidates if c})
    if not unique:
        return None
    lowered = name.lower()
    threshold = max_distance if max_distance is not None else max(2, len(name) // 3)

    best: tuple[int, str] | None = None
    for candidate in unique:
        distance = levenshtein_distance(lowered, candidate.lower())
        if distance > threshold:
            continue
        item = (distance, candidate)
        if best is None or item < best:
            best = item
    return best[1] if best else None


def did_you_mean(name: str, candidates: Iterable[str]) -> str | None:
    match = closest_name(name, candidates)
    if match is None:
        return None
    return f"did you mean '{match}'?"

