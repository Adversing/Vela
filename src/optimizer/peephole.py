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

_COND_INVERT = {
    'EQ': 'NE', 'NE': 'EQ',
    'LT': 'GE', 'GE': 'LT',
    'GT': 'LE', 'LE': 'GT',
    'MI': 'PL', 'PL': 'MI',
    'CS': 'CC', 'CC': 'CS',
    'HI': 'LS', 'LS': 'HI',
    'VS': 'VC', 'VC': 'VS',
}

_ALL_CONDS = frozenset(_COND_INVERT.keys()) | frozenset({'AL'})

_KNOWN_MNEMONICS = frozenset({
    'MOV', 'MVN', 'ADD', 'SUB', 'RSB', 'ADC', 'SBC', 'RSC',
    'AND', 'ORR', 'EOR', 'BIC',
    'CMP', 'CMN', 'TST', 'TEQ',
    'MUL', 'DIV',
    'B', 'BL',
    'SAVEM', 'MOVM', 'SAVE',
    'PUSH', 'POP',
    'MAX', 'MIN', 'ABS', 'MADD',
    'FADD', 'FSUB', 'FMUL', 'FDIV', 'FCMP', 'FMOV',
    'LSL', 'LSR', 'ASR', 'ROR',
    'PIXEL', 'PIXELNB', 'TEXT',
    'WAIT', 'WAITK', 'WAITKNB',
})

_PREDICATABLE = frozenset({
    'MOV', 'MVN',
    'ADD', 'SUB', 'RSB', 'ADC', 'SBC', 'RSC',
    'AND', 'ORR', 'EOR', 'BIC',
    'MUL', 'DIV',
    'MAX', 'MIN', 'ABS', 'MADD',
    'FADD', 'FSUB', 'FMUL', 'FDIV', 'FMOV',
    'SAVEM', 'MOVM', 'SAVE',
    'LSL', 'LSR', 'ASR', 'ROR',
})

_MAX_PREDICATED = 4   # max body instructions to predicate per branch

def _base_mnemonic(op: str) -> str:
    """Strip condition suffix: MOVGT -> MOV, SAVEMLE -> SAVEM."""
    if len(op) >= 3 and op[-2:] in _ALL_CONDS:
        base = op[:-2]
        if base in _KNOWN_MNEMONICS:
            return base
    return op


def _is_conditional_mnemonic(op: str) -> bool:
    """True when *op* carries a condition suffix (e.g. ``ADDNE``)."""
    if len(op) >= 3 and op[-2:] in _ALL_CONDS:
        return op[:-2] in _KNOWN_MNEMONICS
    return False


def peephole_optimize(lines: list[str]) -> list[str]:
    """Run peephole passes on *lines* until a fixpoint is reached."""
    changed = True
    while changed:
        n = len(lines)
        lines = _eliminate_self_mov(lines)
        lines = _fold_immediates(lines)
        lines = _collapse_mov_chains(lines)
        changed = len(lines) != n

    prev = len(lines)
    lines = _conditional_execution(lines)

    if len(lines) != prev:
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
        m = re.match(r'^\s+MOV(\w*)\s+(R\d+),\s*(R\d+)\s*$', line)
        if m:
            suffix = m.group(1)
            # match plain MOV or MOV with condition suffix (not MOVM/MOVS/etc.)
            if (not suffix or suffix in _ALL_CONDS) and m.group(2) == m.group(3):
                continue
        out.append(line)
    return out


def _fold_immediates(lines: list[str]) -> list[str]:
    result = list(lines)
    to_remove: set[int] = set()

    for i in range(len(result) - 1):
        if i in to_remove:
            continue

        # match: MOV Rx, Vimm  (only unconditional MOV: conditional MOVs are semantic)
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
            if _base_mnemonic(op) in _IMM_3OP and rz == rx and rn != rx:
                result[j] = f"{indent}{op} {rd}, {rn}, {vimm}"
                folded = True

        # 2-operand comparison: CMP Rn, Rx  ->  CMP Rn, Vimm
        if not folded:
            m2 = re.match(r'^(\s+)(\w+)\s+(R\d+),\s*(R\d+)\s*$', result[j])
            if m2:
                indent, op, rn, rz = m2.groups()
                if _base_mnemonic(op) in _IMM_2OP and rz == rx:
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

def _conditional_execution(lines: list[str]) -> list[str]:
    """Replace branch-over patterns with predicated (conditional) instructions.

    Exploits the DE1 ISA's ARM-style per-instruction condition field to
    eliminate branches in simple if / if-else constructs and boolean
    materialisation, then collapses CMP + MOVcond pairs into
    dedicated MAX / MIN instructions where applicable.
    """
    lines = _cond_diamond(lines)        # if-else / bool materialisation
    lines = _cond_if_only(lines)        # if-then (no else)
    lines = _collapse_to_maxmin(lines)  # CMP+MOVcond -> MAX / MIN
    lines = _remove_orphan_labels(lines)
    return lines


