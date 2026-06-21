# Vela Standard Library Reference

The standard library is written in Vela and is stored under `stdlib/`. Imported
declarations enter the current module's top-level namespace.

The `Synopsis` sections use prototype notation for compact reference.
They describe available functions and methods; they are not class definitions
to paste verbatim into Vela source.

## 1. Including Library Modules

### Synopsis

```vl
import stdlib::{math};
import stdlib::types::{int, bool, char, float};
import stdlib::types::{array, string, matrix, null};
```

### Notes

Predicate-like functions commonly return `I8`, not Bool. Compare such results
with zero when a condition is required.

## 2. Core Storeable

### Header

```vl
import stdlib::core::{storeable};
```

`Storeable` is imported automatically when a parentless class requires the
implicit object base.

### Synopsis

```vl
class Storeable {
    OnAlloc();
    OnFree;
    I16 GetSize();
    I16 Pointer();
    I16 Reference();
}
```

### Description

`Storeable` supplies the default object lifecycle. `GetSize` reads the object
size from the vtable. `Pointer` and `Reference` return the object reference as
an `I16` value.

## 3. Math

### Header

```vl
import stdlib::{math};
```

### Synopsis

```vl
I16 Abs(I16 x);
I16 Min(I16 a, I16 b);
I16 Max(I16 a, I16 b);
I16 Square(I16 x);
I16 Cube(I16 x);
I8  IsEven(I16 x);
I8  IsOdd(I16 x);
I16 AbsDiff(I16 a, I16 b);
I8  InRange(I16 x, I16 lo, I16 hi);
I16 Clamp(I16 x, I16 lo, I16 hi);
I16 Pow(I16 base, I16 exp);
I16 Gcd(I16 a, I16 b);
I16 Sign(I16 x);
```

### Description

`Abs`, `Min`, and `Max` use inline assembly and lower to native CPU
instructions. The remaining functions are implemented in Vela.

### Example

```vl
module app {
    import stdlib::{math};

    I16 main() {
        ret Clamp(Abs(-20), 0, 10);
    }
}
```

## 4. Int

### Header

```vl
import stdlib::types::{int};
```

### Synopsis

```vl
class Int {
    OnAlloc(I16 val);
    I16 GetValue();
    I16 Abs();
    I16 Negate();
    I8  IsPositive();
    I8  IsNegative();
    I8  IsZero();
    I16 Add(I16 other);
    I16 Sub(I16 other);
    I16 Mul(I16 other);
    I16 Div(I16 other);
    I16 Mod(I16 other);
    I16 Square();
    I8  IsEven();
    I8  IsOdd();
    I8  Equals(I16 other);
    I8  LessThan(I16 other);
    I8  GreaterThan(I16 other);
    I16 Compare(I16 other);
    I16 AbsDiff(I16 other);
    I16 MinWith(I16 other);
    I16 MaxWith(I16 other);
    I16 Clamp(I16 lo, I16 hi);
    I8  Between(I16 lo, I16 hi);
    I16 GcdWith(I16 other);
}
```

### Description

`Int` wraps an `I16` value. Initializing an `Int` variable from an integer
primitive allocates and initializes the wrapper object.

### Example

```vl
Int x = -42;
I16 y = x.Abs();
Free(x);
```

## 5. Float

### Header

```vl
import stdlib::types::{float};
```

### Synopsis

```vl
class Float {
    OnAlloc(F16 val);
    F16 GetValue();
    I8  IsPositive();
    I8  IsNegative();
    I8  IsZero();
    F16 Abs();
    F16 Negate();
    F16 Add(F16 other);
    F16 Sub(F16 other);
    F16 Mul(F16 other);
    F16 Div(F16 other);
    I8  Equals(F16 other);
    I8  GreaterThan(F16 other);
    I8  LessThan(F16 other);
    I8  GreaterOrEqual(F16 other);
    I8  LessOrEqual(F16 other);
    F16 MinWith(F16 other);
    F16 MaxWith(F16 other);
    F16 Clamp(F16 lo, F16 hi);
}
```

### Description

`Float` wraps an `F16` value. Integer literals do not implicitly convert to
`F16`; use `1.0`, not `1`.

## 6. Bool

### Header

```vl
import stdlib::types::{bool};
```

### Synopsis

```vl
class Bool {
    OnAlloc(I8 val);
    I8  GetValue();
    I8  Not();
    I8  IsTrue();
    I8  IsFalse();
    I8  Normalize();
    I8  And(I8 other);
    I8  Or(I8 other);
    I8  Xor(I8 other);
    I8  Nand(I8 other);
    I8  Nor(I8 other);
    I8  Implies(I8 other);
    I16 ToInt();
    I8  Equals(I8 other);
}
```

### Description

`Bool` wraps an `I8` field. It can be initialized from `true`, `false`, or a
comparison result. It shall not be initialized from an integer literal.

