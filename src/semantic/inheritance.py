from __future__ import annotations

from dataclasses import dataclass, field

from src.errors import SemanticError
from src.parser.ast_nodes import ClassDecl, TypeDecl, FunctionDecl


@dataclass
class VtableEntry:
    method_name: str
    mangled_name: str  # e.g. ClassName_method
    slot_index: int


@dataclass
class VtableInfo:
    class_name: str
    entries: list[VtableEntry] = field(default_factory=list)
    class_size: int = 0  # total instance size in bytes

    def slot_for(self, method: str) -> int | None:
        for e in self.entries:
            if e.method_name == method:
                return e.slot_index
        return None


class InheritanceResolver:
    """Validates inheritance chains and builds vtables."""

    def __init__(self) -> None:
        self._classes: dict[str, ClassDecl] = {}
        self._types: dict[str, TypeDecl] = {}
        self._vtables: dict[str, VtableInfo] = {}
        self._field_sizes: dict[str, int] = {}

    def register_class(self, cls: ClassDecl) -> None:
        self._classes[cls.name] = cls

    def register_type(self, td: TypeDecl) -> None:
        self._types[td.name] = td

    def resolve_all(self, type_size_fn) -> dict[str, VtableInfo]:
        """Build vtables for all registered classes. type_size_fn(TypeExpr) -> int."""
        for name, cls in self._classes.items():
            if cls.parent and cls.parent not in self._classes and cls.parent not in self._types:
                raise SemanticError(
                    f"class '{name}' extends unknown class or type '{cls.parent}'"
                )
        for name in self._classes:
            self._check_cycle(name, set())
        for name, cls in self._classes.items():
            self._validate_skeletons(cls)
        for name in self._classes:
            if name not in self._vtables:
                self._build_vtable(name, type_size_fn)
        return self._vtables

    def _check_cycle(self, name: str, visited: set[str]) -> None:
        if name in visited:
            raise SemanticError(f"inheritance cycle detected involving '{name}'")
        visited.add(name)
        cls = self._classes.get(name)
        if cls and cls.parent:
            if cls.parent in self._classes:
                self._check_cycle(cls.parent, visited)

    def _validate_skeletons(self, cls: ClassDecl) -> None:
        """Ensure all skeleton methods from parent type are implemented."""
        if not cls.parent:
            return
        parent_type = self._types.get(cls.parent)
        if not parent_type:
            parent_cls = self._classes.get(cls.parent)
            if parent_cls:
                # inheriting from a class: gonna check its parent chain too
                return
            return
        impl_names = {m.name for m in cls.methods}
        for m in parent_type.methods:
            if m.is_skeleton and m.name not in impl_names:
                raise SemanticError(
                    f"class '{cls.name}' must implement skeleton method '{m.name}' "
                    f"from type '{parent_type.name}'"
                )

    def _build_vtable(self, name: str, type_size_fn) -> VtableInfo:
        if name in self._vtables:
            return self._vtables[name]

        cls = self._classes[name]
        parent_vtable: VtableInfo | None = None

        if cls.parent:
            if cls.parent in self._classes:
                parent_vtable = self._build_vtable(cls.parent, type_size_fn)
            elif cls.parent in self._types:
                parent_vtable = self._build_type_vtable(cls.parent)

        vt = VtableInfo(class_name=name, entries=[], class_size=0)

        # copy parent vtable entries
        if parent_vtable:
            for entry in parent_vtable.entries:
                vt.entries.append(VtableEntry(
                    method_name=entry.method_name,
                    mangled_name=entry.mangled_name,
                    slot_index=entry.slot_index,
                ))

        # add/override with own methods
        for method in cls.methods:
            mangled = f"{name}_{method.name}"
            existing_slot = vt.slot_for(method.name)
            if existing_slot is not None:
                # override
                for e in vt.entries:
                    if e.method_name == method.name:
                        e.mangled_name = mangled
                        break
            else:
                slot = len(vt.entries)
                vt.entries.append(VtableEntry(
                    method_name=method.name,
                    mangled_name=mangled,
                    slot_index=slot,
                ))

        # compute class size: parent instance layout + own fields. Class
        # parents already include the vtable pointer and inherited fields.
        size = parent_vtable.class_size if parent_vtable and cls.parent in self._classes else 2
        for f in cls.fields:
            size += type_size_fn(f.type_expr)
        vt.class_size = size
        self._vtables[name] = vt
        return vt

    def _build_type_vtable(self, name: str) -> VtableInfo:
        """Build a skeleton vtable for a type declaration."""
        td = self._types[name]
        vt = VtableInfo(class_name=name, entries=[])
        for i, m in enumerate(td.methods):
            vt.entries.append(VtableEntry(
                method_name=m.name,
                mangled_name=f"{name}_{m.name}",
                slot_index=i,
            ))
        return vt
