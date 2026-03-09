import pytest

from src.lexer.lexer import Lexer
from src.lexer.tokens import TokenKind, Token
from src.errors import LexerError


def tokenize(source: str) -> list[Token]:
    return Lexer(source, "<test>").tokenize()


def token_kinds(source: str) -> list[TokenKind]:
    return [t.kind for t in tokenize(source)]


def first_token(source: str) -> Token:
    """Return the first non-EOF token."""
    tokens = tokenize(source)
    assert len(tokens) >= 2, "expected at least one token + EOF"
    return tokens[0]


class TestKeywords:
    @pytest.mark.parametrize("text, expected_kind", [
        ("module",  TokenKind.KW_MODULE),
        ("class",   TokenKind.KW_CLASS),
        ("type",    TokenKind.KW_TYPE),
        ("skeleton", TokenKind.KW_SKELETON),
        ("alias",   TokenKind.KW_ALIAS),
        ("if",      TokenKind.KW_IF),
        ("else",    TokenKind.KW_ELSE),
        ("for",     TokenKind.KW_FOR),
        ("while",   TokenKind.KW_WHILE),
        ("ret",     TokenKind.KW_RET),
        ("import",  TokenKind.KW_IMPORT),
        ("ASM",     TokenKind.KW_ASM),
        ("OnAlloc", TokenKind.KW_ONALLOC),
        ("OnFree",  TokenKind.KW_ONFREE),
    ])
    def test_keyword_tokens(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind
        assert tok.value == text

    @pytest.mark.parametrize("text, expected_kind", [
        ("true",  TokenKind.BOOL_TRUE),
        ("false", TokenKind.BOOL_FALSE),
        ("null",  TokenKind.NULL_LITERAL),
    ])
    def test_literal_keywords(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind

    @pytest.mark.parametrize("text, expected_kind", [
        ("I16", TokenKind.TY_I16),
        ("U16", TokenKind.TY_U16),
        ("I8",  TokenKind.TY_I8),
        ("U8",  TokenKind.TY_U8),
        ("F16", TokenKind.TY_F16),
        ("U0",  TokenKind.TY_U0),
        ("Ptr", TokenKind.TY_PTR),
    ])
    def test_type_keywords(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind

    @pytest.mark.parametrize("text, expected_kind", [
        ("Malloc", TokenKind.BI_MALLOC),
        ("Free",   TokenKind.BI_FREE),
        ("Init",   TokenKind.BI_INIT),
        ("SizeOf", TokenKind.BI_SIZEOF),
        ("Print",  TokenKind.BI_PRINT),
    ])
    def test_builtin_keywords(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind


class TestOperators:
    @pytest.mark.parametrize("text, expected_kind", [
        ("+",  TokenKind.PLUS),
        ("-",  TokenKind.MINUS),
        ("*",  TokenKind.STAR),
        ("/",  TokenKind.SLASH),
        ("%",  TokenKind.PERCENT),
        ("!",  TokenKind.NOT),
        ("&",  TokenKind.AMPERSAND),
    ])
    def test_single_char_operators(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind
        assert tok.value == text

    @pytest.mark.parametrize("text, expected_kind", [
        ("==", TokenKind.EQ),
        ("!=", TokenKind.NEQ),
        ("<=", TokenKind.LTE),
        (">=", TokenKind.GTE),
        ("&&", TokenKind.AND),
        ("||", TokenKind.OR),
        ("++", TokenKind.PLUS_PLUS),
        ("--", TokenKind.MINUS_MINUS),
        ("+=", TokenKind.PLUS_EQ),
        ("-=", TokenKind.MINUS_EQ),
        ("*=", TokenKind.STAR_EQ),
        ("/=", TokenKind.SLASH_EQ),
        ("<-", TokenKind.ARROW),
    ])
    def test_two_char_operators(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind
        assert tok.value == text

    @pytest.mark.parametrize("text, expected_kind", [
        ("=", TokenKind.ASSIGN),
        ("<", TokenKind.LT),
        (">", TokenKind.GT),
    ])
    def test_comparison_and_assign(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind


class TestPunctuation:
    @pytest.mark.parametrize("text, expected_kind", [
        ("(",  TokenKind.LPAREN),
        (")",  TokenKind.RPAREN),
        ("{",  TokenKind.LBRACE),
        ("}",  TokenKind.RBRACE),
        ("[",  TokenKind.LBRACKET),
        ("]",  TokenKind.RBRACKET),
        (";",  TokenKind.SEMICOLON),
        (",",  TokenKind.COMMA),
        (":",  TokenKind.COLON),
        (".",  TokenKind.DOT),
    ])
    def test_single_punctuation(self, text, expected_kind):
        tok = first_token(text)
        assert tok.kind == expected_kind
        assert tok.value == text

    def test_double_colon(self):
        tok = first_token("::")
        assert tok.kind == TokenKind.DOUBLE_COLON
        assert tok.value == "::"


class TestTags:
    def test_tag_open_close(self):
        tokens = tokenize("[[ ]]")
        kinds = [t.kind for t in tokens]
        assert kinds[0] == TokenKind.TAG_OPEN
        assert kinds[1] == TokenKind.TAG_CLOSE

    def test_tag_with_identifiers(self):
        tokens = tokenize("[[get, set, visible]]")
        assert tokens[0].kind == TokenKind.TAG_OPEN
        assert tokens[1].kind == TokenKind.IDENTIFIER
        assert tokens[1].value == "get"
        assert tokens[2].kind == TokenKind.COMMA
        assert tokens[3].kind == TokenKind.IDENTIFIER
        assert tokens[3].value == "set"
        assert tokens[5].kind == TokenKind.IDENTIFIER
        assert tokens[5].value == "visible"
        assert tokens[6].kind == TokenKind.TAG_CLOSE


class TestIntLiterals:
    def test_decimal(self):
        tok = first_token("42")
        assert tok.kind == TokenKind.INT_LITERAL
        assert tok.value == "42"

    def test_zero(self):
        tok = first_token("0")
        assert tok.kind == TokenKind.INT_LITERAL
        assert tok.value == "0"

    def test_hex(self):
        tok = first_token("0xFF")
        assert tok.kind == TokenKind.INT_LITERAL
        assert tok.value == "0xFF"

    def test_hex_uppercase(self):
        tok = first_token("0XAB")
        assert tok.kind == TokenKind.INT_LITERAL
        assert tok.value == "0XAB"

    def test_binary(self):
        tok = first_token("0b1010")
        assert tok.kind == TokenKind.INT_LITERAL
        assert tok.value == "0b1010"

    def test_underscore_separator(self):
        tok = first_token("1_000")
        assert tok.kind == TokenKind.INT_LITERAL
        assert tok.value == "1_000"


class TestFloatLiterals:
    def test_simple_float(self):
        tok = first_token("3.14")
        assert tok.kind == TokenKind.FLOAT_LITERAL
        assert tok.value == "3.14"

    def test_exponent(self):
        tok = first_token("1e10")
        assert tok.kind == TokenKind.FLOAT_LITERAL

    def test_negative_exponent(self):
        tok = first_token("2.5e-3")
        assert tok.kind == TokenKind.FLOAT_LITERAL


class TestStringLiterals:
    def test_simple_string(self):
        tok = first_token('"hello"')
        assert tok.kind == TokenKind.STRING_LITERAL
        assert tok.value == "hello"

    def test_empty_string(self):
        tok = first_token('""')
        assert tok.kind == TokenKind.STRING_LITERAL
        assert tok.value == ""

    def test_escape_sequences(self):
        tok = first_token(r'"hello\nworld"')
        assert tok.kind == TokenKind.STRING_LITERAL
        assert tok.value == "hello\nworld"

    def test_escaped_quote(self):
        tok = first_token(r'"say \"hi\""')
        assert tok.kind == TokenKind.STRING_LITERAL
        assert tok.value == 'say "hi"'

    def test_unterminated_string_raises(self):
        with pytest.raises(LexerError):
            tokenize('"unterminated')


class TestCharLiterals:
    def test_simple_char(self):
        tok = first_token("'a'")
        assert tok.kind == TokenKind.CHAR_LITERAL
        assert tok.value == "a"

    def test_escape_newline(self):
        tok = first_token(r"'\n'")
        assert tok.kind == TokenKind.CHAR_LITERAL
        assert tok.value == "\n"

    def test_unterminated_char_raises(self):
        with pytest.raises(LexerError):
            tokenize("'a")


class TestBoolLiterals:
    def test_true(self):
        tok = first_token("true")
        assert tok.kind == TokenKind.BOOL_TRUE
        assert tok.value == "true"

    def test_false(self):
        tok = first_token("false")
        assert tok.kind == TokenKind.BOOL_FALSE
        assert tok.value == "false"


class TestNullLiteral:
    def test_null(self):
        tok = first_token("null")
        assert tok.kind == TokenKind.NULL_LITERAL
        assert tok.value == "null"


class TestIdentifiers:
    def test_simple_identifier(self):
        tok = first_token("myVar")
        assert tok.kind == TokenKind.IDENTIFIER
        assert tok.value == "myVar"

    def test_underscore_identifier(self):
        tok = first_token("_private")
        assert tok.kind == TokenKind.IDENTIFIER
        assert tok.value == "_private"

    def test_alphanumeric_identifier(self):
        tok = first_token("count2")
        assert tok.kind == TokenKind.IDENTIFIER
        assert tok.value == "count2"

    def test_identifier_not_keyword(self):
        tok = first_token("module_name")
        assert tok.kind == TokenKind.IDENTIFIER
        assert tok.value == "module_name"


class TestComments:
    def test_hash_comment_skipped(self):
        tokens = tokenize("# this is a comment\n42")
        assert tokens[0].kind == TokenKind.INT_LITERAL
        assert tokens[0].value == "42"

    def test_double_slash_comment_skipped(self):
        tokens = tokenize("// this is a comment\n42")
        assert tokens[0].kind == TokenKind.INT_LITERAL
        assert tokens[0].value == "42"

    def test_comment_only_produces_eof(self):
        tokens = tokenize("# just a comment")
        assert len(tokens) == 1
        assert tokens[0].kind == TokenKind.EOF

    def test_inline_comment(self):
        tokens = tokenize("42 # inline comment")
        assert tokens[0].kind == TokenKind.INT_LITERAL
        assert tokens[1].kind == TokenKind.EOF


class TestMultiLine:
    def test_multiline_tokenization(self):
        source = "I16 x = 42;\nI16 y = 10;"
        tokens = tokenize(source)
        kinds = [t.kind for t in tokens if t.kind != TokenKind.EOF]
        assert kinds == [
            TokenKind.TY_I16, TokenKind.IDENTIFIER, TokenKind.ASSIGN, TokenKind.INT_LITERAL, TokenKind.SEMICOLON,
            TokenKind.TY_I16, TokenKind.IDENTIFIER, TokenKind.ASSIGN, TokenKind.INT_LITERAL, TokenKind.SEMICOLON,
        ]

    def test_function_signature(self):
        source = "I16 add(I16 a, I16 b)"
        tokens = tokenize(source)
        kinds = [t.kind for t in tokens if t.kind != TokenKind.EOF]
        assert kinds == [
            TokenKind.TY_I16, TokenKind.IDENTIFIER, TokenKind.LPAREN,
            TokenKind.TY_I16, TokenKind.IDENTIFIER, TokenKind.COMMA,
            TokenKind.TY_I16, TokenKind.IDENTIFIER, TokenKind.RPAREN,
        ]

    def test_source_locations_tracked(self):
        source = "I16\nx"
        tokens = tokenize(source)
        assert tokens[0].location.line == 1
        assert tokens[1].location.line == 2

    def test_column_tracking(self):
        source = "I16 x"
        tokens = tokenize(source)
        assert tokens[0].location.column == 1
        assert tokens[1].location.column == 5

    def test_eof_always_last(self):
        tokens = tokenize("")
        assert len(tokens) == 1
        assert tokens[0].kind == TokenKind.EOF

    def test_whitespace_only(self):
        tokens = tokenize("   \t\n  ")
        assert len(tokens) == 1
        assert tokens[0].kind == TokenKind.EOF


class TestLexerErrors:
    def test_unexpected_character(self):
        with pytest.raises(LexerError):
            tokenize("$")

    def test_unexpected_at_sign(self):
        with pytest.raises(LexerError):
            tokenize("@")

    def test_error_includes_location(self):
        with pytest.raises(LexerError) as exc_info:
            tokenize("$")
        assert exc_info.value.location is not None
        assert exc_info.value.location.line == 1
