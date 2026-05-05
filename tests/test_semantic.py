import pytest

from src.lexer.lexer import Lexer
from src.parser.parser import Parser
from src.parser.ast_nodes import Program
from src.semantic.type_checker import TypeChecker
from src.semantic.types import (
    VelaType, VoidType, IntType, FloatType, PtrType_, BoolType,
    ClassType, U0, U8, I8, U16, I16, F16, BOOL, NULL_PTR,
    PRIMITIVE_MAP, types_compatible,
)
from src.semantic.scope import ScopeStack, Symbol, Scope
from src.errors import SemanticError, VelaError


def check(source: str) -> TypeChecker:
    """Parse and type-check source, returning the TypeChecker instance."""
    tokens = Lexer(source, "<test>").tokenize()
    ast = Parser(tokens, "<test>").parse()
    tc = TypeChecker()
    tc.check(ast)
    return tc


def check_module(body: str) -> TypeChecker:
    """Wrap body in a module, parse, and type-check."""
    return check(f"module test {{ {body} }}")


class TestTypeResolution:
    def test_primitive_i16(self):
        tc = check_module("I16 x = 42;")
        names = [name for name, ty, _ in tc.globals]
        types = {name: ty for name, ty, _ in tc.globals}
        assert "x" in names
        assert types["x"] == I16

    def test_primitive_u8(self):
        tc = check_module("U8 flag = 0;")
        types = {name: ty for name, ty, _ in tc.globals}
        assert "flag" in types
        assert types["flag"] == U8

    def test_primitive_f16(self):
        tc = check_module("F16 pi = 3.14;")
        types = {name: ty for name, ty, _ in tc.globals}
        assert "pi" in types
        assert types["pi"] == F16

    def test_primitive_u16(self):
        tc = check_module("U16 big = 1000;")
        types = {name: ty for name, ty, _ in tc.globals}
        assert "big" in types
        assert types["big"] == U16

    def test_global_var_registered(self):
        tc = check_module("I16 x = 10;")
        assert len(tc.globals) == 1
        name, ty, _ = tc.globals[0]
        assert name == "x"
        assert ty == I16


class TestFunctionChecking:
    def test_function_registered(self):
        tc = check_module("I16 add(I16 a, I16 b) { ret a + b; }")
        func_names = [f.name for f in tc.functions]
        assert "add" in func_names

    def test_function_return_type(self):
        tc = check_module("I16 add(I16 a, I16 b) { ret a + b; }")
        fn = [f for f in tc.functions if f.name == "add"][0]
        assert fn.return_type is not None

    def test_function_params(self):
        tc = check_module("I16 add(I16 a, I16 b) { ret a + b; }")
        fn = [f for f in tc.functions if f.name == "add"][0]
        assert len(fn.params) == 2
        assert fn.params[0].name == "a"
        assert fn.params[1].name == "b"

    def test_void_function(self):
        tc = check_module("U0 noop() { ret; }")
        fn = [f for f in tc.functions if f.name == "noop"][0]
        assert fn.return_type is not None

    def test_multiple_functions(self):
        tc = check_module("""
            I16 foo() { ret 1; }
            I16 bar() { ret 2; }
        """)
        func_names = [f.name for f in tc.functions]
        assert "foo" in func_names
        assert "bar" in func_names
        assert len(tc.functions) == 2


