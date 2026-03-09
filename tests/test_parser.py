import pytest

from src.lexer.lexer import Lexer
from src.lexer.tokens import TokenKind
from src.parser.parser import Parser
from src.parser.ast_nodes import (
    Program, ModuleDecl, ImportDecl, FunctionDecl, VarDecl, ClassDecl,
    TypeDecl, AliasDecl, ParamDecl,
    ReturnStmt, IfStmt, ForStmt, WhileStmt, Assignment, ExprStmt,
    FreeStmt, PrintStmt,
    IntLiteral, FloatLiteral, StringLiteral, BoolLiteral, NullLiteral,
    IdentifierExpr, BinaryExpr, UnaryExpr, CallExpr, MethodCallExpr,
    FieldAccessExpr, InitExpr, MallocExpr, SizeOfExpr,
    NamedType, PtrType,
)
from src.errors import ParseError, LexerError

def parse(source: str) -> Program:
    tokens = Lexer(source, "<test>").tokenize()
    return Parser(tokens, "<test>").parse()


def parse_module_body(source: str):
    """Parse source wrapped in a module and return the body nodes."""
    prog = parse(f"module test {{ {source} }}")
    assert len(prog.modules) == 1
    return prog.modules[0].body


def parse_single_decl(source: str):
    """Parse source wrapped in a module, expect exactly one body node."""
    body = parse_module_body(source)
    assert len(body) == 1
    return body[0]


def parse_func_body(source: str):
    """Parse a function inside a module and return its body statements."""
    fn = parse_single_decl(source)
    assert isinstance(fn, FunctionDecl)
    return fn.body


class TestModuleParsing:
    def test_empty_module(self):
        prog = parse("module test {}")
        assert len(prog.modules) == 1
        assert prog.modules[0].name == "test"
        assert prog.modules[0].body == []

    def test_module_name(self):
        prog = parse("module myModule {}")
        assert prog.modules[0].name == "myModule"

    def test_multiple_modules(self):
        prog = parse("module a {} module b {}")
        assert len(prog.modules) == 2
        assert prog.modules[0].name == "a"
        assert prog.modules[1].name == "b"


class TestImportParsing:
    def test_single_import(self):
        prog = parse("module test { import pkg::{mod1}; }")
        mod = prog.modules[0]
        assert len(mod.imports) == 1
        assert mod.imports[0].package == ["pkg"]
        assert mod.imports[0].modules == ["mod1"]

    def test_multi_import(self):
        prog = parse("module test { import std::{io, math}; }")
        imp = prog.modules[0].imports[0]
        assert imp.package == ["std"]
        assert imp.modules == ["io", "math"]

    def test_nested_import(self):
        prog = parse("module test { import stdlib::types::{int, bool}; }")
        imp = prog.modules[0].imports[0]
        assert imp.package == ["stdlib", "types"]
        assert imp.modules == ["int", "bool"]

    def test_wildcard_import(self):
        prog = parse("module test { import stdlib::types::{*}; }")
        imp = prog.modules[0].imports[0]
        assert imp.package == ["stdlib", "types"]
        assert imp.modules == ["*"]


class TestVarDecl:
    def test_simple_var(self):
        node = parse_single_decl("I16 x = 42;")
        assert isinstance(node, VarDecl)
        assert node.name == "x"
        assert isinstance(node.type_expr, NamedType)
        assert node.type_expr.name == "I16"
        assert isinstance(node.initializer, IntLiteral)
        assert node.initializer.value == 42

    def test_var_without_init(self):
        node = parse_single_decl("U8 flag;")
        assert isinstance(node, VarDecl)
        assert node.name == "flag"
        assert node.initializer is None

    def test_var_with_float(self):
        node = parse_single_decl("F16 pi = 3.14;")
        assert isinstance(node, VarDecl)
        assert isinstance(node.initializer, FloatLiteral)
        assert abs(node.initializer.value - 3.14) < 0.001

    def test_tagged_var(self):
        body = parse_module_body("[[get, set]] I16 x;")
        # Tags at top level produce a VarDecl with tags
        node = body[0]
        assert isinstance(node, VarDecl)
        assert "get" in node.tags
        assert "set" in node.tags


