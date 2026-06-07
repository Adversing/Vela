from __future__ import annotations

from src.ir.instructions import IRInstr, IROp

_PHYSICAL_REGS = {f"R{i}" for i in range(15)}
_CALL_CLOBBERS = {IROp.CALL, IROp.VCALL, IROp.PRINT_SYSCALL}


def constant_fold(instrs: list[IRInstr]) -> list[IRInstr]:
    """Replace sequences involving only constants with a single CONST."""
    known: dict[str, int | float] = {}
    result: list[IRInstr] = []

    for instr in instrs:
        # labels are join points: values from different branches converge,
        # so we cannot trust any previously-known constants.
        if instr.op == IROp.LABEL:
            known.clear()
            result.append(instr)
            continue

        if instr.op == IROp.ASM_INLINE:
            for reg in _PHYSICAL_REGS:
                known.pop(reg, None)
            result.append(instr)
            continue

        if instr.op in _CALL_CLOBBERS:
            for reg in _PHYSICAL_REGS:
                known.pop(reg, None)
            if instr.dest:
                known.pop(instr.dest, None)
            result.append(instr)
            continue

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

        # MOV propagation or invalidation
        if instr.op == IROp.MOV and instr.dest:
            if instr.src1 in known:
                known[instr.dest] = known[instr.src1]
            elif instr.dest in known:
                del known[instr.dest]
        # invalidate dest for other writes
        elif instr.dest and instr.op not in (IROp.CONST, IROp.FCONST):
            if instr.dest in known:
                del known[instr.dest]

        result.append(instr)

    return result


_FOLDABLE = {
    IROp.ADD,
    IROp.SUB,
    IROp.MUL,
    IROp.DIV,
    IROp.MOD,
    IROp.UDIV,
    IROp.UMOD,
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
        IROp.DIV: lambda: _trunc_div_i16(a, b),
        IROp.MOD: lambda: _mod_i16(a, b),
        IROp.UDIV: lambda: _udiv_u16(a, b),
        IROp.UMOD: lambda: _umod_u16(a, b),
        IROp.AND: lambda: int(a) & int(b),
        IROp.OR: lambda: int(a) | int(b),
        IROp.XOR: lambda: int(a) ^ int(b),
        IROp.SHL: lambda: int(a) << int(b),
        IROp.SHR: lambda: (int(a) & 0xFFFF) >> int(b),
        IROp.ASR: lambda: _to_i16(a) >> int(b),
        IROp.FADD: lambda: float(a) + float(b),
        IROp.FSUB: lambda: float(a) - float(b),
        IROp.FMUL: lambda: float(a) * float(b),
        IROp.FDIV: lambda: float(a) / float(b) if float(b) != 0 else 0.0,
    }
    return ops[op]()


def _to_i16(value) -> int:
    value = int(value) & 0xFFFF
    return value - 0x10000 if value & 0x8000 else value


def _trunc_div_i16(a, b) -> int:
    lhs = _to_i16(a)
    rhs = _to_i16(b)
    if rhs == 0:
        return 0
    q = abs(lhs) // abs(rhs)
    return -q if (lhs < 0) != (rhs < 0) else q


def _mod_i16(a, b) -> int:
    lhs = _to_i16(a)
    rhs = _to_i16(b)
    if rhs == 0:
        return 0
    return lhs - (_trunc_div_i16(lhs, rhs) * rhs)


def _to_u16(value) -> int:
    return int(value) & 0xFFFF


def _udiv_u16(a, b) -> int:
    lhs = _to_u16(a)
    rhs = _to_u16(b)
    if rhs == 0:
        return 0
    return lhs // rhs


def _umod_u16(a, b) -> int:
    lhs = _to_u16(a)
    rhs = _to_u16(b)
    if rhs == 0:
        return 0
    return lhs % rhs
