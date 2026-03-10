import unittest
from src.ir.instructions import IROp, IRInstr
from src.semantic.inheritance import VtableInfo, VtableEntry
from src.optimizer.devirtualizer import devirtualize
from src.optimizer.inliner import inline_functions
from src.optimizer.escape_analysis import escape_analyze


class TestDevirtualizer(unittest.TestCase):
    """Tests for the devirtualization pass."""

    def _make_vtables(self) -> dict[str, VtableInfo]:
        return {
            "Int": VtableInfo(
                class_name="Int",
                class_size=4,
                entries=[
                    VtableEntry(method_name="Abs", mangled_name="Int_Abs", slot_index=0),
                    VtableEntry(method_name="Add", mangled_name="Int_Add", slot_index=1),
                ],
            ),
        }

    def test_devirtualize_known_type(self):
        """VCALL with known vtable → direct CALL."""
        instrs = [
            # __malloc → obj register
            IRInstr(op=IROp.CONST, dest="%t0", imm=4),
            IRInstr(op=IROp.PARAM, src1="%t0", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            # vtable store
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt", label="__vtable_Int"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            # VCALL slot 0 (Abs)
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.VCALL, dest="%res", src1="%obj", label="Abs",
                    imm=0, arg_count=1),
        ]
        vtables = self._make_vtables()
        result = devirtualize(instrs, vtables)

        # The VCALL should be replaced with a direct CALL to Int_Abs
        calls = [i for i in result if i.op == IROp.CALL and i.label == "Int_Abs"]
        self.assertEqual(len(calls), 1)
        # No VCALLs should remain
        vcalls = [i for i in result if i.op == IROp.VCALL]
        self.assertEqual(len(vcalls), 0)

    def test_vcall_unknown_type_not_devirtualized(self):
        """VCALL without known type is left alone."""
        instrs = [
            IRInstr(op=IROp.PARAM, src1="%unknown", imm=0),
            IRInstr(op=IROp.VCALL, dest="%res", src1="%unknown",
                    label="Foo", imm=0, arg_count=1),
        ]
        vtables = self._make_vtables()
        result = devirtualize(instrs, vtables)
        vcalls = [i for i in result if i.op == IROp.VCALL]
        self.assertEqual(len(vcalls), 1)


class TestInliner(unittest.TestCase):
    """Tests for the function inlining pass."""

    def test_inline_small_function(self):
        """A function with ≤ threshold instructions should be inlined."""
        # Callee: Int_Abs body (simplified)
        callee_body = [
            IRInstr(op=IROp.LABEL, label="Int_Abs"),
            IRInstr(op=IROp.MOV, dest="%a", src1="__arg0"),
            IRInstr(op=IROp.ABS, dest="%r", src1="%a"),
            IRInstr(op=IROp.RET),
        ]
        func_ir = {"Int_Abs": callee_body}

        # Caller
        caller = [
            IRInstr(op=IROp.CONST, dest="%x", imm=42),
            IRInstr(op=IROp.PARAM, src1="%x", imm=0),
            IRInstr(op=IROp.CALL, dest="%result", label="Int_Abs", arg_count=1),
        ]

        result = inline_functions(caller, func_ir)
        # The CALL should be replaced with the inlined body
        calls = [i for i in result if i.op == IROp.CALL and i.label == "Int_Abs"]
        self.assertEqual(len(calls), 0, "CALL should have been inlined")
        # An ABS instruction should appear in the result
        abs_ops = [i for i in result if i.op == IROp.ABS]
        self.assertEqual(len(abs_ops), 1, "ABS instruction should be present")

    def test_recursive_not_inlined(self):
        """Recursive functions should NOT be inlined."""
        callee_body = [
            IRInstr(op=IROp.LABEL, label="fact"),
            IRInstr(op=IROp.CALL, dest="%r", label="fact", arg_count=1),
            IRInstr(op=IROp.RET),
        ]
        func_ir = {"fact": callee_body}

        caller = [
            IRInstr(op=IROp.PARAM, src1="%x", imm=0),
            IRInstr(op=IROp.CALL, dest="%r", label="fact", arg_count=1),
        ]
        result = inline_functions(caller, func_ir)
        calls = [i for i in result if i.op == IROp.CALL and i.label == "fact"]
        self.assertEqual(len(calls), 1, "Recursive CALL should NOT be inlined")


