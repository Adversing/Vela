from __future__ import annotations

import re

# 3-operand instructions whose operand2 can be an immediate Vimm
_IMM_3OP = frozenset({
    'ADD', 'SUB', 'AND', 'ORR', 'EOR', 'RSB',
    'LSL', 'LSR', 'ASR', 'ROR', 'BIC',
})
# 2-operand comparison instructions whose operand2 can be Vimm
_IMM_2OP = frozenset({'CMP', 'CMN', 'TST', 'TEQ'})

# general-purpose registers eligible for optimisation
_GP_REGS = frozenset(f'R{i}' for i in range(13))  # R0-R12


def peephole_optimize(lines: list[str]) -> list[str]:
    """Run peephole passes on *lines* until a fixpoint is reached."""
    changed = True
    while changed:
        n = len(lines)
        lines = _eliminate_self_mov(lines)
        lines = _fold_immediates(lines)
        lines = _collapse_mov_chains(lines)
        changed = len(lines) != n
    return lines

def _eliminate_self_mov(lines: list[str]) -> list[str]:
    out: list[str] = []
    for line in lines:
        m = re.match(r'^\s+MOV\s+(R\d+),\s*(R\d+)\s*$', line)
        if m and m.group(1) == m.group(2):
            continue
        out.append(line)
    return out

def _fold_immediates(lines: list[str]) -> list[str]:
    result = list(lines)
    to_remove: set[int] = set()

    for i in range(len(result) - 1):
        if i in to_remove:
            continue

        # match: MOV Rx, Vimm
        m = re.match(r'^\s+MOV\s+(R\d+),\s*(V\d+)\s*$', result[i])
        if not m:
            continue
        rx, vimm = m.group(1), m.group(2)
        if rx not in _GP_REGS:
            continue

        j = _next_live(result, i + 1, to_remove)
        if j is None:
            continue

        folded = False

        # 3-operand: OP Rd, Rn, Rx  ->  OP Rd, Rn, Vimm
        m3 = re.match(r'^(\s+)(\w+)\s+(R\d+),\s*(R\d+),\s*(R\d+)\s*$', result[j])
        if m3:
            indent, op, rd, rn, rz = m3.groups()
            if op in _IMM_3OP and rz == rx and rn != rx:
                result[j] = f"{indent}{op} {rd}, {rn}, {vimm}"
                folded = True

        # 2-operand comparison: CMP Rn, Rx  ->  CMP Rn, Vimm
        if not folded:
            m2 = re.match(r'^(\s+)(\w+)\s+(R\d+),\s*(R\d+)\s*$', result[j])
            if m2:
                indent, op, rn, rz = m2.groups()
                if op in _IMM_2OP and rz == rx:
                    result[j] = f"{indent}{op} {rn}, {vimm}"
                    folded = True

        if folded and _is_dead_after(result, j, rx, to_remove):
            to_remove.add(i)

    return [l for idx, l in enumerate(result) if idx not in to_remove]


def _collapse_mov_chains(lines: list[str]) -> list[str]:
    result = list(lines)
    to_remove: set[int] = set()

    for i in range(len(result) - 1):
        if i in to_remove:
            continue

        # match: MOV Rx, <src>  (register, immediate, or label - but not [mem])
        m1 = re.match(r'^(\s+)MOV\s+(R\d+),\s*(\S+)\s*$', result[i])
        if not m1:
            continue
        _indent1, rx, src = m1.groups()
        if rx not in _GP_REGS:
            continue
        if src.startswith('['):
            continue  # memory load - don't collapse

        j = _next_live(result, i + 1, to_remove)
        if j is None:
            continue

        # match: MOV Ry, Rx
        m2 = re.match(r'^(\s+)MOV\s+(R\d+),\s*(R\d+)\s*$', result[j])
        if not m2:
            continue
        indent2, ry, rz = m2.groups()
        if rz != rx or ry == rx:
            continue

        # replace the second MOV with MOV Ry, src
        result[j] = f"{indent2}MOV {ry}, {src}"

        # remove the first MOV if Rx is dead afterwards
        if _is_dead_after(result, j, rx, to_remove):
            to_remove.add(i)

    return [l for idx, l in enumerate(result) if idx not in to_remove]


