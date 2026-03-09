from __future__ import annotations

from dataclasses import dataclass

from src.ir.instructions import IROp, IRInstr

# physical registers available for allocation
CALLER_SAVED = ["R0", "R1", "R2", "R3", "R12"]
CALLEE_SAVED = ["R4", "R5", "R6", "R7", "R8", "R9", "R10"]
ALL_REGS = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7",
            "R8", "R9", "R10", "R12"]


@dataclass
class LiveInterval:
    vreg: str
    start: int
    end: int
    phys_reg: str | None = None
    spill_offset: int | None = None
    crosses_call: bool = False


class RegisterAllocator:
    """Linear scan register allocation mapping virtual -> physical registers."""

    def __init__(self) -> None:
        self.allocation: dict[str, str] = {}
        self.spills: dict[str, int] = {}
        self._next_spill = 0
        self.callee_saved_used: set[str] = set()

    def allocate(self, instrs: list[IRInstr], is_leaf: bool = False) -> dict[str, str]:
        """Compute virtual-to-physical register mapping."""
        self._is_leaf = is_leaf
        intervals = self._compute_intervals(instrs)
        intervals.sort(key=lambda iv: iv.start)
        self._linear_scan(intervals)
        return self.allocation

    def _compute_intervals(self, instrs: list[IRInstr]) -> list[LiveInterval]:
        first_use: dict[str, int] = {}
        last_use: dict[str, int] = {}

        for i, instr in enumerate(instrs):
            for reg in self._regs_of(instr):
                if reg not in first_use:
                    first_use[reg] = i
                last_use[reg] = i

        # find positions of all call-like instructions
        call_positions: list[int] = []
        for i, instr in enumerate(instrs):
            if instr.op in (IROp.CALL, IROp.VCALL, IROp.PRINT_SYSCALL):
                call_positions.append(i)

        intervals: list[LiveInterval] = []
        for vreg in first_use:
            if vreg.startswith("R") or vreg.startswith("__arg"):
                continue
            iv = LiveInterval(vreg=vreg, start=first_use[vreg], end=last_use[vreg])
            # check if this interval spans any call
            for pos in call_positions:
                if iv.start < pos < iv.end:
                    iv.crosses_call = True
                    break
            intervals.append(iv)
        return intervals

    def _regs_of(self, instr: IRInstr) -> list[str]:
        regs = []
        if instr.dest:
            regs.append(instr.dest)
        if instr.src1:
            regs.append(instr.src1)
        if instr.src2:
            regs.append(instr.src2)
        return regs

    def _linear_scan(self, intervals: list[LiveInterval]) -> None:
        active: list[LiveInterval] = []
        free_regs = list(ALL_REGS)

        for iv in intervals:
            # expire old intervals
            expired = []
            for a in active:
                if a.end < iv.start:
                    expired.append(a)
                    if a.phys_reg and a.phys_reg in ALL_REGS:
                        free_regs.append(a.phys_reg)
            for e in expired:
                active.remove(e)

            if iv.crosses_call:
                # must use a callee-saved register to survive the call
                callee_free = [r for r in free_regs if r in CALLEE_SAVED]
                if callee_free:
                    reg = callee_free[0]
                    free_regs.remove(reg)
                    iv.phys_reg = reg
                    self.allocation[iv.vreg] = reg
                    self.callee_saved_used.add(reg)
                    active.append(iv)
                    active.sort(key=lambda x: x.end)
                else:
                    # no callee-saved register free; try to evict a non-cross-call
                    # interval from a callee-saved register
                    evicted = False
                    for a in reversed(active):
                        if a.phys_reg in CALLEE_SAVED and not a.crosses_call:
                            # evict this one to a caller-saved or spill
                            old_reg = a.phys_reg
                            # try to give the evicted interval a caller-saved reg
                            caller_free = [r for r in free_regs if r in CALLER_SAVED]
                            if caller_free:
                                new_reg = caller_free[0]
                                free_regs.remove(new_reg)
                                a.phys_reg = new_reg
                                self.allocation[a.vreg] = new_reg
                            else:
                                active.remove(a)
                                self._spill(a)
                            iv.phys_reg = old_reg
                            self.allocation[iv.vreg] = old_reg
                            self.callee_saved_used.add(old_reg)
                            active.append(iv)
                            active.sort(key=lambda x: x.end)
                            evicted = True
                            break
                    if not evicted:
                        self._spill(iv)
            elif free_regs:
                # always prefer caller-saved registers for intervals that
                # don't cross a call: it avoids callee-saved save/restore cost.
                caller = [r for r in free_regs if r in CALLER_SAVED]
                if caller:
                    reg = caller[0]
                    free_regs.remove(reg)
                else:
                    reg = free_regs.pop(0)
                iv.phys_reg = reg
                self.allocation[iv.vreg] = reg
                if reg in CALLEE_SAVED:
                    self.callee_saved_used.add(reg)
                active.append(iv)
                active.sort(key=lambda x: x.end)
            else:
                # spill: evict the interval ending latest
                if active and active[-1].end > iv.end:
                    spill_iv = active[-1]
                    iv.phys_reg = spill_iv.phys_reg
                    self.allocation[iv.vreg] = iv.phys_reg
                    spill_iv.phys_reg = None
                    self._spill(spill_iv)
                    active.remove(spill_iv)
                    active.append(iv)
                    active.sort(key=lambda x: x.end)
                else:
                    self._spill(iv)

    def _spill(self, iv: LiveInterval) -> None:
        self._next_spill += 2  # 16-bit = 2 bytes
        iv.spill_offset = self._next_spill
        self.spills[iv.vreg] = self._next_spill
        # let's use for now a default register for spilled values (will generate load/store)
        self.allocation[iv.vreg] = "__spill"

    @property
    def spill_size(self) -> int:
        return self._next_spill
