"""Strength reduction — replace expensive ops with cheaper equivalents."""

from __future__ import annotations

from src.ir.instructions import IROp, IRInstr


def strength_reduce(instrs: list[IRInstr]) -> list[IRInstr]:
    """Replace multiplies by powers of two with shifts, etc."""
    known: dict[str, int] = {}
    result: list[IRInstr] = []

    for instr in instrs:
        if instr.op == IROp.CONST and instr.dest and isinstance(instr.imm, int):
            known[instr.dest] = instr.imm

        # MUL by power of 2 -> SHL
        if instr.op == IROp.MUL and instr.dest:
            val = known.get(instr.src2)
            if val is not None and val > 0 and (val & (val - 1)) == 0:
                shift = val.bit_length() - 1
                shift_r = f"__sr_{id(instr)}"
                result.append(IRInstr(op=IROp.CONST, dest=shift_r, imm=shift))
                result.append(IRInstr(op=IROp.SHL, dest=instr.dest,
                                      src1=instr.src1, src2=shift_r))
                continue
            # try src1
            val = known.get(instr.src1)
            if val is not None and val > 0 and (val & (val - 1)) == 0:
                shift = val.bit_length() - 1
                shift_r = f"__sr_{id(instr)}"
                result.append(IRInstr(op=IROp.CONST, dest=shift_r, imm=shift))
                result.append(IRInstr(op=IROp.SHL, dest=instr.dest,
                                      src1=instr.src2, src2=shift_r))
                continue

        # DIV by power of 2 -> SHR (unsigned only)
        if instr.op == IROp.DIV and instr.dest:
            val = known.get(instr.src2)
            if val is not None and val > 0 and (val & (val - 1)) == 0:
                shift = val.bit_length() - 1
                shift_r = f"__sr_{id(instr)}"
                result.append(IRInstr(op=IROp.CONST, dest=shift_r, imm=shift))
                result.append(IRInstr(op=IROp.SHR, dest=instr.dest,
                                      src1=instr.src1, src2=shift_r))
                continue

        # MUL by 0 -> CONST 0
        if instr.op == IROp.MUL and instr.dest:
            if known.get(instr.src1) == 0 or known.get(instr.src2) == 0:
                result.append(IRInstr(op=IROp.CONST, dest=instr.dest, imm=0))
                known[instr.dest] = 0
                continue

        # ADD/SUB by 0 -> MOV
        if instr.op == IROp.ADD and known.get(instr.src2) == 0 and instr.dest:
            result.append(IRInstr(op=IROp.MOV, dest=instr.dest, src1=instr.src1))
            continue
        if instr.op == IROp.SUB and known.get(instr.src2) == 0 and instr.dest:
            result.append(IRInstr(op=IROp.MOV, dest=instr.dest, src1=instr.src1))
            continue

        result.append(instr)

    return result
