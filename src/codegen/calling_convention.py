from __future__ import annotations

ARG_REGS = ["R0", "R1", "R2", "R3"]
CALLEE_SAVED_REGS = ["R4", "R5", "R6", "R7", "R8", "R9", "R10"]
FP_REG = "R11"
SCRATCH_REG = "R12"
SP_REG = "SP"
LR_REG = "R14"


def emit_prologue(callee_saved_used: set[str], local_size: int, is_leaf: bool) -> list[str]:
    """Emit function prologue assembly lines."""
    lines: list[str] = []
    if is_leaf and not callee_saved_used and local_size == 0:
        return lines

    # save LR
    lines.append("    SUB SP, SP, V2")
    lines.append("    SAVEM R14, [SP]")
    # save FP
    lines.append("    SUB SP, SP, V2")
    lines.append("    SAVEM R11, [SP]")
    # set new FP
    lines.append("    MOV R11, SP")

    # save callee-saved registers
    for reg in sorted(callee_saved_used):
        lines.append(f"    SUB SP, SP, V2")
        lines.append(f"    SAVEM {reg}, [SP]")

    # allocate locals
    if local_size > 0:
        lines.append(f"    SUB SP, SP, V{local_size}")

    return lines


def emit_epilogue(callee_saved_used: set[str], is_leaf: bool) -> list[str]:
    """Emit function epilogue assembly lines."""
    lines: list[str] = []
    if is_leaf and not callee_saved_used:
        lines.append("    MOV PC, R14")
        return lines

    # restore SP to FP (skip any locals)
    lines.append("    MOV SP, R11")

    # restore callee-saved registers: they are stored below FP.
    # Prologue pushed them in sorted order, so they are on the stack
    # from FP-2 (first pushed) to FP-N*2 (last pushed).
    # We must go below FP to read them, then pop upward.
    saved_sorted = sorted(callee_saved_used)
    if saved_sorted:
        n = len(saved_sorted)
        lines.append(f"    SUB SP, SP, V{n * 2}")
        # pop in reverse push order (bottom of stack first)
        for reg in reversed(saved_sorted):
            lines.append(f"    MOVM {reg}, [SP]")
            lines.append(f"    ADD SP, SP, V2")

    # now SP is back at FP. Restore R11 and R14.
    lines.append("    MOVM R11, [SP]")
    lines.append("    ADD SP, SP, V2")
    lines.append("    MOVM R14, [SP]")
    lines.append("    ADD SP, SP, V2")
    lines.append("    MOV PC, R14")
    return lines


def emit_arg_setup(arg_regs: list[str]) -> list[str]:
    """Emit argument passing before a call."""
    lines: list[str] = []
    for i, reg in enumerate(arg_regs[:4]):
        if reg != ARG_REGS[i]:
            lines.append(f"    MOV {ARG_REGS[i]}, {reg}")
    # args 5+ go on stack (right to left)
    for reg in reversed(arg_regs[4:]):
        lines.append(f"    SUB SP, SP, V2")
        lines.append(f"    SAVEM {reg}, [SP]")
    return lines
