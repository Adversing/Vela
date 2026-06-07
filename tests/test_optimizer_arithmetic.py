from src.ir.instructions import IROp, IRInstr
from src.optimizer.constant_folder import constant_fold
from src.optimizer.dead_code import eliminate_dead_code
from src.optimizer.escape_analysis import escape_analyze
from src.optimizer.strength_reduction import strength_reduce


def _last_const_imm(instrs: list[IRInstr]) -> int:
    consts = [instr for instr in instrs if instr.op == IROp.CONST]
    assert consts
    return int(consts[-1].imm)


def test_constant_fold_signed_division_truncates_toward_zero():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=-3),
        IRInstr(op=IROp.CONST, dest="b", imm=2),
        IRInstr(op=IROp.DIV, dest="q", src1="a", src2="b"),
    ])
    assert _last_const_imm(result) == 0xFFFF


def test_constant_fold_signed_modulo_keeps_dividend_sign():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=-3),
        IRInstr(op=IROp.CONST, dest="b", imm=2),
        IRInstr(op=IROp.MOD, dest="r", src1="a", src2="b"),
    ])
    assert _last_const_imm(result) == 0xFFFF


def test_constant_fold_unsigned_division_uses_u16_values():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=50000),
        IRInstr(op=IROp.CONST, dest="b", imm=2),
        IRInstr(op=IROp.UDIV, dest="q", src1="a", src2="b"),
    ])
    assert _last_const_imm(result) == 25000


def test_constant_fold_unsigned_modulo_uses_u16_values():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=50001),
        IRInstr(op=IROp.CONST, dest="b", imm=2),
        IRInstr(op=IROp.UMOD, dest="r", src1="a", src2="b"),
    ])
    assert _last_const_imm(result) == 1


def test_constant_fold_signed_modulo_by_zero_matches_codegen_semantics():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=7),
        IRInstr(op=IROp.CONST, dest="b", imm=0),
        IRInstr(op=IROp.MOD, dest="r", src1="a", src2="b"),
    ])
    assert _last_const_imm(result) == 0


def test_constant_fold_unsigned_modulo_by_zero_matches_codegen_semantics():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=7),
        IRInstr(op=IROp.CONST, dest="b", imm=0),
        IRInstr(op=IROp.UMOD, dest="r", src1="a", src2="b"),
    ])
    assert _last_const_imm(result) == 0


def test_constant_fold_distinguishes_logical_and_arithmetic_shift():
    logical = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=-1),
        IRInstr(op=IROp.CONST, dest="b", imm=1),
        IRInstr(op=IROp.SHR, dest="r", src1="a", src2="b"),
    ])
    arithmetic = constant_fold([
        IRInstr(op=IROp.CONST, dest="a", imm=-1),
        IRInstr(op=IROp.CONST, dest="b", imm=1),
        IRInstr(op=IROp.ASR, dest="r", src1="a", src2="b"),
    ])
    assert _last_const_imm(logical) == 0x7FFF
    assert _last_const_imm(arithmetic) == 0xFFFF


def test_strength_reduce_does_not_rewrite_division_to_logical_shift():
    result = strength_reduce([
        IRInstr(op=IROp.CONST, dest="two", imm=2),
        IRInstr(op=IROp.DIV, dest="q", src1="x", src2="two"),
    ])
    assert any(instr.op == IROp.DIV for instr in result)
    assert not any(instr.op == IROp.SHR for instr in result)


def test_strength_reduce_forgets_constant_after_register_overwrite():
    result = strength_reduce([
        IRInstr(op=IROp.CONST, dest="x", imm=2),
        IRInstr(op=IROp.ADD, dest="x", src1="a", src2="b"),
        IRInstr(op=IROp.MUL, dest="out", src1="y", src2="x"),
    ])

    assert any(instr.op == IROp.MUL and instr.dest == "out" for instr in result)
    assert not any(instr.op == IROp.SHL and instr.dest == "out" for instr in result)


def test_strength_reduce_clears_constants_at_labels():
    result = strength_reduce([
        IRInstr(op=IROp.CONST, dest="two", imm=2),
        IRInstr(op=IROp.LABEL, label="join"),
        IRInstr(op=IROp.MUL, dest="out", src1="y", src2="two"),
    ])

    assert any(instr.op == IROp.MUL and instr.dest == "out" for instr in result)
    assert not any(instr.op == IROp.SHL and instr.dest == "out" for instr in result)


