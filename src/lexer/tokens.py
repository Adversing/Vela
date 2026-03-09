from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto

from src.errors import SourceLocation


class TokenKind(Enum):
    # literals
    INT_LITERAL = auto()
    FLOAT_LITERAL = auto()
    STRING_LITERAL = auto()
    CHAR_LITERAL = auto()
    BOOL_TRUE = auto()
    BOOL_FALSE = auto()
    NULL_LITERAL = auto()

    # keywords
    KW_CLASS = auto()
    KW_TYPE = auto()
    KW_SKELETON = auto()
    KW_ALIAS = auto()
    KW_IF = auto()
    KW_ELSE = auto()
    KW_FOR = auto()
    KW_WHILE = auto()
    KW_RET = auto()
    KW_IMPORT = auto()
    KW_MODULE = auto()
    KW_ASM = auto()
    KW_ONALLOC = auto()
    KW_ONFREE = auto()

    # primitive types
    TY_U0 = auto()
    TY_U8 = auto()
    TY_I8 = auto()
    TY_U16 = auto()
    TY_I16 = auto()
    TY_F16 = auto()
    TY_PTR = auto()

    # built-in functions
    BI_MALLOC = auto()
    BI_FREE = auto()
    BI_INIT = auto()
    BI_SIZEOF = auto()
    BI_PRINT = auto()

    # identifiers
    IDENTIFIER = auto()

    # operators
    PLUS = auto()          # +
    MINUS = auto()         # -
    STAR = auto()          # *
    SLASH = auto()         # /
    PERCENT = auto()       # %
    EQ = auto()            # ==
    NEQ = auto()           # !=
    LT = auto()            # <
    GT = auto()            # >
    LTE = auto()           # <=
    GTE = auto()           # >=
    AND = auto()           # &&
    OR = auto()            # ||
    NOT = auto()           # !
    AMPERSAND = auto()     # &
    ASSIGN = auto()        # =
    PLUS_PLUS = auto()     # ++
    MINUS_MINUS = auto()   # --
    PLUS_EQ = auto()       # +=
    MINUS_EQ = auto()      # -=
    STAR_EQ = auto()       # *=
    SLASH_EQ = auto()      # /=
    ARROW = auto()         # <-

    # punctuation
    LPAREN = auto()        # (
    RPAREN = auto()        # )
    LBRACE = auto()        # {
    RBRACE = auto()        # }
    LBRACKET = auto()      # [
    RBRACKET = auto()      # ]
    SEMICOLON = auto()     # ;
    COMMA = auto()         # ,
    COLON = auto()         # :
    DOT = auto()           # .
    DOUBLE_COLON = auto()  # ::

    # tags
    TAG_OPEN = auto()      # [[
    TAG_CLOSE = auto()     # ]]

    # special
    EOF = auto()
    NEWLINE = auto()


KEYWORDS: dict[str, TokenKind] = {
    "class": TokenKind.KW_CLASS,
    "type": TokenKind.KW_TYPE,
    "skeleton": TokenKind.KW_SKELETON,
    "alias": TokenKind.KW_ALIAS,
    "if": TokenKind.KW_IF,
    "else": TokenKind.KW_ELSE,
    "for": TokenKind.KW_FOR,
    "while": TokenKind.KW_WHILE,
    "ret": TokenKind.KW_RET,
    "import": TokenKind.KW_IMPORT,
    "module": TokenKind.KW_MODULE,
    "ASM": TokenKind.KW_ASM,
    "OnAlloc": TokenKind.KW_ONALLOC,
    "OnFree": TokenKind.KW_ONFREE,
    "true": TokenKind.BOOL_TRUE,
    "false": TokenKind.BOOL_FALSE,
    "null": TokenKind.NULL_LITERAL,
    "U0": TokenKind.TY_U0,
    "U8": TokenKind.TY_U8,
    "I8": TokenKind.TY_I8,
    "U16": TokenKind.TY_U16,
    "I16": TokenKind.TY_I16,
    "F16": TokenKind.TY_F16,
    "Ptr": TokenKind.TY_PTR,
    "Malloc": TokenKind.BI_MALLOC,
    "Free": TokenKind.BI_FREE,
    "Init": TokenKind.BI_INIT,
    "SizeOf": TokenKind.BI_SIZEOF,
    "Print": TokenKind.BI_PRINT,
}


@dataclass(frozen=True)
class Token:
    kind: TokenKind
    value: str
    location: SourceLocation

    def __repr__(self) -> str:
        return f"Token({self.kind.name}, {self.value!r}, {self.location})"
