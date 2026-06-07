from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from src.main import compile_source


ROOT = Path(__file__).resolve().parents[1]
CPU_ROOT = ROOT.parent / "CPU"


def _require_cpu_runner() -> None:
    if not (CPU_ROOT / "run.py").exists():
        pytest.skip("CPU/run.py not available")
    if shutil.which("iverilog") is None or shutil.which("vvp") is None:
        pytest.skip("iverilog/vvp not available on PATH")


def _run_on_cpu(source: str, tmp_path: Path) -> str:
    _require_cpu_runner()
    asm = compile_source(source, str(tmp_path / "program.vl"), project_root=ROOT)
    asm_path = tmp_path / "program.de1"
    asm_path.write_text(asm, encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "run.py", str(asm_path)],
        cwd=CPU_ROOT,
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    output = result.stdout + result.stderr
    assert "Simulation Finished!" in output, output
    return output


@pytest.mark.parametrize(
    "example, expected",
    [
        ("hello.vl", 42),
        ("factorial.vl", 120),
        ("linked_list.vl", 30),
        ("polymorphism.vl", 91),
        ("boxed_values.vl", 143),
    ],
)
def test_examples_run_with_cpu_runner(example: str, expected: int, tmp_path: Path):
    source = (ROOT / "examples" / example).read_text(encoding="utf-8")
    output = _run_on_cpu(source, tmp_path)
    assert f"R0: {expected}" in output


@pytest.mark.parametrize(
    "source, expected",
    [
        (
            """
            module test {
                import stdlib::types::{array};
                I16 main() {
                    Array a = Init<Array>(cap: 4);
                    a.Push(11);
                    a.Push(22);
                    I16 result = a.Sum();
                    Free(a);
                    ret result;
                }
            }
            """,
            33,
        ),
        (
            """
            module test {
                import stdlib::types::{string};
                I16 main() {
                    Ptr<U8> text = "AZ";
                    String s = Init<String>(p: text, length: 2);
                    U8 result = s.CharAt(1);
                    Free(s);
                    ret result;
                }
            }
            """,
            90,
        ),
        (
            """
            module test {
                import stdlib::types::{matrix};
                I16 main() {
                    Matrix m = Init<Matrix>(r: 2, c: 2);
                    m.Set(0, 0, 5);
                    m.Set(1, 1, 7);
                    I16 result = m.Trace();
                    Free(m);
                    ret result;
                }
            }
            """,
            12,
        ),
        (
            """
            module test {
                I16 destroyed = 0;
                class Foo {
                    OnAlloc() {}
                    OnFree { destroyed = 9; }
                }
                I16 main() {
                    Ptr<Foo> f = Init<Foo>();
                    Free(f);
                    ret destroyed;
                }
            }
            """,
            9,
        ),
        (
            """
            module test {
                I16 combine(I16 a, I16 b, I16 c, I16 d) {
                    ret a * 1000 + b * 100 + c * 10 + d;
                }
                I16 main() {
                    I16 a = 1; I16 b = 2; I16 c = 3; I16 d = 4;
                    ret combine(d, c, b, a);
                }
            }
            """,
            4321,
        ),
        (
            """
            module test {
                I16 main() {
                    Ptr<U8> a = Malloc(100);
                    Ptr<U8> b = Malloc(100);
                    Ptr<U8> c = Malloc(100);
                    Free(a);
                    Free(b);
                    Ptr<U8> d = Malloc(180);
                    I16 pa = Cast<I16>(a);
                    I16 pd = Cast<I16>(d);
                    Free(c);
                    Free(d);
                    if (pa == pd) { ret 1; }
                    ret 0;
                }
            }
            """,
            1,
        ),
    ],
)
def test_feature_programs_run_with_cpu_runner(source: str, expected: int, tmp_path: Path):
    output = _run_on_cpu(source, tmp_path)
    assert f"R0: {expected}" in output