class TestEscapeAnalysis(unittest.TestCase):
    """Tests for the escape analysis + SROA pass."""

    def test_non_escaping_allocation_elided(self):
        """malloc + free of a non-escaping object should be removed."""
        instrs = [
            # malloc
            IRInstr(op=IROp.CONST, dest="%size", imm=4),
            IRInstr(op=IROp.PARAM, src1="%size", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            # vtable store
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt", label="__vtable_Int"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            # OnAlloc(self, val)
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.PARAM, src1="%val", imm=1),
            IRInstr(op=IROp.CALL, dest="%obj", label="Int_OnAlloc", arg_count=2),
            # field store: obj[2] = val  (offset 2 = value field)
            IRInstr(op=IROp.CONST, dest="%off", imm=2),
            IRInstr(op=IROp.ADD, dest="%addr", src1="%obj", src2="%off"),
            IRInstr(op=IROp.STORE_16, src1="%val", src2="%addr"),
            # field load: read back
            IRInstr(op=IROp.LOAD_16, dest="%read", src1="%addr"),
            # free
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.CALL, dest="%_", label="__free", arg_count=1),
        ]

        result = escape_analyze(instrs)
        # malloc and free should be removed
        malloc_calls = [i for i in result if i.op == IROp.CALL and i.label == "__malloc"]
        self.assertEqual(len(malloc_calls), 0, "malloc should be elided")
        free_calls = [i for i in result if i.op == IROp.CALL and i.label == "__free"]
        self.assertEqual(len(free_calls), 0, "free should be elided")

        # Field store should become a MOV to a scalar register
        movs = [i for i in result if i.op == IROp.MOV]
        scalar_writes = [i for i in movs if i.dest and "__scalar_" in i.dest]
        self.assertTrue(len(scalar_writes) > 0, "Field store should be scalarised")

    def test_escaping_allocation_kept(self):
        """An allocation that escapes (passed to unknown CALL) is NOT elided."""
        instrs = [
            IRInstr(op=IROp.CONST, dest="%size", imm=4),
            IRInstr(op=IROp.PARAM, src1="%size", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            # vtable
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt", label="__vtable_Int"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            # ESCAPE: passed to an unknown function
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.CALL, dest="%r", label="some_other_func", arg_count=1),
        ]
        result = escape_analyze(instrs)
        malloc_calls = [i for i in result if i.op == IROp.CALL and i.label == "__malloc"]
        self.assertEqual(len(malloc_calls), 1, "malloc should NOT be elided")