class TestClassChecking:
    def test_class_registered(self):
        tc = check_module("""
            class Foo {
                I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        assert "Foo" in tc.class_types
        ct = tc.class_types["Foo"]
        assert isinstance(ct, ClassType)
        assert ct.name == "Foo"

    def test_class_fields(self):
        tc = check_module("""
            class Pair {
                I16 x;
                I16 y;
                OnAlloc(I16 a, I16 b) { x = a; y = b; }
                OnFree {}
            }
        """)
        ct = tc.class_types["Pair"]
        field_names = [f[0] for f in ct.fields]
        assert "x" in field_names
        assert "y" in field_names

    def test_class_in_class_types(self):
        tc = check_module("""
            class Foo {
                I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        assert "Foo" in tc.class_types
        assert isinstance(tc.class_types["Foo"], ClassType)

    def test_class_with_method(self):
        tc = check_module("""
            class Foo {
                I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
                I16 getVal() { ret val; }
            }
        """)
        ct = tc.class_types["Foo"]
        assert "getVal" in ct.methods


class TestTagExpansion:
    def test_get_tag_generates_getter(self):
        tc = check_module("""
            class Foo {
                [[get]] I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        ct = tc.class_types["Foo"]
        assert "GetVal" in ct.methods

    def test_set_tag_generates_setter(self):
        tc = check_module("""
            class Foo {
                [[set]] I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        ct = tc.class_types["Foo"]
        assert "SetVal" in ct.methods

    def test_get_and_set_tags(self):
        tc = check_module("""
            class Foo {
                [[get, set]] I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
        """)
        ct = tc.class_types["Foo"]
        assert "GetVal" in ct.methods
        assert "SetVal" in ct.methods

    def test_tag_conflict_with_user_method(self):
        with pytest.raises(VelaError, match="already explicitly defined"):
            check_module("""
                class Foo {
                    [[get]] I16 val;
                    OnAlloc(I16 v) { val = v; }
                    OnFree {}
                    I16 GetVal() { ret val; }
                }
            """)


class TestScopeResolution:
    def test_scope_push_pop(self):
        ss = ScopeStack()
        ss.push("inner")
        ss.define("x", Symbol(name="x", type=I16, kind="var"))
        assert ss.lookup("x") is not None
        ss.pop()
        assert ss.lookup("x") is None

    def test_nested_scopes(self):
        ss = ScopeStack()
        ss.define("global_var", Symbol(name="global_var", type=I16, kind="var"))
        ss.push("inner")
        assert ss.lookup("global_var") is not None
        ss.define("inner_var", Symbol(name="inner_var", type=U8, kind="var"))
        assert ss.lookup("inner_var") is not None
        ss.pop()
        assert ss.lookup("inner_var") is None
        assert ss.lookup("global_var") is not None

    def test_variable_shadowing(self):
        ss = ScopeStack()
        ss.define("x", Symbol(name="x", type=I16, kind="var"))
        ss.push("inner")
        ss.define("x", Symbol(name="x", type=U8, kind="var"))
        sym = ss.lookup("x")
        assert sym.type == U8
        ss.pop()
        sym = ss.lookup("x")
        assert sym.type == I16

    def test_scope_defines_track_depth(self):
        ss = ScopeStack()
        ss.push("level1")
        ss.define("a", Symbol(name="a", type=I16, kind="var"))
        sym = ss.lookup("a")
        assert sym.scope_depth == 1


class TestSemanticErrors:
    def test_undefined_variable_in_return(self):
        with pytest.raises(SemanticError, match="undefined"):
            check_module("I16 f() { ret undefined_var; }")

    def test_undefined_variable_in_expr(self):
        with pytest.raises(SemanticError, match="undefined"):
            check_module("I16 f() { I16 x = unknown; ret x; }")

    def test_duplicate_field_name(self):
        with pytest.raises(SemanticError, match="duplicate field"):
            check_module("""
                class Dup {
                    I16 x;
                    I16 x;
                    OnAlloc() {}
                }
                I16 main() { ret 0; }
            """)

    def test_explicit_storeable_inheritance(self):
        with pytest.raises(SemanticError, match="must not explicitly extend Storeable"):
            check_module("""
                class Bad : Storeable {
                    OnAlloc() {}
                }
                I16 main() { ret 0; }
            """)

    def test_method_on_bare_i16_rejected(self):
        """Calling a method on a bare I16 should produce a SemanticError."""
        with pytest.raises(SemanticError, match="primitive type 'I16' has no methods"):
            check_module("""
                class Int {
                    I16 value;
                    OnAlloc(I16 v) { value = v; }
                    I16 Abs() { ret value; }
                }
                I16 main() { I16 x = 42; ret x.Abs(); }
            """)

    def test_method_on_bare_f16_rejected(self):
        with pytest.raises(SemanticError, match="primitive type.*has no methods"):
            check_module("""
                class Float {
                    F16 value;
                    OnAlloc(F16 v) { value = v; }
                    F16 Abs() { ret value; }
                }
                I16 main() { F16 x = 3.14; F16 y = x.Abs(); ret 0; }
            """)

    def test_field_on_bare_i16_rejected(self):
        with pytest.raises(SemanticError, match="primitive type 'I16' has no fields"):
            check_module("""
                class Int {
                    I16 value;
                    OnAlloc(I16 v) { value = v; }
                }
                I16 main() { I16 x = 42; ret x.value; }
            """)

    def test_address_of_local_rejected(self):
        with pytest.raises(SemanticError, match="cannot take address of local"):
            check_module("""
                I16 main() {
                    I16 x = 3;
                    Ptr<I16> p = &x;
                    ret 0;
                }
            """)


class TestTypeCompatibility:
    def test_same_type_compatible(self):
        assert types_compatible(I16, I16) is True

    def test_int_widening(self):
        assert types_compatible(I16, I8) is True

    def test_int_narrowing_incompatible(self):
        assert types_compatible(I8, I16) is False

    def test_float_from_int(self):
        assert types_compatible(F16, I16) is True

    def test_ptr_void_compatible(self):
        assert types_compatible(PtrType_(inner=VoidType()), PtrType_(inner=I16)) is True

    def test_null_to_ptr(self):
        assert types_compatible(PtrType_(inner=I16), NULL_PTR) is True

    def test_bool_from_int(self):
        # Bool is NOT implicitly convertible from integers
        assert types_compatible(BOOL, I16) is False

    def test_int_from_bool(self):
        # Bool is NOT implicitly convertible to integers
        assert types_compatible(I16, BOOL) is False

    def test_bool_self_compatible(self):
        assert types_compatible(BOOL, BOOL) is True

    def test_different_ptr_incompatible(self):
        assert types_compatible(PtrType_(inner=I16), PtrType_(inner=U8)) is False


class TestTypeProperties:
    def test_void_size(self):
        assert U0.size() == 0

    def test_i16_size(self):
        assert I16.size() == 2

    def test_u8_size(self):
        assert U8.size() == 1

    def test_f16_size(self):
        assert F16.size() == 2

    def test_ptr_size(self):
        assert PtrType_(inner=I16).size() == 2

    def test_bool_size(self):
        assert BOOL.size() == 1

    def test_int_is_numeric(self):
        assert I16.is_numeric() is True

    def test_float_is_numeric(self):
        assert F16.is_numeric() is True

    def test_float_is_float(self):
        assert F16.is_float() is True

    def test_int_not_float(self):
        assert I16.is_float() is False

    def test_signed_int(self):
        assert I16.is_signed() is True

    def test_unsigned_int(self):
        assert U16.is_signed() is False

    def test_primitive_map_contains_all(self):
        for name in ["U0", "U8", "I8", "U16", "I16", "F16"]:
            assert name in PRIMITIVE_MAP


class TestStringLiterals:
    def test_string_literals_collected(self):
        tc = check_module('I16 f() { Print("hello"); ret 0; }')
        assert "hello" in tc.string_literals
