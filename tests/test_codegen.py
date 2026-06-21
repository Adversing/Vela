import re

import pytest

from src.codegen.register_allocator import RegisterAllocator
from src.codegen.asm_emitter import AsmEmitter
from src.errors import CodeGenError
from src.ir.instructions import IROp, IRInstr
from src.semantic.type_checker import TypeChecker


def emit_main(instrs: list[IRInstr]) -> str:
    return AsmEmitter(TypeChecker()).emit({
        "main": [IRInstr(op=IROp.LABEL, label="main"), *instrs],
    })


def test_emitter_rejects_missing_main_entry():
    with pytest.raises(CodeGenError, match="program entry point 'main' is not defined"):
        AsmEmitter(TypeChecker()).emit({
            "helper": [
                IRInstr(op=IROp.LABEL, label="helper"),
                IRInstr(op=IROp.RET, imm=0),
            ],
        })


def test_small_negative_const_does_not_need_late_constant_pool_entry():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%x", imm=-1),
        IRInstr(op=IROp.RET, src1="%x"),
    ])

    assert "__const_" not in asm
    assert "RSB" in asm


def test_large_encoded_const_is_declared_before_use():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%x", imm=0xFFFF),
        IRInstr(op=IROp.RET, src1="%x"),
    ])

    const_line = next(line for line in asm.splitlines() if "__const_" in line and "=" in line)
    load_line = next(line for line in asm.splitlines() if "MOVM" in line and "__const_" in line)
    assert asm.index(const_line) < asm.index(load_line)


def test_unsigned_division_uses_native_cpu_div_without_signed_wrapper():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%a", imm=50000),
        IRInstr(op=IROp.CONST, dest="%b", imm=2),
        IRInstr(op=IROp.UDIV, dest="%q", src1="%a", src2="%b"),
        IRInstr(op=IROp.RET, src1="%q"),
    ])

    assert "DIV" in asm
    assert "__sdiv_" not in asm


def test_unsigned_modulo_uses_native_cpu_div_without_signed_wrapper():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%a", imm=50001),
        IRInstr(op=IROp.CONST, dest="%b", imm=2),
        IRInstr(op=IROp.UMOD, dest="%r", src1="%a", src2="%b"),
        IRInstr(op=IROp.RET, src1="%r"),
    ])

    assert "DIV" in asm
    assert "__smod_" not in asm


def test_signed_modulo_by_zero_emits_zero_result_path():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%a", imm=7),
        IRInstr(op=IROp.CONST, dest="%b", imm=0),
        IRInstr(op=IROp.MOD, dest="%r", src1="%a", src2="%b"),
        IRInstr(op=IROp.RET, src1="%r"),
    ])

    assert re.search(r"BEQ __smod_zero_\d+", asm)
    assert re.search(r"__smod_zero_\d+:\n\s+MOV R\d+, V0", asm)


def test_unsigned_modulo_by_zero_emits_zero_result_path():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%a", imm=7),
        IRInstr(op=IROp.CONST, dest="%b", imm=0),
        IRInstr(op=IROp.UMOD, dest="%r", src1="%a", src2="%b"),
        IRInstr(op=IROp.RET, src1="%r"),
    ])

    assert (
        re.search(r"BEQ __umod_zero_\d+", asm)
        or re.search(r"MOVEQ R\d+, V0", asm)
    )
    assert "DIVNE" in asm or "__umod_zero_" in asm


def test_emitter_saves_r10_when_unsigned_modulo_uses_scratch_product_register():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%a", imm=50001),
        IRInstr(op=IROp.CONST, dest="%b", imm=7),
        IRInstr(op=IROp.UMOD, dest="%r", src1="%a", src2="%b"),
        IRInstr(op=IROp.RET, src1="%r"),
    ])

    assert "SAVEM R10, [SP]" in asm
    assert "MOVM R10, [SP]" in asm


def test_emitter_saves_r8_when_pointer_add_uses_large_element_scratch():
    asm = emit_main([
        IRInstr(op=IROp.CONST, dest="%base", imm=100),
        IRInstr(op=IROp.CONST, dest="%idx", imm=2),
        IRInstr(op=IROp.PTR_ADD, dest="%addr", src1="%base", src2="%idx", type_size=4),
        IRInstr(op=IROp.RET, src1="%addr"),
    ])

    assert "SAVEM R8, [SP]" in asm
    assert "MOVM R8, [SP]" in asm


def test_allocator_does_not_treat_r_prefix_virtual_as_physical_register():
    alloc = RegisterAllocator().allocate([
        IRInstr(op=IROp.CONST, dest="Result", imm=1),
        IRInstr(op=IROp.RET, src1="Result"),
    ], is_leaf=True)

    assert alloc["Result"] == "R0"


def test_emitter_rejects_unallocated_virtual_register_read():
    emitter = AsmEmitter(TypeChecker())
    allocator = RegisterAllocator()

    with pytest.raises(CodeGenError, match="virtual register '%missing' has no allocation"):
        emitter._read_reg([], "%missing", {}, allocator)


def test_emitter_rejects_direct_write_to_stack_argument():
    emitter = AsmEmitter(TypeChecker())

    with pytest.raises(CodeGenError, match="cannot write directly to stack argument '__arg4'"):
        emitter._write_reg("__arg4", {})


def test_emitter_rejects_unsupported_ir_opcode():
    emitter = AsmEmitter(TypeChecker())
    allocator = RegisterAllocator()
    instr = IRInstr(op=IROp.NOT, dest="%out", src1="%in")

    with pytest.raises(CodeGenError, match="unsupported IR op NOT"):
        emitter._emit_instr(instr, {"%out": "R0", "%in": "R1"}, allocator, "main", True)
