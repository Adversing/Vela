from src.codegen.register_allocator import RegisterAllocator
from src.ir.instructions import IROp, IRInstr


def test_active_callee_interval_is_spilled_not_remapped_to_overlapping_caller_reg():
    instrs = [
        IRInstr(op=IROp.CONST, dest="%p0", imm=0),
        IRInstr(op=IROp.CONST, dest="%p1", imm=1),
        IRInstr(op=IROp.CONST, dest="%p2", imm=2),
        IRInstr(op=IROp.CONST, dest="%p3", imm=3),
        IRInstr(op=IROp.CONST, dest="%n", imm=4),
        IRInstr(op=IROp.CONST, dest="%c0", imm=10),
        IRInstr(op=IROp.ADD, dest="%sink0", src1="%p0", src2="%p1"),
        IRInstr(op=IROp.ADD, dest="%sink1", src1="%p2", src2="%p3"),
        IRInstr(op=IROp.CONST, dest="%c1", imm=11),
        IRInstr(op=IROp.CONST, dest="%c2", imm=12),
        IRInstr(op=IROp.CONST, dest="%c3", imm=13),
        IRInstr(op=IROp.CONST, dest="%c4", imm=14),
        IRInstr(op=IROp.MOV, dest="%n_use", src1="%n"),
        IRInstr(op=IROp.CALL, dest="%call", label="callee", arg_count=0),
        IRInstr(op=IROp.MOV, dest="%u0", src1="%c0"),
        IRInstr(op=IROp.MOV, dest="%u1", src1="%c1"),
        IRInstr(op=IROp.MOV, dest="%u2", src1="%c2"),
        IRInstr(op=IROp.MOV, dest="%u3", src1="%c3"),
        IRInstr(op=IROp.MOV, dest="%u4", src1="%c4"),
    ]

    allocator = RegisterAllocator()
    alloc = allocator.allocate(instrs)

    assert alloc["%n"] == "__spill"
    assert allocator.spills["%n"] == 2


def test_inline_asm_binding_register_is_reserved_from_virtual_allocation():
    instrs = [
        IRInstr(op=IROp.CONST, dest="%keep", imm=5),
        IRInstr(op=IROp.MOV, dest="R0", src1="%keep"),
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["MOV R0, V7"]),
        IRInstr(op=IROp.MOV, dest="%out", src1="R0"),
        IRInstr(op=IROp.ADD, dest="%sum", src1="%keep", src2="%out"),
    ]

    alloc = RegisterAllocator().allocate(instrs, is_leaf=True)

    assert alloc["%keep"] != "R0"
    assert alloc["%out"] != "R0"


def test_inline_asm_body_register_is_reserved_from_virtual_allocation():
    instrs = [
        IRInstr(op=IROp.CONST, dest="%a", imm=1),
        IRInstr(op=IROp.CONST, dest="%b", imm=2),
        IRInstr(op=IROp.CONST, dest="%c", imm=3),
        IRInstr(op=IROp.CONST, dest="%d", imm=4),
        IRInstr(op=IROp.CONST, dest="%e", imm=5),
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["MOV R0, V9"]),
        IRInstr(op=IROp.ADD, dest="%ab", src1="%a", src2="%b"),
        IRInstr(op=IROp.ADD, dest="%cd", src1="%c", src2="%d"),
        IRInstr(op=IROp.ADD, dest="%total", src1="%ab", src2="%e"),
    ]

    alloc = RegisterAllocator().allocate(instrs, is_leaf=True)

    assert "R0" not in alloc.values()


def test_inline_asm_callee_saved_register_is_saved_for_abi():
    instrs = [
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["MOV R4, V9"]),
        IRInstr(op=IROp.RET),
    ]

    allocator = RegisterAllocator()
    allocator.allocate(instrs, is_leaf=True)

    assert "R4" in allocator.callee_saved_used


def test_inline_asm_scratch_callee_saved_register_is_saved_for_abi():
    instrs = [
        IRInstr(op=IROp.ASM_INLINE, asm_lines=["MOV R10, V9"]),
        IRInstr(op=IROp.RET),
    ]

    allocator = RegisterAllocator()
    allocator.allocate(instrs, is_leaf=True)

    assert "R10" in allocator.callee_saved_used


def test_allocate_resets_previous_spill_state_when_reused():
    many_live = [
        IRInstr(op=IROp.CONST, dest=f"%v{i}", imm=i)
        for i in range(12)
    ] + [
        IRInstr(op=IROp.ADD, dest=f"%use{i}", src1=f"%v{i}", src2=f"%v{i + 1}")
        for i in range(11)
    ]
    small = [
        IRInstr(op=IROp.CONST, dest="%x", imm=1),
        IRInstr(op=IROp.RET, src1="%x"),
    ]

    allocator = RegisterAllocator()
    allocator.allocate(many_live, is_leaf=True)
    assert allocator.spills

    alloc = allocator.allocate(small, is_leaf=True)

    assert allocator.spills == {}
    assert alloc == {"%x": "R0"}
