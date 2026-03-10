from __future__ import annotations

from src.ir.instructions import IROp, IRInstr


def escape_analyze(instrs: list[IRInstr]) -> list[IRInstr]:
    """Run escape analysis + SROA on one function's instruction list.

    Returns a new instruction list with non-escaping allocations
    replaced by scalar registers and the enclosing malloc/free removed.
    """
    # 1: find all allocations  (CALL __malloc -> dest register)
    allocs = _find_allocations(instrs)
    if not allocs:
        return instrs

    # 2: determine which allocations escape
    non_escaping = _find_non_escaping(instrs, allocs)
    if not non_escaping:
        return instrs

    # 3: sroa - replace field accesses with scalars
    return _scalarise(instrs, non_escaping)

def _find_allocations(instrs: list[IRInstr]) -> dict[str, int]:
    """Return a dict of  allocating_register -> index_in_instrs  for
    every CALL __malloc in the stream.
    """
    allocs: dict[str, int] = {}
    for i, instr in enumerate(instrs):
        if (instr.op == IROp.CALL
                and instr.label == "__malloc"
                and instr.dest):
            allocs[instr.dest] = i
    return allocs

def _find_non_escaping(
    instrs: list[IRInstr],
    allocs: dict[str, int],
) -> set[str]:
    """Return the subset of allocation registers that do NOT escape."""
    escaping: set[str] = set()

    # also track aliases: MOV alias, obj -> alias is also the same object
    # transitive: MOV a, alloc; MOV b, a -> b aliases alloc too
    aliases: dict[str, str] = {}  # alias -> original alloc reg
    for instr in instrs:
        if instr.op == IROp.MOV and instr.dest:
            if instr.src1 in allocs:
                aliases[instr.dest] = instr.src1
            elif instr.src1 in aliases:
                aliases[instr.dest] = aliases[instr.src1]

    def _root(reg: str) -> str | None:
        """Resolve a register to its allocation root (if any)."""
        if reg in allocs:
            return reg
        return aliases.get(reg)

    for instr in instrs:
        # PARAM src1 -> the object is being passed as an argument
        if instr.op == IROp.PARAM and instr.src1:
            root = _root(instr.src1)
            if root:
                # mark as escaping unless the next CALL is __free
                # (I will check this in the context scan below)
                escaping.add(root)

        # VCALL with source as object -> not devirtualized, escapes
        if instr.op == IROp.VCALL and instr.src1:
            root = _root(instr.src1)
            if root:
                escaping.add(root)

        # STORE where the value being stored is the allocation pointer
        # (not where the allocation pointer is the address)
        if instr.op in (IROp.STORE_8, IROp.STORE_16) and instr.src1:
            root = _root(instr.src1)
            if root:
                # however STORE_16 vtable_reg, obj is storing into the
                # object, not storing the object somewhere. That's the
                # case when src2 == root (the object is the address).
                if instr.src2 and _root(instr.src2) == root:
                    pass  # writing a field into our own object - safe
                else:
                    escaping.add(root)

    # 2nd pass: un-escape allocations that are ONLY passed to __free.
    # The first pass conservatively marked all PARAM uses as escaping;
    # now refine.
    refined_escaping = set(escaping)
    for root in escaping:
        if _only_param_use_is_free(instrs, root, aliases):
            refined_escaping.discard(root)

    return set(allocs.keys()) - refined_escaping


def _only_param_use_is_free(
    instrs: list[IRInstr],
    alloc_reg: str,
    aliases: dict[str, str],
) -> bool:
    """Check whether the only PARAM usage of *alloc_reg* feeds into the
    OnAlloc call or ``__free`` — both of which are safe for SROA.
    """
    regs = {alloc_reg} | {a for a, r in aliases.items() if r == alloc_reg}

    i = 0
    while i < len(instrs):
        instr = instrs[i]
        if instr.op == IROp.PARAM and instr.src1 in regs:
            # find the subsequent CALL
            call = _find_next_call(instrs, i + 1)
            if call is None:
                return False
            label = call.label or ""
            if label not in ("__free", "__malloc") and not label.endswith("_OnAlloc"):
                # passed to an arbitrary function - not safe
                return False
        i += 1
    return True


def _find_next_call(instrs: list[IRInstr], start: int) -> IRInstr | None:
    """Find the next CALL instruction at or after *start*."""
    for i in range(start, len(instrs)):
        if instrs[i].op == IROp.CALL:
            return instrs[i]
        # stop if we hit a label (different basic block)
        if instrs[i].op == IROp.LABEL:
            return None
    return None

