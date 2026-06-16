
from pathlib import Path
import re

import pytest

from src.main import compile_source
from src.errors import SemanticError


def compile(source: str) -> str:
    """Compile Vela source and return the assembly text."""
    return compile_source(source, "test.vl")


def compile_project(source: str) -> str:
    return compile_source(source, "test.vl", project_root=Path(__file__).resolve().parents[1])


def test_imports_with_same_declared_module_name_from_different_files_compile(tmp_path):
    (tmp_path / "pkg_a").mkdir()
    (tmp_path / "pkg_b").mkdir()
    (tmp_path / "pkg_a" / "foo.vl").write_text(
        """
        module util {
            I16 a() {
                I16 out = 1;
                ASM([[out]] R0 = out;) { MOV R0, V1 }
                ret out;
            }
        }
        """,
        encoding="utf-8",
    )
    (tmp_path / "pkg_b" / "foo.vl").write_text(
        """
        module util {
            I16 b() {
                I16 out = 2;
                ASM([[out]] R0 = out;) { MOV R0, V2 }
                ret out;
            }
        }
        """,
        encoding="utf-8",
    )

    asm = compile_source(
        """
        module test {
            import pkg_a::{foo};
            import pkg_b::{foo};
            I16 main() { ret a() + b(); }
        }
        """,
        str(tmp_path / "main.vl"),
        project_root=tmp_path,
    )

    assert "a:" in asm
    assert "b:" in asm


def test_imported_global_variable_can_be_referenced(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "config.vl").write_text(
        "module config { I16 answer = 42; }",
        encoding="utf-8",
    )

    asm = compile_source(
        """
        module test {
            import pkg::{config};
            I16 main() { ret answer; }
        }
        """,
        str(tmp_path / "main.vl"),
        project_root=tmp_path,
    )

    assert "answer = 0010101000000000" in asm
    assert "MOVM" in asm


def test_imported_alias_can_be_referenced(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "types.vl").write_text(
        "module types { alias Word <- I16; }",
        encoding="utf-8",
    )

    asm = compile_source(
        """
        module test {
            import pkg::{types};
            Word answer = 42;
            I16 main() { ret answer; }
        }
        """,
        str(tmp_path / "main.vl"),
        project_root=tmp_path,
    )

    assert "answer = 0010101000000000" in asm


def test_imported_alias_does_not_leak_to_sibling_module(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "types.vl").write_text(
        "module types { alias Word <- I16; }",
        encoding="utf-8",
    )

    with pytest.raises(SemanticError, match="unknown type 'Word'"):
        compile_source(
            """
            module first {
                import pkg::{types};
                Word ok = 1;
            }
            module second {
                Word bad = 2;
            }
            """,
            str(tmp_path / "main.vl"),
            project_root=tmp_path,
        )


def test_storeable_auto_import_conflict_is_reported(tmp_path):
    with pytest.raises(SemanticError, match="top-level declaration 'Storeable' conflicts"):
        compile_source(
            """
            module test {
                I16 Storeable() { ret 0; }
                class A { OnAlloc() {} }
                I16 main() { ret 0; }
            }
            """,
            str(tmp_path / "main.vl"),
            project_root=tmp_path,
        )


def test_imported_functions_with_same_flat_label_are_rejected(tmp_path):
    (tmp_path / "pkg_a").mkdir()
    (tmp_path / "pkg_b").mkdir()
    (tmp_path / "pkg_a" / "math.vl").write_text(
        "module math { I16 value() { ret 1; } }",
        encoding="utf-8",
    )
    (tmp_path / "pkg_b" / "math.vl").write_text(
        "module math { I16 value() { ret 2; } }",
        encoding="utf-8",
    )

    with pytest.raises(SemanticError, match="top-level declaration 'value' conflicts"):
        compile_source(
            """
            module test {
                import pkg_a::{math};
                import pkg_b::{math};
                I16 main() { ret value(); }
            }
            """,
            str(tmp_path / "main.vl"),
            project_root=tmp_path,
        )


def test_local_declaration_conflicting_with_imported_label_is_rejected(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "math.vl").write_text(
        "module math { I16 value() { ret 1; } }",
        encoding="utf-8",
    )

    with pytest.raises(SemanticError, match="top-level declaration 'value' conflicts"):
        compile_source(
            """
            module test {
                import pkg::{math};
                I16 value() { ret 2; }
                I16 main() { ret value(); }
            }
            """,
            str(tmp_path / "main.vl"),
            project_root=tmp_path,
        )


