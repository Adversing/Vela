from __future__ import annotations

import re

from src.ir.instructions import IROp, IRInstr

# instructions that have side effects and should never be removed
_SIDE_EFFECTS = {
    IROp.CALL, IROp.VCALL, IROp.RET, IROp.STORE_8, IROp.STORE_16,
    IROp.BRANCH, IROp.BRANCH_EQ, IROp.BRANCH_NE, IROp.BRANCH_LT,
    IROp.BRANCH_GT, IROp.BRANCH_LE, IROp.BRANCH_GE, IROp.BRANCH_MI,
    IROp.BRANCH_PL, IROp.BRANCH_LO, IROp.BRANCH_HI, IROp.BRANCH_LS,
    IROp.BRANCH_HS, IROp.LABEL, IROp.PARAM, IROp.CMP, IROp.FCMP,
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
        if instr.op == IROp.ASM_INLINE:
            for line in instr.asm_lines:
                used.update(_asm_read_regs(line))

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


def _asm_read_regs(line: str) -> set[str]:
    """Best-effort source register extraction for inline CPU assembly."""
    stripped = line.split("#", 1)[0].strip()
    match = re.match(r"^(\w+)\s*(.*)$", stripped)
    if not match:
        return set()

    op = _base_mnemonic(match.group(1).upper())
    args = match.group(2)
    parts = [part.strip() for part in re.split(r"\s*,\s*", args) if part.strip()]

    if op in {"SAVE", "SAVEM", "CMP", "CMN", "TST", "TEQ", "FCMP"}:
        return _regs_in(args)
    if op in {"MOV", "MVN", "MOVM", "FMOV"}:
        return _regs_in(", ".join(parts[1:])) if len(parts) >= 2 else set()
    if op.startswith("B"):
        return set()
    if len(parts) >= 3:
        return _regs_in(", ".join(parts[1:]))
    if len(parts) == 2:
        return _regs_in(parts[1])
    return _regs_in(args)


def _regs_in(text: str) -> set[str]:
    return set(re.findall(r"\bR(?:[0-9]|1[0-4])\b", text))


def _base_mnemonic(op: str) -> str:
    conditions = {
        "EQ", "NE", "LT", "GT", "LE", "GE", "MI", "PL",
        "CS", "CC", "HI", "LS", "VS", "VC", "AL",
    }
    if len(op) > 2 and op[-2:] in conditions:
        return op[:-2]
    return op
