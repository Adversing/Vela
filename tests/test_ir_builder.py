import pytest

from src.errors import CodeGenError
from src.ir.builder import IRBuilder
from src.ir.instructions import IROp
from src.lexer.lexer import Lexer
from src.parser.ast_nodes import BinaryExpr, CallExpr, Expr, IdentifierExpr, IntLiteral, Stmt
from src.parser.parser import Parser
from src.semantic.type_checker import TypeChecker
from src.semantic.types import ClassType, I16


def _build_ir(source: str):
    ast = Parser(Lexer(source, "<ir>").tokenize(), "<ir>").parse()
    checker = TypeChecker()
    checker.check(ast)
    return IRBuilder(checker).build(ast)


def test_ir_builder_rejects_unsupported_statement_node():
    builder = IRBuilder(TypeChecker())
    with pytest.raises(CodeGenError, match="unsupported statement node Stmt"):
        builder._build_stmt(Stmt())


def test_ir_builder_rejects_unsupported_expression_node():
    builder = IRBuilder(TypeChecker())
    with pytest.raises(CodeGenError, match="unsupported expression node Expr"):
        builder._build_expr(Expr())


def test_ir_builder_rejects_unsupported_assignment_target():
    builder = IRBuilder(TypeChecker())
    target = BinaryExpr(op="+", left=IntLiteral(value=1), right=IntLiteral(value=2))
    with pytest.raises(CodeGenError, match="unsupported assignment target BinaryExpr"):
        builder._store_lvalue(target, "%value")


def test_ir_builder_rejects_non_identifier_call_target():
    builder = IRBuilder(TypeChecker())
    call = CallExpr(callee=IntLiteral(value=1), args=[])
    with pytest.raises(CodeGenError, match="unsupported call target IntLiteral"):
        builder._build_call(call)


def test_ir_builder_rejects_missing_global_type_metadata():
    builder = IRBuilder(TypeChecker())
    with pytest.raises(CodeGenError, match="global variable 'missing' has no type information"):
        builder._build_expr(IdentifierExpr(name="missing"))


def test_ir_builder_rejects_missing_class_field_metadata():
    checker = TypeChecker()
    checker.class_types["Box"] = ClassType(name="Box", fields=(("value", I16),))
    builder = IRBuilder(checker)

    with pytest.raises(CodeGenError, match="class 'Box' has no field 'other'"):
        builder._class_field_info("Box", "other")


