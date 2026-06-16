from __future__ import annotations

from src.parser.ast_nodes import *
from src.ir.instructions import IROp, IRInstr
from src.ir.virtual_register import VirtualRegisterAllocator
from src.semantic.types import (
    VelaType, FloatType, IntType, PtrType_, BoolType, VoidType, ClassType,
    U0, I8, U8, I16, U16, F16,
)
from src.semantic.type_checker import TypeChecker
from src.errors import CodeGenError

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
        self._current_return_type: VelaType = U0
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
        ct = self._tc.class_types.get(self._current_class.name)
        return bool(ct and any(field_name == name for field_name, _ in ct.fields))

    def _field_offset_by_name(self, name: str) -> int:
        """Compute field byte offset from the current class."""
        if self._current_class is None:
            return 2
        offset, _ = self._class_field_info(self._current_class.name, name)
        return offset

    def _storage_size(self, ty: VelaType | None) -> int:
        return max(ty.size(), 1) if ty is not None else 2

    def _is_signed_byte(self, ty: VelaType | None) -> bool:
        return isinstance(ty, IntType) and ty.bits == 8 and ty.signed

    def _global_type(self, name: str) -> VelaType | None:
        for global_name, ty, _ in self._tc.globals:
            if global_name == name:
                return ty
        sym = self._tc.scopes.lookup(name)
        return sym.type if sym and sym.kind == "var" else None

    def _require_global_type(self, name: str) -> VelaType:
        ty = self._global_type(name)
        if ty is None:
            raise CodeGenError(f"global variable '{name}' has no type information")
        return ty

    def _class_field_info(self, cls_name: str, field_name: str) -> tuple[int, VelaType]:
        ct = self._tc.class_types.get(cls_name)
        if ct is None or not hasattr(ct, 'fields'):
            raise CodeGenError(f"class '{cls_name}' has no field metadata")
        offset = 2  # skip vtable pointer
        for fn, ft in ct.fields:
            if fn == field_name:
                return offset, ft
            offset += self._storage_size(ft)
        raise CodeGenError(f"class '{cls_name}' has no field '{field_name}'")

    def _class_field_offset(self, cls_name: str, field_name: str) -> int:
        """Compute field byte offset for any class by name."""
        offset, _ = self._class_field_info(cls_name, field_name)
        return offset

    def _emit_load_from_addr(self, addr_reg: str, ty: VelaType | None) -> str:
        r = self._tmp()
        if self._storage_size(ty) == 1:
            self._emit(IRInstr(op=IROp.LOAD_8, dest=r, src1=addr_reg, type_size=1))
            if self._is_signed_byte(ty):
                self._emit(IRInstr(op=IROp.SIGN_EXTEND_8, dest=r, src1=r))
        else:
            self._emit(IRInstr(op=IROp.LOAD_16, dest=r, src1=addr_reg, type_size=2))
        return r

    def _emit_store_to_addr(self, val_reg: str, addr_reg: str, ty: VelaType | None) -> None:
        if self._storage_size(ty) == 1:
            self._emit(IRInstr(op=IROp.STORE_8, src1=val_reg, src2=addr_reg, type_size=1))
        else:
            self._emit(IRInstr(op=IROp.STORE_16, src1=val_reg, src2=addr_reg, type_size=2))

    def _coerce_value_to_type(self, value_reg: str, ty: VelaType | None) -> str:
        """Normalize register values that represent narrower storage types."""
        if not isinstance(ty, IntType) or ty.bits != 8:
            return value_reg

        mask = self._tmp()
        truncated = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=mask, imm=0xFF))
        self._emit(IRInstr(op=IROp.AND, dest=truncated, src1=value_reg, src2=mask))
        if ty.signed:
            self._emit(IRInstr(op=IROp.SIGN_EXTEND_8, dest=truncated, src1=truncated))
        return truncated

    def _bool_value_reg(self, expr: Expr, value_reg: str) -> str:
        """Load Bool wrapper payload when a Bool object is used as a value."""
        inferred = getattr(expr, "inferred_type", None)
        if not (
            isinstance(inferred, PtrType_)
            and isinstance(inferred.inner, ClassType)
            and inferred.inner.name == "Bool"
        ):
            return value_reg
        offset, ty = self._class_field_info("Bool", "value")
        addr = self._tmp()
        off_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
        self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=value_reg, src2=off_r))
        return self._emit_load_from_addr(addr, ty)

    def _indexed_element_type(self, expr: IndexExpr) -> VelaType:
        obj_type = getattr(expr.obj, "inferred_type", None)
        if isinstance(obj_type, PtrType_):
            return obj_type.inner
        return U8

    def _emit_field_load(self, field_name: str) -> str:
        """Emit IR for loading self.field_name, return result register."""
        self_reg = self._locals["self"]
        offset, ty = self._class_field_info(self._current_class.name, field_name) if self._current_class else (2, I16)
        addr = self._tmp()
        off_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
        self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=self_reg, src2=off_r))
        return self._emit_load_from_addr(addr, ty)

    def _emit_field_store(self, field_name: str, val_reg: str) -> None:
        """Emit IR for storing val_reg into self.field_name."""
        self_reg = self._locals["self"]
        offset, ty = self._class_field_info(self._current_class.name, field_name) if self._current_class else (2, I16)
        addr = self._tmp()
        off_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
        self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=self_reg, src2=off_r))
        self._emit_store_to_addr(val_reg, addr, ty)

    def _build_function(self, fn: FunctionDecl, cls_name: str | None = None) -> None:
        mangled = self._mangle_func(cls_name, fn.name)
        self._current_func = mangled
        self._vr.reset()
        self._instrs = []
        self._locals = {}
        self._local_types = {}
        self._current_return_type = self._resolve_type(fn.return_type)

        self._emit(IRInstr(op=IROp.LABEL, label=mangled))

        # if inside a class, inject implicit 'self'/'this' as first parameter
        param_offset = 0
        if cls_name is not None:
            self_vr = self._tmp()
            self._locals["self"] = self_vr
            self._locals["this"] = self_vr  # alias for tag-generated code
            self_ty = self._tc.class_types.get(cls_name, ClassType(name=cls_name))
            self._local_types["self"] = PtrType_(self_ty)
            self._local_types["this"] = PtrType_(self_ty)
            self._emit(IRInstr(op=IROp.MOV, dest=self_vr, src1="__arg0"))
            param_offset = 1

        # bind parameters to virtual registers
        for i, p in enumerate(fn.params):
            vr = self._tmp()
            self._locals[p.name] = vr
            pty = self._resolve_type(p.type_expr)
            self._local_types[p.name] = pty
            self._emit(IRInstr(op=IROp.MOV, dest=vr, src1=f"__arg{i + param_offset}"))
            coerced = self._coerce_value_to_type(vr, pty)
            if coerced != vr:
                self._emit(IRInstr(op=IROp.MOV, dest=vr, src1=coerced))
        # build body
        for stmt in fn.body:
            self._build_stmt(stmt)

        # implicit return for U0 (Void) functions
        ret_ty = self._current_return_type
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
        else:
            raise CodeGenError(f"unsupported statement node {type(stmt).__name__}")

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
                val = self._coerce_value_to_type(val, ty)
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
                        _, field_ty = self._class_field_info(
                            self._current_class.name,
                            stmt.target.name,
                        )
                        val_reg = self._apply_compound_op(stmt.op, old, val_reg, field_ty)
                    self._emit_field_store(stmt.target.name, val_reg)
                    return
                # global variable
                addr = self._tmp()
                self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=stmt.target.name))
                ty = self._require_global_type(stmt.target.name)
                if stmt.op != "=":
                    old = self._emit_load_from_addr(addr, ty)
                    val_reg = self._apply_compound_op(stmt.op, old, val_reg, ty)
                self._emit_store_to_addr(val_reg, addr, ty)
                return

            if stmt.op != "=":
                target_ty = self._local_types.get(stmt.target.name)
                val_reg = self._apply_compound_op(stmt.op, target_vr, val_reg, target_ty)
            val_reg = self._coerce_value_to_type(
                val_reg,
                self._local_types.get(stmt.target.name),
            )
            self._emit(IRInstr(op=IROp.MOV, dest=target_vr, src1=val_reg))
            return

        if isinstance(stmt.target, DerefExpr):
            addr_reg = self._build_expr(stmt.target.operand)
            target_ty = getattr(stmt.target, "inferred_type", I16)
            if stmt.op != "=":
                old = self._emit_load_from_addr(addr_reg, target_ty)
                val_reg = self._apply_compound_op(stmt.op, old, val_reg, target_ty)
            self._emit_store_to_addr(val_reg, addr_reg, target_ty)
            return

        if isinstance(stmt.target, FieldAccessExpr):
            obj_reg = self._build_expr(stmt.target.obj)
            offset, field_ty = self._field_info(stmt.target)
            addr = self._tmp()
            off_r = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
            self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=obj_reg, src2=off_r))
            if stmt.op != "=":
                old = self._emit_load_from_addr(addr, field_ty)
                val_reg = self._apply_compound_op(stmt.op, old, val_reg, field_ty)
            self._emit_store_to_addr(val_reg, addr, field_ty)
            return

        if isinstance(stmt.target, IndexExpr):
            base_reg = self._build_expr(stmt.target.obj)
            idx_reg = self._build_expr(stmt.target.index)
            elem_ty = self._indexed_element_type(stmt.target)
            addr = self._tmp()
            self._emit(IRInstr(
                op=IROp.PTR_ADD,
                dest=addr,
                src1=base_reg,
                src2=idx_reg,
                type_size=self._storage_size(elem_ty),
            ))
            if stmt.op != "=":
                old = self._emit_load_from_addr(addr, elem_ty)
                val_reg = self._apply_compound_op(stmt.op, old, val_reg, elem_ty)
            self._emit_store_to_addr(val_reg, addr, elem_ty)
            return

    def _apply_compound_op(
        self,
        op: str,
        lhs: str,
        rhs: str,
        result_ty: VelaType | None,
    ) -> str:
        result = self._tmp()
        op_map = {
            "+=": IROp.ADD,
            "-=": IROp.SUB,
            "*=": IROp.MUL,
            "/=": self._division_op(result_ty),
        }
        ir_op = op_map.get(op, IROp.ADD)
        self._emit(IRInstr(op=ir_op, dest=result, src1=lhs, src2=rhs))
        return self._coerce_value_to_type(result, result_ty)

    def _division_op(self, result_ty: VelaType | None) -> IROp:
        if isinstance(result_ty, IntType) and not result_ty.signed:
            return IROp.UDIV
        return IROp.DIV

    def _modulo_op(self, result_ty: VelaType | None) -> IROp:
        if isinstance(result_ty, IntType) and not result_ty.signed:
            return IROp.UMOD
        return IROp.MOD

    def _build_return(self, stmt: ReturnStmt) -> None:
        if stmt.value:
            val = self._build_expr(stmt.value)
            val = self._coerce_value_to_type(val, self._current_return_type)
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
        saved_locals = dict(self._locals)
        saved_local_types = dict(self._local_types)
        uid = self._next_uid()
        cond_label = f"__for_{uid}_cond"
        end_label = f"__for_{uid}_end"

        try:
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
        finally:
            self._locals = saved_locals
            self._local_types = saved_local_types

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
                l = self._bool_value_reg(expr.left, l)
                r = self._bool_value_reg(expr.right, r)
                is_float = (
                    isinstance(getattr(expr.left, 'inferred_type', None), FloatType) or
                    isinstance(getattr(expr.right, 'inferred_type', None), FloatType)
                )
                cmp_op = IROp.FCMP if is_float else IROp.CMP
                self._emit(IRInstr(op=cmp_op, src1=l, src2=r))
                # branch on inverse condition
                unsigned = (not is_float) and self._comparison_uses_unsigned(expr)
                self._emit(IRInstr(
                    op=self._comparison_branch(expr.op, unsigned=unsigned, invert=True),
                    label=false_label,
                ))
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
        # If the expression is a Bool class instance, load .value field
        inferred = getattr(expr, 'inferred_type', None)
        if (isinstance(inferred, PtrType_) and isinstance(inferred.inner, ClassType)
                and inferred.inner.name == "Bool"):
            val = self._bool_value_reg(expr, val)
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

    def _build_logical_value(self, expr: BinaryExpr) -> str:
        """Build short-circuiting logical expression and materialize 0/1."""
        result = self._tmp()
        uid = self._next_uid()
        false_label = f"__logic_{uid}_false"
        true_label = f"__logic_{uid}_true"
        end_label = f"__logic_{uid}_end"

        if expr.op == "&&":
            self._build_condition(expr.left, false_label)
            self._build_condition(expr.right, false_label)
            self._emit(IRInstr(op=IROp.CONST, dest=result, imm=1))
            self._emit(IRInstr(op=IROp.BRANCH, label=end_label))
            self._emit(IRInstr(op=IROp.LABEL, label=false_label))
            self._emit(IRInstr(op=IROp.CONST, dest=result, imm=0))
            self._emit(IRInstr(op=IROp.LABEL, label=end_label))
            return result

        self._build_condition_true(expr.left, true_label)
        self._build_condition(expr.right, false_label)
        self._emit(IRInstr(op=IROp.LABEL, label=true_label))
        self._emit(IRInstr(op=IROp.CONST, dest=result, imm=1))
        self._emit(IRInstr(op=IROp.BRANCH, label=end_label))
        self._emit(IRInstr(op=IROp.LABEL, label=false_label))
        self._emit(IRInstr(op=IROp.CONST, dest=result, imm=0))
        self._emit(IRInstr(op=IROp.LABEL, label=end_label))
        return result

    def _build_free(self, stmt: FreeStmt) -> None:
        ptr = self._build_expr(stmt.expr)
        end_label = f"__free_skip_{self._next_uid()}"
        zero = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=zero, imm=0))
        self._emit(IRInstr(op=IROp.CMP, src1=ptr, src2=zero))
        self._emit(IRInstr(op=IROp.BRANCH_EQ, label=end_label))

        cls_name = self._free_class_name(stmt.expr)
        onfree_label = None
        if cls_name:
            onfree_label = self._resolve_onfree_label(cls_name)
            self._emit(IRInstr(op=IROp.PARAM, src1=ptr, imm=0))
            self._emit(IRInstr(
                op=IROp.CALL,
                label=onfree_label,
                arg_count=1,
            ))

        if onfree_label != "Storeable_OnFree":
            self._emit(IRInstr(op=IROp.PARAM, src1=ptr))
            self._emit(IRInstr(op=IROp.CALL, label="__free", arg_count=1))
        self._emit(IRInstr(op=IROp.LABEL, label=end_label))

    def _free_class_name(self, expr: Expr) -> str | None:
        ty = getattr(expr, "inferred_type", None)
        if isinstance(ty, PtrType_) and isinstance(ty.inner, ClassType):
            return ty.inner.name
        return None

    def _resolve_onfree_label(self, cls_name: str) -> str:
        cls = self._tc.class_decls.get(cls_name)
        if cls is None:
            return f"{cls_name}_OnFree"
        if cls.on_free and cls.on_free.body:
            return f"{cls_name}_OnFree"
        if cls.parent and cls.parent in self._tc.class_decls:
            return self._resolve_onfree_label(cls.parent)
        return f"{cls_name}_OnFree"

    def _build_print(self, stmt: PrintStmt) -> None:
        val = self._build_expr(stmt.value)
        self._emit(IRInstr(op=IROp.PRINT_SYSCALL, src1=val))

    def _build_asm(self, stmt: AsmBlock) -> None:
        # load inputs
        for binding in stmt.inputs:
            src = self._load_asm_binding(binding.variable)
            self._emit(IRInstr(op=IROp.MOV, dest=binding.register, src1=src))
        # emit inline assembly
        self._emit(IRInstr(op=IROp.ASM_INLINE, asm_lines=stmt.body))
        # store outputs
        for binding in stmt.outputs:
            self._store_asm_binding(binding.variable, binding.register)

    def _load_asm_binding(self, name: str) -> str:
        local = self._locals.get(name)
        if local is not None:
            return local
        if self._is_field_of_current_class(name):
            return self._emit_field_load(name)
        ty = self._global_type(name)
        if ty is not None:
            addr = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=name))
            return self._emit_load_from_addr(addr, ty)
        return name

    def _store_asm_binding(self, name: str, src_reg: str) -> None:
        local = self._locals.get(name)
        if local is not None:
            value = self._coerce_value_to_type(src_reg, self._local_types.get(name))
            self._emit(IRInstr(op=IROp.MOV, dest=local, src1=value))
            return
        if self._is_field_of_current_class(name):
            self._emit_field_store(name, src_reg)
            return
        ty = self._global_type(name)
        if ty is not None:
            addr = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=name))
            self._emit_store_to_addr(src_reg, addr, ty)

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
            label = self._tc.string_labels.get(expr.value)
            if label is None:
                label = f"__str_{len(self._tc.string_labels) + 1}"
                self._tc.string_labels[expr.value] = label
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
            ty = self._require_global_type(expr.name)
            addr = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=expr.name))
            return self._emit_load_from_addr(addr, ty)

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
            return self._emit_load_from_addr(addr, getattr(expr, "inferred_type", I16))
        if isinstance(expr, AddressOfExpr):
            return self._build_address_of(expr)
        if isinstance(expr, InitExpr):
            return self._build_init(expr)
        if isinstance(expr, MallocExpr):
            return self._build_malloc(expr)
        if isinstance(expr, SizeOfExpr):
            r = self._tmp()
            ty = self._resolve_type(expr.target_type)
            self._emit(IRInstr(op=IROp.CONST, dest=r, imm=ty.size()))
            return r
        if isinstance(expr, CastExpr):
            value = self._build_expr(expr.operand)
            return self._coerce_value_to_type(value, self._resolve_type(expr.target_type))
        if isinstance(expr, MultiDispatchExpr):
            return self._build_multi_dispatch(expr)

        raise CodeGenError(f"unsupported expression node {type(expr).__name__}")

    def _build_binary(self, expr: BinaryExpr) -> str:
        if expr.op in ("&&", "||"):
            return self._build_logical_value(expr)

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
                left = self._bool_value_reg(expr.left, left)
                right = self._bool_value_reg(expr.right, right)
                self._emit(IRInstr(op=IROp.FCMP, src1=left, src2=right))
                return self._materialize_comparison(expr.op, r, unsigned=False)

        result_ty = getattr(expr, "inferred_type", None)
        op_map = {
            "+": IROp.ADD,
            "-": IROp.SUB,
            "*": IROp.MUL,
            "/": self._division_op(result_ty),
            "%": self._modulo_op(result_ty),
            "&": IROp.AND,
            "|": IROp.OR,
            "^": IROp.XOR,
        }
        if expr.op in op_map:
            self._emit(IRInstr(op=op_map[expr.op], dest=r, src1=left, src2=right))
            return self._coerce_value_to_type(r, result_ty)

        if expr.op in ("==", "!=", "<", ">", "<=", ">="):
            left = self._bool_value_reg(expr.left, left)
            right = self._bool_value_reg(expr.right, right)
            self._emit(IRInstr(op=IROp.CMP, src1=left, src2=right))
            return self._materialize_comparison(
                expr.op,
                r,
                unsigned=self._comparison_uses_unsigned(expr),
            )

        self._emit(IRInstr(op=IROp.MOV, dest=r, src1=left))
        return r

    def _comparison_uses_unsigned(self, expr: BinaryExpr) -> bool:
        """Return True when integer comparison should use unsigned CPU flags."""
        if expr.op not in ("<", ">", "<=", ">="):
            return False

        def unsigned_type(node: Expr) -> bool:
            ty = getattr(node, "inferred_type", None)
            return isinstance(ty, IntType) and not ty.signed

        def signed_non_literal(node: Expr) -> bool:
            ty = getattr(node, "inferred_type", None)
            return (
                isinstance(ty, IntType)
                and ty.signed
                and not isinstance(node, IntLiteral)
            )

        return (
            (unsigned_type(expr.left) or unsigned_type(expr.right))
            and not signed_non_literal(expr.left)
            and not signed_non_literal(expr.right)
        )

    def _comparison_branch(self, op: str, *, unsigned: bool, invert: bool) -> IROp:
        if unsigned:
            true_map = {
                "==": IROp.BRANCH_EQ,
                "!=": IROp.BRANCH_NE,
                "<": IROp.BRANCH_LO,
                ">": IROp.BRANCH_HI,
                "<=": IROp.BRANCH_LS,
                ">=": IROp.BRANCH_HS,
            }
            false_map = {
                "==": IROp.BRANCH_NE,
                "!=": IROp.BRANCH_EQ,
                "<": IROp.BRANCH_HS,
                ">": IROp.BRANCH_LS,
                "<=": IROp.BRANCH_HI,
                ">=": IROp.BRANCH_LO,
            }
        else:
            true_map = {
                "==": IROp.BRANCH_EQ,
                "!=": IROp.BRANCH_NE,
                "<": IROp.BRANCH_LT,
                ">": IROp.BRANCH_GT,
                "<=": IROp.BRANCH_LE,
                ">=": IROp.BRANCH_GE,
            }
            false_map = {
                "==": IROp.BRANCH_NE,
                "!=": IROp.BRANCH_EQ,
                "<": IROp.BRANCH_GE,
                ">": IROp.BRANCH_LE,
                "<=": IROp.BRANCH_GT,
                ">=": IROp.BRANCH_LT,
            }
        return (false_map if invert else true_map)[op]

    def _materialize_comparison(self, op: str, dest: str, *, unsigned: bool = False) -> str:
        """After a CMP, materialise the boolean result into a register."""
        uid = self._next_uid()
        true_label = f"__cmp_{uid}_true"
        end_label = f"__cmp_{uid}_end"
        self._emit(IRInstr(
            op=self._comparison_branch(op, unsigned=unsigned, invert=False),
            label=true_label,
        ))
        self._emit(IRInstr(op=IROp.CONST, dest=dest, imm=0))
        self._emit(IRInstr(op=IROp.BRANCH, label=end_label))
        self._emit(IRInstr(op=IROp.LABEL, label=true_label))
        self._emit(IRInstr(op=IROp.CONST, dest=dest, imm=1))
        self._emit(IRInstr(op=IROp.LABEL, label=end_label))
        return dest

    def _build_unary(self, expr: UnaryExpr) -> str:
        if expr.op in ("post++", "post--"):
            return self._build_post_update(expr)

        operand = self._build_expr(expr.operand)
        r = self._tmp()
        if expr.op == "-":
            if isinstance(getattr(expr.operand, "inferred_type", None), FloatType):
                zero = self._tmp()
                self._emit(IRInstr(op=IROp.FCONST, dest=zero, imm=0.0))
                self._emit(IRInstr(op=IROp.FSUB, dest=r, src1=zero, src2=operand))
                return r
            zero = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=zero, imm=0))
            self._emit(IRInstr(op=IROp.RSB, dest=r, src1=operand, src2=zero))
            return self._coerce_value_to_type(r, getattr(expr, "inferred_type", None))
        if expr.op == "!":
            operand = self._bool_value_reg(expr.operand, operand)
            zero = self._tmp()
            self._emit(IRInstr(op=IROp.CONST, dest=zero, imm=0))
            self._emit(IRInstr(op=IROp.CMP, src1=operand, src2=zero))
            return self._materialize_comparison("==", r)
        self._emit(IRInstr(op=IROp.MOV, dest=r, src1=operand))
        return r

    def _build_post_update(self, expr: UnaryExpr) -> str:
        old = self._build_expr(expr.operand)
        result = self._tmp()
        one = self._tmp()
        new_value = self._tmp()
        self._emit(IRInstr(op=IROp.MOV, dest=result, src1=old))
        self._emit(IRInstr(op=IROp.CONST, dest=one, imm=1))
        op = IROp.ADD if expr.op == "post++" else IROp.SUB
        self._emit(IRInstr(op=op, dest=new_value, src1=old, src2=one))
        self._store_lvalue(expr.operand, new_value)
        return result

    def _build_address_of(self, expr: AddressOfExpr) -> str:
        operand = expr.operand
        if isinstance(operand, IdentifierExpr):
            if self._is_field_of_current_class(operand.name):
                self_reg = self._locals["self"]
                offset = self._field_offset_by_name(operand.name)
                addr = self._tmp()
                off_r = self._tmp()
                self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
                self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=self_reg, src2=off_r))
                return addr
            r = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=r, label=operand.name))
            return r
        if isinstance(operand, DerefExpr):
            return self._build_expr(operand.operand)
        if isinstance(operand, FieldAccessExpr):
            return self._build_field_addr(operand)
        if isinstance(operand, IndexExpr):
            return self._build_index_addr(operand)
        return self._build_expr(operand)

    def _store_lvalue(self, target: Expr, value_reg: str) -> None:
        if isinstance(target, IdentifierExpr):
            local = self._locals.get(target.name)
            if local is not None:
                value_reg = self._coerce_value_to_type(
                    value_reg,
                    self._local_types.get(target.name),
                )
                self._emit(IRInstr(op=IROp.MOV, dest=local, src1=value_reg))
                return
            if self._is_field_of_current_class(target.name):
                self._emit_field_store(target.name, value_reg)
                return
            addr = self._tmp()
            self._emit(IRInstr(op=IROp.LOAD_GLOBAL_ADDR, dest=addr, label=target.name))
            self._emit_store_to_addr(value_reg, addr, self._require_global_type(target.name))
            return
        if isinstance(target, DerefExpr):
            addr = self._build_expr(target.operand)
            self._emit_store_to_addr(value_reg, addr, getattr(target, "inferred_type", I16))
            return
        if isinstance(target, FieldAccessExpr):
            addr = self._build_field_addr(target)
            _, field_ty = self._field_info(target)
            self._emit_store_to_addr(value_reg, addr, field_ty)
            return
        if isinstance(target, IndexExpr):
            addr = self._build_index_addr(target)
            elem_ty = self._indexed_element_type(target)
            self._emit_store_to_addr(value_reg, addr, elem_ty)
            return
        raise CodeGenError(f"unsupported assignment target {type(target).__name__}")

    def _build_call(self, expr: CallExpr) -> str:
        args = [self._build_expr(a) for a in expr.args]
        for i, a in enumerate(args):
            self._emit(IRInstr(op=IROp.PARAM, src1=a, imm=i))
        if not isinstance(expr.callee, IdentifierExpr):
            raise CodeGenError(f"unsupported call target {type(expr.callee).__name__}")
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
        self._emit(IRInstr(op=IROp.CALL,
                           label=f"{wrapper_cls}_OnAlloc", arg_count=2))
        return obj

    def _autofree(self, obj_reg: str) -> None:
        """Free an auto-boxed temporary wrapper object."""
        self._emit(IRInstr(op=IROp.PARAM, src1=obj_reg, imm=0))
        self._emit(IRInstr(op=IROp.CALL, dest=self._tmp(),
                           label="__free", arg_count=1))

    def _build_field_access(self, expr: FieldAccessExpr) -> str:
        addr = self._build_field_addr(expr)
        _, field_ty = self._field_info(expr)
        return self._emit_load_from_addr(addr, field_ty)

    def _build_field_addr(self, expr: FieldAccessExpr) -> str:
        obj_reg = self._build_expr(expr.obj)
        offset, _ = self._field_info(expr)
        addr = self._tmp()
        off_r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=off_r, imm=offset))
        self._emit(IRInstr(op=IROp.ADD, dest=addr, src1=obj_reg, src2=off_r))
        return addr

    def _field_offset(self, expr: FieldAccessExpr) -> int:
        """Compute field byte offset within an object."""
        offset, _ = self._field_info(expr)
        return offset

    def _field_info(self, expr: FieldAccessExpr) -> tuple[int, VelaType]:
        """Compute field byte offset and type within an object."""
        obj_type = getattr(expr.obj, 'inferred_type', None)
        if isinstance(obj_type, PtrType_):
            inner = obj_type.inner
            if isinstance(inner, ClassType):
                return self._class_field_info(inner.name, expr.field_name)
            if hasattr(inner, 'fields'):
                offset = 2
                for fn, ft in inner.fields:
                    if fn == expr.field_name:
                        return offset, ft
                    offset += self._storage_size(ft)
        # fallback: use current class fields
        if self._current_class is not None:
            return self._class_field_info(self._current_class.name, expr.field_name)
        raise CodeGenError(f"cannot resolve field '{expr.field_name}'")

    def _build_index(self, expr: IndexExpr) -> str:
        addr = self._build_index_addr(expr)
        elem_ty = self._indexed_element_type(expr)
        return self._emit_load_from_addr(addr, elem_ty)

    def _build_index_addr(self, expr: IndexExpr) -> str:
        base = self._build_expr(expr.obj)
        idx = self._build_expr(expr.index)
        elem_ty = self._indexed_element_type(expr)
        addr = self._tmp()
        self._emit(IRInstr(
            op=IROp.PTR_ADD,
            dest=addr,
            src1=base,
            src2=idx,
            type_size=self._storage_size(elem_ty),
        ))
        return addr

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
        cls = self._tc.class_decls.get(expr.class_name)
        if cls is not None and cls.on_alloc is not None:
            self._emit(IRInstr(op=IROp.PARAM, src1=obj, imm=0))
            for i, (_, val) in enumerate(expr.kwargs):
                v = self._build_expr(val)
                self._emit(IRInstr(op=IROp.PARAM, src1=v, imm=i + 1))
            self._emit(IRInstr(op=IROp.CALL,
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
        arg_regs = [self._build_expr(arg) for arg in expr.args]
        for target in expr.targets:
            obj = self._build_expr(target)
            self._emit(IRInstr(op=IROp.PARAM, src1=obj, imm=0))
            for i, arg in enumerate(arg_regs):
                self._emit(IRInstr(op=IROp.PARAM, src1=arg, imm=i + 1))

            obj_type = getattr(target, "inferred_type", None)
            cls_name = None
            if isinstance(obj_type, PtrType_):
                inner = obj_type.inner
                if hasattr(inner, "name"):
                    cls_name = inner.name
            elif isinstance(obj_type, ClassType):
                cls_name = obj_type.name

            call_dest = self._tmp()
            if cls_name and cls_name in self._tc.vtables:
                vt = self._tc.vtables[cls_name]
                slot = vt.slot_for(expr.method)
                if slot is not None:
                    self._emit(IRInstr(
                        op=IROp.VCALL,
                        dest=call_dest,
                        src1=obj,
                        label=expr.method,
                        imm=slot,
                        arg_count=len(arg_regs) + 1,
                    ))
                    continue

            mangled = f"{cls_name}_{expr.method}" if cls_name else expr.method
            self._emit(IRInstr(
                op=IROp.CALL,
                dest=call_dest,
                label=mangled,
                arg_count=len(arg_regs) + 1,
            ))
        r = self._tmp()
        self._emit(IRInstr(op=IROp.CONST, dest=r, imm=0))
        return r
