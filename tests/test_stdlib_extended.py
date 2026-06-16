from pathlib import Path
import re

from src.main import compile_source


ROOT = Path(__file__).resolve().parents[1]


def compile_project(source: str) -> str:
    return compile_source(source, "test.vl", project_root=ROOT)


def test_extended_math_functions_compile_and_use_native_scalar_ops():
    asm = compile_project(
        """
        module test {
            import stdlib::{math};

            I16 main() {
                I16 result = Abs(-5) + Min(9, 2) + Max(9, 2);
                result = result + Square(3) + Cube(2) + AbsDiff(5, 12);
                result = result + Gcd(54, 24) + Cast<I16>(IsEven(10));
                result = result + Cast<I16>(IsOdd(7)) + Cast<I16>(InRange(5, 1, 9));
                ret result;
            }
        }
        """
    )

    assert re.search(r"\bABS\s+R\d+\s*,\s*R\d+\b", asm)
    assert re.search(r"\bMIN\s+R0\s*,\s*R0\s*,\s*R1\b", asm)
    assert re.search(r"\bMAX\s+R0\s*,\s*R0\s*,\s*R1\b", asm)
    assert "MUL" in asm
    assert "DIV" in asm


def test_extended_boxed_scalar_methods_compile():
    asm = compile_project(
        """
        module test {
            import stdlib::types::{int, bool, char, float};

            I16 main() {
                Int i = 42;
                Bool b = true;
                Char c = 'f';
                Float x = 3.5;

                I16 result = i.Div(2) + i.Mod(5) + i.Square() + i.Compare(42);
                result = result + i.AbsDiff(50) + i.GcdWith(30);
                result = result + Cast<I16>(i.LessThan(50)) + Cast<I16>(i.GreaterThan(1));
                result = result + Cast<I16>(i.Between(1, 100));
                result = result + Cast<I16>(b.IsTrue()) + Cast<I16>(b.IsFalse());
                result = result + Cast<I16>(b.Normalize()) + Cast<I16>(b.Nand(0));
                result = result + Cast<I16>(b.Nor(0)) + Cast<I16>(b.Implies(1));
                result = result + Cast<I16>(c.IsAlnum()) + Cast<I16>(c.IsHexDigit());
                result = result + Cast<I16>(c.IsWhitespace()) + Cast<I16>(c.IsAscii());
                result = result + Cast<I16>(c.IsControl()) + Cast<I16>(c.IsPrintable());
                result = result + c.HexValue();

                F16 clamped = x.Clamp(1.0, 4.0);
                F16 smaller = x.MinWith(9.0);
                F16 larger = x.MaxWith(1.0);
                if (x.GreaterOrEqual(clamped) == 1) {
                    result = result + 1;
                }
                if (x.LessOrEqual(4.0) == 1) {
                    result = result + 1;
                }
                if (smaller <= larger) {
                    result = result + 1;
                }

                Free(i);
                Free(b);
                Free(c);
                Free(x);
                ret result;
            }
        }
        """
    )

    assert "Int_GcdWith:" in asm
    assert "Bool_Implies:" in asm
    assert "Char_HexValue:" in asm
    assert re.search(r"\bABS\s+R\d+\s*,\s*R\d+\b", asm)
    assert "FCMP" in asm


def test_extended_array_and_string_methods_compile():
    asm = compile_project(
        """
        module test {
            import stdlib::types::{array, string};

            I16 main() {
                Array a = Init<Array>(cap: 6);
                a.TryPush(3);
                a.TryPush(1);
                a.TryPush(3);
                a.Insert(1, 9);
                a.RemoveAt(2);
                a.Reverse();

                Ptr<I16> out = Cast<Ptr<I16>>(Malloc(2));
                a.TryPop(out);
                I16 arrayResult = a.Capacity() + a.Remaining() + a.Count(3);
                arrayResult = arrayResult + a.Min() + a.Max() + a.LastIndexOf(3) + out[0];

                Ptr<U8> text = "ababa";
                Ptr<U8> prefix = "ab";
                Ptr<U8> suffix = "ba";
                Ptr<U8> buf = Malloc(5);
                String s = Init<String>(p: text, length: 5);
                I16 copied = s.CopyTo(buf, 5);
                I16 stringResult = Cast<I16>(s.First()) + Cast<I16>(s.Last());
                stringResult = stringResult + Cast<I16>(s.StartsWith(prefix, 2));
                stringResult = stringResult + Cast<I16>(s.EndsWith(suffix, 2));
                stringResult = stringResult + s.Count('a') + s.IndexOfFrom('b', 2);
                stringResult = stringResult + s.LastIndexOf('a') + copied + Cast<I16>(buf[0]);

                Free(buf);
                Free(out);
                Free(s);
                Free(a);
                ret arrayResult + stringResult;
            }
        }
        """
    )

    assert "Array_Insert:" in asm
    assert "Array_RemoveAt:" in asm
    assert "Array_TryPop:" in asm
    assert "String_StartsWith:" in asm
    assert "String_CopyTo:" in asm