def test_bool_wrapper_equality_loads_payload_before_compare():
    func_ir = _build_ir("""
        module test {
            class Bool {
                I8 value;
                OnAlloc(I8 v) { value = v; }
            }
            I16 main() {
                Bool flag = true;
                if (flag == true) { ret 1; }
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    load_dests = {
        instr.dest for instr in main_ir
        if instr.op == IROp.LOAD_8 and instr.dest is not None
    }
    assert load_dests
    assert any(
        instr.op == IROp.CMP
        and (instr.src1 in load_dests or instr.src2 in load_dests)
        for instr in main_ir
    )


def test_multi_dispatch_lowers_to_class_method_with_arguments():
    func_ir = _build_ir("""
        module test {
            class A {
                OnAlloc() {}
                U0 M(I16 x) {}
            }
            I16 main() {
                A a = Init<A>();
                {a}.M(7);
                Free(a);
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    calls = [instr for instr in main_ir if instr.op in (IROp.CALL, IROp.VCALL)]
    assert not any(instr.op == IROp.CALL and instr.label == "M" for instr in calls)
    assert any(
        (
            instr.op == IROp.VCALL
            and instr.label == "M"
            and instr.arg_count == 2
        )
        or (
            instr.op == IROp.CALL
            and instr.label == "A_M"
            and instr.arg_count == 2
        )
        for instr in calls
    )


def test_init_onalloc_call_does_not_overwrite_object_pointer():
    func_ir = _build_ir("""
        module test {
            I16 clobber() { ret 1234; }
            class Foo {
                OnAlloc() { clobber(); }
                I16 Value() { ret 7; }
            }
            I16 main() {
                Foo f = Init<Foo>();
                I16 value = f.Value();
                Free(f);
                ret value;
            }
        }
    """)
    main_ir = func_ir["main"]
    onalloc = next(
        instr for instr in main_ir
        if instr.op == IROp.CALL and instr.label == "Foo_OnAlloc"
    )
    assert onalloc.dest is None


def test_autobox_onalloc_call_does_not_overwrite_object_pointer():
    func_ir = _build_ir("""
        module test {
            I16 clobber() { ret 1234; }
            class Int {
                I16 value;
                OnAlloc(I16 v) {
                    value = v;
                    clobber();
                }
            }
            I16 main() {
                Int value = 1;
                Free(value);
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    onalloc = next(
        instr for instr in main_ir
        if instr.op == IROp.CALL and instr.label == "Int_OnAlloc"
    )
    assert onalloc.dest is None


def test_asm_input_binding_loads_global_value_from_memory():
    func_ir = _build_ir("""
        module test {
            I16 g = 7;
            I16 main() {
                I16 out = 0;
                ASM(
                    [[in]] R0 = g;
                    [[out]] R0 = out;
                ) {
                    ADD R0, R0, V5
                }
                ret out;
            }
        }
    """)
    main_ir = func_ir["main"]

    assert any(instr.op == IROp.LOAD_GLOBAL_ADDR and instr.label == "g" for instr in main_ir)
    assert any(instr.op == IROp.LOAD_16 for instr in main_ir)
    assert not any(instr.op == IROp.MOV and instr.src1 == "g" for instr in main_ir)


def test_asm_output_binding_stores_global_value_to_memory():
    func_ir = _build_ir("""
        module test {
            I16 g = 0;
            I16 main() {
                ASM([[out]] R0 = g;) {
                    MOV R0, V9
                }
                ret g;
            }
        }
    """)
    main_ir = func_ir["main"]

    assert any(instr.op == IROp.LOAD_GLOBAL_ADDR and instr.label == "g" for instr in main_ir)
    assert any(instr.op == IROp.STORE_16 and instr.src1 == "R0" for instr in main_ir)


def test_asm_output_binding_stores_current_class_field():
    func_ir = _build_ir("""
        module test {
            class Box {
                I16 value;
                OnAlloc() {
                    ASM([[out]] R0 = value;) {
                        MOV R0, V9
                    }
                }
            }
        }
    """)
    onalloc_ir = func_ir["Box_OnAlloc"]

    assert any(instr.op == IROp.STORE_16 and instr.src1 == "R0" for instr in onalloc_ir)


def test_u8_local_assignment_is_truncated_in_register():
    func_ir = _build_ir("""
        module test {
            I16 main() {
                U8 x = 255;
                x++;
                ret x;
            }
        }
    """)
    main_ir = func_ir["main"]
    assert any(instr.op == IROp.AND for instr in main_ir)
    assert any(
        instr.op == IROp.CONST and instr.imm == 0xFF
        for instr in main_ir
    )


def test_u8_arithmetic_temporary_is_truncated_before_comparison():
    func_ir = _build_ir("""
        module test {
            I16 main() {
                U8 x = 255;
                U8 y = 1;
                if (x + y == 0) { ret 1; }
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    add = next(instr for instr in main_ir if instr.op == IROp.ADD)
    truncated = next(
        instr for instr in main_ir
        if instr.op == IROp.AND and instr.src1 == add.dest
    )
    assert any(
        instr.op == IROp.CMP and instr.src1 == truncated.dest
        for instr in main_ir
    )


def test_i8_unary_temporary_is_sign_extended_before_comparison():
    func_ir = _build_ir("""
        module test {
            I16 main() {
                I8 x = 1;
                if (-x == -1) { ret 1; }
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    negated = next(instr for instr in main_ir if instr.op == IROp.RSB)
    masked = next(
        instr for instr in main_ir
        if instr.op == IROp.AND and instr.src1 == negated.dest
    )
    extended = next(
        instr for instr in main_ir
        if instr.op == IROp.SIGN_EXTEND_8 and instr.src1 == masked.dest
    )
    assert any(
        instr.op == IROp.CMP and instr.src1 == extended.dest
        for instr in main_ir
    )


def test_unsigned_division_and_modulo_use_unsigned_ir_ops():
    func_ir = _build_ir("""
        module test {
            U16 divide(U16 x) { ret x / 2; }
            U16 mod(U16 x) { ret x % 2; }
            U16 assign(U16 x) {
                x /= 2;
                ret x;
            }
        }
    """)

    assert any(instr.op == IROp.UDIV for instr in func_ir["divide"])
    assert any(instr.op == IROp.UMOD for instr in func_ir["mod"])
    assert any(instr.op == IROp.UDIV for instr in func_ir["assign"])


def test_init_without_onalloc_does_not_emit_missing_constructor_call():
    func_ir = _build_ir("""
        module test {
            class Plain {
                I16 value;
            }
            I16 main() {
                Ptr<Plain> p = Init<Plain>();
                Free(p);
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    assert not any(
        instr.op == IROp.CALL and instr.label == "Plain_OnAlloc"
        for instr in main_ir
    )


def test_i8_cast_sign_extends_in_register():
    func_ir = _build_ir("""
        module test {
            I16 main() {
                ret Cast<I8>(255);
            }
        }
    """)
    main_ir = func_ir["main"]
    assert any(instr.op == IROp.AND for instr in main_ir)
    assert any(instr.op == IROp.SIGN_EXTEND_8 for instr in main_ir)


def test_logical_expression_short_circuits_rhs_call():
    func_ir = _build_ir("""
        module test {
            class Bool {
                I8 value;
                OnAlloc(I8 v) { value = v; }
            }
            Bool rhs() {
                ret Init<Bool>(v: 1);
            }
            I16 main() {
                Bool value = false && rhs();
                Free(value);
                ret 0;
            }
        }
    """)
    main_ir = func_ir["main"]
    call_idx = next(
        idx for idx, instr in enumerate(main_ir)
        if instr.op == IROp.CALL and instr.label == "rhs"
    )
    branch_ops = {
        IROp.BRANCH,
        IROp.BRANCH_EQ,
        IROp.BRANCH_NE,
        IROp.BRANCH_LT,
        IROp.BRANCH_GT,
        IROp.BRANCH_LE,
        IROp.BRANCH_GE,
        IROp.BRANCH_LO,
        IROp.BRANCH_HI,
        IROp.BRANCH_LS,
        IROp.BRANCH_HS,
    }
    assert any(instr.op in branch_ops for instr in main_ir[:call_idx])
    assert not any(instr.op == IROp.AND for instr in main_ir)


def test_for_loop_local_shadowing_does_not_leak_after_loop():
    func_ir = _build_ir("""
        module test {
            I16 main() {
                I16 x = 10;
                for (I16 x = 0; x < 1; x++) {}
                ret x;
            }
        }
    """)
    main_ir = func_ir["main"]
    outer_dest = next(
        instr.dest for instr in main_ir
        if instr.op == IROp.MOV and instr.src1
        and any(c.op == IROp.CONST and c.dest == instr.src1 and c.imm == 10 for c in main_ir)
    )
    assert main_ir[-1].op == IROp.RET
    assert main_ir[-1].src1 == outer_dest