### Example

```vl
Bool b = true;
if (b) {
    Print(1);
}
I8 inv = b.Not();
Free(b);
```

## 7. Char

### Header

```vl
import stdlib::types::{char};
```

### Synopsis

```vl
class Char {
    OnAlloc(U8 val);
    U8  GetValue();
    I8  IsAlpha();
    I8  IsDigit();
    I8  IsAlnum();
    I8  IsHexDigit();
    I8  IsUpper();
    I8  IsLower();
    I8  IsSpace();
    I8  IsWhitespace();
    I8  IsAscii();
    I8  IsControl();
    I8  IsPrintable();
    U8  ToUpper();
    U8  ToLower();
    I16 ToInt();
    I16 HexValue();
    I8  Equals(U8 other);
}
```

### Description

`Char` wraps a `U8` character code and provides ASCII classification and case
conversion helpers.

## 8. String

### Header

```vl
import stdlib::types::{string};
```

### Synopsis

```vl
class String {
    OnAlloc(Ptr<U8> p, I16 length);
    Ptr<U8> GetPtr();
    I16 GetLen();
    I8  IsEmpty();
    U8  CharAt(I16 index);
    U8  First();
    U8  Last();
    I8  Equals(Ptr<U8> otherPtr, I16 otherLen);
    I8  StartsWith(Ptr<U8> otherPtr, I16 otherLen);
    I8  EndsWith(Ptr<U8> otherPtr, I16 otherLen);
    I8  Contains(U8 ch);
    I16 Count(U8 ch);
    I16 IndexOf(U8 ch);
    I16 IndexOfFrom(U8 ch, I16 start);
    I16 LastIndexOf(U8 ch);
    I16 CopyTo(Ptr<U8> dest, I16 maxLen);
}
```

### Description

`String` stores a byte pointer and a length. It does not own or free the
buffer passed to `OnAlloc`.

### Returns

`IndexOf`, `IndexOfFrom`, and `LastIndexOf` return `-1` if the character is not
found.

### Example

```vl
Ptr<U8> text = "AZ";
String s = Init<String>(p: text, length: 2);
U8 z = s.CharAt(1);
Free(s);
```

## 9. Array

### Header

```vl
import stdlib::types::{array};
```

### Synopsis

```vl
class Array {
    OnAlloc(I16 cap);
    OnFree;
    I16 GetLength();
    I16 Get(I16 index);
    I16 Capacity();
    I16 Remaining();
    U0  Set(I16 index, I16 value);
    U0  Push(I16 value);
    I8  TryPush(I16 value);
    I16 Pop();
    I8  TryPop(Ptr<I16> dest);
    I8  IsEmpty();
    I8  IsFull();
    I16 First();
    I16 Last();
    I8  Contains(I16 value);
    I16 Count(I16 value);
    I16 IndexOf(I16 value);
    I16 LastIndexOf(I16 value);
    U0  Fill(I16 value);
    U0  Clear();
    U0  Swap(I16 a, I16 b);
    U0  Reverse();
    I8  Insert(I16 index, I16 value);
    I8  RemoveAt(I16 index);
    I16 Min();
    I16 Max();
    I16 Sum();
}
```

### Description

`Array` is a heap-backed dynamic array of `I16`. Its `OnFree` releases the
internal data buffer.

### Constraints

`Get`, `Set`, `Push`, and `Pop` do not perform bounds checks. Use `TryPush` and
`TryPop` when capacity or emptiness shall be checked.

### Example

```vl
Array a = Init<Array>(cap: 4);
a.Push(11);
a.Push(22);
I16 total = a.Sum();
Free(a);
```

## 10. Matrix

### Header

```vl
import stdlib::types::{matrix};
```

### Synopsis

```vl
class Matrix {
    OnAlloc(I16 r, I16 c);
    OnFree;
    I16 GetRows();
    I16 GetCols();
    I16 Get(I16 row, I16 col);
    U0  Set(I16 row, I16 col, I16 value);
    I16 Size();
    I8  IsSquare();
    U0  Fill(I16 value);
    I16 Sum();
    I16 MulWith(I16 otherData, I16 otherRows, I16 otherCols);
    I16 Trace();
    U0  AddScalar(I16 value);
    U0  Scale(I16 factor);
}
```

### Description

`Matrix` is a heap-backed row-major matrix of `I16`. Its `OnFree` releases the
internal data buffer.

`MulWith` receives the right-hand data pointer as an `I16`, casts it to
`Ptr<I16>`, allocates a new result buffer, and returns the result buffer
address as `I16`. Caller code is responsible for that returned buffer.

## 11. Null Alias

### Header

```vl
import stdlib::types::{null};
```

### Synopsis

```vl
alias NULL <- Ptr<U0>;
```

### Description

The alias is provided for code that wants a named generic pointer type. The
literal `null` is built into the language and does not require this import.