def _extract_branch_cond(stripped: str):
    """``'BLE __if_1'`` → ``('LE', '__if_1')``  or  ``None``."""
    m = re.match(
        r'^B(EQ|NE|LT|GT|LE|GE|MI|PL|CS|CC|HI|LS|VS|VC)\s+(\S+)$',
        stripped,
    )
    return (m.group(1), m.group(2)) if m else None


def _is_predicatable(stripped: str) -> bool:
    """True if the instruction can safely receive a condition suffix."""
    m = re.match(r'^(\w+)', stripped)
    return m is not None and m.group(1) in _PREDICATABLE


def _predicate_line(line: str, cond: str) -> str:
    """Append condition suffix to mnemonic in *line*."""
    m = re.match(r'^(\s+)(\w+)([ \t]+.*)$', line)
    if m:
        indent, mnem, rest = m.groups()
        return f"{indent}{mnem}{cond}{rest}"
    return line


def _skip_blanks(lines: list[str], start: int) -> int:
    """Return index of next non-blank, non-comment line."""
    i = start
    while i < len(lines):
        s = lines[i].strip()
        if s and not s.startswith('#'):
            return i
        i += 1
    return i


def _collect_predicatable(lines: list[str], start: int, limit: int):
    """Collect up to *limit* consecutive predicatable instruction indices.

    Returns ``(list_of_indices, next_scan_index)``.
    """
    indices: list[int] = []
    i = start
    while i < len(lines) and len(indices) < limit:
        s = lines[i].strip()
        if not s or s.startswith('#'):
            i += 1
            continue
        if _is_label_line(s) or not _is_predicatable(s):
            break
        indices.append(i)
        i += 1
    return indices, i


def _count_label_refs(lines: list[str]) -> dict[str, int]:
    """Count how many times each label is referenced (excluding definitions)."""
    _NOT_LABEL = re.compile(r'^(R\d+|V\d+|SP|PC|LR|ASR|LSL|LSR|ROR)$')
    refs: dict[str, int] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or _is_label_line(stripped):
            continue
        tokens = re.findall(r'\b([A-Za-z_]\w*)\b', stripped)
        for tok in tokens[1:]:
            if not _NOT_LABEL.match(tok):
                refs[tok] = refs.get(tok, 0) + 1
    return refs

def _cond_diamond(lines: list[str]) -> list[str]:
    """Transform if-else diamonds into predicated instruction pairs.

    ::

        Bcond  target          CMP sets flags before this
        <body1>          ───►  <body1 with inverted cond>
        B      skip            <body2 with cond>
        target:
        <body2>
        skip:
    """
    label_refs = _count_label_refs(lines)
    result: list[str] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        bc = _extract_branch_cond(stripped) if not _is_label_line(stripped) else None
        if bc:
            match = _try_diamond(lines, i, bc, label_refs)
            if match:
                cond, body1_idx, body2_idx, end_i = match
                inv = _COND_INVERT[cond]
                for idx in body1_idx:
                    result.append(_predicate_line(lines[idx], inv))
                for idx in body2_idx:
                    result.append(_predicate_line(lines[idx], cond))
                i = end_i
                continue
        result.append(lines[i])
        i += 1
    return result


def _try_diamond(lines, bi, bc, label_refs):
    """Match ``Bcond target; body1; B skip; target:; body2; skip:``

    Returns (cond, body1_indices, body2_indices, next_i) or None.
    Only matches when both labels have exactly one reference (this pattern).
    """
    cond, target = bc

    body1, ni = _collect_predicatable(lines, bi + 1, _MAX_PREDICATED)
    if not body1:
        return None

    # unconditional B skip_label
    j = _skip_blanks(lines, ni)
    if j >= len(lines):
        return None
    m = re.match(r'^B\s+(\S+)$', lines[j].strip())
    if not m:
        return None
    skip = m.group(1)

    # target_label:
    k = _skip_blanks(lines, j + 1)
    if k >= len(lines) or lines[k].strip() != f"{target}:":
        return None

    body2, nk = _collect_predicatable(lines, k + 1, _MAX_PREDICATED)
    if not body2:
        return None

    # skip_label:
    e = _skip_blanks(lines, nk)
    if e >= len(lines) or lines[e].strip() != f"{skip}:":
        return None

    # both labels must be single-use (only referenced from this pattern)
    if label_refs.get(target, 0) != 1 or label_refs.get(skip, 0) != 1:
        return None

    return cond, body1, body2, e + 1


def _cond_if_only(lines: list[str]) -> list[str]:
    """Transform if-then (no else) into predicated instructions.

    ::

        Bcond  target          <body with inverted cond>
        <body>           ───►  target:          (label kept)
        target:
    """
    result: list[str] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        bc = _extract_branch_cond(stripped) if not _is_label_line(stripped) else None
        if bc:
            match = _try_if_only(lines, i, bc)
            if match:
                inv_cond, body_idx, resume_i = match
                for idx in body_idx:
                    result.append(_predicate_line(lines[idx], inv_cond))
                i = resume_i   # label is not consumed; next iteration keeps it
                continue
        result.append(lines[i])
        i += 1
    return result


