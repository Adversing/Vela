import pytest

from src.lexer.lexer import Lexer
from src.parser.parser import Parser
from src.parser.ast_nodes import CallExpr, Expr, IntLiteral, Program
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

    def test_alias_resolves_in_same_module(self):
        tc = check_module("alias Word <- I16; Word x = 7;")
        types = {name: ty for name, ty, _ in tc.globals}
        assert types["x"] == I16

    def test_alias_does_not_leak_between_type_checkers(self):
        check_module("alias LocalOnly <- I16; LocalOnly x = 1;")
        with pytest.raises(SemanticError, match="unknown type 'LocalOnly'"):
            check_module("LocalOnly y = 2;")

    def test_alias_does_not_leak_between_modules_without_import(self):
        with pytest.raises(SemanticError, match="unknown type 'Word'"):
            check("""
                module a { alias Word <- I16; }
                module b { Word x = 1; }
            """)

    def test_class_type_does_not_leak_between_modules_without_import(self):
        with pytest.raises(SemanticError, match="unknown type 'Foo'"):
            check("""
                module a { class Foo { OnAlloc() {} } }
                module b { Ptr<Foo> x = null; }
            """)

    def test_init_class_does_not_leak_between_modules_without_import(self):
        with pytest.raises(SemanticError, match="undefined class 'Foo'"):
            check("""
                module a { class Foo { OnAlloc() {} } }
                module b { I16 main() { Init<Foo>(); ret 0; } }
            """)

    def test_type_decl_does_not_leak_between_modules_without_import(self):
        with pytest.raises(SemanticError, match="unknown type 'Shape'"):
            check("""
                module a { type Shape { skeleton I16 area(); } }
                module b { Ptr<Shape> x = null; }
            """)


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

    def test_inherited_duplicate_field_name_rejected(self):
        with pytest.raises(SemanticError, match="field 'x' duplicates inherited field"):
            check_module("""
                class Base {
                    I16 x;
                    OnAlloc() {}
                }
                class Child : Base {
                    I16 x;
                    OnAlloc() {}
                }
                I16 main() { ret 0; }
            """)

    def test_duplicate_global_name_rejected(self):
        with pytest.raises(SemanticError, match="duplicate top-level declaration 'x'"):
            check_module("I16 x = 1; I16 x = 2;")

    def test_duplicate_function_name_rejected(self):
        with pytest.raises(SemanticError, match="duplicate top-level declaration 'f'"):
            check_module("I16 f() { ret 1; } I16 f() { ret 2; }")

    def test_duplicate_top_level_cross_kind_rejected(self):
        with pytest.raises(SemanticError, match="duplicate top-level declaration 'Thing'"):
            check_module("class Thing { OnAlloc() {} } I16 Thing = 0;")

    def test_reserved_internal_top_level_prefix_rejected(self):
        with pytest.raises(SemanticError, match="reserved internal prefix"):
            check_module("I16 __malloc = 0;")

    def test_storeable_class_name_is_reserved_for_implicit_base(self):
        with pytest.raises(SemanticError, match="implicit Storeable base class"):
            check_module("class Storeable { OnAlloc() {} }")

    def test_global_main_label_conflicts_with_program_entry(self):
        with pytest.raises(SemanticError, match="assembly label 'main'"):
            check_module("I16 main = 0;")

    def test_duplicate_module_declarations_in_same_file_rejected(self):
        with pytest.raises(SemanticError, match="duplicate module 'test'"):
            check("""
                module test { I16 a = 1; }
                module test { I16 b = 2; }
            """)

    def test_space_label_conflicts_with_data_section(self):
        with pytest.raises(SemanticError, match="assembly label 'space'"):
            check_module("I16 space() { ret 0; }")

    def test_class_method_mangle_conflicting_with_function_label_rejected(self):
        with pytest.raises(SemanticError, match="assembly label 'Box_Get'"):
            check_module("""
                I16 Box_Get() { ret 1; }
                class Box {
                    OnAlloc() {}
                    I16 Get() { ret 2; }
                }
            """)

    def test_duplicate_local_name_rejected(self):
        with pytest.raises(SemanticError, match="duplicate local declaration 'x'"):
            check_module("""
                I16 main() {
                    I16 x = 1;
                    I16 x = 2;
                    ret x;
                }
            """)

    def test_duplicate_parameter_name_rejected(self):
        with pytest.raises(SemanticError, match="duplicate parameter 'x'"):
            check_module("I16 f(I16 x, I16 x) { ret x; }")

    def test_duplicate_class_method_name_rejected(self):
        with pytest.raises(SemanticError, match="duplicate method 'M'"):
            check_module("""
                class Dup {
                    OnAlloc() {}
                    I16 M() { ret 1; }
                    I16 M() { ret 2; }
                }
            """)

    def test_duplicate_type_method_name_rejected(self):
        with pytest.raises(SemanticError, match="duplicate method 'M'"):
            check_module("""
                type I {
                    skeleton I16 M();
                    skeleton I16 M();
                }
            """)

    def test_class_skeleton_signature_exact_match_allowed(self):
        check_module("""
            type I {
                skeleton I16 M(I16 x);
            }
            class A : I {
                OnAlloc() {}
                I16 M(I16 x) { ret x; }
            }
            I16 main() { ret 0; }
        """)

    def test_class_skeleton_wrong_arity_rejected(self):
        with pytest.raises(SemanticError, match="method 'M' must match skeleton signature"):
            check_module("""
                type I {
                    skeleton I16 M(I16 x);
                }
                class A : I {
                    OnAlloc() {}
                    I16 M() { ret 1; }
                }
                I16 main() { ret 0; }
            """)

    def test_class_skeleton_wrong_return_rejected(self):
        with pytest.raises(SemanticError, match="method 'M' must match skeleton signature"):
            check_module("""
                type I {
                    skeleton I16 M(I16 x);
                }
                class A : I {
                    OnAlloc() {}
                    U0 M(I16 x) {}
                }
                I16 main() { ret 0; }
            """)

    def test_class_skeleton_wrong_parameter_type_rejected(self):
        with pytest.raises(SemanticError, match="method 'M' must match skeleton signature"):
            check_module("""
                type I {
                    skeleton I16 M(I16 x);
                }
                class A : I {
                    OnAlloc() {}
                    I16 M(U16 x) { ret Cast<I16>(x); }
                }
                I16 main() { ret 0; }
            """)

    def test_class_method_override_signature_exact_match_allowed(self):
        check_module("""
            class Base {
                OnAlloc() {}
                I16 M(I16 x) { ret x; }
            }
            class Child : Base {
                OnAlloc() {}
                I16 M(I16 x) { ret x + 1; }
            }
            I16 main() { ret 0; }
        """)

    def test_class_method_override_wrong_arity_rejected(self):
        with pytest.raises(SemanticError, match="method 'M' must match inherited signature"):
            check_module("""
                class Base {
                    OnAlloc() {}
                    I16 M(I16 x) { ret x; }
                }
                class Child : Base {
                    OnAlloc() {}
                    I16 M() { ret 1; }
                }
                I16 main() { ret 0; }
            """)

    def test_class_method_override_wrong_return_rejected(self):
        with pytest.raises(SemanticError, match="method 'M' must match inherited signature"):
            check_module("""
                class Base {
                    OnAlloc() {}
                    I16 M(I16 x) { ret x; }
                }
                class Child : Base {
                    OnAlloc() {}
                    U0 M(I16 x) {}
                }
                I16 main() { ret 0; }
            """)

    def test_class_method_override_wrong_parameter_type_rejected(self):
        with pytest.raises(SemanticError, match="method 'M' must match inherited signature"):
            check_module("""
                class Base {
                    OnAlloc() {}
                    I16 M(I16 x) { ret x; }
                }
                class Child : Base {
                    OnAlloc() {}
                    I16 M(U16 x) { ret Cast<I16>(x); }
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

    def test_unknown_class_parent_rejected(self):
        with pytest.raises(SemanticError, match="extends unknown class or type 'Missing'"):
            check_module("""
                class Bad : Missing {
                    OnAlloc() {}
                }
                I16 main() { ret 0; }
            """)

    def test_class_parent_must_be_visible_in_current_module(self):
        with pytest.raises(SemanticError, match="extends unknown class or type 'Base'"):
            check("""
                module a { class Base { OnAlloc() {} } }
                module b { class Child : Base { OnAlloc() {} } }
            """)

    def test_class_inheritance_cycle_rejected(self):
        with pytest.raises(SemanticError, match="inheritance cycle detected"):
            check_module("""
                class A : B { OnAlloc() {} }
                class B : A { OnAlloc() {} }
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

    def test_incompatible_var_initializer_rejected(self):
        with pytest.raises(SemanticError, match="cannot initialise I8 from I16"):
            check_module("I8 x = 1000;")

    def test_negative_literal_can_initialise_signed_byte(self):
        tc = check_module("I8 x = -1;")
        types = {name: ty for name, ty, _ in tc.globals}
        assert types["x"] == I8

    def test_negative_literal_must_fit_signed_byte(self):
        with pytest.raises(SemanticError, match="cannot initialise I8 from I16"):
            check_module("I8 x = -129;")

    def test_negative_literal_rejected_for_unsigned_byte(self):
        with pytest.raises(SemanticError, match="cannot initialise U8 from I16"):
            check_module("U8 x = -1;")

    def test_integer_literal_above_u16_rejected_even_in_expression(self):
        with pytest.raises(SemanticError, match="integer literal 70000 is outside the 16-bit range"):
            check_module("""
                I16 main() {
                    I16 x = 70000 + 1;
                    ret x;
                }
            """)

    def test_unsigned_range_literal_expression_cannot_return_signed_word_implicitly(self):
        with pytest.raises(SemanticError, match="returns I16, got U16"):
            check_module("""
                I16 main() {
                    ret 50000 + 1;
                }
            """)

    def test_negative_i16_min_literal_allowed(self):
        check_module("""
            I16 main() {
                ret -32768;
            }
        """)

    def test_negative_i16_min_literal_stays_signed_in_expression(self):
        check_module("""
            I16 main() {
                ret -32768 + 1;
            }
        """)

    def test_negative_i16_literal_below_min_rejected_in_expression(self):
        with pytest.raises(SemanticError, match="integer literal -32769 is outside the I16 range"):
            check_module("""
                I16 main() {
                    ret -32769 + 1;
                }
            """)

    def test_char_literal_must_fit_u8_even_when_widened(self):
        with pytest.raises(SemanticError, match="outside the U8 range"):
            check_module("""
                I16 main() {
                    ret 'Ā';
                }
            """)

    def test_unsigned_literal_can_initialise_signed_wider_type_when_it_fits(self):
        check_module("I16 x = 255;")

    def test_unsigned_byte_variable_can_widen_to_signed_word(self):
        check_module("""
            I16 main() {
                U8 x = 255;
                I16 y = x;
                ret y;
            }
        """)

    def test_unsigned_word_variable_cannot_implicitly_become_signed_word(self):
        with pytest.raises(SemanticError, match="cannot initialise I16 from U16"):
            check_module("""
                I16 main() {
                    U16 x = 40000;
                    I16 y = x;
                    ret y;
                }
            """)

    def test_signed_byte_variable_cannot_implicitly_become_unsigned_byte(self):
        with pytest.raises(SemanticError, match="cannot initialise U8 from I8"):
            check_module("""
                I16 main() {
                    I8 x = -1;
                    U8 y = x;
                    ret y;
                }
            """)

    def test_signed_word_variable_cannot_implicitly_become_unsigned_word(self):
        with pytest.raises(SemanticError, match="cannot initialise U16 from I16"):
            check_module("""
                I16 main() {
                    I16 x = -1;
                    U16 y = x;
                    ret Cast<I16>(y);
                }
            """)

    def test_mixed_same_width_signed_unsigned_arithmetic_rejected(self):
        with pytest.raises(SemanticError, match="operator '\\+' requires compatible numeric operands"):
            check_module("""
                I16 main() {
                    I16 s = -1;
                    U16 u = 1;
                    ret s + u;
                }
            """)

    def test_unsigned_byte_arithmetic_can_widen_to_signed_word(self):
        check_module("""
            I16 main() {
                U8 u = 1;
                I16 s = 2;
                ret u + s;
            }
        """)

    def test_mixed_same_width_signed_unsigned_comparison_rejected(self):
        with pytest.raises(SemanticError, match="operator '<' requires compatible numeric operands"):
            check_module("""
                I16 main() {
                    I16 s = -1;
                    U16 u = 1;
                    if (s < u) { ret 1; }
                    ret 0;
                }
            """)

    def test_unsigned_word_comparison_with_fitting_literal_allowed(self):
        check_module("""
            I16 main() {
                U16 u = 40000;
                if (u < 50000) { ret 1; }
                ret 0;
            }
        """)

    def test_unsigned_word_comparison_with_negative_literal_rejected(self):
        with pytest.raises(SemanticError, match="operator '<' requires compatible numeric operands"):
            check_module("""
                I16 main() {
                    U16 u = 1;
                    if (u < -1) { ret 1; }
                    ret 0;
                }
            """)

    def test_int_literal_cannot_initialise_float(self):
        with pytest.raises(SemanticError, match="cannot initialise F16 from I16"):
            check_module("""
                F16 main() {
                    F16 x = 1;
                    ret x;
                }
            """)

    def test_int_value_cannot_return_as_float(self):
        with pytest.raises(SemanticError, match="returns F16, got I16"):
            check_module("""
                F16 f(I16 x) {
                    ret x;
                }
            """)

    def test_int_literal_cannot_pass_as_float_argument(self):
        with pytest.raises(SemanticError, match="argument 1 of id expects F16, got I16"):
            check_module("""
                F16 id(F16 x) { ret x; }
                F16 main() {
                    ret id(1);
                }
            """)

    def test_int_to_float_cast_rejected(self):
        with pytest.raises(SemanticError, match="cannot cast I16 to F16"):
            check_module("""
                F16 main() {
                    ret Cast<F16>(1);
                }
            """)

    def test_float_to_int_cast_rejected(self):
        with pytest.raises(SemanticError, match="cannot cast F16 to I16"):
            check_module("""
                I16 main() {
                    F16 x = 1.0;
                    ret Cast<I16>(x);
                }
            """)

    def test_mixed_int_float_arithmetic_rejected(self):
        with pytest.raises(SemanticError, match="operator '\\+' requires compatible numeric operands"):
            check_module("""
                F16 f() {
                    ret 1.0 + 2;
                }
            """)

    def test_mixed_int_float_comparison_rejected(self):
        with pytest.raises(SemanticError, match="operator '<' requires compatible numeric operands"):
            check_module("""
                I16 main() {
                    if (1.0 < 2) { ret 1; }
                    ret 0;
                }
            """)

    def test_return_unsigned_word_variable_as_signed_word_requires_cast(self):
        with pytest.raises(SemanticError, match="returns I16, got U16"):
            check_module("""
                I16 f() {
                    U16 x = 40000;
                    ret x;
                }
            """)

    def test_argument_unsigned_word_variable_as_signed_word_requires_cast(self):
        with pytest.raises(SemanticError, match="argument 1 of f expects I16, got U16"):
            check_module("""
                I16 f(I16 x) { ret x; }
                I16 main() {
                    U16 x = 40000;
                    ret f(x);
                }
            """)

    def test_bare_function_name_is_not_a_value(self):
        with pytest.raises(SemanticError, match="'f' is a func, not a value"):
            check_module("""
                I16 f() { ret 7; }
                I16 main() {
                    ret f;
                }
            """)

    def test_bare_class_name_is_not_a_value(self):
        with pytest.raises(SemanticError, match="'Box' is a class, not a value"):
            check_module("""
                class Box {
                    I16 value;
                }
                I16 main() {
                    ret Box;
                }
            """)

    def test_dynamic_global_initializer_rejected(self):
        with pytest.raises(SemanticError, match="global initializer .* static literal"):
            check_module("I16 x = 1 + 2;")

    def test_string_pointer_global_initializer_rejected(self):
        with pytest.raises(SemanticError, match="global initializer .* static literal"):
            check_module('Ptr<U8> p = "Hi";')

    def test_null_pointer_global_initializer_allowed(self):
        tc = check_module("Ptr<I16> p = null;")
        types = {name: ty for name, ty, _ in tc.globals}
        assert str(types["p"]) == "Ptr<I16>"

    def test_void_global_variable_rejected(self):
        with pytest.raises(SemanticError, match="global variable 'x' cannot have type U0"):
            check_module("U0 x;")

    def test_void_local_variable_rejected(self):
        with pytest.raises(SemanticError, match="local variable 'x' cannot have type U0"):
            check_module("""
                U0 main() {
                    U0 x;
                    ret;
                }
            """)

    def test_void_parameter_rejected(self):
        with pytest.raises(SemanticError, match="parameter 'x' cannot have type U0"):
            check_module("I16 f(U0 x) { ret 0; }")

    def test_void_class_field_rejected(self):
        with pytest.raises(SemanticError, match="field 'x' cannot have type U0"):
            check_module("""
                class Bad {
                    U0 x;
                }
            """)

    def test_void_pointer_value_allowed(self):
        check_module("""
            Ptr<U0> p = null;
            U0 main() {
                ret;
            }
        """)

    def test_non_identifier_call_target_rejected(self):
        tc = TypeChecker()
        with pytest.raises(SemanticError, match="call target must be a function name"):
            tc._check_expr(CallExpr(callee=IntLiteral(value=1), args=[]))

    def test_unsupported_expression_node_rejected(self):
        tc = TypeChecker()
        with pytest.raises(SemanticError, match="unsupported expression node Expr"):
            tc._check_expr(Expr())

    def test_incompatible_assignment_rejected(self):
        with pytest.raises(SemanticError, match="cannot assign Ptr<U0> to I16"):
            check_module("""
                I16 main() {
                    I16 x = 0;
                    x = null;
                    ret x;
                }
            """)

    def test_wrapper_autobox_initializer_allowed(self):
        check_module("""
            class Int {
                I16 value;
                OnAlloc(I16 v) { value = v; }
            }
            I16 main() {
                Int x = 42;
                Free(x);
                ret 0;
            }
        """)

    def test_free_rejects_non_pointer(self):
        with pytest.raises(SemanticError, match="Free expects a pointer, got I16"):
            check_module("""
                I16 main() {
                    Free(123);
                    ret 0;
                }
            """)

    def test_free_accepts_raw_pointer(self):
        check_module("""
            I16 main() {
                Ptr<I16> p = Malloc(2);
                Free(p);
                ret 0;
            }
        """)

    def test_malloc_size_must_be_integer(self):
        with pytest.raises(SemanticError, match="Malloc size must be an integer"):
            check_module("""
                I16 main() {
                    Ptr<I16> p = Malloc(null);
                    ret 0;
                }
            """)

    def test_malloc_negative_literal_size_rejected(self):
        with pytest.raises(SemanticError, match="Malloc size must be non-negative"):
            check_module("""
                I16 main() {
                    Ptr<I16> p = Malloc(-1);
                    ret 0;
                }
            """)

    def test_print_rejects_unsupported_format_argument(self):
        with pytest.raises(SemanticError, match="Print expects 1 argument, got 2"):
            check_module("""
                I16 main() {
                    Print(42, "hex");
                    ret 0;
                }
            """)

    def test_indexing_requires_pointer(self):
        with pytest.raises(SemanticError, match="indexing requires a pointer, got I16"):
            check_module("""
                I16 main() {
                    I16 x = 3;
                    ret x[0];
                }
            """)

    def test_pointer_index_must_be_integer(self):
        with pytest.raises(SemanticError, match="pointer index must be an integer"):
            check_module("""
                I16 main() {
                    Ptr<I16> p = Malloc(2);
                    I16 x = p[null];
                    Free(p);
                    ret x;
                }
            """)

    def test_deref_requires_pointer(self):
        with pytest.raises(SemanticError, match="dereference requires a pointer, got I16"):
            check_module("""
                I16 main() {
                    I16 x = 3;
                    ret *x;
                }
            """)

    def test_cannot_deref_void_pointer(self):
        with pytest.raises(SemanticError, match="cannot dereference Ptr<U0>"):
            check_module("""
                I16 main() {
                    Ptr<U0> p = Malloc(2);
                    I16 x = *p;
                    Free(p);
                    ret x;
                }
            """)

    def test_field_access_requires_class_pointer(self):
        with pytest.raises(SemanticError, match="field access requires a class instance"):
            check_module("""
                I16 main() {
                    ret null.value;
                }
            """)

    def test_method_call_requires_class_pointer(self):
        with pytest.raises(SemanticError, match="method call requires a class instance"):
            check_module("""
                I16 main() {
                    ret null.Value();
                }
            """)

    def test_arithmetic_rejects_bool_operand(self):
        with pytest.raises(SemanticError, match="operator '\\+' requires numeric operands"):
            check_module("""
                I16 main() {
                    ret true + 1;
                }
            """)

    def test_arithmetic_rejects_pointer_operand(self):
        with pytest.raises(SemanticError, match="operator '\\+' requires numeric operands"):
            check_module("""
                I16 main() {
                    Ptr<I16> p = Malloc(2);
                    I16 x = p + 1;
                    Free(p);
                    ret x;
                }
            """)

    def test_modulo_rejects_float_operands(self):
        with pytest.raises(SemanticError, match="operator '%' requires integer operands"):
            check_module("""
                F16 f() {
                    ret 3.5 % 2.0;
                }
            """)

    def test_ordered_comparison_rejects_pointers(self):
        with pytest.raises(SemanticError, match="operator '<' requires numeric operands"):
            check_module("""
                I16 main() {
                    Ptr<I16> p = Malloc(2);
                    if (p < null) { ret 1; }
                    Free(p);
                    ret 0;
                }
            """)

    def test_pointer_equality_with_null_allowed(self):
        check_module("""
            I16 main() {
                Ptr<I16> p = null;
                if (p == null) { ret 1; }
                ret 0;
            }
        """)

    def test_multi_dispatch_checks_method_arguments(self):
        with pytest.raises(SemanticError, match="A.M expects 1 argument, got 0"):
            check_module("""
                class A {
                    OnAlloc() {}
                    U0 M(I16 x) {}
                }
                I16 main() {
                    A a = Init<A>();
                    {a}.M();
                    Free(a);
                    ret 0;
                }
            """)

    def test_multi_dispatch_target_must_be_class(self):
        with pytest.raises(SemanticError, match="multi-dispatch target must be a class instance"):
            check_module("""
                I16 main() {
                    I16 x = 1;
                    {x}.M();
                    ret 0;
                }
            """)

    def test_unary_minus_requires_numeric_operand(self):
        with pytest.raises(SemanticError, match="operator '-' requires a numeric operand"):
            check_module("""
                I16 main() {
                    ret -null;
                }
            """)

    def test_post_increment_requires_assignable_target(self):
        with pytest.raises(SemanticError, match="requires an assignable target"):
            check_module("""
                I16 main() {
                    5++;
                    ret 0;
                }
            """)

    def test_assignment_to_literal_rejected(self):
        with pytest.raises(SemanticError, match="assignment '=' requires an assignable target"):
            check_module("""
                I16 main() {
                    1 = 2;
                    ret 0;
                }
            """)

    def test_assignment_to_binary_expression_rejected(self):
        with pytest.raises(SemanticError, match="assignment '=' requires an assignable target"):
            check_module("""
                I16 main() {
                    (1 + 2) = 3;
                    ret 0;
                }
            """)

    def test_assignment_to_call_result_rejected(self):
        with pytest.raises(SemanticError, match="assignment '=' requires an assignable target"):
            check_module("""
                I16 f() { ret 1; }
                I16 main() {
                    f() = 3;
                    ret 0;
                }
            """)

    def test_asm_binding_unknown_variable_rejected(self):
        with pytest.raises(SemanticError, match="undefined ASM binding variable 'missing'"):
            check_module("""
                I16 main() {
                    ASM([[in]] R0 = missing;) {
                        MOV R0, V1
                    }
                    ret 0;
                }
            """)

    def test_asm_binding_invalid_register_rejected(self):
        with pytest.raises(SemanticError, match="ASM binding register must be R0..R9"):
            check_module("""
                I16 main() {
                    I16 x = 1;
                    ASM([[in]] SP = x;) {
                    }
                    ret x;
                }
            """)

    def test_post_increment_requires_integer_target(self):
        with pytest.raises(SemanticError, match="operator '\\+\\+' requires an integer target"):
            check_module("""
                I16 main() {
                    F16 x = 1.0;
                    x++;
                    ret 0;
                }
            """)

    def test_unknown_named_type_rejected(self):
        with pytest.raises(SemanticError, match="unknown type 'Missing'"):
            check_module("Missing value = 0;")

    def test_unknown_pointer_inner_type_rejected(self):
        with pytest.raises(SemanticError, match="unknown type 'Missing'"):
            check_module("Ptr<Missing> value = null;")

    def test_sizeof_unknown_type_rejected(self):
        with pytest.raises(SemanticError, match="unknown type 'Missing'"):
            check_module("I16 main() { ret SizeOf(Missing); }")

    def test_function_can_reference_later_class_type(self):
        tc = check_module("""
            Ptr<Foo> make() { ret null; }
            class Foo {
                OnAlloc() {}
            }
        """)
        fn = next(f for f in tc.functions if f.name == "make")
        ret = tc._resolve_type(fn.return_type)
        assert isinstance(ret, PtrType_)
        assert isinstance(ret.inner, ClassType)
        assert ret.inner.name == "Foo"

    def test_function_can_reference_later_global_variable(self):
        check_module("""
            I16 read() { ret value; }
            I16 value = 7;
        """)

    def test_non_void_function_must_not_fall_through(self):
        with pytest.raises(SemanticError, match="function 'f' must return I16 on all paths"):
            check_module("I16 f() { I16 x = 1; }")

    def test_non_void_if_without_else_can_fall_through(self):
        with pytest.raises(SemanticError, match="function 'f' must return I16 on all paths"):
            check_module("""
                I16 f() {
                    if (true) { ret 1; }
                }
            """)

    def test_non_void_if_else_returns_on_all_paths(self):
        check_module("""
            I16 f() {
                if (true) { ret 1; } else { ret 2; }
            }
        """)

    def test_non_void_literal_infinite_loop_with_return_is_definite(self):
        check_module("""
            I16 f() {
                while (true) { ret 1; }
            }
        """)


class TestTypeCompatibility:
    def test_same_type_compatible(self):
        assert types_compatible(I16, I16) is True

    def test_int_widening(self):
        assert types_compatible(I16, I8) is True

    def test_unsigned_int_widens_to_larger_signed_int(self):
        assert types_compatible(I16, U8) is True

    def test_unsigned_int_same_width_signed_target_incompatible(self):
        assert types_compatible(I16, U16) is False

    def test_signed_int_to_unsigned_target_incompatible(self):
        assert types_compatible(U16, I8) is False

    def test_int_narrowing_incompatible(self):
        assert types_compatible(I8, I16) is False

    def test_float_from_int_rejected_without_backend_conversion(self):
        assert types_compatible(F16, I16) is False

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