class TestHelloWorld:
    def test_print_produces_asm(self):
        asm = compile("""
            module test {
                I16 main() {
                    Print(42);
                    ret 0;
                }
            }
        """)
        assert isinstance(asm, str)
        assert len(asm) > 0

    def test_print_has_space_section(self):
        asm = compile("""
            module test {
                I16 main() {
                    Print(42);
                    ret 0;
                }
            }
        """)
        assert "space:" in asm

    def test_print_has_main_label(self):
        asm = compile("""
            module test {
                I16 main() {
                    Print(42);
                    ret 0;
                }
            }
        """)
        assert "main:" in asm

    def test_print_has_main(self):
        asm = compile("""
            module test {
                I16 main() {
                    Print(42);
                    ret 0;
                }
            }
        """)
        assert "main:" in asm

    def test_print_has_syscall(self):
        asm = compile("""
            module test {
                I16 main() {
                    Print(42);
                    ret 0;
                }
            }
        """)
        assert "__syscall" in asm


class TestArithmetic:
    def test_addition_produces_add(self):
        asm = compile("""
            module test {
                I16 x = 10;
                I16 y = 20;
                I16 add(I16 a, I16 b) { ret a + b; }
                I16 main() {
                    ret add(x, y);
                }
            }
        """)
        assert "ADD" in asm

    def test_subtraction_produces_sub(self):
        asm = compile("""
            module test {
                I16 main() {
                    I16 x = 30 - 10;
                    ret x;
                }
            }
        """)
        assert "SUB" in asm or "MOV" in asm  # may constant-fold

    def test_multiplication_produces_mul(self):
        asm = compile("""
            module test {
                I16 x = 3;
                I16 y = 4;
                I16 mul(I16 a, I16 b) { ret a * b; }
                I16 main() {
                    ret mul(x, y);
                }
            }
        """)
        assert "MUL" in asm

    def test_constant_in_asm(self):
        asm = compile("""
            module test {
                I16 main() {
                    I16 x = 42;
                    ret x;
                }
            }
        """)
        assert "V42" in asm or "42" in asm

    def test_signed_modulo_uses_signed_adjustment(self):
        asm = compile("""
            module test {
                I16 x = 7;
                I16 y = 3;
                I16 rem(I16 a, I16 b) { ret a % b; }
                I16 main() { ret rem(x, y); }
            }
        """)
        assert "# Signed modulo" in asm
        assert "__smod_neg_" in asm
        assert "RSB" in asm

    def test_signed_modulo_by_zero_runtime_path_returns_zero(self):
        asm = compile("""
            module test {
                I16 zero = 0;
                I16 rem(I16 a, I16 b) {
                    I16 p0 = 0; I16 p1 = 1; I16 p2 = 2; I16 p3 = 3;
                    I16 p4 = 4; I16 p5 = 5; I16 p6 = 6; I16 p7 = 7;
                    I16 p8 = 8; I16 p9 = 9; I16 p10 = 10; I16 p11 = 11;
                    I16 p12 = 12; I16 p13 = 13; I16 p14 = 14; I16 p15 = 15;
                    ret a % b;
                }
                I16 main() { ret rem(7, zero); }
            }
        """)
        assert "__smod_zero_" in asm
        assert "MOV" in asm and "V0" in asm

    def test_float_unary_minus_uses_fp_subtract(self):
        asm = compile("""
            module test {
                F16 value = 1.0;
                F16 neg(F16 x) {
                    ret -x;
                }
                F16 main() { ret neg(value); }
            }
        """)
        assert "FSUB" in asm
        assert "RSB" not in asm


class TestFunctionCalls:
    def test_function_call_produces_bl(self):
        asm = compile("""
            module test {
                I16 keep(I16 n) {
                    I16 out = n;
                    ASM([[in]] R0 = n; [[out]] R0 = out;) {
                        ADD R0, R0, V0
                    }
                    ret out;
                }
                I16 main() {
                    ret keep(3);
                }
            }
        """)
        assert "BL keep" in asm

    def test_function_label_present(self):
        asm = compile("""
            module test {
                I16 keep(I16 n) {
                    I16 out = n;
                    ASM([[in]] R0 = n; [[out]] R0 = out;) {
                        ADD R0, R0, V0
                    }
                    ret out;
                }
                I16 main() {
                    ret keep(4);
                }
            }
        """)
        assert "keep:" in asm

    def test_callee_function_referenced(self):
        asm = compile("""
            module test {
                I16 double(I16 n) {
                    I16 out = n + n;
                    ASM([[in]] R0 = out; [[out]] R0 = out;) {
                        ADD R0, R0, V0
                    }
                    ret out;
                }
                I16 main() {
                    I16 r = double(5);
                    ret r;
                }
            }
        """)
        assert "BL double" in asm or "double:" in asm

    def test_recursive_function(self):
        asm = compile("""
            module test {
                I16 factorial(I16 n) {
                    if (n <= 1) { ret 1; }
                    ret n * factorial(n - 1);
                }
                I16 main() {
                    I16 r = factorial(5);
                    ret r;
                }
            }
        """)
        assert "factorial:" in asm
        assert "BL factorial" in asm