def _try_if_only(lines, bi, bc):
    """Match Bcond target; body; target: (label preserved).

    Returns (inverted_cond, body_indices, label_line_index) or None.
    """
    cond, target = bc

    body, ni = _collect_predicatable(lines, bi + 1, _MAX_PREDICATED)
    if not body:
        return None

    j = _skip_blanks(lines, ni)
    if j >= len(lines) or lines[j].strip() != f"{target}:":
        return None

    return _COND_INVERT[cond], body, j

_HIGH_CONDS = frozenset({'GT', 'GE'})
_LOW_CONDS  = frozenset({'LT', 'LE'})


def _collapse_to_maxmin(lines: list[str]) -> list[str]:
    """Collapse ``CMP Ra, Rb; MOVcond1 Rd, Ra; MOVcond2 Rd, Rb`` → MAX/MIN."""
    result: list[str] = []
    i = 0
    while i < len(lines):
        if i + 2 < len(lines):
            r = _try_maxmin(lines, i)
            if r:
                instr_line, consumed = r
                result.append(instr_line)
                i += consumed
                continue
        result.append(lines[i])
        i += 1
    return result


def _try_maxmin(lines, i):
    """Try to match CMP + 2x conditional MOV -> MAX / MIN.

    Returns (replacement_line, lines_consumed) or None.
    """
    s0 = lines[i].strip()
    m_cmp = re.match(r'^CMP\s+(\S+),\s*(\S+)$', s0)
    if not m_cmp:
        return None
    cmp_x, cmp_y = m_cmp.group(1), m_cmp.group(2)

    s1 = lines[i + 1].strip()
    m1 = re.match(r'^MOV(EQ|NE|LT|GT|LE|GE|MI|PL|CS|CC|HI|LS)\s+(\S+),\s*(\S+)$', s1)
    if not m1:
        return None
    c1, d1, a = m1.group(1), m1.group(2), m1.group(3)

    s2 = lines[i + 2].strip()
    m2 = re.match(r'^MOV(EQ|NE|LT|GT|LE|GE|MI|PL|CS|CC|HI|LS)\s+(\S+),\s*(\S+)$', s2)
    if not m2:
        return None
    c2, d2, b = m2.group(1), m2.group(2), m2.group(3)

    # both MOVs must target the same register, with complementary conditions
    if d1 != d2 or _COND_INVERT.get(c1) != c2:
        return None

    # figure out which source is the "high" (GT/GE) pick
    if c1 in _HIGH_CONDS:
        high_src, low_src = a, b
    elif c1 in _LOW_CONDS:
        high_src, low_src = b, a
    else:
        return None  # EQ/NE/MI/PL etc.: not a max/min

    indent = re.match(r'^(\s*)', lines[i]).group(1)

    # MAX: the high-condition branch picks cmp_x (signed greater)
    if high_src == cmp_x and low_src == cmp_y:
        return f"{indent}MAX {d1}, {cmp_x}, {cmp_y}", 3
    # MIN: the low-condition branch picks cmp_x (signed smaller)
    if low_src == cmp_x and high_src == cmp_y:
        return f"{indent}MIN {d1}, {cmp_x}, {cmp_y}", 3

    return None


def _remove_orphan_labels(lines: list[str]) -> list[str]:
    """Remove compiler-generated labels (__...) that are never referenced."""
    refs = _count_label_refs(lines)
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if _is_label_line(stripped):
            name = stripped[:-1]
            if name.startswith('__') and refs.get(name, 0) == 0:
                continue
        out.append(line)
    return out


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
        if _base_mnemonic(op) == 'BL':
            if reg in ('R0', 'R1', 'R2', 'R3', 'R12'):
                return True
            # callee-saved survive a call; keep scanning.

        # conditional branches: conservatively continue scanning fallthrough.

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
    op_raw, args = m.group(1), m.group(2)
    op = _base_mnemonic(op_raw)
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
    """Check if an instruction unconditionally writes to *reg*.

    A predicated instruction (e.g. MOVGT) does NOT count as
    an unconditional write because on the false-path the old value
    persists.
    """
    m = re.match(r'^(\w+)\s+(.*)', line)
    if not m:
        return False
    op_raw, args = m.group(1), m.group(2)

    # conditional instructions never unconditionally kill a register
    if _is_conditional_mnemonic(op_raw):
        return False

    op = _base_mnemonic(op_raw)
    parts = [p.strip() for p in args.split(',')]

    if op in ('SAVE', 'SAVEM', 'CMP', 'CMN', 'TST', 'TEQ', 'FCMP'):
        return False
    if op_raw.startswith('B'):
        return op == 'BL' and reg == 'R14'

    # first operand is destination for most instructions.
    if parts:
        return parts[0].strip() == reg
    return False
