from __future__ import annotations

from src.ir.instructions import IROp, IRInstr

# instructions that have side effects and should never be removed
_SIDE_EFFECTS = {
    IROp.CALL, IROp.VCALL, IROp.RET, IROp.STORE_8, IROp.STORE_16,
    IROp.BRANCH, IROp.BRANCH_EQ, IROp.BRANCH_NE, IROp.BRANCH_LT,
    IROp.BRANCH_GT, IROp.BRANCH_LE, IROp.BRANCH_GE, IROp.BRANCH_MI,
    IROp.BRANCH_PL, IROp.LABEL, IROp.PARAM, IROp.CMP, IROp.FCMP,
    IROp.ASM_INLINE, IROp.PRINT_SYSCALL,
}


def eliminate_dead_code(instrs: list[IRInstr]) -> list[IRInstr]:
    """Remove assignments whose results are never read."""
    # collect all registers that are read (used as src)
    used: set[str] = set()
    for instr in instrs:
        if instr.src1:
            used.add(instr.src1)
        if instr.src2:
            used.add(instr.src2)

    result: list[IRInstr] = []
    for instr in instrs:
        # keep all side-effectful instructions
        if instr.op in _SIDE_EFFECTS:
            result.append(instr)
            continue
        # keep if destination is ever used or if no dest (pure side effect)
        if instr.dest is None or instr.dest in used:
            result.append(instr)
            continue
        # dead, let's skip it

    # and also remove unreachable code after unconditional RET/BRANCH until next LABEL
    final: list[IRInstr] = []
    skip = False
    for instr in result:
        if instr.op == IROp.LABEL:
            skip = False
        if not skip:
            final.append(instr)
        if instr.op == IROp.RET:
            skip = True
        if instr.op == IROp.BRANCH and instr.label:
            skip = True

    return final