class TestFullAutoboxElimination(unittest.TestCase):
    """End-to-end test: all 3 passes together should eliminate auto-boxing."""

    def _run_full_pipeline(self, cls_name, cls_size, method_name,
                           method_slot, callee_body, func_ir, caller):
        """Helper: run devirt → inline → SROA on caller and assert the
        auto-boxing overhead is eliminated."""
        vtables = {
            cls_name: VtableInfo(
                class_name=cls_name,
                class_size=cls_size,
                entries=[
                    VtableEntry(method_name=method_name,
                                mangled_name=f"{cls_name}_{method_name}",
                                slot_index=method_slot),
                ],
            ),
        }
        func_ir[f"{cls_name}_{method_name}"] = callee_body

        # Pass 1: Devirtualize
        ir = devirtualize(caller, vtables)
        vcalls = [i for i in ir if i.op == IROp.VCALL]
        self.assertEqual(len(vcalls), 0,
                         f"VCALL should be devirtualized for {cls_name}")

        # Pass 2: Inline
        ir = inline_functions(ir, func_ir)
        direct_calls = [i for i in ir
                        if i.op == IROp.CALL
                        and i.label == f"{cls_name}_{method_name}"]
        self.assertEqual(len(direct_calls), 0,
                         f"{cls_name}_{method_name} should be inlined")

        # Pass 3: Escape analysis + SROA
        ir = escape_analyze(ir)
        malloc_calls = [i for i in ir
                        if i.op == IROp.CALL and i.label == "__malloc"]
        free_calls = [i for i in ir
                      if i.op == IROp.CALL and i.label == "__free"]
        self.assertEqual(len(malloc_calls), 0,
                         f"malloc should be elided for {cls_name}")
        self.assertEqual(len(free_calls), 0,
                         f"free should be elided for {cls_name}")
        return ir

    def _make_autobox_caller(self, cls_name, cls_size, method_name,
                             method_slot, value_imm):
        """Build a standard autobox caller IR for any wrapper type."""
        return [
            IRInstr(op=IROp.LABEL, label="main"),
            IRInstr(op=IROp.CONST, dest="%x", imm=value_imm),
            # autobox: malloc wrapper
            IRInstr(op=IROp.CONST, dest="%sz", imm=cls_size),
            IRInstr(op=IROp.PARAM, src1="%sz", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            # vtable store
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt",
                    label=f"__vtable_{cls_name}"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            # OnAlloc(self, val)
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.PARAM, src1="%x", imm=1),
            IRInstr(op=IROp.CALL, dest="%obj",
                    label=f"{cls_name}_OnAlloc", arg_count=2),
            # VCALL method (slot)
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.VCALL, dest="%res", src1="%obj",
                    label=method_name, imm=method_slot, arg_count=1),
            # free
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.CALL, dest="%_", label="__free", arg_count=1),
            IRInstr(op=IROp.RET),
        ]

    def _make_method_body(self, cls_name, method_name, core_op):
        """Build a simple method body: load self.value, apply op, store back."""
        mangled = f"{cls_name}_{method_name}"
        return [
            IRInstr(op=IROp.LABEL, label=mangled),
            IRInstr(op=IROp.MOV, dest="%self", src1="__arg0"),
            IRInstr(op=IROp.CONST, dest="%off", imm=2),
            IRInstr(op=IROp.ADD, dest="%faddr", src1="%self", src2="%off"),
            IRInstr(op=IROp.LOAD_16, dest="%v", src1="%faddr"),
            IRInstr(op=core_op, dest="%r", src1="%v"),
            IRInstr(op=IROp.STORE_16, src1="%r", src2="%faddr"),
            IRInstr(op=IROp.RET),
        ]

    def test_autobox_int_abs(self):
        """Int x = 42; x.Abs() → ABS on scalar register."""
        body = self._make_method_body("Int", "Abs", IROp.ABS)
        caller = self._make_autobox_caller("Int", 4, "Abs", 0, 42)
        func_ir = {"main": caller}
        ir = self._run_full_pipeline("Int", 4, "Abs", 0, body, func_ir, caller)
        abs_ops = [i for i in ir if i.op == IROp.ABS]
        self.assertTrue(len(abs_ops) > 0, "ABS should remain after all passes")

    def test_autobox_float_neg(self):
        """Float f = 3.14; f.Neg() → NEG on scalar register.

        Verifies the passes are class-agnostic; Float wrapper works
        the same as Int.
        """
        body = self._make_method_body("Float", "Neg", IROp.NEG)
        caller = self._make_autobox_caller("Float", 4, "Neg", 0, 314)
        func_ir = {"main": caller}
        ir = self._run_full_pipeline("Float", 4, "Neg", 0, body, func_ir, caller)
        neg_ops = [i for i in ir if i.op == IROp.NEG]
        self.assertTrue(len(neg_ops) > 0, "NEG should remain after all passes")

    def test_autobox_bool_not(self):
        """Bool b = true; b.IsZero() → NOT on scalar register.

        Tests with a different wrapper class (Bool) and different size.
        """
        body = self._make_method_body("Bool", "IsZero", IROp.NOT)
        caller = self._make_autobox_caller("Bool", 4, "IsZero", 0, 1)
        func_ir = {"main": caller}
        ir = self._run_full_pipeline("Bool", 4, "IsZero", 0, body, func_ir, caller)
        not_ops = [i for i in ir if i.op == IROp.NOT]
        self.assertTrue(len(not_ops) > 0, "NOT should remain after all passes")

    def test_autobox_char_abs(self):
        """Char c = 'A'; c.ToUpper() → ABS stand-in on scalar register.

        Uses ABS as a placeholder op to verify Char wrapper elimination.
        """
        body = self._make_method_body("Char", "ToUpper", IROp.ABS)
        caller = self._make_autobox_caller("Char", 4, "ToUpper", 0, 65)
        func_ir = {"main": caller}
        ir = self._run_full_pipeline("Char", 4, "ToUpper", 0, body, func_ir, caller)
        abs_ops = [i for i in ir if i.op == IROp.ABS]
        self.assertTrue(len(abs_ops) > 0,
                        "Core op should remain after Char auto-box elimination")

    def test_two_wrappers_same_function(self):
        """Two different wrapper types in the same caller should both
        be eliminated independently.
        """
        vtables = {
            "Int": VtableInfo(
                class_name="Int", class_size=4,
                entries=[VtableEntry("Abs", "Int_Abs", 0)],
            ),
            "Float": VtableInfo(
                class_name="Float", class_size=4,
                entries=[VtableEntry("Neg", "Float_Neg", 0)],
            ),
        }
        int_body = self._make_method_body("Int", "Abs", IROp.ABS)
        float_body = self._make_method_body("Float", "Neg", IROp.NEG)
        func_ir = {"Int_Abs": int_body, "Float_Neg": float_body}

        caller = [
            IRInstr(op=IROp.LABEL, label="main"),
            IRInstr(op=IROp.CONST, dest="%ix", imm=10),
            IRInstr(op=IROp.CONST, dest="%isz", imm=4),
            IRInstr(op=IROp.PARAM, src1="%isz", imm=0),
            IRInstr(op=IROp.CALL, dest="%iobj", label="__malloc", arg_count=1),
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%ivt",
                    label="__vtable_Int"),
            IRInstr(op=IROp.STORE_16, src1="%ivt", src2="%iobj"),
            IRInstr(op=IROp.PARAM, src1="%iobj", imm=0),
            IRInstr(op=IROp.PARAM, src1="%ix", imm=1),
            IRInstr(op=IROp.CALL, dest="%iobj",
                    label="Int_OnAlloc", arg_count=2),
            IRInstr(op=IROp.PARAM, src1="%iobj", imm=0),
            IRInstr(op=IROp.VCALL, dest="%ires", src1="%iobj",
                    label="Abs", imm=0, arg_count=1),
            IRInstr(op=IROp.PARAM, src1="%iobj", imm=0),
            IRInstr(op=IROp.CALL, dest="%_1", label="__free", arg_count=1),
            IRInstr(op=IROp.CONST, dest="%fx", imm=314),
            IRInstr(op=IROp.CONST, dest="%fsz", imm=4),
            IRInstr(op=IROp.PARAM, src1="%fsz", imm=0),
            IRInstr(op=IROp.CALL, dest="%fobj", label="__malloc", arg_count=1),
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%fvt",
                    label="__vtable_Float"),
            IRInstr(op=IROp.STORE_16, src1="%fvt", src2="%fobj"),
            IRInstr(op=IROp.PARAM, src1="%fobj", imm=0),
            IRInstr(op=IROp.PARAM, src1="%fx", imm=1),
            IRInstr(op=IROp.CALL, dest="%fobj",
                    label="Float_OnAlloc", arg_count=2),
            IRInstr(op=IROp.PARAM, src1="%fobj", imm=0),
            IRInstr(op=IROp.VCALL, dest="%fres", src1="%fobj",
                    label="Neg", imm=0, arg_count=1),
            IRInstr(op=IROp.PARAM, src1="%fobj", imm=0),
            IRInstr(op=IROp.CALL, dest="%_2", label="__free", arg_count=1),
            IRInstr(op=IROp.RET),
        ]
        func_ir["main"] = caller

        ir = devirtualize(caller, vtables)
        ir = inline_functions(ir, func_ir)
        ir = escape_analyze(ir)

        vcalls = [i for i in ir if i.op == IROp.VCALL]
        malloc_calls = [i for i in ir
                        if i.op == IROp.CALL and i.label == "__malloc"]
        free_calls = [i for i in ir
                      if i.op == IROp.CALL and i.label == "__free"]
        abs_ops = [i for i in ir if i.op == IROp.ABS]
        neg_ops = [i for i in ir if i.op == IROp.NEG]

        self.assertEqual(len(vcalls), 0, "All VCALLs should be devirtualized")
        self.assertEqual(len(malloc_calls), 0,
                         "Both mallocs should be elided")
        self.assertEqual(len(free_calls), 0, "Both frees should be elided")
        self.assertTrue(len(abs_ops) > 0, "Int ABS should survive")
        self.assertTrue(len(neg_ops) > 0, "Float NEG should survive")


