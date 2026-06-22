from __future__ import annotations

from src.errors import SemanticError, VelaError, SourceLocation, SourceSpan, did_you_mean
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
        self.type_decls: dict[str, TypeDecl] = {}
        self.string_literals: list[str] = []
        self.string_labels: dict[str, str] = {}
        self._current_func: FunctionDecl | None = None
        self._current_class: str | None = None
        self._module_resolver = module_resolver
        self._checked_modules: set[tuple[str, str]] = set()
        self.imported_modules: list[ModuleDecl] = []
        self._included_top_level_names: dict[str, tuple[tuple[str, str], str]] = {}
        self._assembly_labels: dict[str, tuple[tuple[str, str], str]] = {}

    def check(self, program: Program) -> None:
        seen_modules: dict[tuple[str, str], ModuleDecl] = {}
        for mod in program.modules:
            module_key = self._module_key(mod)
            if module_key in seen_modules:
                raise SemanticError(
                    f"duplicate module '{mod.name}' in the same source file",
                    mod.location,
                    hint="rename one module; modules in the same file must have distinct names",
                )
            seen_modules[module_key] = mod
        for mod in program.modules:
            self._check_module(mod)

    def _ensure_storeable_imported(self) -> None:
        """Auto-import stdlib/core/storeable.vl so every class can inherit Storeable."""
        if not self._module_resolver:
            return
        try:
            storeable_mod = self._module_resolver.resolve(
                ["stdlib", "core"], "storeable"
            )
        except VelaError as exc:
            if "cannot resolve import stdlib::core::storeable" in exc.message:
                return
            raise
        if not self._has_imported_module(storeable_mod):
            self.imported_modules.append(storeable_mod)
        self._check_module(storeable_mod)

    def _check_module(self, mod: ModuleDecl) -> None:
        # avoid processing the same module twice (imported from multiple places)
        module_key = self._module_key(mod)
        if module_key in self._checked_modules:
            return

        # The backend emits one flat assembly namespace.  Reserve source names
        # and generated labels before imports so imported code cannot silently
        # overwrite local declarations or IR entries.
        self._check_duplicate_top_level_declarations(mod)
        self._register_top_level_names(mod)
        self._register_assembly_labels(mod)
        self._checked_modules.add(module_key)

        self.scopes.push(mod.name)

        # resolve imports first - inject imported declarations into scope
        if self._module_resolver and mod.imports:
            self._process_imports(mod.imports)

        # Class and type names have a separate namespace from values.  Define
        # local placeholders before checking signatures so references to types
        # declared later in the module are visible without leaking unrelated
        # modules' type declarations.
        self._define_local_type_placeholders(mod)

        # first pass: register type and class names before resolving any
        # signatures.  Otherwise a function or field that mentions a class
        # declared later in the same module silently degrades to I16.
        has_parentless_classes = False
        for node in mod.body:
            if isinstance(node, ClassDecl):
                process_tags(node)
                self._register_assembly_labels(mod)
                self.inheritance.register_class(node)
                self.class_decls[node.name] = node
                if node.parent == "Storeable":
                    raise SemanticError(
                        f"class '{node.name}' must not explicitly extend Storeable; "
                        f"all classes inherit Storeable implicitly",
                        node.location,
                    )
                if (
                    node.parent is not None
                    and self._lookup_visible_symbol(node.parent, {"class", "type"}) is None
                ):
                    raise SemanticError(
                        f"class '{node.name}' extends unknown class or type '{node.parent}'",
                        node.location,
                    )
                if node.parent is None:
                    has_parentless_classes = True
                # check for duplicate field names
                seen_fields: set[str] = set()
                for fld in node.fields:
                    self._check_value_storage_type(
                        self._resolve_type(fld.type_expr),
                        f"field '{fld.name}'",
                        fld.location,
                    )
                    if fld.name in seen_fields:
                        raise SemanticError(
                            f"class '{node.name}': duplicate field '{fld.name}'",
                            fld.location,
                        )
                    seen_fields.add(fld.name)
                seen_methods: set[str] = set()
                for method in node.methods:
                    if method.name in seen_methods:
                        raise SemanticError(
                            f"class '{node.name}': duplicate method '{method.name}'",
                            method.location,
                        )
                    seen_methods.add(method.name)
            elif isinstance(node, TypeDecl):
                seen_methods: set[str] = set()
                for method in node.methods:
                    if method.name in seen_methods:
                        raise SemanticError(
                            f"type '{node.name}': duplicate method '{method.name}'",
                            method.location,
                        )
                    seen_methods.add(method.name)
                    self._check_signature_value_types(method)
                self.inheritance.register_type(node)
                self.type_decls[node.name] = node

        # auto-import Storeable only when there are parentless classes that need it
        if has_parentless_classes and "Storeable" not in self.class_decls:
            self._ensure_storeable_imported()

        # auto-extend Storeable for classes without an explicit parent
        if "Storeable" in self.class_decls:
            for cls in self._module_classes(mod):
                if cls.parent is None and cls.name != "Storeable":
                    cls.parent = "Storeable"

        # build vtables
        self.vtables = self.inheritance.resolve_all(self._type_size)
        self._check_inherited_field_conflicts(self._module_classes(mod))

        # register class types in scope
        for cls in self._module_classes(mod):
            vt = self.vtables.get(cls.name)
            field_tuples = self._collect_class_fields(cls.name)
            method_names = tuple(m.name for m in cls.methods)
            ct = ClassType(
                name=cls.name, parent=cls.parent,
                fields=field_tuples, methods=method_names,
                vtable_index=({e.method_name: e.slot_index for e in vt.entries} if vt else {}),
                total_size=vt.class_size if vt else 2,
            )
            self.class_types[cls.name] = ct
            self.scopes.define(cls.name, Symbol(name=cls.name, type=ct, kind="class"))

        # Register local type declarations in the type namespace.
        for node in mod.body:
            if isinstance(node, TypeDecl):
                ty = TypeDeclType(
                    name=node.name,
                    methods=tuple(m.name for m in node.methods),
                )
                self.scopes.define(node.name, Symbol(name=node.name, type=ty, kind="type"))

        # aliases can now resolve primitive names, class names, and imported
        # names consistently.
        for node in mod.body:
            if isinstance(node, AliasDecl):
                resolved = self._resolve_type(node.target_type)
                self.aliases[node.name] = resolved
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=resolved, kind="alias",
                ))

        # Register global variable names before checking function bodies so
        # functions can refer to globals declared later in the module.
        for node in mod.body:
            if isinstance(node, VarDecl):
                ty = self._resolve_type(node.type_expr)
                self._check_value_storage_type(ty, f"global variable '{node.name}'", node.location)
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ty, kind="var", is_global=True,
                ))

        # register function signatures after all named types are known
        for node in mod.body:
            if isinstance(node, FunctionDecl):
                ret = self._resolve_type(node.return_type)
                param_types = [self._resolve_type(p.type_expr) for p in node.params]
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ret, kind="func",
                    params=param_types, return_type=ret,
                ))
                self.functions.append(node)

        # second pass: check bodies
        for node in mod.body:
            if isinstance(node, FunctionDecl):
                self._check_function(node)
            elif isinstance(node, ClassDecl):
                self._check_class(node)
            elif isinstance(node, VarDecl):
                ty = self._resolve_type(node.type_expr)
                self._check_value_storage_type(ty, f"global variable '{node.name}'", node.location)
                init_val = None
                if node.initializer:
                    init_val = self._check_expr(node.initializer)
                    self._check_initializer_compatible(ty, init_val, node.initializer)
                    self._check_global_initializer_static(node.name, ty, node.initializer)
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ty, kind="var", is_global=True,
                ))
                self.globals.append((node.name, ty, node.initializer))

        self.scopes.pop()

    def _check_duplicate_top_level_declarations(self, mod: ModuleDecl) -> None:
        seen: dict[str, str] = {}
        for node in mod.body:
            if not isinstance(node, (AliasDecl, ClassDecl, TypeDecl, FunctionDecl, VarDecl)):
                continue
            name = node.name
            if name.startswith("__"):
                raise SemanticError(
                    f"top-level declaration '{name}' uses reserved internal prefix '__'",
                    getattr(node, "location", None),
                    hint="rename the declaration; labels beginning with '__' are reserved for generated CPU code",
                )
            if (
                isinstance(node, ClassDecl)
                and name == "Storeable"
                and not self._is_builtin_storeable_module(mod)
            ):
                raise SemanticError(
                    "class 'Storeable' conflicts with the implicit Storeable base class",
                    getattr(node, "location", None),
                    hint="rename the class; Storeable is provided by stdlib/core/storeable.vl",
                )
            if name in seen:
                raise SemanticError(
                    f"duplicate top-level declaration '{name}'",
                    getattr(node, "location", None),
                    hint=f"'{name}' was already declared as a {seen[name]} in this module",
                )
            seen[name] = self._decl_kind(node)

    def _register_top_level_names(self, mod: ModuleDecl) -> None:
        module_key = self._module_key(mod)
        for node in mod.body:
            if not isinstance(node, (AliasDecl, ClassDecl, TypeDecl, FunctionDecl, VarDecl)):
                continue
            desc = f"{self._decl_kind(node)} '{node.name}'"
            previous = self._included_top_level_names.get(node.name)
            if previous is not None:
                prev_key, prev_desc = previous
                if prev_key == module_key and prev_desc == desc:
                    continue
                raise SemanticError(
                    f"top-level declaration '{node.name}' conflicts with included {prev_desc}",
                    getattr(node, "location", None),
                    hint="Vela currently emits a flat program namespace; rename one declaration or compile it separately",
                )
            self._included_top_level_names[node.name] = (module_key, desc)

    def _register_assembly_labels(self, mod: ModuleDecl) -> None:
        module_key = self._module_key(mod)
        for label, node, desc in self._assembly_label_declarations(mod):
            if label == "main" and not (
                isinstance(node, FunctionDecl) and node.name == "main"
            ):
                raise SemanticError(
                    f"assembly label 'main' for {desc} conflicts with the program entry label",
                    getattr(node, "location", None),
                    hint="rename the declaration; the backend always emits a top-level 'main:' entry label",
                )
            if label == "space":
                raise SemanticError(
                    f"assembly label 'space' for {desc} conflicts with the data section label",
                    getattr(node, "location", None),
                    hint="rename the declaration; the backend always emits a top-level 'space:' data label",
                )
            previous = self._assembly_labels.get(label)
            if previous is not None:
                prev_key, prev_desc = previous
                if prev_key == module_key and prev_desc == desc:
                    continue
                raise SemanticError(
                    f"assembly label '{label}' for {desc} conflicts with {prev_desc}",
                    getattr(node, "location", None),
                    hint="Vela currently emits flat CPU labels; rename one declaration to avoid the collision",
                )
            self._assembly_labels[label] = (module_key, desc)

    def _assembly_label_declarations(
        self,
        mod: ModuleDecl,
    ) -> list[tuple[str, ASTNode, str]]:
        labels: list[tuple[str, ASTNode, str]] = []
        for node in mod.body:
            if isinstance(node, FunctionDecl) and not node.is_skeleton:
                labels.append((node.name, node, f"function '{node.name}'"))
            elif isinstance(node, VarDecl):
                labels.append((node.name, node, f"global variable '{node.name}'"))
            elif isinstance(node, ClassDecl):
                labels.append((
                    f"__vtable_{node.name}",
                    node,
                    f"vtable for class '{node.name}'",
                ))
                if node.on_alloc is not None and not node.on_alloc.is_skeleton:
                    labels.append((
                        f"{node.name}_OnAlloc",
                        node.on_alloc,
                        f"OnAlloc for class '{node.name}'",
                    ))
                labels.append((
                    f"{node.name}_OnFree",
                    node.on_free or node,
                    f"OnFree slot for class '{node.name}'",
                ))
                for method in node.methods:
                    if method.is_skeleton:
                        continue
                    labels.append((
                        f"{node.name}_{method.name}",
                        method,
                        f"method '{node.name}.{method.name}'",
                    ))
        return labels

    def _decl_kind(self, node: ASTNode) -> str:
        if isinstance(node, AliasDecl):
            return "alias"
        if isinstance(node, ClassDecl):
            return "class"
        if isinstance(node, TypeDecl):
            return "type"
        if isinstance(node, FunctionDecl):
            return "function"
        if isinstance(node, VarDecl):
            return "variable"
        return "declaration"

    def _module_key(self, mod: ModuleDecl) -> tuple[str, str]:
        filename = mod.location.file if mod.location is not None else ""
        return (filename, mod.name)

    def _is_builtin_storeable_module(self, mod: ModuleDecl) -> bool:
        filename = mod.location.file if mod.location is not None else ""
        normalized = filename.replace("\\", "/")
        return mod.name == "storeable" and normalized.endswith("stdlib/core/storeable.vl")

    def _has_imported_module(self, mod: ModuleDecl) -> bool:
        key = self._module_key(mod)
        return any(self._module_key(existing) == key for existing in self.imported_modules)

    def _module_classes(self, mod: ModuleDecl) -> list[ClassDecl]:
        return [node for node in mod.body if isinstance(node, ClassDecl)]

    def _define_local_type_placeholders(self, mod: ModuleDecl) -> None:
        for node in mod.body:
            if isinstance(node, ClassDecl):
                self.scopes.define(node.name, Symbol(
                    name=node.name,
                    type=ClassType(name=node.name, parent=node.parent),
                    kind="class",
                ))
            elif isinstance(node, TypeDecl):
                self.scopes.define(node.name, Symbol(
                    name=node.name,
                    type=TypeDeclType(
                        name=node.name,
                        methods=tuple(m.name for m in node.methods),
                    ),
                    kind="type",
                ))

    def _lookup_visible_symbol(self, name: str, kinds: set[str]) -> Symbol | None:
        scope = self.scopes.current
        while scope is not None:
            sym = scope.lookup_local(name)
            if sym is not None and sym.kind in kinds:
                return sym
            scope = scope.parent
        return None

    def _collect_class_fields(self, class_name: str) -> tuple[tuple[str, VelaType], ...]:
        cls = self.class_decls.get(class_name)
        if cls is None:
            return ()
        fields: list[tuple[str, VelaType]] = []
        if cls.parent and cls.parent in self.class_decls:
            parent_type = self.class_types.get(cls.parent)
            if parent_type is not None:
                fields.extend(parent_type.fields)
            else:
                fields.extend(self._collect_class_fields(cls.parent))
        fields.extend((f.name, self._resolve_type(f.type_expr)) for f in cls.fields)
        return tuple(fields)

    def _check_inherited_field_conflicts(self, classes: list[ClassDecl]) -> None:
        for cls in classes:
            if not cls.parent or cls.parent not in self.class_decls:
                continue
            inherited = {name for name, _ in self._collect_class_fields(cls.parent)}
            for field in cls.fields:
                if field.name in inherited:
                    raise SemanticError(
                        f"class '{cls.name}': field '{field.name}' duplicates inherited field",
                        field.location,
                        hint="use a distinct field name; inherited fields are already present",
                    )

    def _process_imports(self, imports: list[ImportDecl]) -> None:
        """Resolve each import and check the imported module's declarations."""
        for imp in imports:
            if "*" in imp.modules:
                imported_mods = self._module_resolver.resolve_all(imp.package)
                for imported_mod in imported_mods:
                    if not self._has_imported_module(imported_mod):
                        self.imported_modules.append(imported_mod)
                    self._check_module(imported_mod)
                    self._inject_imported_symbols(imported_mod)
            else:
                for mod_name in imp.modules:
                    imported_mod = self._module_resolver.resolve(imp.package, mod_name)
                    if not self._has_imported_module(imported_mod):
                        self.imported_modules.append(imported_mod)
                    self._check_module(imported_mod)
                    self._inject_imported_symbols(imported_mod)

    def _inject_imported_symbols(self, mod: ModuleDecl) -> None:
        """Expose imported top-level declarations in the current module scope."""
        for node in mod.body:
            if isinstance(node, ClassDecl):
                ct = self.class_types.get(node.name)
                if ct is not None:
                    self.scopes.define(node.name, Symbol(
                        name=node.name, type=ct, kind="class",
                    ))
            elif isinstance(node, TypeDecl):
                self.scopes.define(node.name, Symbol(
                    name=node.name,
                    type=TypeDeclType(
                        name=node.name,
                        methods=tuple(m.name for m in node.methods),
                    ),
                    kind="type",
                ))

        for node in mod.body:
            if isinstance(node, AliasDecl):
                resolved = self._resolve_type(node.target_type)
                self.aliases[node.name] = resolved
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=resolved, kind="alias",
                ))

        for node in mod.body:
            if isinstance(node, FunctionDecl) and not node.is_skeleton:
                ret = self._resolve_type(node.return_type)
                param_types = [self._resolve_type(p.type_expr) for p in node.params]
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ret, kind="func",
                    params=param_types, return_type=ret,
                ))
            elif isinstance(node, VarDecl):
                ty = self._resolve_type(node.type_expr)
                self.scopes.define(node.name, Symbol(
                    name=node.name, type=ty, kind="var", is_global=True,
                ))

    def _check_signature_value_types(self, fn: FunctionDecl) -> None:
        for param in fn.params:
            self._check_value_storage_type(
                self._resolve_type(param.type_expr),
                f"parameter '{param.name}'",
                param.location,
            )

    def _check_value_storage_type(
        self,
        ty: VelaType,
        subject: str,
        location: SourceLocation | None,
    ) -> None:
        if not isinstance(ty, VoidType):
            return
        raise SemanticError(
            f"{subject} cannot have type U0",
            location,
            hint="use U0 only as a function return type or inside Ptr<U0>",
        )

    def _check_function(self, fn: FunctionDecl) -> None:
        if fn.is_skeleton:
            return
        self._current_func = fn
        self.scopes.push(fn.name)
        seen_params: set[str] = set()
        for p in fn.params:
            if p.name in seen_params:
                raise SemanticError(
                    f"function '{fn.name}': duplicate parameter '{p.name}'",
                    p.location,
                )
            seen_params.add(p.name)
            pty = self._resolve_type(p.type_expr)
            self._check_value_storage_type(pty, f"parameter '{p.name}'", p.location)
            self.scopes.define(p.name, Symbol(name=p.name, type=pty, kind="param"))
        for stmt in fn.body:
            self._check_stmt(stmt)
        expected = self._resolve_type(fn.return_type)
        if not isinstance(expected, VoidType) and not self._block_always_returns(fn.body):
            raise SemanticError(
                f"function '{fn.name}' must return {expected} on all paths",
                fn.location,
                hint="add a return statement or change the function return type to U0",
            )
        self.scopes.pop()
        self._current_func = None

    def _block_always_returns(self, stmts: list[Stmt]) -> bool:
        return any(self._stmt_always_returns(stmt) for stmt in stmts)

    def _stmt_always_returns(self, stmt: Stmt) -> bool:
        if isinstance(stmt, ReturnStmt):
            return True
        if isinstance(stmt, IfStmt):
            return (
                bool(stmt.then_body)
                and bool(stmt.else_body)
                and self._block_always_returns(stmt.then_body)
                and self._block_always_returns(stmt.else_body)
            )
        if isinstance(stmt, WhileStmt):
            return (
                isinstance(stmt.condition, BoolLiteral)
                and stmt.condition.value is True
                and self._block_always_returns(stmt.body)
            )
        if isinstance(stmt, ForStmt):
            condition_always_true = (
                stmt.condition is None
                or (
                    isinstance(stmt.condition, BoolLiteral)
                    and stmt.condition.value is True
                )
            )
            return condition_always_true and self._block_always_returns(stmt.body)
        return False

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

        self._check_class_method_overrides(cls)
        self._check_skeleton_signatures(cls)

        if cls.on_alloc:
            self._check_function(cls.on_alloc)
        if cls.on_free:
            self._check_function(cls.on_free)
        for m in cls.methods:
            self._check_function(m)

        self.scopes.pop()
        self._current_class = None

    def _check_class_method_overrides(self, cls: ClassDecl) -> None:
        if not cls.parent or cls.parent not in self.class_decls:
            return
        for method in cls.methods:
            parent_method = self._find_method_decl(cls.parent, method.name)
            if parent_method is None:
                continue
            expected_ret = self._resolve_type(parent_method.return_type)
            actual_ret = self._resolve_type(method.return_type)
            expected_params = [self._resolve_type(p.type_expr) for p in parent_method.params]
            actual_params = [self._resolve_type(p.type_expr) for p in method.params]
            if actual_ret == expected_ret and actual_params == expected_params:
                continue
            raise SemanticError(
                f"class '{cls.name}' method '{method.name}' must match inherited "
                f"signature {expected_ret}({', '.join(str(p) for p in expected_params)})",
                method.location,
                hint="overridden methods must keep the same return type and parameter types",
            )

    def _check_skeleton_signatures(self, cls: ClassDecl) -> None:
        if not cls.parent or cls.parent not in self.type_decls:
            return
        parent_type = self.type_decls[cls.parent]
        methods = {method.name: method for method in cls.methods}
        for skeleton in parent_type.methods:
            if not skeleton.is_skeleton:
                continue
            impl = methods.get(skeleton.name)
            if impl is None:
                continue
            expected_ret = self._resolve_type(skeleton.return_type)
            actual_ret = self._resolve_type(impl.return_type)
            expected_params = [self._resolve_type(p.type_expr) for p in skeleton.params]
            actual_params = [self._resolve_type(p.type_expr) for p in impl.params]
            if actual_ret == expected_ret and actual_params == expected_params:
                continue
            raise SemanticError(
                f"class '{cls.name}' method '{impl.name}' must match skeleton "
                f"signature {expected_ret}({', '.join(str(p) for p in expected_params)}) "
                f"from type '{parent_type.name}'",
                impl.location,
                hint="use the same return type and parameter types as the skeleton method",
            )

    def _check_stmt(self, stmt: Stmt) -> None:
        if isinstance(stmt, VarDecl):
            ty = self._resolve_type(stmt.type_expr)
            self._check_value_storage_type(ty, f"local variable '{stmt.name}'", stmt.location)
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
                self._check_initializer_compatible(ty, init_ty, stmt.initializer)
            existing = self.scopes.current.lookup_local(stmt.name)
            if existing is not None:
                raise SemanticError(
                    f"duplicate local declaration '{stmt.name}'",
                    stmt.location,
                    hint=f"'{stmt.name}' is already declared in this scope",
                )
            self.scopes.define(stmt.name, Symbol(name=stmt.name, type=ty, kind="var"))
        elif isinstance(stmt, Assignment):
            if not self._is_lvalue_expr(stmt.target):
                raise SemanticError(
                    f"assignment '{stmt.op}' requires an assignable target",
                    getattr(stmt.target, "location", None),
                    span=self._expr_span(stmt.target),
                    hint="assign to a variable, field, pointer dereference, or indexed pointer element",
                )
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
            if not self._argument_compatible(target_ty, value_ty, stmt.value):
                raise SemanticError(
                    f"cannot assign {value_ty} to {target_ty}",
                    getattr(stmt.value, "location", None),
                    span=self._expr_span(stmt.value),
                    hint="use Cast<T>(expr) only when the conversion is intentional",
                )
        elif isinstance(stmt, ReturnStmt):
            expected = self._resolve_type(self._current_func.return_type) if self._current_func else U0
            if stmt.value:
                actual = self._check_expr(stmt.value)
                if isinstance(expected, VoidType):
                    raise SemanticError(
                        f"function '{self._current_func.name if self._current_func else '<unknown>'}' "
                        "returns U0 and must not return a value",
                        getattr(stmt.value, "location", None),
                        span=self._expr_span(stmt.value),
                        hint="use 'ret;' or change the function return type",
                    )
                if not self._argument_compatible(expected, actual, stmt.value):
                    raise SemanticError(
                        f"function '{self._current_func.name if self._current_func else '<unknown>'}' "
                        f"returns {expected}, got {actual}",
                        getattr(stmt.value, "location", None),
                        span=self._expr_span(stmt.value),
                        hint="return a value compatible with the function declaration",
                    )
            elif not isinstance(expected, VoidType):
                raise SemanticError(
                    f"function '{self._current_func.name if self._current_func else '<unknown>'}' "
                    f"must return {expected}",
                    getattr(stmt, "location", None),
                    span=self._location_span(getattr(stmt, "location", None), len("ret")),
                    hint="return a value or change the function return type to U0",
                )
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
                expr_ty = self._check_expr(stmt.expr)
                if not isinstance(expr_ty, PtrType_):
                    raise SemanticError(
                        f"Free expects a pointer, got {expr_ty}",
                        getattr(stmt.expr, "location", None),
                        span=self._expr_span(stmt.expr),
                        hint="only values returned by Malloc, Init<T>, null, or pointer expressions can be freed",
                    )
        elif isinstance(stmt, PrintStmt):
            if stmt.fmt is not None:
                raise SemanticError(
                    "Print expects 1 argument, got 2",
                    getattr(stmt.fmt, "location", None),
                    span=self._expr_span(stmt.fmt),
                    hint="Print currently supports only Print(value)",
                )
            if stmt.value:
                self._check_expr(stmt.value)
        elif isinstance(stmt, AsmBlock):
            self._check_asm_block(stmt)

    def _check_asm_block(self, stmt: AsmBlock) -> None:
        for binding in [*stmt.inputs, *stmt.outputs]:
            if not self._valid_asm_register(binding.register):
                raise SemanticError(
                    f"ASM binding register must be R0..R9, got '{binding.register}'",
                    binding.location,
                    hint="use a concrete general-purpose register such as R0 or R1",
                )
            sym = self.scopes.lookup(binding.variable)
            if sym is None or sym.kind not in {"var", "param"}:
                raise self._undefined_name_error(
                    "ASM binding variable",
                    binding.variable,
                    binding.location,
                    self._location_span(binding.location, len(binding.variable)),
                    self.scopes.visible_names(kinds={"var", "param"}),
                )

    def _valid_asm_register(self, register: str) -> bool:
        if not register.startswith("R") or not register[1:].isdigit():
            return False
        return 0 <= int(register[1:]) <= 9

    def _check_expr(self, expr: Expr) -> VelaType:
        if isinstance(expr, IntLiteral):
            if expr.value < 0 or expr.value > 0xFFFF:
                raise SemanticError(
                    f"integer literal {expr.value} is outside the 16-bit range",
                    expr.location,
                    span=self._expr_span(expr),
                    hint="use a value between 0 and 65535",
                )
            expr.inferred_type = I16 if expr.value <= 0x7FFF else U16
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
            if ord(expr.value) > 0xFF:
                raise SemanticError(
                    f"char literal U+{ord(expr.value):04X} is outside the U8 range",
                    expr.location,
                    span=self._expr_span(expr),
                    hint="Char is U8; use a character with codepoint 0..255",
                )
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
                raise self._undefined_name_error(
                    "identifier",
                    expr.name,
                    expr.location,
                    self._expr_span(expr, len(expr.name)),
                    self.scopes.visible_names(),
                )
            if sym.kind not in {"var", "param"}:
                raise SemanticError(
                    f"'{expr.name}' is a {sym.kind}, not a value",
                    expr.location,
                    span=self._expr_span(expr, len(expr.name)),
                    hint="use variables, parameters, fields, or call functions with parentheses",
                )
            expr.inferred_type = sym.type
            return sym.type
        if isinstance(expr, BinaryExpr):
            lt = self._check_expr(expr.left)
            rt = self._check_expr(expr.right)
            if expr.op in ("==", "!=", "<", ">", "<=", ">="):
                self._check_comparison_operands(expr.op, lt, rt, expr)
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
            elif expr.op in ("+", "-", "*", "/", "%"):
                self._check_arithmetic_operands(expr.op, lt, rt, expr)
                result_ty = self._numeric_common_type(lt, rt, expr.left, expr.right)
                if result_ty is None:
                    raise SemanticError(
                        f"operator '{expr.op}' requires compatible numeric operands, "
                        f"got {lt} and {rt}",
                        getattr(expr, "location", None),
                        span=self._expr_span(expr),
                        hint="use Cast<T>(expr) when signedness conversion is intentional",
                    )
                expr.inferred_type = result_ty
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
                if not self._is_lvalue_expr(expr.operand):
                    raise SemanticError(
                        f"operator '{expr.op[-2:]}' requires an assignable target",
                        getattr(expr.operand, "location", None),
                        span=self._expr_span(expr.operand),
                        hint="use increment or decrement on variables, fields, dereferences, or indexed elements",
                    )
                if not isinstance(ot, IntType):
                    raise SemanticError(
                        f"operator '{expr.op[-2:]}' requires an integer target, got {ot}",
                        getattr(expr.operand, "location", None),
                        span=self._expr_span(expr.operand),
                        hint="increment and decrement are integer-only",
                    )
                expr.inferred_type = ot
            else:
                if expr.op == "-" and not ot.is_numeric():
                    raise SemanticError(
                        f"operator '-' requires a numeric operand, got {ot}",
                        getattr(expr.operand, "location", None),
                        span=self._expr_span(expr.operand),
                        hint="use unary '-' only with integer or F16 values",
                    )
                if expr.op == "-" and isinstance(expr.operand, IntLiteral):
                    value = -expr.operand.value
                    if not self._int_literal_fits(value, I16):
                        raise SemanticError(
                            f"integer literal {value} is outside the I16 range",
                            expr.location,
                            span=self._expr_span(expr),
                            hint="use a value between -32768 and 32767",
                        )
                    expr.inferred_type = I16
                    return I16
                expr.inferred_type = ot
            return expr.inferred_type
        if isinstance(expr, CallExpr):
            if not isinstance(expr.callee, IdentifierExpr):
                raise SemanticError(
                    "call target must be a function name",
                    getattr(expr.callee, "location", None),
                    span=self._expr_span(expr.callee) if expr.callee else None,
                )
            sym = self.scopes.lookup(expr.callee.name)
            arg_types = [self._check_expr(a) for a in expr.args]
            if sym is None:
                raise self._undefined_name_error(
                    "function",
                    expr.callee.name,
                    expr.callee.location,
                    self._expr_span(expr.callee, len(expr.callee.name)),
                    self.scopes.visible_names(kinds={"func"}),
                )
            if sym.kind != "func":
                raise SemanticError(
                    f"'{expr.callee.name}' is a {sym.kind}, not a function",
                    expr.callee.location,
                    span=self._expr_span(expr.callee, len(expr.callee.name)),
                )
            self._check_call_arity(expr.callee.name, len(sym.params), len(expr.args), expr)
            self._check_argument_types(expr.callee.name, sym.params, arg_types, expr.args)
            expr.inferred_type = sym.return_type
            return sym.return_type
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
                method_decl = self._find_method_decl(cls_type.name, expr.method)
                if method_decl is None:
                    candidates = self._class_method_names(cls_type.name)
                    raise self._undefined_name_error(
                        "method",
                        expr.method,
                        expr.method_location or expr.location,
                        self._location_span(expr.method_location or expr.location, len(expr.method)),
                        candidates,
                        owner=f"type '{cls_type.name}'",
                    )
                arg_types = [getattr(a, "inferred_type", None) or self._check_expr(a) for a in expr.args]
                param_types = [self._resolve_type(p.type_expr) for p in method_decl.params]
                self._check_call_arity(
                    f"{cls_type.name}.{expr.method}",
                    len(param_types),
                    len(expr.args),
                    expr,
                )
                self._check_argument_types(
                    f"{cls_type.name}.{expr.method}",
                    param_types,
                    arg_types,
                    expr.args,
                )
                ret = self._resolve_type(method_decl.return_type)
                expr.inferred_type = ret
                return ret
            raise SemanticError(
                f"method call requires a class instance, got {obj_type}",
                getattr(expr.obj, "location", None),
                span=self._expr_span(expr.obj),
                hint="use methods only on class values or Ptr<Class> values",
            )
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
                raise self._undefined_name_error(
                    "field",
                    expr.field_name,
                    expr.field_location or expr.location,
                    self._location_span(expr.field_location or expr.location, len(expr.field_name)),
                    [name for name, _ in ot.inner.fields],
                    owner=f"type '{ot.inner.name}'",
                )
            raise SemanticError(
                f"field access requires a class instance, got {ot}",
                getattr(expr.obj, "location", None),
                span=self._expr_span(expr.obj),
                hint="use fields only on class values or Ptr<Class> values",
            )
        if isinstance(expr, IndexExpr):
            ot = self._check_expr(expr.obj)
            index_ty = self._check_expr(expr.index)
            if not isinstance(ot, PtrType_):
                raise SemanticError(
                    f"indexing requires a pointer, got {ot}",
                    getattr(expr.obj, "location", None),
                    span=self._expr_span(expr.obj),
                    hint="index only Ptr<T> values",
                )
            if isinstance(ot.inner, VoidType):
                raise SemanticError(
                    "cannot index Ptr<U0>",
                    getattr(expr.obj, "location", None),
                    span=self._expr_span(expr.obj),
                    hint="cast the pointer to Ptr<T> with a concrete element type first",
                )
            if not isinstance(index_ty, IntType):
                raise SemanticError(
                    f"pointer index must be an integer, got {index_ty}",
                    getattr(expr.index, "location", None),
                    span=self._expr_span(expr.index),
                    hint="use an integer byte or element offset",
                )
            expr.inferred_type = ot.inner
            return expr.inferred_type
        if isinstance(expr, DerefExpr):
            ot = self._check_expr(expr.operand)
            if not isinstance(ot, PtrType_):
                raise SemanticError(
                    f"dereference requires a pointer, got {ot}",
                    getattr(expr.operand, "location", None),
                    span=self._expr_span(expr.operand),
                    hint="use '*' only on Ptr<T> values",
                )
            if isinstance(ot.inner, VoidType):
                raise SemanticError(
                    "cannot dereference Ptr<U0>",
                    getattr(expr.operand, "location", None),
                    span=self._expr_span(expr.operand),
                    hint="cast the pointer to Ptr<T> with a concrete element type first",
                )
            expr.inferred_type = ot.inner
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
            visible_class = self._lookup_visible_symbol(expr.class_name, {"class"})
            if visible_class is None and self.scopes.current.depth != 0:
                raise self._undefined_name_error(
                    "class",
                    expr.class_name,
                    expr.location,
                    self._location_span(expr.location, len("Init")),
                    self.scopes.visible_names(kinds={"class"}),
                )
            ct = (
                visible_class.type
                if visible_class is not None and isinstance(visible_class.type, ClassType)
                else self.class_types.get(expr.class_name)
            )
            if ct is None:
                raise self._undefined_name_error(
                    "class",
                    expr.class_name,
                    expr.location,
                    self._location_span(expr.location, len("Init")),
                    self.class_types.keys(),
                )
            self._check_init_args(expr)
            expr.inferred_type = PtrType_(inner=ct)
            return expr.inferred_type
        if isinstance(expr, MallocExpr):
            size_ty = self._check_expr(expr.size)
            if not isinstance(size_ty, IntType):
                raise SemanticError(
                    f"Malloc size must be an integer, got {size_ty}",
                    getattr(expr.size, "location", None),
                    span=self._expr_span(expr.size),
                    hint="pass the allocation size in bytes as an integer expression",
                )
            literal_size = self._int_literal_value(expr.size)
            if literal_size is not None and literal_size < 0:
                raise SemanticError(
                    f"Malloc size must be non-negative, got {literal_size}",
                    getattr(expr.size, "location", None),
                    span=self._expr_span(expr.size),
                    hint="pass a non-negative byte count",
                )
            expr.inferred_type = PtrType_(inner=VoidType())
            return expr.inferred_type
        if isinstance(expr, SizeOfExpr):
            self._resolve_type(expr.target_type)
            expr.inferred_type = U16
            return U16
        if isinstance(expr, CastExpr):
            source_ty = self._check_expr(expr.operand) if expr.operand else U0
            target_ty = self._resolve_type(expr.target_type)
            if isinstance(source_ty, FloatType) != isinstance(target_ty, FloatType):
                raise SemanticError(
                    f"cannot cast {source_ty} to {target_ty}",
                    getattr(expr, "location", None),
                    span=self._expr_span(expr),
                    hint="integer and pointer conversions to or from F16 are not supported by the CPU backend",
                )
            expr.inferred_type = target_ty
            return expr.inferred_type
        if isinstance(expr, MultiDispatchExpr):
            arg_types = [self._check_expr(arg) for arg in expr.args]
            for t in expr.targets:
                target_ty = self._check_expr(t)
                cls_type = None
                if isinstance(target_ty, PtrType_) and isinstance(target_ty.inner, ClassType):
                    cls_type = target_ty.inner
                elif isinstance(target_ty, ClassType):
                    cls_type = target_ty
                if cls_type is None:
                    raise SemanticError(
                        f"multi-dispatch target must be a class instance, got {target_ty}",
                        getattr(t, "location", None),
                        span=self._expr_span(t),
                        hint="use {a, b}.method(...) only with class values",
                    )
                method_decl = self._find_method_decl(cls_type.name, expr.method)
                if method_decl is None:
                    raise self._undefined_name_error(
                        "method",
                        expr.method,
                        expr.location,
                        self._expr_span(expr),
                        self._class_method_names(cls_type.name),
                        owner=f"type '{cls_type.name}'",
                    )
                param_types = [self._resolve_type(p.type_expr) for p in method_decl.params]
                self._check_call_arity(
                    f"{cls_type.name}.{expr.method}",
                    len(param_types),
                    len(expr.args),
                    expr,
                )
                self._check_argument_types(
                    f"{cls_type.name}.{expr.method}",
                    param_types,
                    arg_types,
                    expr.args,
                )
            expr.inferred_type = U0
            return U0
        raise SemanticError(
            f"unsupported expression node {type(expr).__name__}",
            getattr(expr, "location", None),
            span=self._expr_span(expr),
        )

    def _expr_span(self, expr: Expr, width: int = 1) -> SourceSpan | None:
        if getattr(expr, "span", None) is not None:
            return expr.span
        return self._location_span(getattr(expr, "location", None), width)

    def _location_span(self, location: SourceLocation | None, width: int = 1) -> SourceSpan | None:
        if location is None:
            return None
        return SourceSpan.from_location(location, width)

    def _undefined_name_error(
        self,
        kind: str,
        name: str,
        location: SourceLocation | None,
        span: SourceSpan | None,
        candidates,
        *,
        owner: str | None = None,
    ) -> SemanticError:
        subject = f"{kind} '{name}'"
        if owner:
            message = f"{owner} has no {subject}"
        else:
            message = f"undefined {subject}"
        hint = did_you_mean(name, candidates)
        if hint is None:
            hint = "check the spelling, declaration order, and imports"
        return SemanticError(message, location, span=span, hint=hint)

    def _check_call_arity(
        self,
        callable_name: str,
        expected: int,
        actual: int,
        expr: Expr,
    ) -> None:
        if expected == actual:
            return
        noun = "argument" if expected == 1 else "arguments"
        raise SemanticError(
            f"{callable_name} expects {expected} {noun}, got {actual}",
            getattr(expr, "location", None),
            span=self._expr_span(expr),
            hint="adjust the argument list to match the declaration",
        )

    def _check_argument_types(
        self,
        callable_name: str,
        expected: list[VelaType],
        actual: list[VelaType],
        args: list[Expr],
    ) -> None:
        for idx, (expected_ty, actual_ty) in enumerate(zip(expected, actual), start=1):
            if self._argument_compatible(expected_ty, actual_ty, args[idx - 1]):
                continue
            raise SemanticError(
                f"argument {idx} of {callable_name} expects {expected_ty}, got {actual_ty}",
                getattr(args[idx - 1], "location", None),
                span=self._expr_span(args[idx - 1]),
                hint="use Cast<T>(expr) only when the conversion is intentional",
            )

    def _check_global_initializer_static(
        self,
        name: str,
        ty: VelaType,
        expr: Expr,
    ) -> None:
        if self._is_static_global_initializer(ty, expr):
            return
        raise SemanticError(
            f"global initializer for '{name}' must be a static literal",
            getattr(expr, "location", None),
            span=self._expr_span(expr),
            hint="use an integer, char, float, or null literal; initialize dynamic values in a function",
        )

    def _is_static_global_initializer(self, ty: VelaType, expr: Expr) -> bool:
        if isinstance(ty, IntType):
            return self._int_literal_value(expr) is not None
        if isinstance(ty, FloatType):
            return self._float_literal_value(expr) is not None
        if isinstance(ty, PtrType_):
            return isinstance(expr, NullLiteral)
        return False

    def _check_initializer_compatible(
        self,
        target: VelaType,
        source: VelaType,
        expr: Expr,
    ) -> None:
        if self._initializer_compatible(target, source, expr):
            return
        raise SemanticError(
            f"cannot initialise {target} from {source}",
            getattr(expr, "location", None),
            span=self._expr_span(expr),
            hint="use Cast<T>(expr) only when the conversion is intentional",
        )

    def _initializer_compatible(self, target: VelaType, source: VelaType, expr: Expr) -> bool:
        if self._argument_compatible(target, source, expr):
            return True
        if is_bool_like(target):
            return is_bool_like(source)
        if isinstance(source, BoolType):
            return is_bool_like(target)
        if not (
            isinstance(target, PtrType_)
            and isinstance(target.inner, ClassType)
            and not isinstance(source, PtrType_)
        ):
            return False
        cls = self.class_decls.get(target.inner.name)
        if cls is None or cls.on_alloc is None or not cls.on_alloc.params:
            return False
        first_param = cls.on_alloc.params[0]
        expected = self._resolve_type(first_param.type_expr)
        return self._argument_compatible(expected, source, expr)

    def _is_lvalue_expr(self, expr: Expr) -> bool:
        return isinstance(expr, (IdentifierExpr, DerefExpr, FieldAccessExpr, IndexExpr))

    def _check_arithmetic_operands(
        self,
        op: str,
        left: VelaType,
        right: VelaType,
        expr: BinaryExpr,
    ) -> None:
        if not left.is_numeric() or not right.is_numeric():
            raise SemanticError(
                f"operator '{op}' requires numeric operands, got {left} and {right}",
                getattr(expr, "location", None),
                span=self._expr_span(expr),
                hint="use arithmetic only with integer or F16 values",
            )
        if op == "%" and (left.is_float() or right.is_float()):
            raise SemanticError(
                "operator '%' requires integer operands",
                getattr(expr, "location", None),
                span=self._expr_span(expr),
                hint="use '/' for F16 division; modulo is integer-only",
            )

    def _check_comparison_operands(
        self,
        op: str,
        left: VelaType,
        right: VelaType,
        expr: BinaryExpr,
    ) -> None:
        if op in ("<", ">", "<=", ">="):
            if left.is_numeric() and right.is_numeric():
                if self._numeric_common_type(left, right, expr.left, expr.right) is None:
                    raise SemanticError(
                        f"operator '{op}' requires compatible numeric operands, got {left} and {right}",
                        getattr(expr, "location", None),
                        span=self._expr_span(expr),
                        hint="use Cast<T>(expr) when signedness conversion is intentional",
                    )
                return
            raise SemanticError(
                f"operator '{op}' requires numeric operands, got {left} and {right}",
                getattr(expr, "location", None),
                span=self._expr_span(expr),
                hint="ordered comparisons are only defined for integer and F16 values",
            )

        if is_bool_like(left) or is_bool_like(right):
            if is_bool_like(left) and is_bool_like(right):
                return
            raise SemanticError(
                f"operator '{op}' requires compatible operands, got {left} and {right}",
                getattr(expr, "location", None),
                span=self._expr_span(expr),
                hint="Bool values only compare with Bool values",
            )

        if left.is_numeric() and right.is_numeric():
            if self._numeric_common_type(left, right, expr.left, expr.right) is None:
                raise SemanticError(
                    f"operator '{op}' requires compatible operands, got {left} and {right}",
                    getattr(expr, "location", None),
                    span=self._expr_span(expr),
                    hint="use Cast<T>(expr) when signedness conversion is intentional",
                )
            return
        if self._argument_compatible(left, right, expr.right):
            return
        if self._argument_compatible(right, left, expr.left):
            return
        raise SemanticError(
            f"operator '{op}' requires compatible operands, got {left} and {right}",
            getattr(expr, "location", None),
            span=self._expr_span(expr),
            hint="compare values of compatible types or use Cast<T>(expr) intentionally",
        )

    def _find_method_decl(self, class_name: str, method_name: str) -> FunctionDecl | None:
        cls_decl = self.class_decls.get(class_name)
        while cls_decl is not None:
            for method in cls_decl.methods:
                if method.name == method_name:
                    return method
            if not cls_decl.parent:
                return None
            cls_decl = self.class_decls.get(cls_decl.parent)
        return None

    def _class_method_names(self, class_name: str) -> list[str]:
        names: list[str] = []
        cls_decl = self.class_decls.get(class_name)
        while cls_decl is not None:
            names.extend(method.name for method in cls_decl.methods)
            if not cls_decl.parent:
                break
            cls_decl = self.class_decls.get(cls_decl.parent)
        return names

    def _check_init_args(self, expr: InitExpr) -> None:
        cls = self.class_decls.get(expr.class_name)
        if cls is None or cls.on_alloc is None:
            expected_params: list[ParamDecl] = []
        else:
            expected_params = cls.on_alloc.params

        self._check_call_arity(
            f"Init<{expr.class_name}>",
            len(expected_params),
            len(expr.kwargs),
            expr,
        )
        expected_names = [param.name for param in expected_params]
        for idx, ((name, value_expr), param) in enumerate(zip(expr.kwargs, expected_params), start=1):
            if name != param.name:
                hint = did_you_mean(name, expected_names)
                if hint is None:
                    hint = (
                        "Init<T> arguments are named but currently lowered in "
                        "OnAlloc parameter order"
                    )
                raise SemanticError(
                    f"argument {idx} of Init<{expr.class_name}> is named '{name}', "
                    f"expected '{param.name}'",
                    getattr(value_expr, "location", None),
                    span=self._expr_span(value_expr),
                    hint=hint,
                )
            actual_ty = self._check_expr(value_expr)
            expected_ty = self._resolve_type(param.type_expr)
            if not self._argument_compatible(expected_ty, actual_ty, value_expr):
                raise SemanticError(
                    f"argument '{name}' of Init<{expr.class_name}> expects "
                    f"{expected_ty}, got {actual_ty}",
                    getattr(value_expr, "location", None),
                    span=self._expr_span(value_expr),
                    hint="use Cast<T>(expr) only when the conversion is intentional",
                )

    def _numeric_common_type(
        self,
        left: VelaType,
        right: VelaType,
        left_expr: Expr,
        right_expr: Expr,
    ) -> VelaType | None:
        if isinstance(left, FloatType) and isinstance(right, FloatType):
            return F16
        if isinstance(left, FloatType) or isinstance(right, FloatType):
            return None
        if isinstance(left, IntType) and isinstance(right, IntType):
            if self._argument_compatible(left, right, right_expr):
                return left
            if self._argument_compatible(right, left, left_expr):
                return right
        return None

    def _argument_compatible(self, expected: VelaType, actual: VelaType, expr: Expr) -> bool:
        literal_value = self._int_literal_value(expr)
        if isinstance(expected, IntType) and isinstance(actual, IntType) and literal_value is not None:
            return self._int_literal_fits(literal_value, expected)
        if types_compatible(expected, actual):
            return True
        return False

    def _int_literal_value(self, expr: Expr) -> int | None:
        if isinstance(expr, IntLiteral):
            return expr.value
        if isinstance(expr, CharLiteral):
            return ord(expr.value)
        if (
            isinstance(expr, UnaryExpr)
            and expr.op == "-"
            and isinstance(expr.operand, IntLiteral)
        ):
            return -expr.operand.value
        return None

    def _float_literal_value(self, expr: Expr) -> float | None:
        if isinstance(expr, FloatLiteral):
            return expr.value
        if (
            isinstance(expr, UnaryExpr)
            and expr.op == "-"
            and isinstance(expr.operand, FloatLiteral)
        ):
            return -expr.operand.value
        return None

    def _int_literal_fits(self, value: int, target: IntType) -> bool:
        if target.signed:
            low = -(1 << (target.bits - 1))
            high = (1 << (target.bits - 1)) - 1
        else:
            low = 0
            high = (1 << target.bits) - 1
        return low <= value <= high

    def _resolve_type(self, texpr: TypeExpr | None) -> VelaType:
        if texpr is None:
            return U0
        if isinstance(texpr, NamedType):
            if texpr.name in PRIMITIVE_MAP:
                return PRIMITIVE_MAP[texpr.name]
            visible = self._lookup_visible_symbol(texpr.name, {"alias", "class", "type"})
            if visible is not None:
                if visible.kind == "alias":
                    return visible.type
                if visible.kind == "class":
                    if isinstance(visible.type, ClassType):
                        return PtrType_(inner=visible.type)
                    return PtrType_(inner=self.class_types.get(
                        texpr.name,
                        ClassType(name=texpr.name),
                    ))
                if visible.kind == "type":
                    return visible.type
            # Outside an active module scope, keep the historical lookup path
            # for IR generation and tests that resolve already-checked ASTs.
            if self.scopes.current.depth != 0:
                raise SemanticError(
                    f"unknown type '{texpr.name}'",
                    texpr.location,
                    span=getattr(texpr, "span", None),
                    hint="use a primitive type, class name, type declaration, alias, or Ptr<T>",
                )
            if texpr.name in self.aliases:
                return self.aliases[texpr.name]
            if texpr.name in self.class_types:
                return PtrType_(inner=self.class_types[texpr.name])
            if texpr.name in self.class_decls:
                vt = self.vtables.get(texpr.name)
                return PtrType_(inner=ClassType(
                    name=texpr.name,
                    parent=self.class_decls[texpr.name].parent,
                    total_size=vt.class_size if vt else 2,
                ))
            if texpr.name in self.type_decls:
                td = self.type_decls[texpr.name]
                return TypeDeclType(
                    name=td.name,
                    methods=tuple(m.name for m in td.methods),
                )
            raise SemanticError(
                f"unknown type '{texpr.name}'",
                texpr.location,
                span=getattr(texpr, "span", None),
                hint="use a primitive type, class name, type declaration, alias, or Ptr<T>",
            )
        if isinstance(texpr, PtrType):
            inner = self._resolve_type(texpr.inner)
            if isinstance(inner, PtrType_) and isinstance(inner.inner, ClassType):
                inner = inner.inner
            return PtrType_(inner=inner)
        raise SemanticError(
            "unknown type expression",
            getattr(texpr, "location", None),
            span=getattr(texpr, "span", None),
            hint="use a primitive type, class name, type declaration, alias, or Ptr<T>",
        )

    def _type_size(self, texpr) -> int:
        ty = self._resolve_type(texpr)
        return max(ty.size(), 1)
