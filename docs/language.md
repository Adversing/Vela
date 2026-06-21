# Vela Language Reference

This document describes the syntax and semantics accepted by the Vela
compiler. 

## 1. Translation Units

### Syntax

```text
program:
    module-declaration+

module-declaration:
    module identifier { module-item* }

module-item:
    import-declaration
    alias-declaration
    variable-declaration
    function-definition
    class-declaration
    type-declaration
```

### Constraints

Two modules in the same source file shall not have the same module name. A
source file shall begin with a `module` declaration.

The generated assembly namespace is flat. Top-level declarations from the
current module and imported modules shall not produce the same assembly label.
Names beginning with `__` are reserved.

### Semantics

A compiled program shall define a top-level function named `main` in the source
translation unit. Missing `main` is a semantic error. Imported functions named
`main` do not satisfy this entry point requirement.

### Example

```vl
module hello {
    U0 main() {
        Print(42);
        ret;
    }
}
```

## 2. Lexical Elements

### Comments

```vl
// comment
# comment
```

Comments extend to the end of the line.

### Identifiers

Identifiers begin with a letter or `_` and continue with letters, digits, or
`_`. Keywords and built-in names listed below are reserved in the positions
where the grammar recognizes them.

### Keywords

```text
alias class else for if import module OnAlloc OnFree ret skeleton type while ASM
```

### Primitive Type Names

```text
U0 U8 I8 U16 I16 F16 Ptr
```

### Built-In Function Names

```text
Malloc Free Init SizeOf Cast Print
```

### Literals

| Form | Type | Notes |
| --- | --- | --- |
| `42`, `1_000` | integer | Decimal. |
| `0xFF` | integer | Hexadecimal. |
| `0b1010` | integer | Binary. |
| `3.14`, `1.0e-2` | `F16` | Binary16 value in the backend. |
| `'A'`, `'\n'` | `U8` | Character code shall fit in 0..255. |
| `"text"` | `Ptr<U8>` | Emitted as zero-terminated data. |
| `true`, `false` | Bool | Internal boolean value. |
| `null` | `Ptr<U0>` | Assignable to any pointer type. |

Integer literals shall fit in the 16-bit range accepted by the compiler.
Negative integer literals are parsed as unary `-` applied to a positive
integer literal.

## 3. Imports

### Syntax

```text
import-declaration:
    import package-path::{ import-list } ;

package-path:
    identifier (:: identifier)*

import-list:
    *
    identifier (, identifier)*
```

### Semantics

An import makes top-level declarations from the imported module visible in the
importing module.

Resolution is path based:

```text
import pkg::sub::{mod} -> <project_root>/pkg/sub/mod.vl
```

For `stdlib`, the resolver also searches Vela's bundled `stdlib/` directory.

### Example

```vl
module app {
    import stdlib::{math};
    import stdlib::types::{int, bool};

    I16 main() {
        ret Abs(-5);
    }
}
```

## 4. Types

### Syntax

```text
type-name:
    U0
    U8
    I8
    U16
    I16
    F16
    identifier
    Ptr < type-name >
```

### Primitive Types

| Type | Meaning | Size |
| --- | --- | --- |
| `U0` | no value | 0 bytes |
| `U8` | unsigned 8-bit integer | 1 byte |
| `I8` | signed 8-bit integer | 1 byte |
| `U16` | unsigned 16-bit integer | 2 bytes |
| `I16` | signed 16-bit integer | 2 bytes |
| `F16` | binary16 floating point | 2 bytes |

### Constraints

`U0` shall only appear as a function return type or inside a pointer type such
as `Ptr<U0>`. It shall not be used as the type of a variable, parameter, or
field.

Pointer types are 2 bytes wide. `Ptr<U0>` is the generic pointer type.

When an identifier names a class, its type denotes a pointer to an instance of
that class. The following declarations both store object references:

```vl
Box a = Init<Box>();
Ptr<Box> b = Init<Box>();
```

### Type Compatibility

Assignment, arguments, and return statements use these compatibility rules:

- identical types are compatible;
- integer widening is allowed when the target can represent every source
  value;
- `U8` can widen to `I16`;
- `U16` does not implicitly convert to `I16`;
- signed integer values do not implicitly convert to unsigned types;
- `F16` does not implicitly convert to or from integer or pointer types;
- `Ptr<U0>` is compatible with concrete pointer types;
- `null` is compatible with any pointer type;
- Bool is not implicitly compatible with integer types.

### Casts

`Cast<T>(expr)` performs an explicit cast. Casts between `F16` and non-float
types are rejected by the backend.

```vl
U16 raw = 40000;
I16 bits = Cast<I16>(raw);
Ptr<I16> words = Cast<Ptr<I16>>(Malloc(8));
```

