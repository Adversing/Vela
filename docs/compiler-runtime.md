# Vela Implementation Reference

This document describes translation, runtime support, ABI, and target CPU
facts for the current Vela compiler.

## 1. Translation

### Synopsis

```bash
python -m src.main input.vl -o output.de1
```

### Translation Phases

```text
source characters
  -> tokens
  -> abstract syntax tree
  -> semantic analysis
  -> intermediate representation
  -> optimized intermediate representation
  -> .de1 assembly
  -> peephole-optimized .de1 assembly
```

### Description

The compiler parses all modules in the source file, resolves imports, checks
types, lowers to IR, applies optimization passes, and emits textual `.de1`
assembly for the CPU assembler and simulator.

Imported modules that are required for code generation are inserted into the
compilation unit before IR generation.

## 2. Target Machine

### Parameters

| Item | Value |
| --- | --- |
| Data cell width | 8 bits |
| Register width | 16 bits by default |
| Address width | 16 bits by default |
| Addressable RAM | 64 KB by default |
| Instruction width | 32 bits |
| General registers | R0 through R14 |
| Stack pointer convention | R13, written as `SP` |
| Link register | R14 |
| Program counter | separate register, written as `PC` |

### Instruction Notes

The generated assembly uses the CPU's ARM-like instruction set. Common
instructions include `MOV`, `ADD`, `SUB`, `CMP`, `B`, `BL`, `MOVM`, `SAVEM`,
`SAVE`, `ABS`, `MAX`, `MIN`, and binary16 floating point operations.

The CPU encoding has a 12-bit immediate operand field. The code generator emits
small immediates directly and stores larger constants in the data section.

## 3. Program Image

### Layout

```text
space:
    runtime variables
    user globals
    vtables
    string literals
    integer constant pool
    float constant pool

main:
    optional heap setup
    optional vtable setup
    BL __entry_main
    B __program_end

__entry_main:
    compiled Vela `main` function

other compiled functions
runtime helpers

__program_end:
```

### Semantics

Runtime helpers are emitted only if referenced. For example, a program that
does not call `Print` does not include `__syscall`, and a program that does not
allocate does not include `__malloc`.

## 4. Calling Convention

### Register Use

| Register | Use |
| --- | --- |
| R0 | first argument and return value |
| R1 through R3 | arguments 2 through 4 |
| R4 through R10 | callee-saved |
| R11 | frame pointer |
| R12 | scratch and virtual dispatch target |
| SP | stack pointer |
| R14 | link register |

### Constraints

Arguments after the fourth are passed on the stack. The caller removes those
stack arguments after the call.

### Function Frame

Non-leaf functions and functions that need spills or callee-saved registers use
a frame with this logical sequence:

```text
push R14
push R11
set R11 = SP
push used callee-saved registers
reserve spill slots
```

Leaf functions with no spills and no callee-saved register use may omit the
frame.

## 5. Data Representation

### Scalars

| Vela type | Storage |
| --- | --- |
| `U8`, `I8`, Bool payloads | 1 byte |
| `U16`, `I16`, `F16` | 2 bytes |
| `Ptr<T>` | 2 bytes |

Multi-byte scalar values are stored little-endian in CPU memory.

### Strings

String literals are emitted as labels in `space:` and are terminated by a zero
byte. Their Vela type is `Ptr<U8>`.

## 6. Object Representation

### Object Layout

```text
offset 0: vtable pointer, 2 bytes
offset 2: first field
offset n: following fields
```

Inherited fields are laid out before fields declared by a child class.

### Vtable Layout

```text
offset 0: class size, 2 bytes
offset 2: OnFree pointer, 2 bytes
offset 4: method slot 0
offset 6: method slot 1
...
```

### Virtual Calls

A virtual call loads the object's vtable pointer, reads the selected method
slot, places the target address in `R12`, and branches through `__vdispatch`.

When devirtualization proves the concrete class, the call may be emitted as a
direct `CALL` instead.

## 7. Heap Runtime

### Allocation

`Malloc(size)` lowers to `__malloc(size)`. Each heap block has a 4-byte header:

```text
offset 0: block_size, including header
offset 2: next_free
offset 4: user data
```

### Free List

The allocator keeps a free list sorted by address. `__malloc` can split large
free blocks. `__free` reinserts blocks and coalesces adjacent free blocks.

### Object Free

For class pointers, `Free(p)` first calls the resolved `OnFree` path. If that
path is `Storeable_OnFree`, it already performs raw deallocation. Otherwise the
compiler emits a following call to `__free`.

`Free(null)` returns without doing work.

## 8. Runtime Syscall

### Synopsis

```text
R0 = parameter
R1 = syscall id
BL __syscall
```

### Description

`Print(value)` uses syscall id `1`. The runtime stores the parameter and id in
runtime variables that the CPU runner can inspect.

## 9. Inline Assembly Boundary

### Semantics

Inline assembly blocks are emitted into the instruction stream after input
bindings and before output bindings.

The register allocator reserves physical registers that inline assembly uses.
If an inline assembly block mentions callee-saved registers, the function frame
preserves them.

### Optimizer Effects

Inline assembly is a conservative boundary. Constant propagation and strength
reduction forget facts about physical registers across it. Escape analysis does
not scalarize functions containing inline assembly.

## 10. Optimization Passes

### Constant Folding

Constant folding replaces IR operations with constants when all inputs are
known. Labels, calls, and inline assembly clear relevant facts.

Signed division truncates toward zero. Signed and unsigned division or modulo
by zero fold to `0`, matching the generated runtime path.

### Strength Reduction

Strength reduction rewrites multiplication by powers of two as shifts and
removes arithmetic identities such as addition by zero.

### Devirtualization

The devirtualizer recognizes objects allocated by `__malloc` and initialized
with a known vtable. A virtual call on such an object can become a direct call
to the method label from the vtable slot.

### Inlining

The inliner can inline functions that:

- have at most 32 IR instructions;
- are not directly recursive;
- do not contain inline assembly;
- are not runtime allocation helpers.

### Escape Analysis and SROA

Escape analysis identifies heap allocations whose pointer value does not
escape the current function. Such objects can be replaced with scalar virtual
registers for their fields. The pass can remove matching allocation,
constructor, vtable store, and free operations.

### Dead Code Elimination

Dead code elimination removes assignments whose results are never read. It
also drops instructions after unconditional return or branch until the next
label.

### Assembly Peephole

The peephole pass operates on emitted assembly text. It:

- removes self moves;
- folds immediates into following instructions where safe;
- collapses simple move chains;
- predicates small branch-over patterns using condition suffixes;
- recognizes selected `CMP` plus conditional move patterns as `MAX` or `MIN`;
- removes unreferenced compiler-generated labels.

## 11. Diagnostics and Reserved Names

### Reserved Labels

The labels `main` and `space` are reserved by the generated program layout.
Names beginning with `__` are reserved for compiler and runtime use.

### Common Rejections

The semantic checker rejects:

- unknown types and identifiers;
- duplicate top-level declarations in a module;
- imported declarations that collide in the flat assembly namespace;
- method calls on primitive values;
- field access on primitive values;
- `U0` variables, parameters, and fields;
- non-Bool conditions;
- address-of applied to locals or parameters;
- integer and `F16` mixed arithmetic;
- casts between `F16` and non-float types.

## 12. Running Output

### Synopsis

```bash
cd ../CPU
python run.py ../Vela/examples/factorial.de1
```

### Description

The CPU runner reads textual `.de1` assembly, runs the simulation, and prints
register values and logs. The Vela test suite includes end-to-end checks for
the bundled examples when the CPU runner and simulator dependencies are
available.
