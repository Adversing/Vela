from __future__ import annotations

from src.errors import SemanticError, VelaError, SourceLocation
from src.parser.ast_nodes import *
from src.semantic.types import (
    VelaType, VoidType, IntType, FloatType, PtrType_, BoolType,
    ClassType, TypeDeclType, U0, U8, I8, U16, I16, F16, BOOL, NULL_PTR,
    PRIMITIVE_MAP, types_compatible, is_bool_like,
)
from src.semantic.scope import ScopeStack, Symbol
from src.semantic.inheritance import InheritanceResolver, VtableInfo
from src.semantic.tag_processor import process_tags

_PRIMITIVE_TO_BOXED: dict[VelaType, str] = {
    I16:  "Int",
    U16:  "Int",
    I8:   "Int",       # I8 is IntType(8, signed=True); Bool literal has BoolType
    U8:   "Char",
    F16:  "Float",
    BOOL: "Bool",
}


class TypeChecker:
    """Single-pass type checker and name resolver."""

    def __init__(self, module_resolver=None) -> None:
        self.scopes = ScopeStack()
        self.inheritance = InheritanceResolver()
        self.aliases: dict[str, VelaType] = {}
        self.class_types: dict[str, ClassType] = {}
        self.vtables: dict[str, VtableInfo] = {}
        self.globals: list[tuple[str, VelaType, Any]] = []
        self.functions: list[FunctionDecl] = []
        self.class_decls: dict[str, ClassDecl] = {}
        self.string_literals: list[str] = []
        self.string_labels: dict[str, str] = {}
        self._current_func: FunctionDecl | None = None
        self._current_class: str | None = None
        self._module_resolver = module_resolver
        self._checked_modules: set[str] = set()
        self.imported_modules: list[ModuleDecl] = []

    def check(self, program: Program) -> None:
        for mod in program.modules:
            self._check_module(mod)

    def _ensure_storeable_imported(self) -> None:
        """Auto-import stdlib/core/storeable.vl so every class can inherit Storeable."""
        if "storeable" in self._checked_modules:
            return
        if not self._module_resolver:
            return
        try:
            storeable_mod = self._module_resolver.resolve(
                ["stdlib", "core"], "storeable"
            )
            if storeable_mod.name not in {m.name for m in self.imported_modules}:
                self.imported_modules.append(storeable_mod)
            self._check_module(storeable_mod)
        except (VelaError, Exception):
            pass  # storeable not available - graceful fallback

    def _check_module(self, mod: ModuleDecl) -> None:
        # avoid processing the same module twice (imported from multiple places)
        if mod.name in self._checked_modules:
            return
        self._checked_modules.add(mod.name)

        self.scopes.push(mod.name)

        # resolve imports first - inject imported declarations into scope
        if self._module_resolver and mod.imports:
            self._process_imports(mod.imports)

        # first pass: register all type/class/function/alias names
        has_parentless_classes = False
        for node in mod.body:
            if isinstance(node, AliasDecl):
                resolved = self._resolve_type(node.target_type)
                self.aliases[node.name] = resolved
                PRIMITIVE_MAP[node.name] = resolved
            elif isinstance(node, ClassDecl):
                process_tags(node)
                self.inheritance.register_class(node)
                self.class_decls[node.name] = node
                if node.parent == "Storeable":
                    raise SemanticError(
                        f"class '{node.name}' must not explicitly extend Storeable; "
                        f"all classes inherit Storeable implicitly",
                        node.location,
                    )
                if node.parent is None:
                    has_parentless_classes = True
                # check for duplicate field names
                seen_fields: set[str] = set()
                for fld in node.fields:
                    if fld.name in seen_fields:
                        raise SemanticError(
                            f"class '{node.name}': duplicate field '{fld.name}'",
                            fld.location,
                        )
                    seen_fields.add(fld.name)
            elif isinstance(node, TypeDecl):
                self.inheritance.register_type(node)
            elif isinstance(node, FunctionDecl):
                ret = self._resolve_type(node.return_type)
                param_types = [self._resolve_type(p.type_expr) for p in node.params]
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ret, kind="func",
                    params=param_types, return_type=ret,
                ))
                self.functions.append(node)

        # auto-import Storeable only when there are parentless classes that need it
        if has_parentless_classes and "Storeable" not in self.class_decls:
            self._ensure_storeable_imported()

        # auto-extend Storeable for classes without an explicit parent
        if "Storeable" in self.class_decls:
            for name, cls in self.class_decls.items():
                if cls.parent is None and name != "Storeable":
                    cls.parent = "Storeable"

        # build vtables
        self.vtables = self.inheritance.resolve_all(self._type_size)

        # register class types in scope
        for name, cls in self.class_decls.items():
            vt = self.vtables.get(name)
            field_tuples = self._collect_class_fields(name)
            method_names = tuple(m.name for m in cls.methods)
            ct = ClassType(
                name=name, parent=cls.parent,
                fields=field_tuples, methods=method_names,
                vtable_index=({e.method_name: e.slot_index for e in vt.entries} if vt else {}),
                total_size=vt.class_size if vt else 2,
            )
            self.class_types[name] = ct
            self.scopes.define(name, Symbol(name=name, type=ct, kind="class"))

        # second pass: check bodies
        for node in mod.body:
            if isinstance(node, FunctionDecl):
                self._check_function(node)
            elif isinstance(node, ClassDecl):
                self._check_class(node)
            elif isinstance(node, VarDecl):
                ty = self._resolve_type(node.type_expr)
                init_val = None
                if node.initializer:
                    init_val = self._check_expr(node.initializer)
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ty, kind="var", is_global=True,
                ))
                self.globals.append((node.name, ty, node.initializer))

        self.scopes.pop()

    def _collect_class_fields(self, class_name: str) -> tuple[tuple[str, VelaType], ...]:
        cls = self.class_decls.get(class_name)
        if cls is None:
            return ()
        fields: list[tuple[str, VelaType]] = []
        if cls.parent and cls.parent in self.class_decls:
            fields.extend(self._collect_class_fields(cls.parent))
        fields.extend((f.name, self._resolve_type(f.type_expr)) for f in cls.fields)
        return tuple(fields)

    def _process_imports(self, imports: list[ImportDecl]) -> None:
        """Resolve each import and check the imported module's declarations."""
        for imp in imports:
            if "*" in imp.modules:
                imported_mods = self._module_resolver.resolve_all(imp.package)
                for imported_mod in imported_mods:
                    if imported_mod.name not in {m.name for m in self.imported_modules}:
                        self.imported_modules.append(imported_mod)
                    self._check_module(imported_mod)
            else:
                for mod_name in imp.modules:
                    imported_mod = self._module_resolver.resolve(imp.package, mod_name)
                    if imported_mod.name not in {m.name for m in self.imported_modules}:
                        self.imported_modules.append(imported_mod)
                    self._check_module(imported_mod)


    def _check_function(self, fn: FunctionDecl) -> None:
        if fn.is_skeleton:
            return
        self._current_func = fn
        self.scopes.push(fn.name)
        for p in fn.params:
            pty = self._resolve_type(p.type_expr)
            self.scopes.define(p.name, Symbol(name=p.name, type=pty, kind="param"))
        for stmt in fn.body:
            self._check_stmt(stmt)
        self.scopes.pop()
        self._current_func = None

    def _check_class(self, cls: ClassDecl) -> None:
        self._current_class = cls.name
        ct = self.class_types.get(cls.name)
        self.scopes.push(cls.name)
        # 'this' pointer
        if ct:
            self.scopes.define("this", Symbol(name="this", type=PtrType_(inner=ct), kind="param"))
        # fields accessible via self
        for field_name, field_type in self._collect_class_fields(cls.name):
            self.scopes.define(field_name, Symbol(name=field_name, type=field_type, kind="var"))

        if cls.on_alloc:
            self._check_function(cls.on_alloc)
        if cls.on_free:
            self._check_function(cls.on_free)
        for m in cls.methods:
            self._check_function(m)

        self.scopes.pop()
        self._current_class = None

    def _check_stmt(self, stmt: Stmt) -> None:
        if isinstance(stmt, VarDecl):
            ty = self._resolve_type(stmt.type_expr)
            if stmt.initializer:
                init_ty = self._check_expr(stmt.initializer)
                # Bool class / BoolType variables: only accept Bool-like sources
                if is_bool_like(ty) and not is_bool_like(init_ty):
                    raise SemanticError(
                        f"cannot initialise Bool from {init_ty}; "
                        "use true, false, or a comparison",
                        getattr(stmt.initializer, "location", None),
                    )
                # Prevent leaking BoolType into non-Bool targets
                if isinstance(init_ty, BoolType) and not is_bool_like(ty):
                    raise SemanticError(
                        f"cannot assign Bool to {ty}",
                        getattr(stmt.initializer, "location", None),
                    )
            self.scopes.define(stmt.name, Symbol(name=stmt.name, type=ty, kind="var"))
        elif isinstance(stmt, Assignment):
            target_ty = self._check_expr(stmt.target)
            value_ty = self._check_expr(stmt.value)
            if is_bool_like(target_ty) and not is_bool_like(value_ty):
                raise SemanticError(
                    f"cannot assign {value_ty} to Bool; "
                    "use true, false, or a comparison",
                    getattr(stmt.value, "location", None),
                )
            if isinstance(value_ty, BoolType) and not is_bool_like(target_ty):
                raise SemanticError(
                    f"cannot assign Bool to {target_ty}",
                    getattr(stmt.value, "location", None),
                )
        elif isinstance(stmt, ReturnStmt):
            if stmt.value:
                self._check_expr(stmt.value)
        elif isinstance(stmt, IfStmt):
            cond_ty = self._check_expr(stmt.condition)
            if not is_bool_like(cond_ty):
                raise SemanticError(
                    f"if condition must be Bool, got {cond_ty}; "
                    "use a comparison (e.g. x != 0)",
                    getattr(stmt.condition, "location", None),
                )
            for s in stmt.then_body:
                self._check_stmt(s)
            for s in stmt.else_body:
                self._check_stmt(s)
        elif isinstance(stmt, ForStmt):
            self.scopes.push("for")
            if stmt.init:
                self._check_stmt(stmt.init)
            if stmt.condition:
                cond_ty = self._check_expr(stmt.condition)
                if not is_bool_like(cond_ty):
                    raise SemanticError(
                        f"for condition must be Bool, got {cond_ty}; "
                        "use a comparison (e.g. i < n)",
                        getattr(stmt.condition, "location", None),
                    )
            if stmt.update:
                self._check_stmt(stmt.update)
            for s in stmt.body:
                self._check_stmt(s)
            self.scopes.pop()
        elif isinstance(stmt, WhileStmt):
            cond_ty = self._check_expr(stmt.condition)
            if not is_bool_like(cond_ty):
                raise SemanticError(
                    f"while condition must be Bool, got {cond_ty}; "
                    "use a comparison (e.g. x != 0)",
                    getattr(stmt.condition, "location", None),
                )
            for s in stmt.body:
                self._check_stmt(s)
        elif isinstance(stmt, ExprStmt):
            if stmt.expr:
                self._check_expr(stmt.expr)
        elif isinstance(stmt, FreeStmt):
            if stmt.expr:
                self._check_expr(stmt.expr)
        elif isinstance(stmt, PrintStmt):
            if stmt.value:
                self._check_expr(stmt.value)
        elif isinstance(stmt, AsmBlock):
            pass  # inline asm - trust the programmer :)

    def _check_expr(self, expr: Expr) -> VelaType:
        if isinstance(expr, IntLiteral):
            if -128 <= expr.value <= 127:
                expr.inferred_type = I16
            else:
                expr.inferred_type = I16
            return expr.inferred_type
        if isinstance(expr, FloatLiteral):
            expr.inferred_type = F16
            return F16
        if isinstance(expr, StringLiteral):
            if expr.value not in self.string_labels:
                self.string_labels[expr.value] = f"__str_{len(self.string_labels) + 1}"
                self.string_literals.append(expr.value)
            expr.inferred_type = PtrType_(inner=U8)
            return expr.inferred_type
        if isinstance(expr, CharLiteral):
            expr.inferred_type = U8
            return U8
        if isinstance(expr, BoolLiteral):
            expr.inferred_type = BOOL
            return BOOL
        if isinstance(expr, NullLiteral):
            expr.inferred_type = NULL_PTR
            return NULL_PTR
        if isinstance(expr, IdentifierExpr):
            sym = self.scopes.lookup(expr.name)
            if sym is None:
                raise SemanticError(f"undefined identifier '{expr.name}'", expr.location)
            expr.inferred_type = sym.type
            return sym.type
        if isinstance(expr, BinaryExpr):
            lt = self._check_expr(expr.left)
            rt = self._check_expr(expr.right)
            if expr.op in ("==", "!=", "<", ">", "<=", ">="):
                expr.inferred_type = BOOL
            elif expr.op in ("&&", "||"):
                if not is_bool_like(lt):
                    raise SemanticError(
                        f"left operand of '{expr.op}' must be Bool, got {lt}",
                        getattr(expr.left, "location", None),
                    )
                if not is_bool_like(rt):
                    raise SemanticError(
                        f"right operand of '{expr.op}' must be Bool, got {rt}",
                        getattr(expr.right, "location", None),
                    )
                expr.inferred_type = BOOL
            elif isinstance(lt, FloatType) or isinstance(rt, FloatType):
                expr.inferred_type = F16
            elif isinstance(lt, PtrType_):
                expr.inferred_type = lt
            else:
                expr.inferred_type = lt if lt.size() >= rt.size() else rt
            return expr.inferred_type
        if isinstance(expr, UnaryExpr):
            ot = self._check_expr(expr.operand)
            if expr.op == "!":
                if not is_bool_like(ot):
                    raise SemanticError(
                        f"operand of '!' must be Bool, got {ot}",
                        getattr(expr.operand, "location", None),
                    )
                expr.inferred_type = BOOL
            elif expr.op in ("post++", "post--"):
                expr.inferred_type = ot
            else:
                expr.inferred_type = ot
            return expr.inferred_type
        if isinstance(expr, CallExpr):
            if isinstance(expr.callee, IdentifierExpr):
                sym = self.scopes.lookup(expr.callee.name)
                if sym and sym.return_type:
                    expr.inferred_type = sym.return_type
                    return sym.return_type
            for a in expr.args:
                self._check_expr(a)
            expr.inferred_type = I16
            return I16
        if isinstance(expr, MethodCallExpr):
            obj_type = self._check_expr(expr.obj)
            for a in expr.args:
                self._check_expr(a)
            # reject method calls on bare primitive types
            actual = obj_type
            if isinstance(actual, PtrType_):
                actual = actual.inner
            if actual in _PRIMITIVE_TO_BOXED:
                boxed = _PRIMITIVE_TO_BOXED[actual]
                raise SemanticError(
                    f"primitive type '{actual}' has no methods; "
                    f"use the boxed type '{boxed}' instead",
                    getattr(expr, 'location', None),
                )
            # resolve return type from class methods if possible
            cls_type = None
            if isinstance(obj_type, PtrType_) and isinstance(obj_type.inner, ClassType):
                cls_type = obj_type.inner
            elif isinstance(obj_type, ClassType):
                cls_type = obj_type
            if cls_type:
                # look up method return type from class declaration
                cls_decl = self.class_decls.get(cls_type.name)
                if cls_decl:
                    for m in cls_decl.methods:
                        if m.name == expr.method:
                            ret = self._resolve_type(m.return_type)
                            expr.inferred_type = ret
                            return ret
            expr.inferred_type = I16
            return I16
        if isinstance(expr, FieldAccessExpr):
            ot = self._check_expr(expr.obj)
            # reject field access on bare primitive types
            actual = ot
            if isinstance(actual, PtrType_):
                actual = actual.inner
            if actual in _PRIMITIVE_TO_BOXED:
                boxed = _PRIMITIVE_TO_BOXED[actual]
                raise SemanticError(
                    f"primitive type '{actual}' has no fields; "
                    f"use the boxed type '{boxed}' instead",
                    getattr(expr, 'location', None),
                )
            expr.inferred_type = I16
            if isinstance(ot, PtrType_) and isinstance(ot.inner, ClassType):
                for fn, ft in ot.inner.fields:
                    if fn == expr.field_name:
                        expr.inferred_type = ft
                        return ft
            return expr.inferred_type
        if isinstance(expr, IndexExpr):
            self._check_expr(expr.obj)
            self._check_expr(expr.index)
            ot = expr.obj.inferred_type
            if isinstance(ot, PtrType_):
                expr.inferred_type = ot.inner
            else:
                expr.inferred_type = U8
            return expr.inferred_type
        if isinstance(expr, DerefExpr):
            ot = self._check_expr(expr.operand)
            if isinstance(ot, PtrType_):
                expr.inferred_type = ot.inner
            else:
                expr.inferred_type = U8
            return expr.inferred_type
        if isinstance(expr, AddressOfExpr):
            ot = self._check_expr(expr.operand)
            if isinstance(expr.operand, IdentifierExpr):
                sym = self.scopes.lookup(expr.operand.name)
                is_current_field = (
                    self._current_class is not None
                    and any(name == expr.operand.name
                            for name, _ in self._collect_class_fields(self._current_class))
                )
                if sym and not sym.is_global and not is_current_field:
                    raise SemanticError(
                        f"cannot take address of local or parameter '{expr.operand.name}'; "
                        "only globals, fields, dereferences and indexed pointers are addressable",
                        expr.location,
                    )
            elif not isinstance(expr.operand, (DerefExpr, FieldAccessExpr, IndexExpr)):
                raise SemanticError(
                    "address-of requires an addressable expression",
                    expr.location,
                )
            expr.inferred_type = PtrType_(inner=ot)
            return expr.inferred_type
        if isinstance(expr, InitExpr):
            ct = self.class_types.get(expr.class_name)
            if ct:
                expr.inferred_type = PtrType_(inner=ct)
            else:
                expr.inferred_type = PtrType_(inner=VoidType())
            return expr.inferred_type
        if isinstance(expr, MallocExpr):
            self._check_expr(expr.size)
            expr.inferred_type = PtrType_(inner=VoidType())
            return expr.inferred_type
        if isinstance(expr, SizeOfExpr):
            expr.inferred_type = U16
            return U16
        if isinstance(expr, CastExpr):
            if expr.operand:
                self._check_expr(expr.operand)
            expr.inferred_type = self._resolve_type(expr.target_type)
            return expr.inferred_type
        if isinstance(expr, MultiDispatchExpr):
            for t in expr.targets:
                self._check_expr(t)
            expr.inferred_type = U0
            return U0
        # fallback
        expr.inferred_type = I16
        return I16

    def _resolve_type(self, texpr: TypeExpr | None) -> VelaType:
        if texpr is None:
            return U0
        if isinstance(texpr, NamedType):
            if texpr.name in self.aliases:
                return self.aliases[texpr.name]
            if texpr.name in PRIMITIVE_MAP:
                return PRIMITIVE_MAP[texpr.name]
            if texpr.name in self.class_types:
                return PtrType_(inner=self.class_types[texpr.name])
            if texpr.name in self.class_decls:
                vt = self.vtables.get(texpr.name)
                return PtrType_(inner=ClassType(
                    name=texpr.name,
                    parent=self.class_decls[texpr.name].parent,
                    total_size=vt.class_size if vt else 2,
                ))
            # forward reference - return placeholder
            return I16
        if isinstance(texpr, PtrType):
            inner = self._resolve_type(texpr.inner)
            if isinstance(inner, PtrType_) and isinstance(inner.inner, ClassType):
                inner = inner.inner
            return PtrType_(inner=inner)
        return I16

    def _type_size(self, texpr) -> int:
        ty = self._resolve_type(texpr)
        return max(ty.size(), 1)
