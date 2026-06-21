# Vela ⛵️

**Vela** is a statically-typed, compiled programming language targeting a custom 16-bit ARM-like CPU architecture. It is a companion project to the [DE1 CPU ISA](https://github.com/tonnoBelloSnello/CPU) - Vela compiles `.vl` source files into `.de1` assembly that the CPU's encoder assembles into machine code for simulation on the Verilog hardware model.

## Table of Contents

This repository contains:

- the Python compiler in `src/`;
- the Vela standard library in `stdlib/`;
- example programs in `examples/`;
- automated tests in `tests/`;
- full documentation in `docs/`.

## Requirements

- Python 3.12 or newer.
- `pytest`, only for running the test suite.
- The `CPU` project in the sibling `../CPU` directory, only for running
  generated `.de1` files on the simulator.

## Quick Start

Compile a program:

```bash
python -m src.main examples/hello.vl -o examples/hello.de1
```

Run the generated assembly with the CPU simulator:

```bash
cd ../CPU
python run.py ../Vela/examples/hello.de1
```

Run the compiler tests:

```bash
pytest
```

## Documentation

- [Documentation index](docs/README.md)
- [Language guide](docs/language.md)
- [Standard library](docs/stdlib.md)
- [Compiler, runtime, and CPU target](docs/compiler-runtime.md)

## License

See [LICENSE](LICENSE).
