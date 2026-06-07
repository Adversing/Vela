from __future__ import annotations

from src.ir.instructions import IROp, IRInstr
from src.semantic.inheritance import VtableInfo


def devirtualize(
    instrs: list[IRInstr],
    vtables: dict[str, VtableInfo],
) -> list[IRInstr]:
    """Replace VCALL instructions with direct CALL when the receiver type
    is statically known.

    Returns a new instruction list.
    """
    malloc_results: set[str] = set()
    vtable_loads: dict[str, str] = {}
    obj_class: dict[str, str] = {}
    result: list[IRInstr] = []

    for instr in instrs:
        replacement: IRInstr | None = None
        if instr.op == IROp.VCALL and instr.src1 in obj_class:
            cls_name = obj_class[instr.src1]
            vt = vtables.get(cls_name)
            if vt is not None and instr.imm is not None:
                entry = _slot_lookup(vt, instr.imm)
                if entry is not None:
                    replacement = IRInstr(
                        op=IROp.CALL,
                        dest=instr.dest,
                        label=entry.mangled_name,
                        arg_count=instr.arg_count,
                    )

        if instr.op == IROp.ASM_INLINE:
            malloc_results.clear()
            vtable_loads.clear()
            obj_class.clear()
            result.append(replacement or instr)
            continue

        previous_dest_class = obj_class.get(instr.dest) if instr.dest else None
        if instr.dest:
            malloc_results.discard(instr.dest)
            vtable_loads.pop(instr.dest, None)
            obj_class.pop(instr.dest, None)

        if (instr.op == IROp.CALL
                and instr.label == "__malloc"
                and instr.dest):
            malloc_results.add(instr.dest)
        elif (instr.op == IROp.CALL
              and instr.dest
              and instr.label
              and instr.label.endswith("_OnAlloc")
              and previous_dest_class is not None
              and instr.label[:-len("_OnAlloc")] == previous_dest_class):
            obj_class[instr.dest] = previous_dest_class

        if (instr.op == IROp.LOAD_GLOBAL_ADDR
                and instr.dest
                and instr.label
                and instr.label.startswith("__vtable_")):
            vtable_loads[instr.dest] = instr.label

        if instr.op == IROp.STORE_16 and instr.src1 and instr.src2:
            vt_label = vtable_loads.get(instr.src1)
            if vt_label and instr.src2 in malloc_results:
                obj_class[instr.src2] = vt_label[len("__vtable_"):]

        if instr.op == IROp.MOV and instr.dest and instr.src1:
            if instr.src1 in obj_class:
                obj_class[instr.dest] = obj_class[instr.src1]
            if instr.src1 in malloc_results:
                malloc_results.add(instr.dest)
            if instr.src1 in vtable_loads:
                vtable_loads[instr.dest] = vtable_loads[instr.src1]

        result.append(replacement or instr)
    return result


def _infer_object_classes(instrs: list[IRInstr]) -> dict[str, str]:
    """Scan the instruction stream and build a register -> class name map.

    Recognises two patterns:

    Pattern A (autobox / Init):
        CALL obj, __malloc
        LOAD_GLOBAL_ADDR vtR, __vtable_<ClassName>
        STORE_16 vtR, obj

    Pattern B (LOAD_GLOBAL_ADDR directly into STORE_16 with obj):
        Same as A but the vtable load may be separated from the store by
        a few other instructions.

    We track the latest vtable label loaded into each register, and when
    we see a STORE_16 with a vtable register into an object register that
    came from __malloc, we record the mapping.
    """

    # registers that received a __malloc result
    malloc_results: set[str] = set()
    # register -> vtable label string  (e.g. "__vtable_Int")
    vtable_loads: dict[str, str] = {}
    # final map:  obj_register -> class_name
    obj_class: dict[str, str] = {}

    for instr in instrs:
        previous_dest_class = obj_class.get(instr.dest) if instr.dest else None
        if instr.dest:
            # Any write replaces the previous value in that register, so all
            # facts about the old value must be discarded before adding facts
            # learned from the current instruction.
            malloc_results.discard(instr.dest)
            vtable_loads.pop(instr.dest, None)
            obj_class.pop(instr.dest, None)

        # track malloc results
        if (instr.op == IROp.CALL
                and instr.label == "__malloc"
                and instr.dest):
            malloc_results.add(instr.dest)
        elif (instr.op == IROp.CALL
              and instr.dest
              and instr.label
              and instr.label.endswith("_OnAlloc")
              and previous_dest_class is not None
              and instr.label[:-len("_OnAlloc")] == previous_dest_class):
            # Preserve legacy/manual IR that models constructors as
            # CALL dest=obj, Class_OnAlloc.
            obj_class[instr.dest] = previous_dest_class

        # track vtable address loads
        if (instr.op == IROp.LOAD_GLOBAL_ADDR
                and instr.dest
                and instr.label
                and instr.label.startswith("__vtable_")):
            vtable_loads[instr.dest] = instr.label

        # track vtable stores into malloc'd objects
        if instr.op == IROp.STORE_16 and instr.src1 and instr.src2:
            vt_label = vtable_loads.get(instr.src1)
            if vt_label and instr.src2 in malloc_results:
                # extract class name from "__vtable_ClassName"
                cls_name = vt_label[len("__vtable_"):]
                obj_class[instr.src2] = cls_name

        # also propagate through MOV: if obj is MOV'd, the copy also
        # points to the same object.
        if instr.op == IROp.MOV and instr.dest and instr.src1:
            if instr.src1 in obj_class:
                obj_class[instr.dest] = obj_class[instr.src1]
            if instr.src1 in malloc_results:
                malloc_results.add(instr.dest)
            if instr.src1 in vtable_loads:
                vtable_loads[instr.dest] = vtable_loads[instr.src1]

    return obj_class


def _slot_lookup(vt: VtableInfo, slot: int):
    """Look up a vtable entry by slot index."""
    for entry in vt.entries:
        if entry.slot_index == slot:
            return entry
    return None
