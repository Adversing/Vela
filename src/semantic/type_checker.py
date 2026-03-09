from __future__ import annotations

from src.errors import SemanticError, VelaError, SourceLocation
from src.parser.ast_nodes import *
from src.semantic.types import (
    VelaType, VoidType, IntType, FloatType, PtrType_, BoolType,
    ClassType, TypeDeclType, U0, U8, I8, U16, I16, F16, BOOL, NULL_PTR,
    PRIMITIVE_MAP, types_compatible,
)
from src.semantic.scope import ScopeStack, Symbol
from src.semantic.inheritance import InheritanceResolver, VtableInfo
from src.semantic.tag_processor import process_tags


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
            field_tuples = tuple((f.name, self._resolve_type(f.type_expr)) for f in cls.fields)
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
        for f in cls.fields:
            ty = self._resolve_type(f.type_expr)
            self.scopes.define(f.name, Symbol(name=f.name, type=ty, kind="var"))

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
                self._check_expr(stmt.initializer)
            self.scopes.define(stmt.name, Symbol(name=stmt.name, type=ty, kind="var"))
        elif isinstance(stmt, Assignment):
            self._check_expr(stmt.target)
            self._check_expr(stmt.value)
        elif isinstance(stmt, ReturnStmt):
            if stmt.value:
                self._check_expr(stmt.value)
        elif isinstance(stmt, IfStmt):
            self._check_expr(stmt.condition)
            for s in stmt.then_body:
                self._check_stmt(s)
            for s in stmt.else_body:
                self._check_stmt(s)
        elif isinstance(stmt, ForStmt):
            self.scopes.push("for")
            if stmt.init:
                self._check_stmt(stmt.init)
            if stmt.condition:
                self._check_expr(stmt.condition)
            if stmt.update:
                self._check_stmt(stmt.update)
            for s in stmt.body:
                self._check_stmt(s)
            self.scopes.pop()
        elif isinstance(stmt, WhileStmt):
            self._check_expr(stmt.condition)
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
            self._check_expr(expr.obj)
            for a in expr.args:
                self._check_expr(a)
            expr.inferred_type = I16
            return I16
        if isinstance(expr, FieldAccessExpr):
            ot = self._check_expr(expr.obj)
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
                return self.class_types[texpr.name]
            # forward reference - return placeholder
            return I16
        if isinstance(texpr, PtrType):
            inner = self._resolve_type(texpr.inner)
            return PtrType_(inner=inner)
        return I16

    def _type_size(self, texpr) -> int:
        ty = self._resolve_type(texpr)
        return max(ty.size(), 1)
