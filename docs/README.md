# Vela Reference Manual

This directory documents the Vela language and its implementation.

## Contents

| Document | Contents |
| --- | --- |
| [language.md](language.md) | Lexical rules, declarations, types, expressions, statements, classes, built-ins, and inline assembly. |
| [stdlib.md](stdlib.md) | Standard library modules, class interfaces, function prototypes, ownership rules, and examples. |
| [compiler-runtime.md](compiler-runtime.md) | Translation pipeline, ABI, object layout, heap runtime, vtables, optimizer behavior, and CPU target notes. |

## Invocation

Compile a translation unit:

```bash
python -m src.main examples/hello.vl -o examples/hello.de1
```

Run the generated program on the sibling CPU simulator:

```bash
cd ../CPU
python run.py ../Vela/examples/hello.de1
```

## Example Programs

The directory `examples/` contains small programs that exercise the documented
language features:

- `hello.vl`
- `factorial.vl`
- `polymorphism.vl`
- `linked_list.vl`
- `boxed_values.vl`