def _next_live(lines: list[str], start: int, to_remove: set[int]) -> int | None:
    """Return the index of the next instruction line (skipping blanks/comments/removed)."""
    for k in range(start, len(lines)):
        if k in to_remove:
            continue
        stripped = lines[k].strip()
        if not stripped or stripped.startswith('#'):
            continue
        # don't cross labels
        if _is_label_line(stripped):
            return None
        return k
    return None


def _is_label_line(stripped: str) -> bool:
    return bool(re.match(r'^[A-Za-z_]\w*:\s*$', stripped))


def _is_dead_after(lines: list[str], after_idx: int, reg: str,
                   to_remove: set[int]) -> bool:
    """Return True if *reg* is not read from *after_idx+1* to end-of-basic-block."""
    for k in range(after_idx + 1, len(lines)):
        if k in to_remove:
            continue
        stripped = lines[k].strip()
        if not stripped or stripped.startswith('#'):
            continue

        # label -> new BB entry point; reg might be live from a jump.
        if _is_label_line(stripped):
            return False

        m = re.match(r'^(\w+)', stripped)
        if not m:
            continue
        op = m.group(1)

        # unconditional branch; control goes to a potentially distant label
        # where *reg* may still be live.  Be conservative.
        if re.match(r'^B\s+\w+$', stripped):
            return False

        # return - end of function.
        if 'MOV PC' in stripped:
            return True

        # BL clobbers caller-saved registers.
        if op == 'BL':
            if reg in ('R0', 'R1', 'R2', 'R3', 'R12'):
                return True
            # callee-saved survive a call; keep scanning.

        # conditional branches: conservatively continue scanning fallthrough.
        # (the codegen never expects stale values on branch targets)

        if _asm_reads_reg(stripped, reg):
            return False
        if _asm_writes_reg(stripped, reg):
            return True

    return True  # end of output → dead


def _has_reg(text: str, reg: str) -> bool:
    """True if *text* contains *reg* as a whole register token."""
    return bool(re.search(r'\b' + re.escape(reg) + r'\b', text))


def _asm_reads_reg(line: str, reg: str) -> bool:
    """Check if an instruction reads *reg* as a source operand."""
    m = re.match(r'^(\w+)\s+(.*)', line)
    if not m:
        return False
    op, args = m.group(1), m.group(2)
    parts = [p.strip() for p in args.split(',')]

    # SAVE/SAVEM - value and address are both sources.
    if op in ('SAVE', 'SAVEM'):
        return _has_reg(args, reg)

    # Comparison - all operands are sources.
    if op in ('CMP', 'CMN', 'TST', 'TEQ', 'FCMP'):
        return _has_reg(args, reg)

    # MOV/MOVM/MVN/FMOV - first arg is dest, rest are sources.
    if op in ('MOV', 'MVN', 'MOVM', 'FMOV'):
        if len(parts) >= 2:
            return _has_reg(', '.join(parts[1:]), reg)
        return False

    # generic 3-operand (ADD, SUB, MUL...) - dest, src, src.
    if len(parts) >= 3:
        return _has_reg(', '.join(parts[1:]), reg)

    # generic 2-operand with dest (ABS Rd, Rs etc.)
    if len(parts) == 2:
        return _has_reg(parts[1], reg)

    # fallback: conservative.
    return _has_reg(args, reg)


def _asm_writes_reg(line: str, reg: str) -> bool:
    """Check if an instruction writes to *reg*."""
    m = re.match(r'^(\w+)\s+(.*)', line)
    if not m:
        return False
    op, args = m.group(1), m.group(2)
    parts = [p.strip() for p in args.split(',')]

    if op in ('SAVE', 'SAVEM', 'CMP', 'CMN', 'TST', 'TEQ', 'FCMP'):
        return False
    if op.startswith('B'):
        return op == 'BL' and reg == 'R14'

    # first operand is destination for most instructions.
    if parts:
        return parts[0].strip() == reg
    return False