## 5. Bool Values

### Semantics

The literals `true` and `false` produce the compiler's boolean type. A value is
Bool-like if it is this internal Bool type or the standard library `Bool`
class.

### Constraints

Conditions in `if`, `while`, and `for` shall be Bool-like.

Integer values are not conditions by themselves.

### Example

```vl
I16 main() {
    I16 x = 10;

    if (x != 0) {
        Print(x);
    }

    ret x;
}
```

Many standard library predicates return `I8`. Compare those values before
using them as conditions:

```vl
Int n = 0;
if (n.IsZero() != 0) {
    Print(1);
}
Free(n);
```

## 6. Declarations

### Alias Declarations

#### Syntax

```text
alias identifier <- type-name ;
```

#### Example

```vl
alias Word <- I16;
Word count = 3;
```

### Variable Declarations

#### Syntax

```text
variable-declaration:
    type-name identifier ;
    type-name identifier = expression ;
```

#### Constraints

Global initializers shall be static scalar initializers:

- integer or character literal for integer types;
- float literal for `F16`;
- `null` for pointer types.

Dynamic initialization shall be performed inside a function.

#### Semantics

Local variables without an initializer are initialized to zero. A local
variable shall not duplicate another name in the same scope.

#### Example

```vl
module globals {
    I16 counter = 0;
    U8 letter = 'A';
    Ptr<I16> ptr = null;
}
```

## 7. Functions

### Syntax

```text
function-definition:
    type-name identifier ( parameter-list? ) block

parameter-list:
    parameter (, parameter)*

parameter:
    type-name identifier
```

### Constraints

Parameter names shall be unique within one function. Parameters shall not have
type `U0`.

A non-`U0` function shall return a compatible value on all paths recognized by
the checker.

### Semantics

Function names are visible throughout the module after the compiler registers
top-level declarations. A function can refer to a global variable or class type
declared later in the same module.

### Example

```vl
I16 add(I16 a, I16 b) {
    ret a + b;
}

U0 printSum(I16 a, I16 b) {
    Print(add(a, b));
    ret;
}
```

## 8. Statements

### Syntax

```text
statement:
    block
    variable-declaration
    expression ;
    assignment ;
    ret expression? ;
    if ( expression ) block else? block?
    while ( expression ) block
    for ( for-init expression ; expression ) block
    Free ( expression ) ;
    Print ( expression ) ;
    asm-block
```

### Return

`ret;` is valid in `U0` functions. `ret expression;` returns a value from a
non-`U0` function.

### Selection

The condition of `if` shall be Bool-like.

```vl
if (x > 0) {
    Print(x);
} else {
    Print(0);
}
```

### Iteration

The conditions of `while` and `for` shall be Bool-like.

```vl
while (i < 10) {
    i++;
}

for (I16 i = 0; i < n; i++) {
    sum += i;
}
```

### Assignment

An assignment target shall be a variable, field, dereference, or indexed
element. The supported assignment operators are:

```text
= -= *= /= =
```

## 9. Expressions

### Operator Precedence

From lowest to highest:

| Level | Operators |
| --- | --- |
| 1 | `||` |
| 2 | `&&` |
| 3 | `==`, `!=` |
| 4 | `<`, `>`, `<=`, `>=` |
| 5 | `+`, `-` |
| 6 | `*`, `/`, `%` |
| 7 | unary `!`, `-`, `*`, `&` |
| 8 | postfix `.`, `[]`, `++`, `--` |

### Arithmetic

Operands of `+`, `-`, `*`, `/`, and `%` shall be numeric. `%` shall only be
used with integer operands. Mixed integer and `F16` arithmetic is rejected.

### Logical Operators

Operands of `&&`, `||`, and `!` shall be Bool-like. `&&` and `||` preserve
short-circuit evaluation.

### Comparisons

Ordered comparisons are defined for integer values and for `F16` values.
Equality is also defined for compatible pointer values.

### Postfix Update

`x++` and `x--` require an assignable integer target. The expression evaluates
to the old value and writes back the updated value.

## 10. Pointers

### Syntax

```text
dereference-expression:
    * expression

address-expression:
    & expression

index-expression:
    expression [ expression ]
```

### Constraints

The operand of `*` shall be a pointer to a concrete type. `Ptr<U0>` shall be
cast before dereference.

The operand of `&` shall be addressable by the backend. Addressable forms are
globals, fields, dereferences, and indexed elements. Locals and parameters are
not addressable.

The object operand of `[]` shall be a pointer. The index shall be an integer.

### Semantics

Pointer indexing scales by the pointed type size. `Ptr<U8>` indexes bytes.
`Ptr<I16>` indexes 16-bit elements.

### Example

