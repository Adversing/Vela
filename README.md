# Vela

**Vela** is a statically-typed, compiled programming language targeting a custom 16-bit ARM-like CPU architecture. It is a companion project to the [DE1 CPU ISA](https://github.com/tonnoBelloSnello/CPU) - Vela compiles `.vl` source files into `.asm` assembly that the CPU's encoder assembles into machine code for simulation on the Verilog hardware model.

## Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Language Features](#language-features)
- [Standard Library](#standard-library)
- [Compiler Pipeline](#compiler-pipeline)
- [Code Generation](#code-generation)
- [Optimization Passes](#optimization-passes)
- [Examples](#examples)
- [Testing](#testing)

---

## Quick Start

**Requirements**: Python 3.12+

```bash
# Compile a Vela program
python -m src.main examples/hello.vl -o examples/hello.asm

# Run the generated assembly on the CPU simulator (requires DE1 CPU project)
cd ../CPU
python run.py ../Vela/examples/hello.asm
```

**Output on success**: `[velac] Compiled examples/hello.vl -> examples/hello.asm`

---

## Project Structure

```
Vela/
├── src/                          # Compiler implementation
│   ├── main.py                   # CLI entry point
│   ├── errors.py                 # Error types and reporting
│   ├── lexer/                    # Tokenization
│   │   ├── lexer.py
│   │   └── tokens.py             # Token kinds and Token dataclass
│   ├── parser/                   # AST construction
│   │   ├── parser.py             # Recursive-descent parser
│   │   └── ast_nodes.py          # AST node classes
│   ├── semantic/                 # Type checking and symbol resolution
│   │   ├── type_checker.py       # Single-pass type checker
│   │   ├── types.py              # Type definitions (IntType, PtrType_, ClassType, ...)
│   │   ├── scope.py              # Scope stack and symbol table
│   │   ├── tag_processor.py      # [[get]]/[[set]] tag expansion
│   │   ├── module_resolver.py    # Import resolution
│   │   └── inheritance.py        # Inheritance validation and vtable construction
│   ├── ir/                       # Intermediate representation
│   │   ├── instructions.py       # IR instruction classes and IROp enum
│   │   ├── builder.py            # AST -> IR lowering
│   │   └── virtual_register.py   # Virtual register allocation
│   ├── optimizer/                # IR and ASM optimization passes
│   │   ├── constant_folder.py
│   │   ├── dead_code.py
│   │   ├── strength_reduction.py
│   │   └── peephole.py           # ASM-level peephole optimizer
│   └── codegen/                  # Assembly code emission
│       ├── asm_emitter.py        # Main code emitter
│       ├── calling_convention.py # Prologue/epilogue and ABI
│       ├── register_allocator.py # Virtual -> physical register mapping
│       ├── memory_layout.py      # Data section layout
│       └── runtime.py            # Runtime library (__malloc, __free, __vdispatch, __syscall)
├── stdlib/                       # Standard library (Vela source)
│   ├── core/
│   │   └── storeable.vl          # Base class for all objects
│   ├── types/
│   │   ├── int.vl                # Int wrapper class
│   │   ├── float.vl              # Float wrapper class
│   │   ├── bool.vl               # Bool wrapper class
│   │   ├── char.vl               # Char wrapper class
│   │   ├── string.vl             # String class (length-prefixed)
│   │   ├── array.vl              # Dynamic array
│   │   ├── matrix.vl             # 2D matrix (uses native ISA ops)
│   │   └── null.vl               # NULL alias
│   └── math.vl                   # Math utilities (Abs, Min, Max, Pow, ...)
├── examples/                     # Sample programs with compiled .asm output
│   ├── hello.vl
│   ├── factorial.vl
│   ├── polymorphism.vl
│   └── linked_list.vl
├── tests/                        # Pytest test suite
│   ├── test_lexer.py
│   ├── test_parser.py
│   ├── test_semantic.py
│   └── test_integration.py
└── pyproject.toml
```

---

## Language Features

### Primitive Types

| Type  | Description              | Size    |
|-------|--------------------------|---------|
| `U0`  | Void                     | 0 bytes |
| `U8`  | Unsigned 8-bit integer   | 1 byte  |
| `I8`  | Signed 8-bit integer     | 1 byte  |
| `U16` | Unsigned 16-bit integer  | 2 bytes |
| `I16` | Signed 16-bit integer    | 2 bytes |
| `F16` | IEEE-754 half-precision  | 2 bytes |

### Pointer Types

```vl
Ptr<I16> p = &x;         // Pointer to I16
Ptr<Circle> obj = null;   // Pointer to class instance
```

### Control Flow

```vl
if (x > 0) { ... } else { ... }
while (i < 10) { i++; }
for (I16 i = 0; i < n; i++) { ... }
ret value;                // Return from function
```

### Classes

Vela supports single inheritance, virtual dispatch via vtables, and automatic `Storeable` base class injection.

```vl
class Animal {
    I16 legs;

    OnAlloc(I16 l) {
        legs = l;
    }

    OnFree() { }

    I16 getLegCount() {
        ret legs;
    }
}

class Dog : Animal {
    I16 barkVolume;

    OnAlloc(I16 l, I16 vol) {
        legs = l;
        barkVolume = vol;
    }
}
```

#### Special Methods

- **`OnAlloc`** - Constructor, called on `Init<Class>(args...)`
- **`OnFree`** - Destructor, called on `Free(ptr)`. Falls back to the default `Storeable` implementation if omitted.

#### Type Declarations (Interfaces)

```vl
type Drawable {
    skeleton U0 draw();
    skeleton I16 getArea();
}
```

### Property Tags

Fields can have `[[get]]`, `[[set]]`, or `[[get,set]]` tags that auto-generate PascalCase accessor methods:

```vl
class Point {
    [[get,set]] I16 x;
    [[get]] I16 y;
}
// Generates: GetX(), SetX(I16), GetY()
```

The compiler emits an error if you define a method that conflicts with a tag-generated accessor.

### Auto-Boxing

Primitive values are automatically boxed into stdlib wrapper classes when calling methods:

```vl
Int x = 42;
x.Abs();         // Auto-boxes x into Int, calls Int.Abs()
x.IsPositive();  // Auto-boxes x into Int, calls Int.IsPositive()

Char c = 65;
c.IsAlpha();     // Auto-boxes c into Char

Float f = 3.14;
f.Negate();      // Auto-boxes f into Float
```

**Boxing mapping**: `I16`/`U16` → `Int`, `I8` → `Bool`, `U8` → `Char`, `F16` → `Float`

### Memory Management

Manual allocation with a free-list allocator:

```vl
Ptr<Circle> c = Init<Circle>(5);   // Allocate + construct
I16 area = c.getArea();
Free(c);                            // Deallocate + destruct
```

### Import System

```vl
import stdlib::types::{int};                 // Import specific module
import stdlib::types::{int, float, array};   // Import multiple modules
import stdlib::types::{*};                   // Wildcard: import all from package
import stdlib::math::{*};                    // Math utilities
```

Resolution: `import pkg::sub::{mod}` → `<project_root>/pkg/sub/mod.vl`

`Storeable` from `stdlib/core/` is auto-imported into every compilation unit.

### Generics

```vl
Ptr<T>              // Pointer parameterized by type
Init<ClassName>()   // Generic class instantiation
SizeOf(Type)        // Compile-time size query
Cast<Type>(expr)    // Explicit type cast
```

### Built-in Functions

| Function           | Description                                |
|--------------------|--------------------------------------------|
| `Print(value)`     | Debug print (syscall)                      |
| `Malloc(size)`     | Allocate `size` bytes on the heap          |
| `Free(ptr)`        | Free heap memory (calls `OnFree` if any)   |
| `Init<T>(args...)` | Allocate + construct a class instance      |
| `SizeOf(Type)`     | Byte size of a type                        |
| `Cast<T>(expr)`    | Explicit type cast                         |

### Inline Assembly

```vl
I16 result;
ASM {
    [[in]] R0 = x;
    [[in]] R1 = y;
    ADD R0, R0, R1
    [[out]] result = R0;
}
```

### Operators

| Category    | Operators                          |
|-------------|------------------------------------|
| Arithmetic  | `+`, `-`, `*`, `/`, `%`           |
| Comparison  | `==`, `!=`, `<`, `>`, `<=`, `>=`  |
| Logical     | `&&`, `\|\|`, `!`                 |
| Assignment  | `=`, `+=`, `-=`, `*=`, `/=`       |
| Unary       | `++`, `--`, `&` (address-of)      |
| Access      | `.` (member), `[]` (index)        |

---

## Standard Library

### `stdlib/core/storeable.vl`

Implicit base class for all objects:

- `I16 GetSize()` - object size in bytes
- `I16 Pointer()` - object address
- `I16 Reference()` - reference to object

### `stdlib/types/`

| Class    | Wraps  | Key Methods |
|----------|--------|-------------|
| `Int`    | I16    | `Abs()`, `Negate()`, `IsPositive()`, `IsNegative()`, `IsZero()`, `Add()`, `Sub()`, `Mul()`, `Equals()`, `MinWith()`, `MaxWith()`, `Clamp()` |
| `Float`  | F16    | `Abs()`, `Negate()`, `IsPositive()`, `IsNegative()`, `IsZero()`, `Add()`, `Sub()`, `Mul()`, `Div()`, `Equals()`, `GreaterThan()`, `LessThan()` |
| `Bool`   | I8     | `Not()`, `And()`, `Or()`, `Xor()`, `ToInt()`, `Equals()` |
| `Char`   | U8     | `IsAlpha()`, `IsDigit()`, `IsUpper()`, `IsLower()`, `IsSpace()`, `ToUpper()`, `ToLower()`, `ToInt()`, `Equals()` |
| `String` | Ptr+len | `IsEmpty()`, `CharAt()`, `Equals()`, `Contains()`, `IndexOf()` |
| `Array`  | heap   | `Get()`, `Set()`, `Push()`, `Pop()`, `IsEmpty()`, `First()`, `Last()`, `Contains()`, `IndexOf()`, `Fill()`, `Clear()`, `Sum()` |
| `Matrix` | heap   | `Get()`, `Set()`, `Size()`, `IsSquare()`, `Fill()`, `Sum()`, `Trace()`, `MulWith()`, `AddScalar()`, `Scale()` |

### `stdlib/math.vl`

Module-level functions: `Abs()`, `Min()`, `Max()`, `Clamp()`, `Pow()`, `Sign()`

---

## Compiler Pipeline

```
Source (.vl)
  |
  +-- Lexer ------------ Tokenization (keywords, operators, literals, types)
  |
  +-- Parser ----------- Recursive-descent -> AST
  |
  +-- Semantic Analysis  Type checking, symbol resolution, import loading,
  |                      vtable construction, tag expansion
  |
  +-- IR Generation ---- AST -> three-address code (85+ IR operation types)
  |
  +-- Optimizer -------- Constant folding, strength reduction,
  |                      dead code elimination
  |
  +-- Code Generation -- IR -> assembly with register allocation,
  |                      calling convention, memory layout
  |
  +-- Peephole --------- ASM-level micro-optimizations
  |
  +-- Output (.asm)
```

---

## Code Generation

### Target Architecture

The compiler targets the custom 16-bit CPU defined in [DE1](https://github.com/tonnoBelloSnello/CPU):

- **16-bit registers** R0-R14 (R13 = SP, R14 = LR), separate PC
- **32-bit fixed-length instructions**
- **64 KB byte-addressable RAM** (little-endian for 16-bit stores)
- **12-bit immediate max** (values > 4095 use a constant pool)
- **No indexed addressing** - computed via `ADD` + `MOVM`/`SAVEM`
- **Flags set only by** CMP, CMN, TST, TEQ, FCMP (no `S` suffix on ALU ops)

### Calling Convention

| Register | Role |
|----------|------|
| R0-R3    | Arguments and return value (caller-saved) |
| R4-R10   | Callee-saved |
| R11      | Frame pointer |
| R12      | Scratch / vtable dispatch |
| R13      | Stack pointer (starts at 0xFFFF, grows down) |
| R14      | Link register |

**Stack frame layout** (high to low address):

```
[R14 saved]  [R11/FP saved]  [callee-saved R4-R10]  [locals]  <- SP
```

### Runtime Library

The compiler emits four runtime functions appended after user code:

| Function       | Purpose                                                        |
|----------------|----------------------------------------------------------------|
| `__syscall`    | System call interface (R0 = param, R1 = syscall ID)            |
| `__vdispatch`  | Virtual method dispatch (`MOV PC, R12`)                        |
| `__malloc`     | Free-list heap allocator with stack-heap collision detection    |
| `__free`       | Heap deallocation, coalesces adjacent free blocks              |

### Program Layout

```
Address 0x0000: Data section (heap_start, free_list_head, syscall vars, vtables, strings, constants)
Address N:      main: (trampoline: init heap -> init vtables -> BL __entry_main -> B __program_end)
Address M:      User functions
Address P:      Runtime functions (__syscall, __vdispatch, __malloc, __free)
Address Q:      __program_end: (null word -> CPU halts)
```

---

## Optimization Passes

### Constant Folding
Evaluates constant expressions at compile time: `2 + 3` -> `5`

### Strength Reduction
Replaces expensive operations with cheaper equivalents:
- `x * 4` -> `x << 2`
- `x / 8` -> `x >> 3`
- `x * 0` -> `0`, `x + 0` -> `x`, `x * 1` -> `x`

### Dead Code Elimination
Removes assignments whose results are never read.

### Peephole Optimization (ASM-level)
- **Self-move elimination**: `MOV Rx, Rx` -> removed
- **Immediate folding**: `MOV Rx, Vimm` followed by use -> fold immediate
- **MOV chain collapse**: `MOV Rx, src` + `MOV Ry, Rx` -> `MOV Ry, src`

---

## Examples

### hello.vl
```vl
module hello {
    U0 main() {
        I16 x = 42;
        Print(x);
        ret;
    }
}
```
Simulator result: **R0 = 42** ✓

### factorial.vl
```vl
module factorial {
    I16 factorial(I16 n) {
        if (n <= 1) { ret 1; }
        ret n * factorial(n - 1);
    }

    I16 main() {
        I16 result = factorial(5);
        Print(result);
        ret result;
    }
}
```
Simulator result: **R0 = 120** ✓

### polymorphism.vl
Demonstrates class inheritance, virtual dispatch via vtables, and the `type` system with `skeleton` methods. Two classes (`Circle` and `Square`) implement a `Shape` interface.

Simulator result: **R0 = 91** ✓

### linked_list.vl
Manual memory management with `Init<>` / `Free()`, pointer-based linked list traversal, and heap allocation.

Simulator result: **R0 = 30** ✓

---

## Testing

```bash
# Run all tests (264 tests)
pytest tests/

# Run specific test module
pytest tests/test_lexer.py -v
pytest tests/test_parser.py -v
pytest tests/test_semantic.py -v
pytest tests/test_integration.py -v
```

Test modules cover: tokenization, AST construction, type checking, inheritance validation, import resolution, and end-to-end compilation.
