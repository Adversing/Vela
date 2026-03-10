from __future__ import annotations

from copy import copy
from src.ir.instructions import IROp, IRInstr

INLINE_THRESHOLD = 32


def inline_functions(
    instrs: list[IRInstr],
    all_funcs: dict[str, list[IRInstr]],
    *,
    max_rounds: int = 3,
) -> list[IRInstr]:
    """Inline eligible function calls in instrs.

    all_funcs maps mangled function names to their instruction lists.
    Performs up to max_rounds of inlining to handle nested small calls.

    Returns a new instruction list.
    """
    result = instrs
    for _ in range(max_rounds):
        new_result = _inline_one_pass(result, all_funcs)
        if len(new_result) == len(result):
            break  # fixpoint
        result = new_result
    return result


_UID = 0


def _next_inline_uid() -> int:
    global _UID
    _UID += 1
    return _UID


def _inline_one_pass(
    instrs: list[IRInstr],
    all_funcs: dict[str, list[IRInstr]],
) -> list[IRInstr]:
    """One pass of inlining over instrs."""
    # pre-compute eligibility
    eligible = _compute_eligible(all_funcs)

    result: list[IRInstr] = []
    # we need to look backward for PARAM instructions that feed into the
    # CALL, so we collect them in a buffer.
    param_buffer: list[IRInstr] = []

    i = 0
    while i < len(instrs):
        instr = instrs[i]

        # collect PARAMs
        if instr.op == IROp.PARAM:
            param_buffer.append(instr)
            i += 1
            continue

        # let's check if this CALL is inlineable
        if (instr.op == IROp.CALL
                and instr.label
                and instr.label in eligible
                and instr.label != "__malloc"
                and instr.label != "__free"):

            callee_body = all_funcs[instr.label]
            inlined = _do_inline(
                callee_body,
                param_buffer,
                instr.dest,
                instr.arg_count,
            )
            if inlined is not None:
                result.extend(inlined)
                param_buffer = []
                i += 1
                continue

        # not inlined: flush the param buffer and emit the instruction.
        result.extend(param_buffer)
        param_buffer = []
        result.append(instr)
        i += 1

    # flush any trailing PARAMs (shouldn't happen in well-formed IR)
    result.extend(param_buffer)
    return result


def _do_inline(
    callee_body: list[IRInstr],
    params: list[IRInstr],
    call_dest: str | None,
    arg_count: int,
) -> list[IRInstr] | None:
    """Inline callee_body at the call site.

    Returns the inlined instructions, or None if inlining is not possible.
    """
    uid = _next_inline_uid()
    prefix = f"__inl{uid}_"
    end_label = f"{prefix}end"
    # a shared register that every return path writes to, ensuring that
    # regardless of which branch reaches the end label the return value
    # is in a single, predictable register.
    ret_collector = f"{prefix}retval"

    # build the argument map: __argN -> actual register from PARAM instrs.
    arg_map: dict[str, str] = {}
    for p in params:
        if p.imm is not None and isinstance(p.imm, int) and p.src1:
            arg_map[f"__arg{p.imm}"] = p.src1

    # clone and rename the callee body.
    # skip the leading LABEL instruction (the function entry label).
    body = callee_body
    if body and body[0].op == IROp.LABEL:
        body = body[1:]

    inlined: list[IRInstr] = []
    has_ret_value = False
    for orig in body:
        new = _clone_instr(orig)

        # rename registers to avoid conflicts with the caller
        new.dest = _rename_reg(new.dest, prefix, arg_map)
        new.src1 = _rename_reg(new.src1, prefix, arg_map)
        new.src2 = _rename_reg(new.src2, prefix, arg_map)
        new.label = _rename_label(new.label, prefix)

        # handle returns: collect the return value (if any) into the
        # shared collector register, then branch to the end label.
        if new.op == IROp.RET:
            if new.src1 and call_dest:
                inlined.append(IRInstr(
                    op=IROp.MOV, dest=ret_collector, src1=new.src1))
                has_ret_value = True
            inlined.append(IRInstr(op=IROp.BRANCH, label=end_label))
            continue

        inlined.append(new)

    # emit end label
    inlined.append(IRInstr(op=IROp.LABEL, label=end_label))

    # map the collector to the caller's dest register
    if call_dest and has_ret_value:
        inlined.append(IRInstr(
            op=IROp.MOV, dest=call_dest, src1=ret_collector))

    return inlined

def _rename_reg(reg: str | None, prefix: str,
                arg_map: dict[str, str]) -> str | None:
    """Rename a virtual register for the inlined context.

    - __argN is replaced with the actual argument register.
    - physical registers (R0-R14) are left untouched.
    - all other registers (virtual tN, %N, __x) get a
      unique prefix to avoid name clashes with the caller.
    """
    if reg is None:
        return None
    # arg binding
    mapped = arg_map.get(reg)
    if mapped is not None:
        return mapped
    # physical registers (R0-R12, R13/SP, R14/LR, R15/PC) are untouched
    if reg.startswith("R") and reg[1:].isdigit():
        return reg
    if reg.startswith("__arg"):
        # unmapped arg — keep as-is (shouldn't happen in valid IR)
        return reg
    # everything else (virtual tN, %N, __x) gets prefixed
    return f"{prefix}{reg}"


def _rename_label(label: str | None, prefix: str) -> str | None:
    """Prefix internal labels to avoid collisions."""
    if label is None:
        return None
    # don't rename global labels (function names, vtable labels, etc.)
    if (label.startswith("__vtable_")
            or label.startswith("__str_")
            or label == "__malloc"
            or label == "__free"
            or label == "__syscall"):
        return label
    # rename internal labels (branch targets within the function body)
    if label.startswith("__"):
        return f"{prefix}{label}"
    # named function calls should not be renamed
    return label


def _clone_instr(instr: IRInstr) -> IRInstr:
    """Shallow-clone an IRInstr."""
    return IRInstr(
        op=instr.op,
        dest=instr.dest,
        src1=instr.src1,
        src2=instr.src2,
        imm=instr.imm,
        label=instr.label,
        asm_lines=list(instr.asm_lines),
        arg_count=instr.arg_count,
        type_size=instr.type_size,
    )


def _compute_eligible(all_funcs: dict[str, list[IRInstr]]) -> set[str]:
    """Return the set of function names eligible for inlining."""
    eligible: set[str] = set()
    for name, body in all_funcs.items():
        if len(body) > INLINE_THRESHOLD:
            continue
        # check for recursion (direct self-call)
        if any(i.op == IROp.CALL and i.label == name for i in body):
            continue
        # skip functions with inline ASM (cannot safely relocate)
        if any(i.op == IROp.ASM_INLINE for i in body):
            continue
        eligible.add(name)
    return eligible