class TestConditionals:
    def test_if_produces_cmp(self):
        asm = compile("""
            module test {
                I16 main() {
                    I16 x = 5;
                    if (x > 3) { ret 1; }
                    ret 0;
                }
            }
        """)
        assert "CMP" in asm

    def test_if_produces_conditional_branch(self):
        # Use function parameter to prevent constant folding/conditional execution
        asm = compile("""
            module test {
                I16 check(I16 x) {
                    if (x > 3) {
                        Print(1);
                        ret 1;
                    }
                    ret 0;
                }
                I16 main() { ret check(5); }
            }
        """)
        has_branch = any(
            b in asm for b in ["BEQ", "BNE", "BGT", "BLT", "BGE", "BLE"]
        )
        assert has_branch, "expected at least one conditional branch instruction"

    def test_if_else_two_paths(self):
        # Use function parameter to prevent constant folding/conditional execution
        asm = compile("""
            module test {
                I16 check(I16 x) {
                    if (x == 5) {
                        Print(1);
                        ret 1;
                    } else {
                        Print(0);
                        ret 0;
                    }
                }
                I16 main() { ret check(5); }
            }
        """)
        assert "CMP" in asm
        assert "__if" in asm.lower() or "else" in asm.lower() or "BEQ" in asm or "BNE" in asm


class TestClassAllocation:
    BASIC_CLASS = """
        module test {
            class Foo {
                I16 val;
                OnAlloc(I16 v) { val = v; }
                OnFree {}
            }
            I16 main() {
                Ptr<Foo> f = Init<Foo>(v: 1);
                Free(f);
                ret 0;
            }
        }
    """

    def test_class_compiles(self):
        asm = compile(self.BASIC_CLASS)
        assert isinstance(asm, str)
        assert len(asm) > 0

    def test_produces_malloc_runtime(self):
        asm = compile(self.BASIC_CLASS)
        assert "__malloc" in asm

    def test_produces_free_runtime(self):
        asm = compile(self.BASIC_CLASS)
        assert "__free" in asm

    def test_on_alloc_is_inlined_when_statically_reachable(self):
        asm = compile(self.BASIC_CLASS)
        assert "Foo_OnAlloc:" not in asm
        assert "__vtable_Foo" in asm
        assert "BL __malloc" in asm
        assert "SAVEM" in asm

    def test_on_free_label(self):
        asm = compile(self.BASIC_CLASS)
        # Foo has empty OnFree so it falls back to Storeable_OnFree
        assert "Storeable_OnFree:" in asm

    def test_bundled_storeable_resolves_outside_project_root(self, tmp_path):
        asm = compile_source(self.BASIC_CLASS, str(tmp_path / "program.vl"))
        assert "Storeable_OnFree:" in asm

    def test_field_stored_by_offset(self):
        asm = compile(self.BASIC_CLASS)
        # Fields are stored via register + offset, no bare "val" in ASM
        lines = asm.splitlines()
        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and not stripped.endswith(":"):
                # Assembly instructions should not reference bare field name "val"
                tokens = stripped.split()
                for tok in tokens:
                    if tok == "val":
                        pytest.fail("bare field name 'val' found in ASM output")


