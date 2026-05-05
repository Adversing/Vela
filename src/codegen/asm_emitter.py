from __future__ import annotations

from src.ir.instructions import IROp, IRInstr
from src.codegen.register_allocator import RegisterAllocator
from src.codegen.calling_convention import emit_prologue, emit_epilogue, ARG_REGS
from src.codegen.memory_layout import MemoryLayout
from src.codegen.runtime import emit_runtime
from src.semantic.type_checker import TypeChecker
from src.optimizer.peephole import peephole_optimize


class AsmEmitter:
    def __init__(self, checker: TypeChecker) -> None:
        self._tc = checker
        self._layout = MemoryLayout(checker)
        self._output: list[str] = []
        self._uid = 0

    def _next_uid(self) -> int:
        self._uid += 1
        return self._uid

    def emit(self, func_ir: dict[str, list[IRInstr]]) -> str:
        """Produce the complete .de1 file as a string."""
        self._func_ir = func_ir  # store for OnFree resolution

        self._scan_pools(func_ir)
        runtime_usage = self._compute_runtime_usage(func_ir)
        self._layout.configure_runtime_usage(
            uses_heap=(runtime_usage["uses_malloc"] or runtime_usage["uses_free"]),
            uses_syscall=runtime_usage["uses_syscall"],
        )

        data_lines = self._layout.build()
        self._output.extend(data_lines)
        self._output.append("")

        vtable_init = self._build_vtable_init()

        entry = "main" if "main" in func_ir else next(iter(func_ir), "main")

        self._output.append("main:")

        # Heap bootstrap is needed only when allocation can happen.
        if runtime_usage["uses_malloc"] or runtime_usage["uses_free"]:
            self._output.append("    MOV R0, __program_end")
            self._output.append("    ADD R0, R0, V4")
            self._output.append("    SAVEM R0, [__heap_start]")

        if vtable_init:
            self._output.extend(vtable_init)

        # call entry function via BL so that R14 (LR) is set correctly.
        # Without this, R14 = 0 at boot and main's MOV PC, R14 would
        # jump to address 0, causing an infinite loop.
        if entry in func_ir:
            self._output.append("    BL __entry_main")
            self._output.append("    B __program_end")
            self._output.append("")
            self._output.append("__entry_main:")
            self._emit_function_body(entry, func_ir[entry])
        self._output.append("")

        # emit all other funcs
        for func_name, instrs in func_ir.items():
            if func_name == entry:
                continue  # already emitted inline above
            self._emit_function(func_name, instrs)
            self._output.append("")

        # emit only runtime helpers that are actually referenced by IR
        self._output.extend(
            emit_runtime(
                include_syscall=runtime_usage["uses_syscall"],
                include_vdispatch=runtime_usage["uses_vdispatch"],
                include_malloc=runtime_usage["uses_malloc"],
                include_free=runtime_usage["uses_free"],
            )
        )

        self._output.append("")
        self._output.append("__program_end:") # this will be filled in by the linker with the actual end address of the program

        self._output = peephole_optimize(self._output)

        return "\n".join(self._output)

    def _compute_runtime_usage(self, func_ir: dict[str, list[IRInstr]]) -> dict[str, bool]:
        """Detect which runtime helper functions are actually needed."""
        uses_syscall = False
        uses_vdispatch = False
        uses_malloc = False
        uses_free = False

        for instrs in func_ir.values():
            for instr in instrs:
                if instr.op == IROp.PRINT_SYSCALL:
                    uses_syscall = True
                elif instr.op == IROp.VCALL:
                    uses_vdispatch = True
                elif instr.op == IROp.CALL:
                    if instr.label == "__malloc":
                        uses_malloc = True
                    elif instr.label == "__free":
                        uses_free = True

        return {
            "uses_syscall": uses_syscall,
            "uses_vdispatch": uses_vdispatch,
            "uses_malloc": uses_malloc,
            "uses_free": uses_free,
        }

    def _scan_pools(self, func_ir: dict[str, list[IRInstr]]) -> None:
        """Pre-scan IR for constants > 4095, string labels, and float constants."""
        for instrs in func_ir.values():
            for instr in instrs:
                if instr.op == IROp.CONST and isinstance(instr.imm, int):
                    if self._layout.needs_constant_pool(instr.imm):
                        self._layout.get_constant_label(instr.imm)
                if instr.op == IROp.FCONST and isinstance(instr.imm, float):
                    self._layout.get_float_label(instr.imm)
                if instr.op == IROp.LOAD_GLOBAL_ADDR and instr.label and instr.label.startswith("__str_"):
                    # already in pool via type checker
                    pass

    def _resolve_onfree_label(self, cls_name: str) -> str:
        """Walk parent chain to find nearest class with its own OnFree."""
        if f"{cls_name}_OnFree" in self._func_ir:
            return f"{cls_name}_OnFree"
        cls = self._tc.class_decls.get(cls_name)
        if cls and cls.parent and cls.parent in self._tc.class_decls:
            return self._resolve_onfree_label(cls.parent)
        return f"{cls_name}_OnFree"  # fallback

    def _build_vtable_init(self) -> list[str]:
        """Build code to initialize vtable data with method pointers at startup.

        Vtable layout: [class_size (2B)] [OnFree ptr (2B)] [method_0 (2B)] ...
        """
        lines: list[str] = []
        for cls_name, vt in self._tc.vtables.items():
            vtable_label = f"__vtable_{cls_name}"
            # use R0 as base addr, R1 as value scratch
            lines.append(f"    MOV R0, {vtable_label}")
            # slot 0: class size
            lines.append(f"    MOV R1, V{vt.class_size}")
            lines.append(f"    SAVEM R1, [R0]")
            lines.append(f"    ADD R0, R0, V2")
            # slot 1: OnFree pointer - walk parent chain if needed
            onfree_label = self._resolve_onfree_label(cls_name)
            lines.append(f"    MOV R1, {onfree_label}")
            lines.append(f"    SAVEM R1, [R0]")
            lines.append(f"    ADD R0, R0, V2")
            # method slots
            for entry in vt.entries:
                lines.append(f"    MOV R1, {entry.mangled_name}")
                lines.append(f"    SAVEM R1, [R0]")
                if entry != vt.entries[-1]:
                    lines.append(f"    ADD R0, R0, V2")
        return lines

    def _emit_function(self, name: str, instrs: list[IRInstr]) -> None:
        """Emit a labelled function (label + body)."""
        self._output.append(f"{name}:")
        self._emit_function_body(name, instrs)

    def _emit_function_body(self, name: str, instrs: list[IRInstr]) -> None:
        """Emit function body (prologue + instructions + epilogue), no label."""
        # determine if leaf function (no CALL/VCALL/PRINT_SYSCALL instructions)
        is_leaf = not any(i.op in (IROp.CALL, IROp.VCALL, IROp.PRINT_SYSCALL) for i in instrs)
        uses_stack_args = self._uses_stack_args(instrs)
        frame_is_leaf = is_leaf and not uses_stack_args

        # register allocation (pass is_leaf so allocator can prefer caller-saved)
        allocator = RegisterAllocator()
        alloc = allocator.allocate(instrs, is_leaf=is_leaf)

        # prologue
        prologue = emit_prologue(
            allocator.callee_saved_used,
            allocator.spill_size,
            frame_is_leaf,
        )
        self._output.extend(prologue)

        # track whether we already emitted the epilogue label
        epilogue_label = f"{name}_epilogue"
        #needs_epilogue_label = False

        pending_params: list[IRInstr] = []

        # emit body
        for instr in instrs:
            if instr.op == IROp.LABEL:
                if pending_params:
                    pending_params.clear()
                if instr.label == name:
                    continue  # skip function label (already emitted)
                self._output.append(f"{instr.label}:")
                continue

            if instr.op == IROp.PARAM:
                pending_params.append(instr)
                continue

            if instr.op in (IROp.CALL, IROp.VCALL):
                self._output.extend(
                    self._emit_call_with_params(
                        instr,
                        pending_params,
                        alloc,
                        allocator,
                        name,
                        frame_is_leaf,
                    )
                )
                pending_params = []
                continue

            lines = self._emit_instr(instr, alloc, allocator, name, frame_is_leaf)
            self._output.extend(lines)

        # epilogue (if not already emitted by RET)
        if instrs and instrs[-1].op != IROp.RET:
            self._output.append(f"{epilogue_label}:")
            self._output.extend(emit_epilogue(allocator.callee_saved_used, frame_is_leaf))

    def _uses_stack_args(self, instrs: list[IRInstr]) -> bool:
        def is_stack_arg(value: str | None) -> bool:
            return bool(value and value.startswith("__arg") and int(value[5:]) >= 4)

        return any(is_stack_arg(instr.dest) or is_stack_arg(instr.src1) or is_stack_arg(instr.src2)
                   for instr in instrs)

    def _is_physical_reg(self, value: str | None) -> bool:
        return bool(value and value.startswith("R") and value[1:].isdigit())

    def _spill_address_offset(self, allocator: RegisterAllocator, vreg: str) -> int:
        return len(allocator.callee_saved_used) * 2 + allocator.spills[vreg]

    def _load_spill(self, lines: list[str], allocator: RegisterAllocator,
                    vreg: str, scratch: str) -> str:
        offset = self._spill_address_offset(allocator, vreg)
        lines.append(f"    MOV {scratch}, R11")
        if offset:
            lines.append(f"    SUB {scratch}, {scratch}, V{offset}")
        lines.append(f"    MOVM {scratch}, [{scratch}]")
        return scratch

    def _store_spill(self, lines: list[str], allocator: RegisterAllocator,
                     vreg: str, value_reg: str) -> None:
        addr_scratch = "R10" if value_reg != "R10" else "R12"
        offset = self._spill_address_offset(allocator, vreg)
        lines.append(f"    MOV {addr_scratch}, R11")
        if offset:
            lines.append(f"    SUB {addr_scratch}, {addr_scratch}, V{offset}")
        lines.append(f"    SAVEM {value_reg}, [{addr_scratch}]")

    def _read_reg(self, lines: list[str], vreg: str | None,
                  alloc: dict[str, str], allocator: RegisterAllocator,
                  scratch: str = "R12") -> str:
        if vreg is None:
            return "R0"
        if self._is_physical_reg(vreg):
            return vreg
        if vreg.startswith("__arg"):
            idx = int(vreg[5:])
            if idx < 4:
                return ARG_REGS[idx]
            offset = 4 + (idx - 4) * 2
            lines.append(f"    MOV {scratch}, R11")
            lines.append(f"    ADD {scratch}, {scratch}, V{offset}")
            lines.append(f"    MOVM {scratch}, [{scratch}]")
            return scratch
        if alloc.get(vreg) == "__spill":
            return self._load_spill(lines, allocator, vreg, scratch)
        return alloc.get(vreg, "R0")

    def _write_reg(self, vreg: str | None, alloc: dict[str, str],
                   scratch: str = "R12") -> str:
        if vreg is None:
            return "R0"
        if self._is_physical_reg(vreg):
            return vreg
        if vreg.startswith("__arg"):
            idx = int(vreg[5:])
            return ARG_REGS[idx] if idx < 4 else "R0"
        if alloc.get(vreg) == "__spill":
            return scratch
        return alloc.get(vreg, "R0")

    def _store_dest(self, lines: list[str], vreg: str | None,
                    value_reg: str, alloc: dict[str, str],
                    allocator: RegisterAllocator) -> None:
        if vreg and not self._is_physical_reg(vreg) and alloc.get(vreg) == "__spill":
            self._store_spill(lines, allocator, vreg, value_reg)

    def _fmt_imm(self, val: int | float) -> str:
        if isinstance(val, float):
            return f"F{val}"
        val = int(val)
        if val < 0:
            return f"V{val}"
        if val > 4095:
            label = self._layout.get_constant_label(val)
            return f"[{label}]"
        return f"V{val}"

    def _emit_arg_setup(self, params: list[IRInstr], arg_count: int,
                        alloc: dict[str, str],
                        allocator: RegisterAllocator) -> list[str]:
        lines: list[str] = []
        by_index: dict[int, IRInstr] = {}
        for param in params:
            idx = int(param.imm if param.imm is not None else 0)
            by_index[idx] = param

        for idx in range(arg_count - 1, 3, -1):
            param = by_index.get(idx)
            if param is None:
                continue
            src = self._read_reg(lines, param.src1, alloc, allocator, "R12")
            lines.append("    SUB SP, SP, V2")
            lines.append(f"    SAVEM {src}, [SP]")

        reg_indices = [idx for idx in range(min(arg_count, 4)) if idx in by_index]
        for idx in reg_indices:
            src = self._read_reg(lines, by_index[idx].src1, alloc, allocator, "R12")
            lines.append("    SUB SP, SP, V2")
            lines.append(f"    SAVEM {src}, [SP]")

        count = len(reg_indices)
        for pos, idx in enumerate(reg_indices):
            offset = 2 * (count - 1 - pos)
            lines.append("    MOV R12, SP")
            if offset:
                lines.append(f"    ADD R12, R12, V{offset}")
            lines.append(f"    MOVM {ARG_REGS[idx]}, [R12]")
        if count:
            lines.append(f"    ADD SP, SP, V{count * 2}")
        return lines

    def _emit_call_with_params(self, instr: IRInstr, params: list[IRInstr],
                               alloc: dict[str, str],
                               allocator: RegisterAllocator,
                               func_name: str, is_leaf: bool) -> list[str]:
        lines = self._emit_arg_setup(params, instr.arg_count, alloc, allocator)

        if instr.op == IROp.CALL:
            lines.append(f"    BL {instr.label}")
            if instr.dest:
                d = self._write_reg(instr.dest, alloc, "R12")
                if d != "R0":
                    lines.append(f"    MOV {d}, R0")
                self._store_dest(lines, instr.dest, d, alloc, allocator)
        elif instr.op == IROp.VCALL:
            slot = instr.imm if instr.imm is not None else 0
            offset = 4 + int(slot) * 2
            lines.append("    MOVM R12, [R0]")
            if offset > 0:
                lines.append(f"    ADD R12, R12, V{offset}")
            lines.append("    MOVM R12, [R12]")
            lines.append("    BL __vdispatch")
            if instr.dest:
                d = self._write_reg(instr.dest, alloc, "R12")
                if d != "R0":
                    lines.append(f"    MOV {d}, R0")
                self._store_dest(lines, instr.dest, d, alloc, allocator)

        if instr.arg_count > 4:
            extra = (instr.arg_count - 4) * 2
            lines.append(f"    ADD SP, SP, V{extra}")
        return lines

    def _emit_instr(self, instr: IRInstr, alloc: dict[str, str],
                    allocator: RegisterAllocator, func_name: str,
                    is_leaf: bool) -> list[str]:
        lines: list[str] = []

        def reg(vreg: str | None, scratch: str = "R12") -> str:
            return self._read_reg(lines, vreg, alloc, allocator, scratch)

        def dreg(vreg: str | None, scratch: str = "R12") -> str:
            return self._write_reg(vreg, alloc, scratch)

        def store(vreg: str | None, value_reg: str) -> None:
            self._store_dest(lines, vreg, value_reg, alloc, allocator)

        def v(val: int) -> str:
            """Format an immediate value, using constant pool if needed."""
            if isinstance(val, float):
                return f"F{val}"
            return self._fmt_imm(val)

        op = instr.op

        if op == IROp.CONST:
            d = dreg(instr.dest)
            val = instr.imm if instr.imm is not None else 0
            val = int(val) & 0xFFFF
            if val > 4095:
                label = self._layout.get_constant_label(int(instr.imm))
                lines.append(f"    MOVM {d}, [{label}]")
            elif int(instr.imm) < 0:
                # use RSB: Rd = 0 - |val| → MVN or RSB
                abs_val = abs(int(instr.imm))
                if abs_val <= 4095:
                    lines.append(f"    MOV {d}, V0")
                    lines.append(f"    RSB {d}, {d}, V{abs_val}")
                    # we want -abs. therefore the correct instr set is: MOV d, V_abs then RSB d, d, V0
                    lines.pop()
                    lines.pop()
                    lines.append(f"    MOV {d}, V{abs_val}")
                    lines.append(f"    RSB {d}, {d}, V0")
                else:
                    label = self._layout.get_constant_label(int(instr.imm) & 0xFFFF)
                    lines.append(f"    MOVM {d}, [{label}]")
            else:
                lines.append(f"    MOV {d}, V{val}")
            store(instr.dest, d)

        elif op == IROp.FCONST:
            d = dreg(instr.dest)
            label = self._layout.get_float_label(instr.imm)
            lines.append(f"    MOVM {d}, [{label}]")
            store(instr.dest, d)

        elif op == IROp.MOV:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            if d != s:
                lines.append(f"    MOV {d}, {s}")
            store(instr.dest, d)

        elif op == IROp.LOAD_GLOBAL_ADDR:
            d = dreg(instr.dest)
            lines.append(f"    MOV {d}, {instr.label}")
            store(instr.dest, d)

        elif op == IROp.LOAD_8:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            lines.append(f"    MOV {d}, [{s}]")
            store(instr.dest, d)

        elif op == IROp.LOAD_16:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            lines.append(f"    MOVM {d}, [{s}]")
            store(instr.dest, d)

        elif op == IROp.STORE_8:
            s = reg(instr.src1)
            addr = reg(instr.src2, "R10")
            lines.append(f"    SAVE {s}, [{addr}]")

        elif op == IROp.STORE_16:
            s = reg(instr.src1)
            addr = reg(instr.src2, "R10")
            lines.append(f"    SAVEM {s}, [{addr}]")

        elif op == IROp.SIGN_EXTEND_8:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            if d != s:
                lines.append(f"    MOV {d}, {s}")
            lines.append(f"    LSL {d}, {d}, V8")
            lines.append(f"    ASR {d}, {d}, V8")
            store(instr.dest, d)

        elif op in (IROp.ADD, IROp.SUB, IROp.AND, IROp.OR, IROp.XOR, IROp.BIC):
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            name_map = {IROp.ADD: "ADD", IROp.SUB: "SUB", IROp.AND: "AND",
                       IROp.OR: "ORR", IROp.XOR: "EOR", IROp.BIC: "BIC"}
            lines.append(f"    {name_map[op]} {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.RSB:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    RSB {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.MUL:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    MUL {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.DIV:
            d = dreg(instr.dest, "R8")
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            # signed division wrapper
            uid = self._next_uid()
            lines.append(f"    # Signed division")
            lines.append(f"    ABS R12, {s1}")
            lines.append(f"    ABS {d}, {s2}")
            lines.append(f"    DIV {d}, R12, {d}")
            lines.append(f"    CMP {s1}, V0")
            lines.append(f"    BMI __sdiv_check_{uid}")
            lines.append(f"    CMP {s2}, V0")
            lines.append(f"    BMI __sdiv_neg_{uid}")
            lines.append(f"    B __sdiv_done_{uid}")
            lines.append(f"__sdiv_check_{uid}:")
            lines.append(f"    CMP {s2}, V0")
            lines.append(f"    BPL __sdiv_neg_{uid}")
            lines.append(f"    B __sdiv_done_{uid}")
            lines.append(f"__sdiv_neg_{uid}:")
            lines.append(f"    RSB {d}, {d}, V0")
            lines.append(f"__sdiv_done_{uid}:")
            store(instr.dest, d)

        elif op == IROp.MOD:
            d = dreg(instr.dest, "R8")
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    DIV R12, {s1}, {s2}")
            lines.append(f"    MUL R12, R12, {s2}")
            lines.append(f"    SUB {d}, {s1}, R12")
            store(instr.dest, d)

        elif op == IROp.SHL:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    LSL {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.SHR:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    LSR {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.ASR:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    ASR {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.NEG:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            lines.append(f"    RSB {d}, {s}, V0")
            store(instr.dest, d)

        # floating point
        elif op in (IROp.FADD, IROp.FSUB, IROp.FMUL, IROp.FDIV):
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            fp_map = {IROp.FADD: "FADD", IROp.FSUB: "FSUB",
                      IROp.FMUL: "FMUL", IROp.FDIV: "FDIV"}
            lines.append(f"    {fp_map[op]} {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.FCMP:
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    FCMP {s1}, {s2}")

        elif op == IROp.FMOV:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            lines.append(f"    FMOV {d}, {s}")
            store(instr.dest, d)

        # comparison
        elif op == IROp.CMP:
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    CMP {s1}, {s2}")

        # branches
        elif op == IROp.BRANCH:
            lines.append(f"    B {instr.label}")

        elif op in (IROp.BRANCH_EQ, IROp.BRANCH_NE, IROp.BRANCH_LT,
                    IROp.BRANCH_GT, IROp.BRANCH_LE, IROp.BRANCH_GE,
                    IROp.BRANCH_MI, IROp.BRANCH_PL):
            br_map = {
                IROp.BRANCH_EQ: "BEQ", IROp.BRANCH_NE: "BNE",
                IROp.BRANCH_LT: "BLT", IROp.BRANCH_GT: "BGT",
                IROp.BRANCH_LE: "BLE", IROp.BRANCH_GE: "BGE",
                IROp.BRANCH_MI: "BMI", IROp.BRANCH_PL: "BPL",
            }
            lines.append(f"    {br_map[op]} {instr.label}")

        # function calls
        elif op == IROp.PARAM:
            s = reg(instr.src1)
            idx = instr.imm if instr.imm is not None else 0
            if idx < 4:
                target = ARG_REGS[int(idx)]
                if s != target:
                    lines.append(f"    MOV {target}, {s}")
            else:
                lines.append(f"    SUB SP, SP, V2")
                lines.append(f"    SAVEM {s}, [SP]")

        elif op == IROp.CALL:
            lines.append(f"    BL {instr.label}")
            if instr.dest:
                d = reg(instr.dest)
                if d != "R0":
                    lines.append(f"    MOV {d}, R0")
            # clean up stack args
            if instr.arg_count > 4:
                extra = (instr.arg_count - 4) * 2
                lines.append(f"    ADD SP, SP, V{extra}")

        elif op == IROp.VCALL:
            # virtual dispatch: load target from vtable
            # always use R0 for vtable lookup: the obj pointer is placed
            # into R0 by PARAM(obj, imm=0) before VCALL. Using
            # reg(instr.src1) would read a potentially clobbered register
            # when 2+ PARAM instructions have shuffled arguments into
            # R1/R2/R3 after the obj->R0 move.
            slot = instr.imm if instr.imm is not None else 0
            # vtable offset: 2 (size) + 2 (OnFree) + slot * 2
            offset = 4 + int(slot) * 2
            lines.append(f"    MOVM R12, [R0]")
            if offset > 0:
                lines.append(f"    ADD R12, R12, V{offset}")
            lines.append(f"    MOVM R12, [R12]")
            lines.append(f"    BL __vdispatch")
            if instr.dest:
                d = reg(instr.dest)
                if d != "R0":
                    lines.append(f"    MOV {d}, R0")

        elif op == IROp.RET:
            if instr.src1:
                s = reg(instr.src1)
                if s != "R0":
                    lines.append(f"    MOV R0, {s}")
            epilogue = emit_epilogue(allocator.callee_saved_used, is_leaf)
            lines.extend(epilogue)

        elif op == IROp.PRINT_SYSCALL:
            s = reg(instr.src1)
            if s != "R0":
                lines.append(f"    MOV R0, {s}")
            lines.append(f"    MOV R1, V1")
            lines.append(f"    BL __syscall")

        elif op == IROp.ASM_INLINE:
            for line in instr.asm_lines:
                lines.append(f"    {line}")

        elif op == IROp.PTR_ADD:
            d = dreg(instr.dest, "R8")
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            elem_size = max(int(instr.type_size or 1), 1)
            if elem_size == 1:
                lines.append(f"    ADD {d}, {s1}, {s2}")
            elif elem_size == 2:
                lines.append(f"    ADD {d}, {s1}, {s2}")
                lines.append(f"    ADD {d}, {d}, {s2}")
            else:
                lines.append(f"    MOV R8, V{elem_size}")
                lines.append(f"    MUL R8, {s2}, R8")
                lines.append(f"    ADD {d}, {s1}, R8")
            store(instr.dest, d)

        elif op == IROp.ABS:
            d = dreg(instr.dest)
            s = reg(instr.src1)
            lines.append(f"    ABS {d}, {s}")
            store(instr.dest, d)

        elif op == IROp.MAX:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    MAX {d}, {s1}, {s2}")
            store(instr.dest, d)

        elif op == IROp.MIN:
            d = dreg(instr.dest)
            s1 = reg(instr.src1)
            s2 = reg(instr.src2, "R10")
            lines.append(f"    MIN {d}, {s1}, {s2}")
            store(instr.dest, d)

        return lines
