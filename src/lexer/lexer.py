from __future__ import annotations

from src.errors import LexerError, SourceLocation, SourceSpan, register_source
from src.lexer.tokens import KEYWORDS, Token, TokenKind


class Lexer:
    """Tokenises a single Vela source file."""

    def __init__(self, source: str, filename: str = "<stdin>") -> None:
        self._src = source
        self._file = filename
        register_source(filename, source)
        self._pos = 0
        self._line = 1
        self._col = 1
        self._tokens: list[Token] = []

    def tokenize(self) -> list[Token]:
        """Return the full list of tokens (including final EOF)."""
        while not self._at_end():
            self._skip_whitespace_and_comments()
            if self._at_end():
                break
            self._scan_token()
        self._tokens.append(self._make(TokenKind.EOF, ""))
        return self._tokens

    def _loc(self) -> SourceLocation:
        return SourceLocation(self._file, self._line, self._col)

    def _at_end(self) -> bool:
        return self._pos >= len(self._src)

    def _peek(self, offset: int = 0) -> str:
        i = self._pos + offset
        return self._src[i] if i < len(self._src) else "\0"

    def _advance(self) -> str:
        ch = self._src[self._pos]
        self._pos += 1
        if ch == "\n":
            self._line += 1
            self._col = 1
        else:
            self._col += 1
        return ch

    def _match(self, expected: str) -> bool:
        if self._at_end() or self._src[self._pos] != expected:
            return False
        self._advance()
        return True

    def _make(self, kind: TokenKind, value: str, loc: SourceLocation | None = None) -> Token:
        loc = loc or self._loc()
        span = SourceSpan(
            file=loc.file,
            start_line=loc.line,
            start_column=loc.column,
            end_line=max(loc.line, self._line),
            end_column=max(1, self._col),
        ).normalized()
        return Token(kind, value, loc, span)

    def _skip_whitespace_and_comments(self) -> None:
        while not self._at_end():
            ch = self._peek()
            if ch in (" ", "\t", "\r", "\n"):
                self._advance()
            elif ch == "/" and self._peek(1) == "/":
                while not self._at_end() and self._peek() != "\n":
                    self._advance()
            elif ch == "#":
                while not self._at_end() and self._peek() != "\n":
                    self._advance()
            else:
                break

    def _scan_token(self) -> None:
        loc = self._loc()
        ch = self._peek()

        # two-char tokens first
        if ch == "[" and self._peek(1) == "[":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.TAG_OPEN, "[[", loc))
            return
        if ch == "]" and self._peek(1) == "]":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.TAG_CLOSE, "]]", loc))
            return
        if ch == "=" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.EQ, "==", loc))
            return
        if ch == "!" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.NEQ, "!=", loc))
            return
        if ch == "<" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.LTE, "<=", loc))
            return
        if ch == ">" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.GTE, ">=", loc))
            return
        if ch == "&" and self._peek(1) == "&":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.AND, "&&", loc))
            return
        if ch == "|" and self._peek(1) == "|":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.OR, "||", loc))
            return
        if ch == "+" and self._peek(1) == "+":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.PLUS_PLUS, "++", loc))
            return
        if ch == "-" and self._peek(1) == "-":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.MINUS_MINUS, "--", loc))
            return
        if ch == "+" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.PLUS_EQ, "+=", loc))
            return
        if ch == "-" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.MINUS_EQ, "-=", loc))
            return
        if ch == "*" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.STAR_EQ, "*=", loc))
            return
        if ch == "/" and self._peek(1) == "=":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.SLASH_EQ, "/=", loc))
            return
        if ch == "<" and self._peek(1) == "-":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.ARROW, "<-", loc))
            return
        if ch == ":" and self._peek(1) == ":":
            self._advance(); self._advance()
            self._tokens.append(self._make(TokenKind.DOUBLE_COLON, "::", loc))
            return

        # single-char tokens
        single: dict[str, TokenKind] = {
            "+": TokenKind.PLUS, "-": TokenKind.MINUS,
            "*": TokenKind.STAR, "/": TokenKind.SLASH,
            "%": TokenKind.PERCENT, "!": TokenKind.NOT,
            "&": TokenKind.AMPERSAND, "=": TokenKind.ASSIGN,
            "<": TokenKind.LT, ">": TokenKind.GT,
            "(": TokenKind.LPAREN, ")": TokenKind.RPAREN,
            "{": TokenKind.LBRACE, "}": TokenKind.RBRACE,
            "[": TokenKind.LBRACKET, "]": TokenKind.RBRACKET,
            ";": TokenKind.SEMICOLON, ",": TokenKind.COMMA,
            ":": TokenKind.COLON, ".": TokenKind.DOT,
        }
        if ch in single:
            self._advance()
            self._tokens.append(self._make(single[ch], ch, loc))
            return

        # String literal
        if ch == '"':
            self._scan_string(loc)
            return

        # Char literal
        if ch == "'":
            self._scan_char(loc)
            return

        # Number literal (int or float)
        if ch.isdigit():
            self._scan_number(loc)
            return

        # Hex literal 0x...
        if ch == "0" and self._peek(1) in ("x", "X"):
            self._scan_number(loc)
            return

        # Identifier or keyword
        if ch.isalpha() or ch == "_":
            self._scan_identifier(loc)
            return

        raise LexerError(f"unexpected character {ch!r}", loc, span=SourceSpan.from_location(loc))

    def _scan_string(self, loc: SourceLocation) -> None:
        self._advance()  # opening "
        buf: list[str] = []
        while not self._at_end() and self._peek() != '"':
            if self._peek() == "\\":
                self._advance()
                esc = self._advance()
                buf.append({"n": "\n", "t": "\t", "\\": "\\", '"': '"', "0": "\0"}.get(esc, esc))
            else:
                buf.append(self._advance())
        if self._at_end():
            raise LexerError(
                "unterminated string literal",
                loc,
                span=SourceSpan.from_location(loc),
                hint="close the string literal with a double quote",
            )
        self._advance()  # closing "
        self._tokens.append(self._make(TokenKind.STRING_LITERAL, "".join(buf), loc))

    def _scan_char(self, loc: SourceLocation) -> None:
        self._advance()  # opening '
        if self._peek() == "\\":
            self._advance()
            ch = self._advance()
            val = {"n": "\n", "t": "\t", "\\": "\\", "'": "'", "0": "\0"}.get(ch, ch)
        else:
            val = self._advance()
        if self._at_end() or self._peek() != "'":
            raise LexerError(
                "unterminated char literal",
                loc,
                span=SourceSpan.from_location(loc),
                hint="close the character literal with a single quote",
            )
        self._advance()  # closing '
        self._tokens.append(self._make(TokenKind.CHAR_LITERAL, val, loc))

    def _scan_number(self, loc: SourceLocation) -> None:
        start = self._pos
        # Hex
        if self._peek() == "0" and self._peek(1) in ("x", "X"):
            self._advance(); self._advance()
            while not self._at_end() and self._peek() in "0123456789abcdefABCDEF_":
                self._advance()
            self._tokens.append(self._make(TokenKind.INT_LITERAL, self._src[start:self._pos], loc))
            return
        # Binary 0b
        if self._peek() == "0" and self._peek(1) in ("b", "B"):
            self._advance(); self._advance()
            while not self._at_end() and self._peek() in "01_":
                self._advance()
            self._tokens.append(self._make(TokenKind.INT_LITERAL, self._src[start:self._pos], loc))
            return
        # Decimal / float
        while not self._at_end() and (self._peek().isdigit() or self._peek() == "_"):
            self._advance()
        is_float = False
        if not self._at_end() and self._peek() == "." and self._peek(1) != ".":
            is_float = True
            self._advance()
            while not self._at_end() and (self._peek().isdigit() or self._peek() == "_"):
                self._advance()
        # Exponent
        if not self._at_end() and self._peek() in ("e", "E"):
            is_float = True
            self._advance()
            if not self._at_end() and self._peek() in ("+", "-"):
                self._advance()
            while not self._at_end() and self._peek().isdigit():
                self._advance()
        text = self._src[start:self._pos]
        kind = TokenKind.FLOAT_LITERAL if is_float else TokenKind.INT_LITERAL
        self._tokens.append(self._make(kind, text, loc))

    def _scan_identifier(self, loc: SourceLocation) -> None:
        start = self._pos
        while not self._at_end() and (self._peek().isalnum() or self._peek() == "_"):
            self._advance()
        text = self._src[start:self._pos]
        kind = KEYWORDS.get(text, TokenKind.IDENTIFIER)
        self._tokens.append(self._make(kind, text, loc))
