from __future__ import annotations

import sys
import os
from pathlib import Path

from src.lexer.lexer import Lexer
from src.parser.parser import Parser
from src.semantic.type_checker import TypeChecker
from src.semantic.module_resolver import ModuleResolver
from src.ir.builder import IRBuilder
from src.optimizer.constant_folder import constant_fold
from src.optimizer.dead_code import eliminate_dead_code
from src.optimizer.strength_reduction import strength_reduce
from src.codegen.asm_emitter import AsmEmitter
from src.errors import VelaError


def compile_source(source: str, filename: str = "<stdin>",
                   project_root: str | Path | None = None) -> str:
    """Compile Vela source code to .de1 assembly text.

    *project_root* is the directory used to resolve ``import pkg::{mod}``
    statements.  Defaults to the parent directory of *filename*.
    """
    if project_root is None:
        project_root = Path(filename).resolve().parent
    project_root = Path(project_root)

    # lex
    lexer = Lexer(source, filename)
    tokens = lexer.tokenize()

    # parse
    parser = Parser(tokens, filename)
    ast = parser.parse()

    # semantic analysis with import resolution
    resolver = ModuleResolver(project_root)
    checker = TypeChecker(module_resolver=resolver)
    checker.check(ast)

    # IR generation: include imported modules so their functions/classes
    # get code generated too.
    existing_names = {m.name for m in ast.modules}
    for imp_mod in checker.imported_modules:
        if imp_mod.name not in existing_names:
            ast.modules.insert(0, imp_mod)
            existing_names.add(imp_mod.name)
    builder = IRBuilder(checker)
    func_ir = builder.build(ast)

    # optimize each function
    for name in func_ir:
        ir = func_ir[name]
        ir = constant_fold(ir)
        ir = strength_reduce(ir)
        ir = eliminate_dead_code(ir)
        func_ir[name] = ir

    # emit assembly
    emitter = AsmEmitter(checker)
    asm_text = emitter.emit(func_ir)

    return asm_text


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: velac <input.vl> [-o output.de1]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = None

    if "-o" in sys.argv:
        idx = sys.argv.index("-o")
        if idx + 1 < len(sys.argv):
            output_file = sys.argv[idx + 1]

    if output_file is None:
        output_file = Path(input_file).stem + ".de1"

    try:
        with open(input_file, "r", encoding="utf-8") as f:
            source = f.read()
    except FileNotFoundError:
        print(f"error: file not found: {input_file}")
        sys.exit(1)

    try:
        asm = compile_source(source, input_file)
    except VelaError as e:
        print(str(e))
        sys.exit(1)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(asm)

    print(f"[velac] Compiled {input_file} → {output_file}")


if __name__ == "__main__":
    main()