class TestDevirtualizerMultiType(unittest.TestCase):
    """Devirtualization across different wrapper types."""

    def test_devirtualize_float(self):
        """VCALL on Float wrapper → direct CALL to Float_Neg."""
        vtables = {
            "Float": VtableInfo(
                class_name="Float", class_size=4,
                entries=[
                    VtableEntry("Neg", "Float_Neg", 0),
                    VtableEntry("Add", "Float_Add", 1),
                ],
            ),
        }
        instrs = [
            IRInstr(op=IROp.CONST, dest="%t0", imm=4),
            IRInstr(op=IROp.PARAM, src1="%t0", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt",
                    label="__vtable_Float"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.VCALL, dest="%res", src1="%obj",
                    label="Neg", imm=0, arg_count=1),
        ]
        result = devirtualize(instrs, vtables)
        calls = [i for i in result
                 if i.op == IROp.CALL and i.label == "Float_Neg"]
        self.assertEqual(len(calls), 1)
        vcalls = [i for i in result if i.op == IROp.VCALL]
        self.assertEqual(len(vcalls), 0)

    def test_devirtualize_second_slot(self):
        """VCALL for vtable slot 1 → resolves to correct mangled name."""
        vtables = {
            "Int": VtableInfo(
                class_name="Int", class_size=4,
                entries=[
                    VtableEntry("Abs", "Int_Abs", 0),
                    VtableEntry("Add", "Int_Add", 1),
                    VtableEntry("Max", "Int_Max", 2),
                ],
            ),
        }
        instrs = [
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt",
                    label="__vtable_Int"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.VCALL, dest="%r", src1="%obj",
                    label="Max", imm=2, arg_count=1),
        ]
        result = devirtualize(instrs, vtables)
        calls = [i for i in result
                 if i.op == IROp.CALL and i.label == "Int_Max"]
        self.assertEqual(len(calls), 1, "Slot 2 should resolve to Int_Max")


