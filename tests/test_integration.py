
import pytest

from src.main import compile_source


def compile(source: str) -> str:
    """Compile Vela source and return the assembly text."""
    return compile_source(source, "test.vl")


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
                I16 main() {
                    I16 x = 10 + 20;
                    ret x;
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
                I16 mul(I16 a, I16 b) { ret a * b; }
                I16 main() {
                    I16 x = mul(3, 4);
                    ret x;
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


class TestFunctionCalls:
    def test_function_call_produces_bl(self):
        asm = compile("""
            module test {
                I16 add(I16 a, I16 b) { ret a + b; }
                I16 main() {
                    I16 r = add(3, 4);
                    ret r;
                }
            }
        """)
        assert "BL" in asm

    def test_function_label_present(self):
        asm = compile("""
            module test {
                I16 add(I16 a, I16 b) { ret a + b; }
                I16 main() {
                    I16 r = add(3, 4);
                    ret r;
                }
            }
        """)
        assert "add:" in asm

    def test_callee_function_referenced(self):
        asm = compile("""
            module test {
                I16 double(I16 n) { ret n + n; }
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
        asm = compile("""
            module test {
                I16 main() {
                    I16 x = 5;
                    if (x > 3) { ret 1; }
                    ret 0;
                }
            }
        """)
        has_branch = any(
            b in asm for b in ["BEQ", "BNE", "BGT", "BLT", "BGE", "BLE"]
        )
        assert has_branch, "expected at least one conditional branch instruction"

    def test_if_else_two_paths(self):
        asm = compile("""
            module test {
                I16 main() {
                    I16 x = 5;
                    if (x == 5) { ret 1; } else { ret 0; }
                }
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

    def test_on_alloc_label(self):
        asm = compile(self.BASIC_CLASS)
        assert "Foo_OnAlloc:" in asm

    def test_on_free_label(self):
        asm = compile(self.BASIC_CLASS)
        # Foo has empty OnFree so it falls back to Storeable_OnFree
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
    """Verify all programs produce the required ASM boilerplate."""

    MINIMAL_PROGRAM = """
        module test {
            I16 main() { ret 0; }
        }
    """

    def test_space_section(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "space:" in asm

    def test_main_label(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "main:" in asm

    def test_syscall_routine(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "__syscall" in asm

    def test_malloc_routine(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "__malloc" in asm

    def test_free_routine(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "__free" in asm

    def test_heap_start_in_space(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "__heap_start" in asm

    def test_free_list_head_in_space(self):
        asm = compile(self.MINIMAL_PROGRAM)
        assert "__free_list_head" in asm


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
        assert "Node_OnAlloc:" in asm
        # Verify field access uses offsets
        assert "SAVEM" in asm


class TestMultipleFunctions:
    def test_multiple_functions_all_have_labels(self):
        asm = compile("""
            module test {
                I16 foo() { ret 1; }
                I16 bar() { ret 2; }
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
        assert "Node_OnAlloc:" in asm
        # Node has empty OnFree → falls back to Storeable_OnFree
        assert "Storeable_OnFree:" in asm
        assert "Node_getValue:" in asm
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