class TestAsmSections:
    """Verify programs produce required ASM boilerplate when needed."""

    MINIMAL_PROGRAM = """
        module test {
            I16 main() { ret 0; }
        }
    """

    # Program that uses syscall (Print)
    SYSCALL_PROGRAM = """
        module test {
            I16 main() { Print(42); ret 0; }
        }
    """

    # Program that uses malloc/free (class allocation)
    ALLOC_PROGRAM = """
        module test {
            class Foo {
                I16 val;
                OnAlloc(I16 v) { val = v; }
            }
            I16 main() {
                Ptr<Foo> f = Init<Foo>(v: 1);
                Free(f);
                ret 0;
            }
        }
    """

    def test_space_section(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "space:" in asm

    def test_main_label(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "main:" in asm

    def test_syscall_routine(self):
        # Only emitted when Print/syscall is used
        asm = compile(self.SYSCALL_PROGRAM)
        assert "__syscall" in asm

    def test_malloc_routine(self):
        # Only emitted when class allocation is used
        asm = compile(self.ALLOC_PROGRAM)
        assert "__malloc" in asm

    def test_free_routine(self):
        # Only emitted when Free is used
        asm = compile(self.ALLOC_PROGRAM)
        assert "__free" in asm

    def test_heap_start_in_space(self):
        # Only emitted when malloc/free is used
        asm = compile(self.ALLOC_PROGRAM)
        assert "__heap_start" in asm

    def test_free_list_head_in_space(self):
        # Only emitted when malloc/free is used
        asm = compile(self.ALLOC_PROGRAM)
        assert "__free_list_head" in asm

    def test_allocator_runtime_uses_unsigned_heap_comparisons(self):
        asm = compile(self.ALLOC_PROGRAM)
        assert "BCS __malloc_found" in asm
        assert "BCC __malloc_use_whole" in asm
        assert "BCC __free_insert" in asm
        assert "__free_coalesce_prev:" in asm
        assert "MOV R3, R6\n    ADD R3, R3, V2\n    SAVEM R4, [R3]" in asm
        assert "BGE __malloc_found" not in asm
        assert "BLT __malloc_use_whole" not in asm
        assert "BLT __free_insert" not in asm

    def test_minimal_program_no_runtime(self):
        """Dead runtime elimination: minimal program shouldn't include unused runtime."""
        asm = compile(self.MINIMAL_PROGRAM)
        # Minimal program should NOT include these since they're not used
        assert "__malloc" not in asm
        assert "__free" not in asm
        assert "__heap_start" not in asm
        assert "__syscall" not in asm
        assert "__vdispatch" not in asm
        assert "__free_list_head" not in asm
        assert "__syscall_param" not in asm
        assert "__syscall_id" not in asm

    def test_print_only_does_not_pull_allocator(self):
        asm = compile(self.SYSCALL_PROGRAM)
        assert "__syscall" in asm
        assert "__malloc" not in asm
        assert "__free" not in asm
        assert "__heap_start" not in asm
        assert "__free_list_head" not in asm

    def test_allocator_program_does_not_pull_syscall(self):
        asm = compile("""
            module test {
                class Foo {
                    I16 val;
                    OnAlloc(I16 v) { val = v; }
                    OnFree {}
                }
                I16 main() {
                    Ptr<Foo> f = Init<Foo>(v: 1);
                    Free(f);
                    ret 0;
                }
            }
        """)
        assert "__malloc" in asm
        assert "__free" in asm
        assert "__heap_start" in asm
        assert "__syscall" not in asm

    def test_virtual_dispatch_runtime_not_forced(self):
        """If a program does not require virtual dispatch, __vdispatch should stay absent."""
        asm = compile(self.MINIMAL_PROGRAM)
        assert "__vdispatch" not in asm


class TestLoops:
    def test_while_loop_compiles(self):
        asm = compile("""
            module test {
                I16 main() {
                    I16 i = 0;
                    while (i < 10) {
                        i = i + 1;
                    }
                    ret i;
                }
            }
        """)
        assert "CMP" in asm
        # Should have a backwards branch (loop)
        assert "B " in asm or "BLT" in asm or "BGE" in asm or "BNE" in asm

    def test_for_loop_compiles(self):
        asm = compile("""
            module test {
                I16 main() {
                    I16 sum = 0;
                    for (I16 i = 0; i < 5; i++) {
                        sum += i;
                    }
                    ret sum;
                }
            }
        """)
        assert isinstance(asm, str)
        assert "CMP" in asm


class TestPointers:
    def test_ptr_field_access(self):
        asm = compile("""
            module test {
                class Node {
                    I16 value;
                    Ptr<Node> next;
                    OnAlloc(I16 val) {
                        value = val;
                        next = null;
                    }
                    OnFree {}
                }
                I16 main() {
                    Ptr<Node> n = Init<Node>(val: 42);
                    Free(n);
                    ret 0;
                }
            }
        """)
        assert "Node_OnAlloc:" not in asm
        assert "__vtable_Node" in asm
        # Verify field access uses offsets, even when OnAlloc is inlined.
        assert "SAVEM" in asm


class TestMultipleFunctions:
    def test_multiple_functions_all_have_labels(self):
        asm = compile("""
            module test {
                I16 foo() {
                    I16 out = 1;
                    ASM([[out]] R0 = out;) { MOV R0, V1 }
                    ret out;
                }
                I16 bar() {
                    I16 out = 2;
                    ASM([[out]] R0 = out;) { MOV R0, V2 }
                    ret out;
                }
                I16 main() {
                    I16 a = foo();
                    I16 b = bar();
                    ret a + b;
                }
            }
        """)
        assert "foo:" in asm
        assert "bar:" in asm
        assert "main:" in asm


class TestGlobalVariables:
    def test_global_var_in_space(self):
        asm = compile("""
            module test {
                I16 counter = 0;
                I16 main() {
                    ret counter;
                }
            }
        """)
        assert "counter" in asm

    def test_negative_global_integer_initializer_is_encoded(self):
        asm = compile("""
            module test {
                I16 counter = -1;
                I16 main() { ret counter; }
            }
        """)
        assert "counter = 1111111111111111" in asm

    def test_byte_global_initializer_and_load_use_byte_width(self):
        asm = compile("""
            module test {
                I8 flag = -1;
                I16 main() { ret flag; }
            }
        """)
        assert "flag = 11111111" in asm
        assert any(
            line.strip().startswith("MOV ") and "[R" in line
            for line in asm.splitlines()
        )
        assert "AND" in asm and "CMP" in asm and "SUBCS" in asm

    def test_char_global_initializer_is_encoded(self):
        asm = compile("""
            module test {
                U8 letter = 'A';
                I16 main() { ret letter; }
            }
        """)
        assert "letter = 01000001" in asm

    def test_negative_global_float_initializer_is_encoded(self):
        asm = compile("""
            module test {
                F16 temp = -1.5;
                F16 main() { ret temp; }
            }
        """)
        assert "temp = F-1.5" in asm


class TestExamplePrograms:
    def test_hello_world(self):
        asm = compile("""
            module hello {
                U0 main() {
                    I16 x = 42;
                    Print(x);
                    ret;
                }
            }
        """)
        assert "main:" in asm
        assert "__syscall" in asm

    def test_factorial(self):
        asm = compile("""
            module factorial {
                I16 factorial(I16 n) {
                    if (n <= 1) {
                        ret 1;
                    }
                    ret n * factorial(n - 1);
                }
                I16 main() {
                    I16 result = factorial(5);
                    Print(result);
                    ret result;
                }
            }
        """)
        assert "factorial:" in asm
        assert "BL factorial" in asm
        assert "MUL" in asm

    def test_linked_list_structure(self):
        asm = compile("""
            module linked_list {
                class Node {
                    I16 value;
                    Ptr<Node> next;
                    OnAlloc(I16 val) {
                        value = val;
                        next = null;
                    }
                    OnFree {}
                    I16 getValue() {
                        ret value;
                    }
                }
                I16 main() {
                    Ptr<Node> head = Init<Node>(val: 10);
                    Ptr<Node> second = Init<Node>(val: 20);
                    I16 sum = 10 + 20;
                    Print(sum);
                    Free(second);
                    Free(head);
                    ret sum;
                }
            }
        """)
        assert "Node_OnAlloc:" not in asm
        # Node has empty OnFree → falls back to Storeable_OnFree
        assert "Storeable_OnFree:" in asm
        assert "Node_getValue:" not in asm
        assert "__malloc" in asm
        assert "__free" in asm


class TestNoBareFieldNames:
    """Ensure field names are resolved to register+offset, not emitted raw."""

    def test_no_bare_field_in_simple_class(self):
        asm = compile("""
            module test {
                class Point {
                    I16 x;
                    I16 y;
                    OnAlloc(I16 a, I16 b) { x = a; y = b; }
                    OnFree {}
                }
                I16 main() {
                    Ptr<Point> p = Init<Point>(a: 1, b: 2);
                    Free(p);
                    ret 0;
                }
            }
        """)
        # Check that instruction operands don't contain bare field references
        for line in asm.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.endswith(":"):
                continue
            # Labels section (space:) may have names, but instructions shouldn't
            # have raw field names as operands
            parts = stripped.split()
            if len(parts) >= 1 and parts[0] in ("MOV", "ADD", "SUB", "SAVEM", "MOVM",
                                                   "CMP", "MUL", "DIV"):
                operand_text = " ".join(parts[1:])
                for field_name in ("x", "y"):
                    # Bare field name as a standalone operand token
                    operand_tokens = [t.strip(",[]") for t in parts[1:]]
                    # Skip register names like R0-R15 and values like V0-V65535
                    filtered = [t for t in operand_tokens
                                if not t.startswith("R") and not t.startswith("V")
                                and not t.startswith("SP") and not t.startswith("PC")
                                and not t.startswith("__")]
                    # "x" or "y" should not appear as a bare operand
                    # (it's fine inside labels like "__if_1_else")
                    assert field_name not in filtered, (
                        f"bare field '{field_name}' in ASM: {stripped}"
                    )


class TestPipelineRobustness:
    """Ensure various programs compile without exceptions."""

    @pytest.mark.parametrize("source", [
        "module t { I16 main() { ret 0; } }",
        "module t { I16 main() { ret 1 + 2; } }",
        "module t { I16 main() { I16 x = 5; ret x; } }",
        "module t { I16 main() { if (1 > 0) { ret 1; } ret 0; } }",
        "module t { I16 f() { ret 1; } I16 main() { ret f(); } }",
        "module t { I16 main() { Print(99); ret 0; } }",
    ])
    def test_compiles_without_error(self, source):
        asm = compile(source)
        assert isinstance(asm, str)
        assert "space:" in asm
        assert "main:" in asm


class TestCompletedRuntimeFeatures:
    def test_imported_module_function_is_callable(self):
        asm = compile_project("""
            module test {
                import stdlib::{math};
                I16 main() {
                    ret Abs(5);
                }
            }
        """)
        assert "Abs:" in asm
        assert "BL Abs" in asm or "__inl" in asm

    def test_cast_expression_compiles_as_noop(self):
        asm = compile("""
            module test {
                I16 main() {
                    Ptr<U8> p = "AB";
                    Ptr<I16> q = Cast<Ptr<I16>>(p);
                    I16 value = q[0];
                    ret value;
                }
            }
        """)
        assert "Cast" not in asm
        assert "MOVM" in asm

    def test_string_literal_pool_is_emitted_and_nul_terminated(self):
        asm = compile("""
            module test {
                Ptr<U8> main() {
                    Ptr<U8> p = "Hi";
                    ret p;
                }
            }
        """)
        assert '__str_1 = "Hi\\0"' in asm
        assert "MOV R0, __str_1" in asm

    def test_byte_index_uses_byte_load(self):
        asm = compile("""
            module test {
                I16 main() {
                    Ptr<U8> p = "AZ";
                    U8 c = p[1];
                    ret c;
                }
            }
        """)
        body = "\n".join(line.strip() for line in asm.splitlines() if line.strip())
        assert "MOVM R0, [" not in body
        assert any(line.strip().startswith("MOV ") and "[" in line for line in asm.splitlines())

    def test_u8_local_update_wraps_before_return(self):
        asm = compile("""
            module test {
                I16 main() {
                    U8 x = 255;
                    x++;
                    ret x;
                }
            }
        """)
        assert "MOV R0, V256" not in asm
        assert "MOV R0, V0" in asm

    def test_u8_arithmetic_temporary_wraps_before_comparison(self):
        asm = compile("""
            module test {
                I16 main() {
                    U8 x = 255;
                    U8 y = 1;
                    if (x + y == 0) { ret 1; }
                    ret 0;
                }
            }
        """)
        assert "V256" not in asm
        assert "CMP" in asm

    def test_word_index_scales_by_two(self):
        asm = compile("""
            module test {
                I16 main() {
                    Ptr<I16> p = Cast<Ptr<I16>>("ABCD");
                    I16 x = p[1];
                    ret x;
                }
            }
        """)
        assert "MOVM" in asm
        assert asm.count("ADD") >= 2

    def test_free_on_class_invokes_destructor_before_raw_free(self):
        asm = compile("""
            module test {
                I16 destroyed = 0;
                class Foo {
                    OnAlloc() {}
                    OnFree {
                        destroyed = 7;
                    }
                }
                I16 main() {
                    Ptr<Foo> f = Init<Foo>();
                    Free(f);
                    ret destroyed;
                }
            }
        """)
        assert "destroyed" in asm
        assert "V7" in asm
        if "BL Foo_OnFree" in asm and "BL __free" in asm:
            assert asm.index("BL Foo_OnFree") < asm.index("BL __free")

    def test_init_without_onalloc_does_not_call_missing_constructor(self):
        asm = compile("""
            module test {
                I16 sink = 0;
                class Plain {
                    I16 value;
                }
                I16 main() {
                    Ptr<Plain> p = Init<Plain>();
                    ASM([[in]] R0 = p;) {
                        SAVEM R0, [sink]
                    }
                    Free(p);
                    ret 0;
                }
            }
        """)
        assert "Plain_OnAlloc" not in asm
        assert "BL __malloc" in asm
        assert "BL __free" in asm

    def test_inherited_fields_are_addressed_from_parent_layout(self):
        asm = compile("""
            module test {
                class Base {
                    I8 flag;
                    OnAlloc(I8 f) { flag = f; }
                }
                class Child : Base {
                    I16 value;
                    OnAlloc(I8 f, I16 v) {
                        flag = f;
                        value = v;
                    }
                    I16 Sum() {
                        ret flag + value;
                    }
                }
                I16 main() {
                    Ptr<Child> c = Init<Child>(f: 3, v: 4);
                    I16 result = c.Sum();
                    Free(c);
                    ret result;
                }
            }
        """)
        assert "SAVE" in asm
        assert "SAVEM" in asm

    def test_arg_shuffle_uses_temp_stack_for_register_args(self):
        asm = compile("""
            module test {
                I16 combine(I16 a, I16 b, I16 c, I16 d) {
                    I16 pad0 = a + b; I16 pad1 = pad0 + c; I16 pad2 = pad1 + d;
                    I16 pad3 = pad2 + a; I16 pad4 = pad3 + b; I16 pad5 = pad4 + c;
                    I16 pad6 = pad5 + d; I16 pad7 = pad6 + a; I16 pad8 = pad7 + b;
                    I16 pad9 = pad8 + c; I16 pad10 = pad9 + d; I16 pad11 = pad10 + a;
                    I16 ab = a * 1000 + b * 100;
                    I16 cd = c * 10 + d;
                    ret ab + cd;
                }
                I16 main() {
                    I16 a = 1;
                    I16 b = 2;
                    I16 c = 3;
                    I16 d = 4;
                    ret combine(d, c, b, a);
                }
            }
        """)
        assert "BL combine" in asm
        assert "SAVEM" in asm and "MOVM R0" in asm

    def test_stack_arguments_are_loaded_from_frame(self):
        asm = compile("""
            module test {
                I16 six(I16 a, I16 b, I16 c, I16 d, I16 e, I16 f) {
                    I16 p0 = a + b; I16 p1 = p0 + c; I16 p2 = p1 + d;
                    I16 p3 = p2 + e; I16 p4 = p3 + f; I16 p5 = p4 + a;
                    I16 p6 = p5 + b; I16 p7 = p6 + c; I16 p8 = p7 + d;
                    I16 p9 = p8 + e; I16 p10 = p9 + f; I16 p11 = p10 + a;
                    I16 p12 = p11 + b; I16 p13 = p12 + c; I16 p14 = p13 + d;
                    I16 p15 = p14 + e; I16 p16 = p15 + f; I16 p17 = p16 + a;
                    ret e * 10 + f;
                }
                I16 main() {
                    ret six(1, 2, 3, 4, 5, 6);
                }
            }
        """)
        assert "BL six" in asm
        assert "MOV R12, R11" in asm
        assert "ADD R12, R12, V4" in asm

    def test_post_update_writes_back_to_field_and_index(self):
        asm = compile("""
            module test {
                U8 g = 65;
                class A {
                    I16 x;
                    OnAlloc() { x = 1; }
                }
                I16 main() {
                    Ptr<A> a = Init<A>();
                    a.x++;
                    Ptr<U8> p = &g;
                    p[0]++;
                    I16 result = a.x + p[0];
                    Free(a);
                    ret result;
                }
            }
        """)
        assert "SAVE" in asm
        assert "SAVEM" in asm
        assert asm.count("ADD") >= 2

    def test_address_of_global_field_and_index_compile(self):
        asm = compile("""
            module test {
                I16 g = 7;
                class Box {
                    I16 value;
                    OnAlloc(I16 v) { value = v; }
                    Ptr<I16> ValuePtr() { ret &value; }
                }
                I16 main() {
                    Ptr<I16> gp = &g;
                    Ptr<Box> b = Init<Box>(v: 5);
                    Ptr<I16> fp = b.ValuePtr();
                    Ptr<I16> ip = &gp[0];
                    I16 result = *gp + *fp + *ip;
                    Free(b);
                    ret result;
                }
            }
        """)
        assert "MOV" in asm and "g" in asm
        assert "MOVM" in asm

    def test_inline_asm_callee_saved_register_is_preserved(self):
        asm = compile("""
            module test {
                I16 main() {
                    ASM() {
                        MOV R4, V9
                    }
                    ret 0;
                }
            }
        """)
        assert "SAVEM R4, [SP]" in asm
        assert "MOVM R4, [SP]" in asm

    def test_inline_asm_r10_is_preserved_as_callee_saved(self):
        asm = compile("""
            module test {
                I16 main() {
                    ASM() {
                        MOV R10, V9
                    }
                    ret 0;
                }
            }
        """)
        assert "SAVEM R10, [SP]" in asm
        assert "MOVM R10, [SP]" in asm

    def test_inline_asm_input_binding_survives_dead_code_elimination(self):
        asm = compile("""
            module test {
                I16 g = 4;
                I16 main() {
                    I16 x = 0;
                    ASM([[in]] R0 = g; [[out]] R1 = x;) {
                        ADD R1, R0, V2
                    }
                    ret x;
                }
            }
        """)
        lines = [line.strip() for line in asm.splitlines()]
        asm_matches = [
            i for i, line in enumerate(lines)
            if re.match(r"ADD\s+R1\s*,\s*R0\s*,", line)
        ]
        assert asm_matches
        asm_idx = asm_matches[0]
        setup_window = lines[max(0, asm_idx - 4):asm_idx]
        assert any(re.match(r"MOV\s+R0\s*,\s*R\d+", line) for line in setup_window)

    def test_inline_asm_pointer_input_prevents_scalar_replacement(self):
        asm = compile("""
            module test {
                I16 sink = 0;
                class Box {
                    I16 value;
                    OnAlloc() { value = 1; }
                }
                I16 main() {
                    Box box = Init<Box>();
                    ASM([[in]] R0 = box;) {
                        SAVEM R0, [sink]
                    }
                    Free(box);
                    ret 0;
                }
            }
        """)
        assert "BL __malloc" in asm
        assert re.search(r"SAVEM\s+R0\s*,\s*\[\s*sink\s*\]", asm)

    def test_spill_slots_are_materialized(self):
        asm = compile("""
            module test {
                I16 g0 = 0; I16 g1 = 1; I16 g2 = 2; I16 g3 = 3;
                I16 g4 = 4; I16 g5 = 5; I16 g6 = 6; I16 g7 = 7;
                I16 g8 = 8; I16 g9 = 9; I16 g10 = 10; I16 g11 = 11;
                I16 id(I16 x) {
                    I16 y0 = x + 1; I16 y1 = y0 + 1; I16 y2 = y1 + 1; I16 y3 = y2 + 1;
                    I16 y4 = y3 + 1; I16 y5 = y4 + 1; I16 y6 = y5 + 1; I16 y7 = y6 + 1;
                    I16 y8 = y7 + 1; I16 y9 = y8 + 1; I16 y10 = y9 + 1; I16 y11 = y10 + 1;
                    ret y11;
                }
                I16 main() {
                    I16 a0 = g0; I16 a1 = g1; I16 a2 = g2; I16 a3 = g3;
                    I16 a4 = g4; I16 a5 = g5; I16 a6 = g6; I16 a7 = g7;
                    I16 a8 = g8; I16 a9 = g9; I16 a10 = g10; I16 a11 = g11;
                    I16 k = id(a0);
                    ret a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10 + a11 + k;
                }
            }
        """)
        assert "MOV R10, R11" in asm or "MOV R12, R11" in asm


class TestConditionalExecutionOptimization:
    def test_if_else_select_prefers_conditional_exec(self):
        asm = compile("""
            module test {
                I16 select(I16 a, I16 b) {
                    I16 x = 0;
                    if (a > b) {
                        x = a;
                    } else {
                        x = b;
                    }
                    ret x;
                }
                I16 main() { ret select(7, 3); }
            }
        """)
        # Preferred optimized shape: MAX or predicated moves; fallback branch form is acceptable.
        assert (
            ("MAX" in asm)
            or ("CMP" in asm and "MOVGT" in asm and ("MOVLE" in asm or "MOVLT" in asm))
            or any(b in asm for b in ["BGT", "BLT", "BGE", "BLE", "BEQ", "BNE"])
        )

    def test_unsigned_integer_comparison_uses_unsigned_conditions(self):
        asm = compile("""
            module test {
                I16 gtUnsigned(U16 a, U16 b) {
                    if (a > b) { ret 1; }
                    ret 0;
                }
                I16 gtSigned(I16 a, I16 b) {
                    if (a > b) { ret 1; }
                    ret 0;
                }
                I16 main() {
                    ret gtUnsigned(50000, 40000) + gtSigned(1, 0);
                }
            }
        """)
        assert any(op in asm for op in ("BHI", "BLS", "MOVHI", "MOVLS"))
        assert any(op in asm for op in ("BGT", "BLE", "MOVGT", "MOVLE"))
