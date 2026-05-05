import pytest

from src.errors import LexerError, ParseError, SemanticError
from src.lexer.lexer import Lexer
from src.parser.parser import Parser
from src.semantic.type_checker import TypeChecker


def parse(source: str):
    tokens = Lexer(source, "<diag>").tokenize()
    return Parser(tokens, "<diag>").parse()


def check(source: str) -> TypeChecker:
    ast = parse(source)
    checker = TypeChecker()
    checker.check(ast)
    return checker


class TestRenderedDiagnostics:
    def test_lexer_error_renders_source_underline(self):
        source = "module test { I16 x = $; }"
        with pytest.raises(LexerError) as exc:
            Lexer(source, "<diag>").tokenize()

        text = str(exc.value)
        assert "error: unexpected character '$'" in text
        assert "--> <diag>:1:" in text
        assert "module test { I16 x = $; }" in text
        assert "^" in text

    def test_parser_error_explains_missing_semicolon(self):
        source = "module test {\n    I16 x = 42\n}\n"
        with pytest.raises(ParseError) as exc:
            parse(source)

        text = str(exc.value)
        assert "expected ';'" in text
        assert "help: statements and declarations must end with ';'" in text
        assert "3 | }" in text

    def test_undefined_identifier_suggests_nearest_name(self):
        source = """
        module test {
            I16 main() {
                I16 total = 1;
                ret totla;
            }
        }
        """
        with pytest.raises(SemanticError) as exc:
            check(source)

        text = str(exc.value)
        assert "undefined identifier 'totla'" in text
        assert "help: did you mean 'total'?" in text
        assert "ret totla;" in text
        assert "^^" in text

    def test_unknown_field_suggests_field_name(self):
        source = """
        module test {
            class Foo {
                I16 value;
                OnAlloc(I16 v) { value = v; }
            }
            I16 main() {
                Foo f = Init<Foo>(v: 1);
                ret f.valeu;
            }
        }
        """
        with pytest.raises(SemanticError) as exc:
            check(source)

        text = str(exc.value)
        assert "type 'Foo' has no field 'valeu'" in text
        assert "help: did you mean 'value'?" in text
        assert "ret f.valeu;" in text

    def test_wrong_function_arity_points_at_call(self):
        source = """
        module test {
            I16 add(I16 a, I16 b) { ret a + b; }
            I16 main() { ret add(1); }
        }
        """
        with pytest.raises(SemanticError) as exc:
            check(source)

        text = str(exc.value)
        assert "add expects 2 arguments, got 1" in text
        assert "help: adjust the argument list to match the declaration" in text
        assert "ret add(1);" in text

    def test_return_type_mismatch_points_at_return_value(self):
        source = """
        module test {
            I16 main() {
                ret null;
            }
        }
        """
        with pytest.raises(SemanticError) as exc:
            check(source)

        text = str(exc.value)
        assert "function 'main' returns I16, got Ptr<U0>" in text
        assert "ret null;" in text
        assert "^^^^" in text

    def test_void_function_returning_value_is_diagnostic(self):
        source = """
        module test {
            U0 main() {
                ret 1;
            }
        }
        """
        with pytest.raises(SemanticError) as exc:
            check(source)

        text = str(exc.value)
        assert "function 'main' returns U0 and must not return a value" in text
        assert "help: use 'ret;' or change the function return type" in text