def test_dead_code_preserves_inline_asm_input_register_setup():
    result = eliminate_dead_code([
        IRInstr(op=IROp.LABEL, label="main"),
        IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="addr", label="g"),
        IRInstr(op=IROp.LOAD_16, dest="value", src1="addr"),
        IRInstr(op=IROp.MOV, dest="R0", src1="value"),
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["ADD R1, R0, V2"]),
        IRInstr(op=IROp.MOV, dest="out", src1="R1"),
        IRInstr(op=IROp.RET, src1="out"),
    ])

    assert any(instr.op == IROp.MOV and instr.dest == "R0" for instr in result)


def test_constant_fold_forgets_physical_registers_across_inline_asm():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="five", imm=5),
        IRInstr(op=IROp.MOV, dest="R0", src1="five"),
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["MOV R0, V9"]),
        IRInstr(op=IROp.MOV, dest="out", src1="R0"),
        IRInstr(op=IROp.ADD, dest="sum", src1="out", src2="five"),
    ])

    assert any(instr.op == IROp.ADD and instr.dest == "sum" for instr in result)
    assert not any(instr.op == IROp.CONST and instr.dest == "sum" for instr in result)


def test_constant_fold_forgets_physical_registers_across_call():
    result = constant_fold([
        IRInstr(op=IROp.CONST, dest="five", imm=5),
        IRInstr(op=IROp.MOV, dest="R0", src1="five"),
        IRInstr(op=IROp.CALL, label="clobber", arg_count=0),
        IRInstr(op=IROp.MOV, dest="out", src1="R0"),
        IRInstr(op=IROp.ADD, dest="sum", src1="out", src2="five"),
    ])

    assert any(instr.op == IROp.ADD and instr.dest == "sum" for instr in result)
    assert not any(instr.op == IROp.CONST and instr.dest == "sum" for instr in result)


def test_strength_reduce_forgets_physical_registers_across_call():
    result = strength_reduce([
        IRInstr(op=IROp.CONST, dest="R0", imm=2),
        IRInstr(op=IROp.CALL, label="clobber", arg_count=0),
        IRInstr(op=IROp.MUL, dest="out", src1="value", src2="R0"),
    ])

    assert any(instr.op == IROp.MUL and instr.dest == "out" for instr in result)
    assert not any(instr.op == IROp.SHL and instr.dest == "out" for instr in result)


def test_escape_analysis_does_not_scalarise_across_inline_asm():
    instrs = [
        IRInstr(op=IROp.CONST, dest="size", imm=4),
        IRInstr(op=IROp.PARAM, src1="size", imm=0),
        IRInstr(op=IROp.CALL, dest="obj", label="__malloc", arg_count=1),
        IRInstr(op=IROp.MOV, dest="R0", src1="obj"),
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["SAVEM R0, [sink]"]),
        IRInstr(op=IROp.PARAM, src1="obj", imm=0),
        IRInstr(op=IROp.CALL, label="__free", arg_count=1),
    ]

    result = escape_analyze(instrs)

    assert result == instrs


def test_escape_analysis_keeps_object_passed_to_remaining_vcall():
    instrs = [
        IRInstr(op=IROp.CONST, dest="size", imm=4),
        IRInstr(op=IROp.PARAM, src1="size", imm=0),
        IRInstr(op=IROp.CALL, dest="obj", label="__malloc", arg_count=1),
        IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="vt", label="__vtable_Box"),
        IRInstr(op=IROp.STORE_16, src1="vt", src2="obj"),
        IRInstr(op=IROp.PARAM, src1="obj", imm=0),
        IRInstr(op=IROp.VCALL, dest="res", src1="obj", label="Value", imm=0, arg_count=1),
        IRInstr(op=IROp.PARAM, src1="obj", imm=0),
        IRInstr(op=IROp.CALL, label="__free", arg_count=1),
        IRInstr(op=IROp.RET, src1="res"),
    ]

    result = escape_analyze(instrs)

    assert result == instrs
