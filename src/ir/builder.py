from __future__ import annotations

from src.parser.ast_nodes import *
from src.ir.instructions import IROp, IRInstr
from src.ir.virtual_register import VirtualRegisterAllocator
from src.semantic.types import (
    VelaType, FloatType, IntType, PtrType_, BoolType, VoidType, ClassType,
    I8, U8, I16, U16, F16,
)
from src.semantic.type_checker import TypeChecker

class IRBuilder:
    """Lowers a type-checked AST into a list of IR instructions per function."""

    def __init__(self, checker: TypeChecker) -> None:
        self._tc = checker
        self._vr = VirtualRegisterAllocator()
        self._uid = 0
        self._instrs: list[IRInstr] = []
        self._func_ir: dict[str, list[IRInstr]] = {}
        self._current_func: str = ""
        # tracks local variable -> virtual register mapping
        self._locals: dict[str, str] = {}
        self._local_types: dict[str, VelaType] = {}
        self._module_name: str = ""
        # current class context for bare field resolution
        self._current_class: ClassDecl | None = None

    def build(self, program: Program) -> dict[str, list[IRInstr]]:
        for mod in program.modules:
            self._module_name = mod.name
            for node in mod.body:
                if isinstance(node, FunctionDecl) and not node.is_skeleton:
                    self._build_function(node)
                elif isinstance(node, ClassDecl):
                    self._build_class(node)
        return self._func_ir

    def _next_uid(self) -> int:
        self._uid += 1
        return self._uid

    def _tmp(self) -> str:
        return self._vr.next()

    def _emit(self, instr: IRInstr) -> None:
        self._instrs.append(instr)

    def _mangle(self, name: str) -> str:
        if self._current_func and self._current_func not in ("main",):
            return name
        return name

    def _mangle_func(self, cls_name: str | None, func_name: str) -> str:
        if cls_name:
            return f"{cls_name}_{func_name}"
        return func_name

    def _resolve_type(self, texpr) -> VelaType:
        return self._tc._resolve_type(texpr)

    def _is_field_of_current_class(self, name: str) -> bool:
        """Check if name is a field of the current class."""
        if self._current_class is None:
            return False
        return any(f.name == name for f in self._current_class.fields)

    def _field_offset_by_name(self, name: str) -> int:
        """Compute field byte offset from the current class."""
        if self._current_class is None:
            return 2
        offset = 2  # skip vtable pointer
        for f in self._current_class.fields:
            if f.name == name:
                return offset
            ty = self._resolve_type(f.type_expr)
            offset += max(ty.size(), 2)  # min 2 bytes per field
        return 2

    def _emit_field_load(self, field_name: str) -> str:
        """Emit IR for loading self.field_name, return result register."""
        self_reg = self._locals["self"]
        offset = self._field_offset_by_name(field_name)
        r = self._tmp()
        if offset == 0:
            self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=self_reg))
        else:
            addr = self._tmp()
            off_r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
            self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=self_reg, src2=off_r))
            self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=addr))
        return r

    def _emit_field_store(self, field_name: str, val_reg: str) -> None:
        """Emit IR for storing val_reg into self.field_name."""
        self_reg = self._locals["self"]
        offset = self._field_offset_by_name(field_name)
        addr = self._tmp()
        off_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
        self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=self_reg, src2=off_r))
        self._emit(IRInstr(op=IROp.STORE_16, src1=val_reg, src2=addr))

    def _build_function(self, fn: FunctionDecl, cls_name: str | None = None) -> None:
        mangled = self._mangle_func(cls_name, fn.name)
        self._current_func = mangled
        self._vr.reset()
        self._instrs = []
        self._locals = {}
        self._local_types = {}

        self._emit(IRInstr(op=IROp.LABEL, label=mangled))

        # if inside a class, inject implicit 'self'/'this' as first parameter
        param_offset = 0
        if cls_name is not None:
            self_vr = self._tmp()
            self._locals["self"] = self_vr
            self._locals["this"] = self_vr  # alias for tag-generated code
            self._local_types["self"] = PtrType_(IntType(16, False))
            self._local_types["this"] = PtrType_(IntType(16, False))
            self._emit(IRInstr(op=IROp.MOV, dest=self_vr, src1="__arg0"))
            param_offset = 1

        # bind parameters to virtual registers
        for i, p in enumerate(fn.params):
            vr = self._tmp()
            self._locals[p.name] = vr
            pty = self._resolve_type(p.type_expr)
            self._local_types[p.name] = pty
            self._emit(IRInstr(op=IROp.MOV, dest=vr, src1=f"__arg{i + param_offset}"))
        # build body
        for stmt in fn.body:
            self._build_stmt(stmt)

        # implicit return for U0 (Void) functions
        ret_ty = self._resolve_type(fn.return_type)
        if isinstance(ret_ty, VoidType) and (not self._instrs or self._instrs[-1].op != IROp.RET):
            self._emit(IRInstr(op=IROp.RET))

        self._func_ir[mangled] = list(self._instrs)

    def _build_class(self, cls: ClassDecl) -> None:
        self._current_class = cls
        if cls.on_alloc:
            self._build_function(cls.on_alloc, cls.name)

        # OnFree: generate only if the class has a non-empty body or has no
        # class parent to inherit from.  Classes that inherit from another
        # class (e.g. Storeable) fall back to the parent's OnFree.
        has_real_onfree = cls.on_free and cls.on_free.body
        has_class_parent = (
            cls.parent is not None
            and cls.parent in self._tc.class_decls
        )
        if has_real_onfree:
            self._build_function(cls.on_free, cls.name)
        elif not has_class_parent:
            # root class (no class parent) - generate empty OnFree stub
            stub = FunctionDecl(
                return_type=NamedType(name="U0"), name="OnFree",
                params=[], body=[], location=cls.location if hasattr(cls, 'location') else None,
            )
            self._build_function(stub, cls.name)
        # else: inherits parent's OnFree - no code generated

        for m in cls.methods:
            if not m.is_skeleton:
                self._build_function(m, cls.name)
        self._current_class = None

    def _build_stmt(self, stmt: Stmt) -> None:
        if isinstance(stmt, VarDecl):
            self._build_var_decl(stmt)
        elif isinstance(stmt, Assignment):
            self._build_assignment(stmt)
        elif isinstance(stmt, ReturnStmt):
            self._build_return(stmt)
        elif isinstance(stmt, IfStmt):
            self._build_if(stmt)
        elif isinstance(stmt, ForStmt):
            self._build_for(stmt)
        elif isinstance(stmt, WhileStmt):
            self._build_while(stmt)
        elif isinstance(stmt, ExprStmt):
            if stmt.expr:
                self._build_expr(stmt.expr)
        elif isinstance(stmt, FreeStmt):
            self._build_free(stmt)
        elif isinstance(stmt, PrintStmt):
            self._build_print(stmt)
        elif isinstance(stmt, AsmBlock):
            self._build_asm(stmt)

    def _build_var_decl(self, stmt: VarDecl) -> None:
        vr = self._tmp()
        self._locals[stmt.name] = vr
        ty = self._resolve_type(stmt.type_expr)
        self._local_types[stmt.name] = ty
        if stmt.initializer:
            val = self._build_expr(stmt.initializer)
            # auto-box: if declared type is Ptr<ClassType> (e.g. `Int x = -42`)
            # and the class is a known wrapper, auto-box the primitive value
            if (isinstance(ty, PtrType_)
                    and isinstance(ty.inner, ClassType)
                    and ty.inner.name in self._tc.vtables):
                init_type = getattr(stmt.initializer, 'inferred_type', None)
                # only auto-box if the initializer is a primitive (not already a pointer)
                if init_type and not isinstance(init_type, PtrType_):
                    boxed = self._autobox(val, ty.inner.name)
                    self._emit(IRInstr(op=IROp.MOV, dest=vr, src1=boxed))
                else:
                    self._emit(IRInstr(op=IROp.MOV, dest=vr, src1=val))
            else:
                self._emit(IRInstr(op=IROp.MOV, dest=vr, src1=val))
        else:
            self._emit(IRInstr(op=IROp.CONST, dest=vr, imm=0))

    def _build_assignment(self, stmt: Assignment) -> None:
        val_reg = self._build_expr(stmt.value)

        if isinstance(stmt.target, IdentifierExpr):
            target_vr = self._locals.get(stmt.target.name)
            if target_vr is None:
                # check if it's a field of the current class
                if self._is_field_of_current_class(stmt.target.name):
                    if stmt.op != "=":
                        old = self._emit_field_load(stmt.target.name)
                        val_reg = self._apply_compound_op(stmt.op, old, val_reg)
                    self._emit_field_store(stmt.target.name, val_reg)
                    return
                # global variable
                addr = self._tmp()
                self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=stmt.target.name))
                ty = self._local_types.get(stmt.target.name, I16)
                sym = self._tc.scopes.lookup(stmt.target.name)
                if sym:
                    ty = sym.type
                sz = ty.size() if ty.size() > 0 else 2
                if stmt.op != "=":
                    old = self._tmp()
                    load_op = IROp.LOAD_8 if sz == 1 else IROp.LOAD_16
                    self._emit(IRInstr(op=load_op, dest=old, src1=addr))
                    val_reg = self._apply_compound_op(stmt.op, old, val_reg)
                store_op = IROp.STORE_8 if sz == 1 else IROp.STORE_16
                self._emit(IRInstr(op=store_op, src1=val_reg, src2=addr, type_size=sz))
                return

            if stmt.op != "=":
                val_reg = self._apply_compound_op(stmt.op, target_vr, val_reg)
            self._emit(IRInstr(op=IROp.MOV, dest=target_vr, src1=val_reg))
            return

        if isinstance(stmt.target, DerefExpr):
            addr_reg = self._build_expr(stmt.target.operand)
            if stmt.op != "=":
                old = self._tmp()
                self._emit(IRInstr(op=IROp.LOAD_16, dest=old, src1=addr_reg))
                val_reg = self._apply_compound_op(stmt.op, old, val_reg)
            self._emit(IRInstr(op=IROp.STORE_16, src1=val_reg, src2=addr_reg))
            return

        if isinstance(stmt.target, FieldAccessExpr):
            obj_reg = self._build_expr(stmt.target.obj)
            offset = self._field_offset(stmt.target)
            addr = self._tmp()
            off_r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
            self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=obj_reg, src2=off_r))
            self._emit(IRInstr(op=IROp.STORE_16, src1=val_reg, src2=addr))
            return

        if isinstance(stmt.target, IndexExpr):
            base_reg = self._build_expr(stmt.target.obj)
            idx_reg = self._build_expr(stmt.target.index)
            addr = self._tmp()
            self._emit(IRInstr(op=IROp.PTR_ADD, dest=addr, src1=base_reg, src2=idx_reg))
            self._emit(IRInstr(op=IROp.STORE_16, src1=val_reg, src2=addr))
            return

    def _apply_compound_op(self, op: str, lhs: str, rhs: str) -> str:
        result = self._tmp()
        op_map = {"+=": IROp.ADD, "-=": IROp.SUB, "*=": IROp.MUL, "/=": IROp.DIV}
        ir_op = op_map.get(op, IROp.ADD)
        self._emit(IRInstr(op=ir_op, dest=result, src1=lhs, src2=rhs))
        return result

    def _build_return(self, stmt: ReturnStmt) -> None:
        if stmt.value:
            val = self._build_expr(stmt.value)
            self._emit(IRInstr(op=IROp.RET, src1=val))
        else:
            self._emit(IRInstr(op=IROp.RET))

    def _build_if(self, stmt: IfStmt) -> None:
        uid = self._next_uid()
        else_label = f"__if_{uid}_else"
        end_label = f"__if_{uid}_end"

        self._build_condition(stmt.condition, else_label)

        for s in stmt.then_body:
            self._build_stmt(s)
        if stmt.else_body:
            self._emit(IRInstr(op=IROp.BRANCH, label=end_label))

        self._emit(IRInstr(op=IROp.LABEL, label=else_label))
        for s in stmt.else_body:
            self._build_stmt(s)
        if stmt.else_body:
            self._emit(IRInstr(op=IROp.LABEL, label=end_label))

    def _build_for(self, stmt: ForStmt) -> None:
        uid = self._next_uid()
        cond_label = f"__for_{uid}_cond"
        end_label = f"__for_{uid}_end"

        if stmt.init:
            self._build_stmt(stmt.init)

        self._emit(IRInstr(op=IROp.LABEL, label=cond_label))

        if stmt.condition:
            self._build_condition(stmt.condition, end_label)

        for s in stmt.body:
            self._build_stmt(s)

        if stmt.update:
            self._build_stmt(stmt.update)

        self._emit(IRInstr(op=IROp.BRANCH, label=cond_label))
        self._emit(IRInstr(op=IROp.LABEL, label=end_label))

    def _build_while(self, stmt: WhileStmt) -> None:
        uid = self._next_uid()
        cond_label = f"__while_{uid}_cond"
        end_label = f"__while_{uid}_end"

        self._emit(IRInstr(op=IROp.LABEL, label=cond_label))
        self._build_condition(stmt.condition, end_label)

        for s in stmt.body:
            self._build_stmt(s)

        self._emit(IRInstr(op=IROp.BRANCH, label=cond_label))
        self._emit(IRInstr(op=IROp.LABEL, label=end_label))

    def _build_condition(self, expr: Expr, false_label: str) -> None:
        """Emit CMP + conditional branch for a boolean expression."""
        if isinstance(expr, BinaryExpr):
            if expr.op in ("&&", "||"):
                self._build_logical(expr, false_label)
                return
            if expr.op in ("==", "!=", "<", ">", "<=", ">="):
                l = self._build_expr(expr.left)
                r = self._build_expr(expr.right)
                is_float = (
                    isinstance(getattr(expr.left, 'inferred_type', None), FloatType) or
                    isinstance(getattr(expr.right, 'inferred_type', None), FloatType)
                )
                cmp_op = IROp.FCMP if is_float else IROp.CMP
                self._emit(IRInstr(op=cmp_op, src1=l, src2=r))
                # branch on inverse condition
                inv = {"==": IROp.BRANCH_NE, "!=": IROp.BRANCH_EQ,
                       "<": IROp.BRANCH_GE, ">": IROp.BRANCH_LE,
                       "<=": IROp.BRANCH_GT, ">=": IROp.BRANCH_LT}
                self._emit(IRInstr(op=inv[expr.op], label=false_label))
                return
        if isinstance(expr, UnaryExpr) and expr.op == "!":
            # invert: jump to false_label if inner is TRUE
            uid = self._next_uid()
            true_label = f"__not_{uid}_true"
            self._build_condition(expr.operand, true_label)
            self._emit(IRInstr(op=IROp.BRANCH, label=false_label))
            self._emit(IRInstr(op=IROp.LABEL, label=true_label))
            return
        # general expression: compare to 0
        val = self._build_expr(expr)
        zero = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=zero, imm=0))
        self._emit(IRInstr(op=IROp.CMP, src1=val, src2=zero))
        self._emit(IRInstr(op=IROp.BRANCH_EQ, label=false_label))

    def _build_logical(self, expr: BinaryExpr, false_label: str) -> None:
        if expr.op == "&&":
            # short-circuit: if left is false, skip to false_label
            self._build_condition(expr.left, false_label)
            self._build_condition(expr.right, false_label)
        elif expr.op == "||":
            uid = self._next_uid()
            right_label = f"__or_{uid}_right"
            # if left is true, skip right
            # build inverted: if left true -> continue, else try right
            self._build_condition_true(expr.left, right_label)
            self._build_condition(expr.right, false_label)
            self._emit(IRInstr(op=IROp.LABEL, label=right_label))

    def _build_condition_true(self, expr: Expr, true_label: str) -> None:
        """Branch to true_label if expr is TRUE — used for || short-circuit."""
        uid = self._next_uid()
        skip = f"__or_skip_{uid}"
        self._build_condition(expr, skip)
        self._emit(IRInstr(op=IROp.BRANCH, label=true_label))
        self._emit(IRInstr(op=IROp.LABEL, label=skip))

    def _build_free(self, stmt: FreeStmt) -> None:
        ptr = self._build_expr(stmt.expr)
        self._emit(IRInstr(op=IROp.PARAM, src1=ptr))
        self._emit(IRInstr(op=IROp.CALL, label="__free", arg_count=1))

    def _build_print(self, stmt: PrintStmt) -> None:
        val = self._build_expr(stmt.value)
        self._emit(IRInstr(op=IROp.PRINT_SYSCALL, src1=val))

    def _build_asm(self, stmt: AsmBlock) -> None:
        # load inputs
        for binding in stmt.inputs:
            src = self._locals.get(binding.variable, binding.variable)
            self._emit(IRInstr(op=IROp.MOV, dest=binding.register, src1=src))
        # emit inline assembly
        self._emit(IRInstr(op=IROp.ASM_INLINE, asm_lines=stmt.body))
        # store outputs
        for binding in stmt.outputs:
            dest = self._locals.get(binding.variable)
            if dest is None:
                dest = self._tmp()
                self._locals[binding.variable] = dest
            self._emit(IRInstr(op=IROp.MOV, dest=dest, src1=binding.register))

    def _build_expr(self, expr: Expr) -> str:
        if isinstance(expr, IntLiteral):
            r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=r, imm=expr.value))
            return r
        if isinstance(expr, FloatLiteral):
            r = self._tmp()
            self._emit(IRInstr(op=IROp.FCONST, dest=r, imm=expr.value))
            return r
        if isinstance(expr, StringLiteral):
            r = self._tmp()
            label = f"__str_{self._next_uid()}"
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=r, label=label))
            return r
        if isinstance(expr, CharLiteral):
            r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=r, imm=ord(expr.value)))
            return r
        if isinstance(expr, BoolLiteral):
            r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=r, imm=1 if expr.value else 0))
            return r
        if isinstance(expr, NullLiteral):
            r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=r, imm=0))
            return r
        if isinstance(expr, IdentifierExpr):
            vr = self._locals.get(expr.name)
            if vr:
                return vr
            # check if it's a field of the current class
            if self._is_field_of_current_class(expr.name):
                return self._emit_field_load(expr.name)
            # global variable - load from memory
            sym = self._tc.scopes.lookup(expr.name)
            r = self._tmp()
            addr = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=expr.name))
            if sym and sym.type.size() == 1:
                self._emit(IRInstr(op=IROp.LOAD_8, dest=r, src1=addr, type_size=1))
                if isinstance(sym.type, IntType) and sym.type.signed:
                    self._emit(IRInstr(op=IROp.SIGN_EXTEND_8, dest=r, src1=r))
            else:
                self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=addr))
            return r

        if isinstance(expr, BinaryExpr):
            return self._build_binary(expr)
        if isinstance(expr, UnaryExpr):
            return self._build_unary(expr)
        if isinstance(expr, CallExpr):
            return self._build_call(expr)
        if isinstance(expr, MethodCallExpr):
            return self._build_method_call(expr)
        if isinstance(expr, FieldAccessExpr):
            return self._build_field_access(expr)
        if isinstance(expr, IndexExpr):
            return self._build_index(expr)
        if isinstance(expr, DerefExpr):
            addr = self._build_expr(expr.operand)
            r = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=addr))
            return r
        if isinstance(expr, AddressOfExpr):
            if isinstance(expr.operand, IdentifierExpr):
                r = self._tmp()
                self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=r, label=expr.operand.name))
                return r
            return self._build_expr(expr.operand)
        if isinstance(expr, InitExpr):
            return self._build_init(expr)
        if isinstance(expr, MallocExpr):
            return self._build_malloc(expr)
        if isinstance(expr, SizeOfExpr):
            r = self._tmp()
            ty = self._resolve_type(expr.target_type)
            self._emit(IRInstr(op=IROp.CONST, dest=r, imm=ty.size()))
            return r
        if isinstance(expr, MultiDispatchExpr):
            return self._build_multi_dispatch(expr)

        # fallback
        r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=r, imm=0))
        return r

    def _build_binary(self, expr: BinaryExpr) -> str:
        left = self._build_expr(expr.left)
        right = self._build_expr(expr.right)
        r = self._tmp()

        is_float = (
            isinstance(getattr(expr.left, 'inferred_type', None), FloatType) or
            isinstance(getattr(expr.right, 'inferred_type', None), FloatType)
        )

        if is_float:
            fop_map = {"+": IROp.FADD, "-": IROp.FSUB, "*": IROp.FMUL, "/": IROp.FDIV}
            if expr.op in fop_map:
                self._emit(IRInstr(op=fop_map[expr.op], dest=r, src1=left, src2=right))
                return r
            if expr.op in ("==", "!=", "<", ">", "<=", ">="):
                self._emit(IRInstr(op=IROp.FCMP, src1=left, src2=right))
                return self._materialize_comparison(expr.op, r)

        op_map = {
            "+": IROp.ADD, "-": IROp.SUB, "*": IROp.MUL, "/": IROp.DIV,
            "%": IROp.MOD, "&": IROp.AND, "|": IROp.OR, "^": IROp.XOR,
        }
        if expr.op in op_map:
            self._emit(IRInstr(op=op_map[expr.op], dest=r, src1=left, src2=right))
            return r

        if expr.op in ("==", "!=", "<", ">", "<=", ">="):
            self._emit(IRInstr(op=IROp.CMP, src1=left, src2=right))
            return self._materialize_comparison(expr.op, r)

        if expr.op == "&&":
            # already handled in conditions but may appear as expression
            self._emit(IRInstr(op=IROp.AND, dest=r, src1=left, src2=right))
            return r
        if expr.op == "||":
            self._emit(IRInstr(op=IROp.OR, dest=r, src1=left, src2=right))
            return r

        self._emit(IRInstr(op=IROp.MOV, dest=r, src1=left))
        return r

    def _materialize_comparison(self, op: str, dest: str) -> str:
        """After a CMP, materialise the boolean result into a register."""
        uid = self._next_uid()
        true_label = f"__cmp_{uid}_true"
        end_label = f"__cmp_{uid}_end"
        br_map = {"==": IROp.BRANCH_EQ, "!=": IROp.BRANCH_NE,
                  "<": IROp.BRANCH_LT, ">": IROp.BRANCH_GT,
                  "<=": IROp.BRANCH_LE, ">=": IROp.BRANCH_GE}
        self._emit(IRInstr(op=br_map[op], label=true_label))
        self._emit(IRInstr(op=IROp.CONST, dest=dest, imm=0))
        self._emit(IRInstr(op=IROp.BRANCH, label=end_label))
        self._emit(IRInstr(op=IROp.LABEL, label=true_label))
        self._emit(IRInstr(op=IROp.CONST, dest=dest, imm=1))
        self._emit(IRInstr(op=IROp.LABEL, label=end_label))
        return dest

    def _build_unary(self, expr: UnaryExpr) -> str:
        operand = self._build_expr(expr.operand)
        r = self._tmp()
        if expr.op == "-":
            zero = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=zero, imm=0))
            self._emit(IRInstr(op=IROp.RSB, dest=r, src1=operand, src2=zero))
            return r
        if expr.op == "!":
            zero = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=zero, imm=0))
            self._emit(IRInstr(op=IROp.CMP, src1=operand, src2=zero))
            return self._materialize_comparison("==", r)
        if expr.op == "post++":
            one = self._tmp()
            self._emit(IRInstr(op=IROp.MOV, dest=r, src1=operand))
            self._emit(IRInstr(op=IROp.CONST, dest=one, imm=1))
            self._emit(IRInstr(op=IROp.ADD, dest=operand, src1=operand, src2=one))
            return r
        if expr.op == "post--":
            one = self._tmp()
            self._emit(IRInstr(op=IROp.MOV, dest=r, src1=operand))
            self._emit(IRInstr(op=IROp.CONST, dest=one, imm=1))
            self._emit(IRInstr(op=IROp.SUB, dest=operand, src1=operand, src2=one))
            return r
        self._emit(IRInstr(op=IROp.MOV, dest=r, src1=operand))
        return r

    def _build_call(self, expr: CallExpr) -> str:
        args = [self._build_expr(a) for a in expr.args]
        for i, a in enumerate(args):
            self._emit(IRInstr(op=IROp.PARAM, src1=a, imm=i))
        func_name = ""
        if isinstance(expr.callee, IdentifierExpr):
            func_name = expr.callee.name
        r = self._tmp()
        self._emit(IRInstr(op=IROp.CALL, dest=r, label=func_name, arg_count=len(args)))
        return r

    def _build_method_call(self, expr: MethodCallExpr) -> str:
        obj_reg = self._build_expr(expr.obj)
        args = [self._build_expr(a) for a in expr.args]

        obj_type = getattr(expr.obj, 'inferred_type', None)

        # pass 'this' as first arg
        self._emit(IRInstr(op=IROp.PARAM, src1=obj_reg, imm=0))
        for i, a in enumerate(args):
            self._emit(IRInstr(op=IROp.PARAM, src1=a, imm=i + 1))

        r = self._tmp()
        cls_name = None
        if isinstance(obj_type, PtrType_):
            inner = obj_type.inner
            if hasattr(inner, 'name'):
                cls_name = inner.name
        elif isinstance(obj_type, ClassType):
            cls_name = obj_type.name

        # virtual dispatch if vtable has a slot for this method
        if cls_name and cls_name in self._tc.vtables:
            vt = self._tc.vtables[cls_name]
            slot = vt.slot_for(expr.method)
            if slot is not None:
                self._emit(IRInstr(op=IROp.VCALL, dest=r, src1=obj_reg,
                                   label=expr.method, imm=slot,
                                   arg_count=len(args) + 1))
                return r

        # static call fallback
        mangled = f"{cls_name}_{expr.method}" if cls_name else expr.method
        self._emit(IRInstr(op=IROp.CALL, dest=r, label=mangled, arg_count=len(args) + 1))
        return r

    def _autobox(self, val_reg: str, wrapper_cls: str) -> str:
        """Box a primitive value into a wrapper class instance.

        Emits: ``tmp = Init<wrapper_cls>(val: val_reg)``
        """
        vt = self._tc.vtables[wrapper_cls]
        size = vt.class_size

        size_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=size_r, imm=size))
        self._emit(IRInstr(op=IROp.PARAM, src1=size_r, imm=0))

        obj = self._tmp()
        self._emit(IRInstr(op=IROp.CALL, dest=obj, label="__malloc", arg_count=1))

        # set vtable pointer
        vt_addr = self._tmp()
        self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=vt_addr,
                           label=f"__vtable_{wrapper_cls}"))
        self._emit(IRInstr(op=IROp.STORE_16, src1=vt_addr, src2=obj))

        # call OnAlloc(val)
        self._emit(IRInstr(op=IROp.PARAM, src1=obj, imm=0))
        self._emit(IRInstr(op=IROp.PARAM, src1=val_reg, imm=1))
        self._emit(IRInstr(op=IROp.CALL, dest=obj,
                           label=f"{wrapper_cls}_OnAlloc", arg_count=2))
        return obj

    def _autofree(self, obj_reg: str) -> None:
        """Free an auto-boxed temporary wrapper object."""
        self._emit(IRInstr(op=IROp.PARAM, src1=obj_reg, imm=0))
        self._emit(IRInstr(op=IROp.CALL, dest=self._tmp(),
                           label="__free", arg_count=1))

    def _build_field_access(self, expr: FieldAccessExpr) -> str:
        obj_reg = self._build_expr(expr.obj)
        offset = self._field_offset(expr)
        r = self._tmp()
        if offset == 0:
            self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=obj_reg))
        else:
            addr = self._tmp()
            off_r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
            self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=obj_reg, src2=off_r))
            self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=addr))
        return r

    def _field_offset(self, expr: FieldAccessExpr) -> int:
        """Compute field byte offset within an object."""
        obj_type = getattr(expr.obj, 'inferred_type', None)
        if isinstance(obj_type, PtrType_):
            inner = obj_type.inner
            if hasattr(inner, 'fields'):
                offset = 2  # skip vtable pointer
                for fn, ft in inner.fields:
                    if fn == expr.field_name:
                        return offset
                    offset += max(ft.size(), 1)
        # fallback: use current class fields
        if self._current_class is not None:
            return self._field_offset_by_name(expr.field_name)
        return 2  # default: right after vtable ptr

    def _build_index(self, expr: IndexExpr) -> str:
        base = self._build_expr(expr.obj)
        idx = self._build_expr(expr.index)
        addr = self._tmp()
        self._emit(IRInstr(op=IROp.PTR_ADD, dest=addr, src1=base, src2=idx))
        r = self._tmp()
        self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=addr))
        return r

    def _build_init(self, expr: InitExpr) -> str:
        vt = self._tc.vtables.get(expr.class_name)
        size = vt.class_size if vt else 4
        # malloc
        size_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=size_r, imm=size))
        self._emit(IRInstr(op=IROp.PARAM, src1=size_r, imm=0))
        obj = self._tmp()
        self._emit(IRInstr(op=IROp.CALL, dest=obj, label="__malloc", arg_count=1))
        # set vtable pointer
        vt_addr = self._tmp()
        self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=vt_addr,
                           label=f"__vtable_{expr.class_name}"))
        self._emit(IRInstr(op=IROp.STORE_16, src1=vt_addr, src2=obj))
        # call OnAlloc
        self._emit(IRInstr(op=IROp.PARAM, src1=obj, imm=0))
        for i, (_, val) in enumerate(expr.kwargs):
            v = self._build_expr(val)
            self._emit(IRInstr(op=IROp.PARAM, src1=v, imm=i + 1))
        self._emit(IRInstr(op=IROp.CALL, dest=obj,
                           label=f"{expr.class_name}_OnAlloc",
                           arg_count=len(expr.kwargs) + 1))
        return obj

    def _build_malloc(self, expr: MallocExpr) -> str:
        size = self._build_expr(expr.size)
        self._emit(IRInstr(op=IROp.PARAM, src1=size, imm=0))
        r = self._tmp()
        self._emit(IRInstr(op=IROp.CALL, dest=r, label="__malloc", arg_count=1))
        return r

    def _build_multi_dispatch(self, expr: MultiDispatchExpr) -> str:
        for target in expr.targets:
            obj = self._build_expr(target)
            self._emit(IRInstr(op=IROp.PARAM, src1=obj, imm=0))
            self._emit(IRInstr(op=IROp.CALL, label=expr.method, arg_count=1))
        r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=r, imm=0))
        return r