class TestInlinerMultiType(unittest.TestCase):
    """Inlining for different wrapper method bodies."""

    def test_inline_float_method(self):
        """Float_Neg should be inlined the same as Int_Abs."""
        callee = [
            IRInstr(op=IROp.LABEL, label="Float_Neg"),
            IRInstr(op=IROp.MOV, dest="%self", src1="__arg0"),
            IRInstr(op=IROp.NEG, dest="%r", src1="%self"),
            IRInstr(op=IROp.RET),
        ]
        func_ir = {"Float_Neg": callee}
        caller = [
            IRInstr(op=IROp.CONST, dest="%f", imm=314),
            IRInstr(op=IROp.PARAM, src1="%f", imm=0),
            IRInstr(op=IROp.CALL, dest="%res", label="Float_Neg", arg_count=1),
        ]
        result = inline_functions(caller, func_ir)
        calls = [i for i in result
                 if i.op == IROp.CALL and i.label == "Float_Neg"]
        self.assertEqual(len(calls), 0, "Float_Neg should be inlined")
        neg_ops = [i for i in result if i.op == IROp.NEG]
        self.assertTrue(len(neg_ops) > 0, "NEG instruction should appear")

    def test_inline_with_two_args(self):
        """Method with self + 1 arg (e.g., Int_Add(self, other))."""
        callee = [
            IRInstr(op=IROp.LABEL, label="Int_Add"),
            IRInstr(op=IROp.MOV, dest="%self", src1="__arg0"),
            IRInstr(op=IROp.MOV, dest="%other", src1="__arg1"),
            IRInstr(op=IROp.ADD, dest="%r", src1="%self", src2="%other"),
            IRInstr(op=IROp.RET),
        ]
        func_ir = {"Int_Add": callee}
        caller = [
            IRInstr(op=IROp.CONST, dest="%a", imm=10),
            IRInstr(op=IROp.CONST, dest="%b", imm=20),
            IRInstr(op=IROp.PARAM, src1="%a", imm=0),
            IRInstr(op=IROp.PARAM, src1="%b", imm=1),
            IRInstr(op=IROp.CALL, dest="%res", label="Int_Add", arg_count=2),
        ]
        result = inline_functions(caller, func_ir)
        calls = [i for i in result
                 if i.op == IROp.CALL and i.label == "Int_Add"]
        self.assertEqual(len(calls), 0, "Int_Add should be inlined")
        add_ops = [i for i in result if i.op == IROp.ADD]
        self.assertTrue(len(add_ops) > 0,
                        "ADD instruction from callee should appear")