```vl
I16 global = 7;

I16 main() {
    Ptr<I16> p = &global;
    p[0] = p[0] + 1;
    ret *p;
}
```

## 11. Built-In Operations

### Malloc

#### Synopsis

```vl
Ptr<U0> Malloc(integer-size)
```

#### Constraints

The size expression shall have integer type. A literal size shall be
non-negative.

### Free

#### Synopsis

```vl
Free(pointer-expression);
```

#### Semantics

`Free(null)` has no effect. When the expression has class pointer type, the
resolved `OnFree` path is called before raw deallocation.

### Init

#### Syntax

```text
Init < class-name > ( named-argument-list? )

named-argument:
    identifier : expression
```

#### Constraints

The argument names and order shall match the parameters of `OnAlloc`. If the
class has no `OnAlloc` or `OnAlloc` is defined with no parameters, the argument list shall be empty.

#### Example

```vl
class Point {
    I16 x;
    I16 y;
    OnAlloc(I16 x0, I16 y0) { x = x0; y = y0; }
}

Point p = Init<Point>(x0: 3, y0: 4);
Free(p);
```

### SizeOf

```vl
I16 s = SizeOf(Ptr<I16>);
```

`SizeOf(T)` returns the size of `T` in bytes as `U16`.

### Print

`Print(value);` accepts one expression and lowers to the runtime syscall.

## 12. Classes

### Syntax

```text
class-declaration:
    class identifier class-parent? { class-member* }

class-parent:
    : identifier

class-member:
    field-declaration
    method-definition
    OnAlloc ( parameter-list? ) block
    OnFree block
    OnFree ( ) block
```

### Constraints

Class field names shall be unique across inherited and local fields. Method
names shall be unique within a class. An override shall keep the same return
type and parameter types as the inherited method.

A class shall not explicitly extend `Storeable`; parentless classes receive it
implicitly.

### Semantics

Class values are object references. Inside methods and `OnAlloc` or `OnFree`,
field names may be used directly. The names `this` and `self` refer to the
current object.

`OnAlloc` is called by `Init<T>`. `OnFree` is called by `Free` for class
pointers.

### Example

```vl
class Counter {
    [[get, set]] I16 value;

    OnAlloc(I16 initial) {
        value = initial;
    }

    I16 Inc() {
        value++;
        ret value;
    }
}
```

## 13. Type Declarations

### Syntax

```text
type-declaration:
    type identifier type-parent? { skeleton-method* }

skeleton-method:
    skeleton type-name identifier ( parameter-list? ) ;
```

### Semantics

A `type` declares an interface-like method set and vtable slots. A class that
extends a `type` shall implement every skeleton method with the exact
signature.

### Example

```vl
type Shape {
    skeleton I16 Area();
}

class Square : Shape {
    I16 side;
    OnAlloc(I16 s) { side = s; }
    I16 Area() { ret side * side; }
}
```

## 14. Field Tags

### Syntax

```text
tagged-field:
    [[ tag-list ]] type-name identifier ;

tag-list:
    identifier (, identifier)*
```

### Semantics

The recognized code-generating tags are `get` and `set`.

For a field named `value`, `[[get]]` generates `GetValue()`, and `[[set]]`
generates `SetValue(T value)`. A collision with an explicitly declared method
is an error.

The standard library also uses `visible` as metadata. The current compiler
does not generate code for `visible`.

## 15. Multi-Dispatch

### Syntax

```text
{ target-list } . identifier ( argument-list? )
```

### Constraints

Every target shall be a class value or class pointer that has the named
method. The arguments shall match that method's parameter list.

### Semantics

The same method call is emitted for each target. The expression type is `U0`.

## 16. Inline Assembly

### Syntax

```text
ASM ( asm-binding-list? ) { assembly-lines }

asm-binding:
    [[ in ]] register = identifier ;
    [[ out ]] register = identifier ;
```

### Constraints

Binding registers shall be `R0` through `R9`. Binding variables shall name
visible variables or parameters.

### Semantics

Input bindings copy Vela values into CPU registers before the raw assembly
body. Output bindings copy CPU registers back into Vela variables after the
body.

### Example

```vl
I16 absAsm(I16 x) {
    I16 out = 0;
    ASM(
        [[in]] R0 = x;
        [[out]] R0 = out;
    ) {
        ABS R0, R0
    }
    ret out;
}
```

## 17. Implementation Limits

- Generated assembly labels are flat.
- `main`, `space`, and names beginning with `__` are reserved.
- Memory management is manual.
- Pointer indexing has no bounds checks.
- Primitive values do not have fields or methods.
- The exposed generic forms are `Ptr<T>`, `Init<T>`, `SizeOf(T)`, and
  `Cast<T>(expr)`.
