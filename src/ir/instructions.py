from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto


class IROp(Enum):
    # constants and moves
    CONST = auto()
    FCONST = auto()
    MOV = auto()

    # memory
    LOAD_8 = auto()
    LOAD_16 = auto()
    STORE_8 = auto()
    STORE_16 = auto()
    LOAD_GLOBAL_ADDR = auto()

    # arithmetic
    ADD = auto()
    SUB = auto()
    MUL = auto()
    DIV = auto()
    MOD = auto()
    UDIV = auto()
    UMOD = auto()
    NEG = auto()
    RSB = auto()

    # logical
    AND = auto()
    OR = auto()
    XOR = auto()
    NOT = auto()
    BIC = auto()

    # shifts
    SHL = auto()
    SHR = auto()
    ASR = auto()

    # floating point
    FADD = auto()
    FSUB = auto()
    FMUL = auto()
    FDIV = auto()
    FCMP = auto()
    FMOV = auto()

    # comparison
    CMP = auto()

    # branches
    BRANCH = auto()
    BRANCH_EQ = auto()
    BRANCH_NE = auto()
    BRANCH_LT = auto()
    BRANCH_GT = auto()
    BRANCH_LE = auto()
    BRANCH_GE = auto()
    BRANCH_MI = auto()
    BRANCH_PL = auto()
    BRANCH_LO = auto()  # unsigned <
    BRANCH_HI = auto()  # unsigned >
    BRANCH_LS = auto()  # unsigned <=
    BRANCH_HS = auto()  # unsigned >=

    # functions
    CALL = auto()
    VCALL = auto()
    RET = auto()
    PARAM = auto()       # push argument before call

    # special
    LABEL = auto()
    SIGN_EXTEND_8 = auto()
    ASM_INLINE = auto()
    PRINT_SYSCALL = auto()

    # pointer
    PTR_ADD = auto()

    # ABS/MAX/MIN
    ABS = auto()
    MAX = auto()
    MIN = auto()


@dataclass
class IRInstr:
    op: IROp
    dest: str | None = None
    src1: str | None = None
    src2: str | None = None
    # for CONST/FCONST: immediate value
    imm: int | float | None = None
    # for LABEL/BRANCH/CALL: label name
    label: str | None = None
    # for ASM_INLINE: raw assembly lines
    asm_lines: list[str] = field(default_factory=list)
    # for CALL: number of arguments
    arg_count: int = 0
    # for type info
    type_size: int = 2  # 1 = byte, 2 = word

    def __repr__(self) -> str:
        parts = [self.op.name]
        if self.dest:
            parts.append(f"dest={self.dest}")
        if self.src1:
            parts.append(f"src1={self.src1}")
        if self.src2:
            parts.append(f"src2={self.src2}")
        if self.imm is not None:
            parts.append(f"imm={self.imm}")
        if self.label:
            parts.append(f"label={self.label}")
        return f"IR({', '.join(parts)})"