class TestEscapeAnalysisMultiType(unittest.TestCase):
    """Escape analysis for different wrapper class patterns."""

    def test_float_wrapper_elided(self):
        """Non-escaping Float wrapper allocation is scalarised."""
        instrs = [
            IRInstr(op=IROp.CONST, dest="%size", imm=4),
            IRInstr(op=IROp.PARAM, src1="%size", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt",
                    label="__vtable_Float"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.PARAM, src1="%val", imm=1),
            IRInstr(op=IROp.CALL, dest="%obj",
                    label="Float_OnAlloc", arg_count=2),
            IRInstr(op=IROp.CONST, dest="%off", imm=2),
            IRInstr(op=IROp.ADD, dest="%addr", src1="%obj", src2="%off"),
            IRInstr(op=IROp.STORE_16, src1="%val", src2="%addr"),
            IRInstr(op=IROp.LOAD_16, dest="%read", src1="%addr"),
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.CALL, dest="%_", label="__free", arg_count=1),
        ]
        result = escape_analyze(instrs)
        malloc_calls = [i for i in result
                        if i.op == IROp.CALL and i.label == "__malloc"]
        self.assertEqual(len(malloc_calls), 0,
                         "Float malloc should be elided")

    def test_bool_wrapper_elided(self):
        """Non-escaping Bool wrapper allocation is scalarised."""
        instrs = [
            IRInstr(op=IROp.CONST, dest="%size", imm=4),
            IRInstr(op=IROp.PARAM, src1="%size", imm=0),
            IRInstr(op=IROp.CALL, dest="%obj", label="__malloc", arg_count=1),
            IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest="%vt",
                    label="__vtable_Bool"),
            IRInstr(op=IROp.STORE_16, src1="%vt", src2="%obj"),
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.PARAM, src1="%bval", imm=1),
            IRInstr(op=IROp.CALL, dest="%obj",
                    label="Bool_OnAlloc", arg_count=2),
            IRInstr(op=IROp.PARAM, src1="%obj", imm=0),
            IRInstr(op=IROp.CALL, dest="%_", label="__free", arg_count=1),
        ]
        result = escape_analyze(instrs)
        malloc_calls = [i for i in result
                        if i.op == IROp.CALL and i.label == "__malloc"]
        self.assertEqual(len(malloc_calls), 0,
                         "Bool malloc should be elided")


if __name__ == "__main__":
    unittest.main()