class TestFunctionDecl:
    def test_simple_function(self):
        fn = parse_single_decl("I16 add(I16 a, I16 b) { ret a + b; }")
        assert isinstance(fn, FunctionDecl)
        assert fn.name == "add"
        assert isinstance(fn.return_type, NamedType)
        assert fn.return_type.name == "I16"
        assert len(fn.params) == 2
        assert fn.params[0].name == "a"
        assert fn.params[1].name == "b"

    def test_void_function(self):
        fn = parse_single_decl("U0 doNothing() { ret; }")
        assert isinstance(fn, FunctionDecl)
        assert fn.name == "doNothing"
        assert isinstance(fn.return_type, NamedType)
        assert fn.return_type.name == "U0"

    def test_no_params(self):
        fn = parse_single_decl("I16 getValue() { ret 42; }")
        assert isinstance(fn, FunctionDecl)
        assert fn.params == []

    def test_function_body_has_return(self):
        fn = parse_single_decl("I16 f() { ret 1; }")
        assert len(fn.body) == 1
        assert isinstance(fn.body[0], ReturnStmt)
        assert isinstance(fn.body[0].value, IntLiteral)


class TestClassDecl:
    def test_simple_class(self):
        cls = parse_single_decl("""
            class Foo {
                I16 x;
                I16 y;
            }
        """)
        assert isinstance(cls, ClassDecl)
        assert cls.name == "Foo"
        assert len(cls.fields) == 2
        assert cls.fields[0].name == "x"
        assert cls.fields[1].name == "y"

    def test_class_with_method(self):
        cls = parse_single_decl("""
            class Bar {
                I16 val;
                I16 getVal() { ret val; }
            }
        """)
        assert isinstance(cls, ClassDecl)
        assert len(cls.methods) == 1
        assert cls.methods[0].name == "getVal"

    def test_class_with_on_alloc(self):
        cls = parse_single_decl("""
            class Baz {
                I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        assert isinstance(cls, ClassDecl)
        assert cls.on_alloc is not None
        assert cls.on_alloc.name == "OnAlloc"
        assert len(cls.on_alloc.params) == 1
        assert cls.on_alloc.params[0].name == "v"

    def test_class_with_on_free(self):
        cls = parse_single_decl("""
            class Baz {
                I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        assert cls.on_free is not None
        assert cls.on_free.name == "OnFree"

    def test_class_inheritance(self):
        cls = parse_single_decl("""
            class Child : Parent {
                I16 extra;
            }
        """)
        assert cls.parent == "Parent"

    def test_class_with_ptr_field(self):
        cls = parse_single_decl("""
            class Node {
                I16 value;
                Ptr<Node> next;
            }
        """)
        assert len(cls.fields) == 2
        assert isinstance(cls.fields[1].type_expr, PtrType)


class TestExpressions:
    def test_binary_addition(self):
        stmts = parse_func_body("I16 f() { ret 1 + 2; }")
        ret = stmts[0]
        assert isinstance(ret, ReturnStmt)
        assert isinstance(ret.value, BinaryExpr)
        assert ret.value.op == "+"

    def test_binary_subtraction(self):
        stmts = parse_func_body("I16 f() { ret 10 - 3; }")
        expr = stmts[0].value
        assert isinstance(expr, BinaryExpr)
        assert expr.op == "-"

    def test_binary_multiplication(self):
        stmts = parse_func_body("I16 f() { ret 4 * 5; }")
        expr = stmts[0].value
        assert isinstance(expr, BinaryExpr)
        assert expr.op == "*"

    def test_operator_precedence_mul_over_add(self):
        stmts = parse_func_body("I16 f() { ret 1 + 2 * 3; }")
        expr = stmts[0].value
        assert isinstance(expr, BinaryExpr)
        assert expr.op == "+"
        assert isinstance(expr.right, BinaryExpr)
        assert expr.right.op == "*"

    def test_comparison_operators(self):
        for op in ["==", "!=", "<", ">", "<=", ">="]:
            stmts = parse_func_body(f"I16 f() {{ ret 1 {op} 2; }}")
            expr = stmts[0].value
            assert isinstance(expr, BinaryExpr)
            assert expr.op == op

    def test_logical_and_or(self):
        stmts = parse_func_body("I16 f() { ret true && false || true; }")
        expr = stmts[0].value
        # || has lower precedence than &&
        assert isinstance(expr, BinaryExpr)
        assert expr.op == "||"
        assert isinstance(expr.left, BinaryExpr)
        assert expr.left.op == "&&"

    def test_unary_negation(self):
        stmts = parse_func_body("I16 f() { ret -5; }")
        expr = stmts[0].value
        assert isinstance(expr, UnaryExpr)
        assert expr.op == "-"

    def test_unary_not(self):
        stmts = parse_func_body("I16 f() { ret !true; }")
        expr = stmts[0].value
        assert isinstance(expr, UnaryExpr)
        assert expr.op == "!"

    def test_function_call(self):
        stmts = parse_func_body("I16 f() { ret add(1, 2); }")
        expr = stmts[0].value
        assert isinstance(expr, CallExpr)
        assert isinstance(expr.callee, IdentifierExpr)
        assert expr.callee.name == "add"
        assert len(expr.args) == 2

    def test_method_call(self):
        stmts = parse_func_body("I16 f() { ret obj.getValue(); }")
        expr = stmts[0].value
        assert isinstance(expr, MethodCallExpr)
        assert expr.method == "getValue"

    def test_field_access(self):
        stmts = parse_func_body("I16 f() { ret obj.x; }")
        expr = stmts[0].value
        assert isinstance(expr, FieldAccessExpr)
        assert expr.field_name == "x"

    def test_parenthesized_expression(self):
        stmts = parse_func_body("I16 f() { ret (1 + 2) * 3; }")
        expr = stmts[0].value
        assert isinstance(expr, BinaryExpr)
        assert expr.op == "*"
        assert isinstance(expr.left, BinaryExpr)
        assert expr.left.op == "+"

    def test_literal_true(self):
        stmts = parse_func_body("I16 f() { ret true; }")
        assert isinstance(stmts[0].value, BoolLiteral)
        assert stmts[0].value.value is True

    def test_literal_false(self):
        stmts = parse_func_body("I16 f() { ret false; }")
        assert isinstance(stmts[0].value, BoolLiteral)
        assert stmts[0].value.value is False

    def test_literal_null(self):
        stmts = parse_func_body("I16 f() { ret null; }")
        assert isinstance(stmts[0].value, NullLiteral)

    def test_string_literal(self):
        stmts = parse_func_body('I16 f() { ret "hello"; }')
        assert isinstance(stmts[0].value, StringLiteral)
        assert stmts[0].value.value == "hello"

    def test_hex_literal(self):
        stmts = parse_func_body("I16 f() { ret 0xFF; }")
        assert isinstance(stmts[0].value, IntLiteral)
        assert stmts[0].value.value == 255

    def test_binary_literal(self):
        stmts = parse_func_body("I16 f() { ret 0b1010; }")
        assert isinstance(stmts[0].value, IntLiteral)
        assert stmts[0].value.value == 10


class TestControlFlow:
    def test_if_statement(self):
        stmts = parse_func_body("I16 f() { if (x > 0) { ret 1; } ret 0; }")
        assert isinstance(stmts[0], IfStmt)
        assert isinstance(stmts[0].condition, BinaryExpr)
        assert len(stmts[0].then_body) == 1
        assert stmts[0].else_body == []

    def test_if_else(self):
        stmts = parse_func_body("I16 f() { if (x > 0) { ret 1; } else { ret 0; } }")
        stmt = stmts[0]
        assert isinstance(stmt, IfStmt)
        assert len(stmt.then_body) == 1
        assert len(stmt.else_body) == 1

    def test_while_loop(self):
        stmts = parse_func_body("I16 f() { while (x > 0) { x = x - 1; } ret 0; }")
        assert isinstance(stmts[0], WhileStmt)
        assert isinstance(stmts[0].condition, BinaryExpr)

    def test_for_loop(self):
        stmts = parse_func_body("I16 f() { for (I16 i = 0; i < 10; i++) { x = x + 1; } ret 0; }")
        stmt = stmts[0]
        assert isinstance(stmt, ForStmt)
        assert isinstance(stmt.init, VarDecl)
        assert isinstance(stmt.condition, BinaryExpr)

    def test_nested_if(self):
        stmts = parse_func_body("""
            I16 f() {
                if (a > 0) {
                    if (b > 0) {
                        ret 1;
                    }
                }
                ret 0;
            }
        """)
        outer = stmts[0]
        assert isinstance(outer, IfStmt)
        inner = outer.then_body[0]
        assert isinstance(inner, IfStmt)


class TestStatements:
    def test_assignment(self):
        stmts = parse_func_body("I16 f() { I16 x = 0; x = 42; ret x; }")
        assert isinstance(stmts[1], Assignment)
        assert stmts[1].op == "="

    def test_compound_assignment(self):
        for op in ["+=", "-=", "*=", "/="]:
            stmts = parse_func_body(f"I16 f() {{ I16 x = 0; x {op} 1; ret x; }}")
            assert isinstance(stmts[1], Assignment)
            assert stmts[1].op == op

    def test_return_void(self):
        stmts = parse_func_body("U0 f() { ret; }")
        assert isinstance(stmts[0], ReturnStmt)
        assert stmts[0].value is None

    def test_return_value(self):
        stmts = parse_func_body("I16 f() { ret 42; }")
        assert isinstance(stmts[0], ReturnStmt)
        assert isinstance(stmts[0].value, IntLiteral)

    def test_local_var_decl(self):
        stmts = parse_func_body("I16 f() { I16 x = 10; ret x; }")
        assert isinstance(stmts[0], VarDecl)
        assert stmts[0].name == "x"

    def test_free_statement(self):
        stmts = parse_func_body("I16 f() { Free(ptr); ret 0; }")
        assert isinstance(stmts[0], FreeStmt)

    def test_print_statement(self):
        stmts = parse_func_body("I16 f() { Print(42); ret 0; }")
        assert isinstance(stmts[0], PrintStmt)
        assert isinstance(stmts[0].value, IntLiteral)

    def test_expression_statement(self):
        stmts = parse_func_body("I16 f() { doSomething(); ret 0; }")
        assert isinstance(stmts[0], ExprStmt)
        assert isinstance(stmts[0].expr, CallExpr)


class TestTypeExpressions:
    def test_named_type_i16(self):
        fn = parse_single_decl("I16 f() { ret 0; }")
        assert isinstance(fn, FunctionDecl)
        assert isinstance(fn.return_type, NamedType)
        assert fn.return_type.name == "I16"

    def test_named_type_u0(self):
        fn = parse_single_decl("U0 f() { ret; }")
        assert isinstance(fn.return_type, NamedType)
        assert fn.return_type.name == "U0"

    @pytest.mark.parametrize("type_name", ["I16", "U16", "I8", "U8", "F16", "U0"])
    def test_primitive_types_parse(self, type_name):
        fn = parse_single_decl(f"{type_name} f() {{ ret; }}")
        assert isinstance(fn.return_type, NamedType)
        assert fn.return_type.name == type_name

    def test_ptr_type(self):
        node = parse_single_decl("Ptr<Node> f() { ret null; }")
        assert isinstance(node.return_type, PtrType)
        assert isinstance(node.return_type.inner, NamedType)
        assert node.return_type.inner.name == "Node"

    def test_nested_ptr_type(self):
        node = parse_single_decl("Ptr<Ptr<I16>> f() { ret null; }")
        assert isinstance(node.return_type, PtrType)
        assert isinstance(node.return_type.inner, PtrType)


class TestBuiltinExpressions:
    def test_init_expr(self):
        stmts = parse_func_body("I16 f() { Ptr<Foo> p = Init<Foo>(val: 10); ret 0; }")
        decl = stmts[0]
        assert isinstance(decl, VarDecl)
        assert isinstance(decl.initializer, InitExpr)
        assert decl.initializer.class_name == "Foo"
        assert len(decl.initializer.kwargs) == 1
        assert decl.initializer.kwargs[0][0] == "val"

    def test_malloc_expr(self):
        stmts = parse_func_body("I16 f() { Ptr<I16> p = Malloc(16); ret 0; }")
        decl = stmts[0]
        assert isinstance(decl.initializer, MallocExpr)

    def test_sizeof_expr(self):
        stmts = parse_func_body("I16 f() { I16 s = SizeOf(Node); ret s; }")
        decl = stmts[0]
        assert isinstance(decl.initializer, SizeOfExpr)


class TestParserErrors:
    def test_missing_semicolon(self):
        with pytest.raises(ParseError):
            parse("module test { I16 x = 42 }")

    def test_missing_closing_brace(self):
        with pytest.raises(ParseError):
            parse("module test { I16 f() { ret 0; }")

    def test_unexpected_token_in_expression(self):
        with pytest.raises((ParseError, LexerError)):
            parse("module test { I16 f() { ret @; } }")

    def test_missing_module_keyword(self):
        with pytest.raises(ParseError):
            parse("test { I16 x = 1; }")