def _scalarise(
    instrs: list[IRInstr],
    non_escaping: set[str],
) -> list[IRInstr]:
    """Replace field accesses on non-escaping objects with scalar registers
    and remove the enclosing malloc/free calls.

    Field accesses are recognised as:
        CONST off_reg, <offset>
        ADD   addr_reg, obj_reg, off_reg
        STORE_16 val_reg, addr_reg        <- field write
        LOAD_16  dest, addr_reg           <- field read

    They get replaced with:
        MOV __scalar_<obj>_<offset>, val_reg  (write)
        MOV dest, __scalar_<obj>_<offset>     (read)
    """
    # build alias map (transitive: MOV a, alloc; MOV b, a -> b aliases alloc)
    aliases: dict[str, str] = {}
    for instr in instrs:
        if instr.op == IROp.MOV and instr.dest:
            if instr.src1 in non_escaping:
                aliases[instr.dest] = instr.src1
            elif instr.src1 in aliases:
                aliases[instr.dest] = aliases[instr.src1]

    def _root(reg: str) -> str | None:
        if reg in non_escaping:
            return reg
        return aliases.get(reg)

    # pre-scan: track constant values for offset computation
    const_vals: dict[str, int] = {}
    for instr in instrs:
        if instr.op == IROp.CONST and instr.dest and isinstance(instr.imm, int):
            const_vals[instr.dest] = instr.imm

    # track ADD results: addr_reg = obj_reg + const_offset
    # i'll build this incrementally.
    addr_to_field: dict[str, tuple[str, int]] = {}
    # addr_reg -> (obj_root, offset)

    # also track which instructions to remove entirely.
    remove_indices: set[int] = set()

    # first pass: identify all addr computations and mark for removal
    for i, instr in enumerate(instrs):
        if instr.op == IROp.ADD and instr.dest and instr.src1 and instr.src2:
            root1 = _root(instr.src1)
            root2 = _root(instr.src2)
            if root1 and instr.src2 in const_vals:
                addr_to_field[instr.dest] = (root1, const_vals[instr.src2])
                remove_indices.add(i)
            elif root2 and instr.src1 in const_vals:
                addr_to_field[instr.dest] = (root2, const_vals[instr.src1])
                remove_indices.add(i)

    # track which alloc regs correspond to which PARAM+CALL sequences to remove.
    alloc_call_indices = _find_alloc_free_indices(instrs, non_escaping, aliases)
    remove_indices.update(alloc_call_indices)

    # second pass: rewrite loads/stores to scalars
    result: list[IRInstr] = []
    for i, instr in enumerate(instrs):
        if i in remove_indices:
            continue

        # STORE_16 val, addr  where addr is obj+offset -> scalar write
        if instr.op == IROp.STORE_16 and instr.src2 in addr_to_field:
            obj_root, offset = addr_to_field[instr.src2]
            scalar = _scalar_name(obj_root, offset)
            result.append(IRInstr(op=IROp.MOV, dest=scalar, src1=instr.src1))
            continue

        # STORE_16 directly into obj (offset 0 = vtable ptr write)
        if instr.op == IROp.STORE_16 and instr.src2:
            root = _root(instr.src2)
            if root:
                # this is the vtable pointer store - just remove it
                continue

        # LOAD_16 dest, addr  where addr is obj+offset -> scalar read
        if instr.op == IROp.LOAD_16 and instr.src1 in addr_to_field:
            obj_root, offset = addr_to_field[instr.src1]
            scalar = _scalar_name(obj_root, offset)
            result.append(IRInstr(op=IROp.MOV, dest=instr.dest, src1=scalar))
            continue

        # LOAD_16 directly from obj (offset 0 = vtable ptr read)
        if instr.op == IROp.LOAD_16 and instr.src1:
            root = _root(instr.src1)
            if root:
                # vtable ptr load on a scalarised object - can be removed
                # unless someone actually uses the vtable (which shouldn't
                # happen after devirtualisation).
                continue

        # skip CONST instructions that only served as offsets for removed ADDs
        if (instr.op == IROp.CONST
                and instr.dest in const_vals
                and instr.dest in {i.src2 for i in instrs if i.op == IROp.ADD
                                   and i.dest in addr_to_field}):
            # check: is this const ONLY used as an offset for scalarised
            # accesses? if so, remove it.
            if _register_only_used_in(instrs, instr.dest, remove_indices, addr_to_field):
                continue

        # LOAD_GLOBAL_ADDR for vtable of a scalarised object - remove
        if (instr.op == IROp.LOAD_GLOBAL_ADDR
                and instr.label
                and instr.label.startswith("__vtable_")):
            # check if this vtable load feeds into a STORE into a
            # non-escaping object (already removed above)
            if _vtable_load_feeds_scalarised(instrs, i, instr.dest, non_escaping, aliases):
                continue

        # MOV propagating a scalarised object pointer - remove
        # (DCE will clean up later, but removing here avoids reading
        # a register whose definition was already removed.)
        if instr.op == IROp.MOV and instr.src1:
            root = _root(instr.src1)
            if root:
                # this MOV copies the (now-scalarised) pointer - skip it.
                continue

        result.append(instr)

    return result


