from __future__ import annotations

from src.ir.instructions import IRInstr, IROp


def constant_fold(instrs: list[IRInstr]) -> list[IRInstr]:
    """Replace sequences involving only constants with a single CONST."""
    known: dict[str, int | float] = {}
    result: list[IRInstr] = []

    for instr in instrs:
        if instr.op == IROp.CONST and instr.dest:
            known[instr.dest] = instr.imm
            result.append(instr)
            continue

        if instr.op == IROp.FCONST and instr.dest:
            known[instr.dest] = instr.imm
            result.append(instr)
            continue

        if instr.op in _FOLDABLE and instr.src1 in known and instr.src2 in known:
            v1 = known[instr.src1]
            v2 = known[instr.src2]
            if isinstance(v1, (int, float)) and isinstance(v2, (int, float)):
                try:
                    val = _eval_op(instr.op, v1, v2)
                except Exception:
                    result.append(instr)
                    continue
                if instr.dest:
                    known[instr.dest] = val
                    if isinstance(val, float):
                        result.append(IRInstr(op=IROp.FCONST, dest=instr.dest, imm=val))
                    else:
                        result.append(
                            IRInstr(
                                op=IROp.CONST, dest=instr.dest, imm=int(val) & 0xFFFF
                            )
                        )
                    continue

        # MOV propagation: if src is a known constant, replace
        if instr.op == IROp.MOV and instr.src1 in known and instr.dest:
            known[instr.dest] = known[instr.src1]

        # invalidate dest
        if instr.dest and instr.op not in (IROp.CONST, IROp.FCONST):
            if instr.dest in known and instr.op != IROp.MOV:
                del known[instr.dest]

        result.append(instr)

    return result


_FOLDABLE = {
    IROp.ADD,
    IROp.SUB,
    IROp.MUL,
    IROp.DIV,
    IROp.MOD,
    IROp.AND,
    IROp.OR,
    IROp.XOR,
    IROp.SHL,
    IROp.SHR,
    IROp.ASR,
    IROp.FADD,
    IROp.FSUB,
    IROp.FMUL,
    IROp.FDIV,
}


def _eval_op(op: IROp, a, b):
    ops = {
        IROp.ADD: lambda: int(a) + int(b),
        IROp.SUB: lambda: int(a) - int(b),
        IROp.MUL: lambda: int(a) * int(b),
        IROp.DIV: lambda: int(a) // int(b) if int(b) != 0 else 0,
        IROp.MOD: lambda: int(a) % int(b) if int(b) != 0 else 0,
        IROp.AND: lambda: int(a) & int(b),
        IROp.OR: lambda: int(a) | int(b),
        IROp.XOR: lambda: int(a) ^ int(b),
        IROp.SHL: lambda: int(a) << int(b),
        IROp.SHR: lambda: int(a) >> int(b),
        IROp.ASR: lambda: int(a) >> int(b),
        IROp.FADD: lambda: float(a) + float(b),
        IROp.FSUB: lambda: float(a) - float(b),
        IROp.FMUL: lambda: float(a) * float(b),
        IROp.FDIV: lambda: float(a) / float(b) if float(b) != 0 else 0.0,
    }
    return ops[op]()