def _scalar_name(obj_reg: str, offset: int) -> str:
    """Generate a unique scalar register name for a field."""
    return f"__scalar_{obj_reg}_off{offset}"


def _find_alloc_free_indices(
    instrs: list[IRInstr],
    non_escaping: set[str],
    aliases: dict[str, str],
) -> set[int]:
    """Find indices of instructions that are part of the malloc/free
    lifecycle of non-escaping objects and should be removed.
    """
    remove: set[int] = set()
    regs = set(non_escaping) | {a for a, r in aliases.items() if r in non_escaping}

    # find __malloc CALL and its preceding PARAM(size)
    for i, instr in enumerate(instrs):
        if (instr.op == IROp.CALL
                and instr.label == "__malloc"
                and instr.dest in non_escaping):
            remove.add(i)
            # look backward for the PARAM that feeds the size
            for j in range(i - 1, max(i - 5, -1), -1):
                if instrs[j].op == IROp.PARAM:
                    remove.add(j)
                    # also remove the CONST that feeds the size param
                    if instrs[j].src1:
                        for k in range(j - 1, max(j - 5, -1), -1):
                            if (instrs[k].op == IROp.CONST
                                    and instrs[k].dest == instrs[j].src1):
                                remove.add(k)
                                break
                    break

    # find __free CALL and its preceding PARAM(obj)
    for i, instr in enumerate(instrs):
        if instr.op == IROp.CALL and instr.label == "__free":
            # check if the preceding PARAM passes a non-escaping object
            for j in range(i - 1, max(i - 5, -1), -1):
                if instrs[j].op == IROp.PARAM and instrs[j].src1 in regs:
                    remove.add(i)
                    remove.add(j)
                    break

    # find OnAlloc CALL and its preceding PARAMs
    for i, instr in enumerate(instrs):
        if (instr.op == IROp.CALL
                and instr.label
                and instr.label.endswith("_OnAlloc")):
            # check if the first PARAM (self) is a non-escaping object
            for j in range(i - 1, -1, -1):
                if instrs[j].op == IROp.PARAM and instrs[j].imm == 0:
                    if instrs[j].src1 in regs:
                        remove.add(i)
                        # remove all PARAMs for this call
                        for k in range(j, i):
                            if instrs[k].op == IROp.PARAM:
                                remove.add(k)
                    break

    return remove


def _register_only_used_in(
    instrs: list[IRInstr],
    reg: str,
    removed_indices: set[int],
    addr_map: dict[str, tuple[str, int]],
) -> bool:
    """Check if a register is only used in instructions that are being removed
    or in ADD instructions that compute addresses for scalarised fields.
    """
    for i, instr in enumerate(instrs):
        if i in removed_indices:
            continue
        if instr.src1 == reg or instr.src2 == reg:
            if instr.op == IROp.ADD and instr.dest in addr_map:
                continue  # this ADD is being removed too
            return False
    return True


def _vtable_load_feeds_scalarised(
    instrs: list[IRInstr],
    load_idx: int,
    vt_reg: str,
    non_escaping: set[str],
    aliases: dict[str, str],
) -> bool:
    """Check if a LOAD_GLOBAL_ADDR (vtable) result is only stored into
    a non-escaping object.
    """
    regs = set(non_escaping) | {a for a, r in aliases.items() if r in non_escaping}

    for i in range(load_idx + 1, min(load_idx + 10, len(instrs))):
        instr = instrs[i]
        if instr.op == IROp.STORE_16 and instr.src1 == vt_reg:
            if instr.src2 in regs:
                return True
        if instr.op == IROp.LABEL:
            break
    return False
