from __future__ import annotations

from src.parser.ast_nodes import (
    ClassDecl, FunctionDecl, NamedType, ParamDecl, ReturnStmt,
    FieldAccessExpr, IdentifierExpr, VarDecl, Assignment,
)
from src.errors import VelaError


def process_tags(cls: ClassDecl) -> None:
    """Expand tags on class fields into getter/setter methods.

    Generates PascalCase names: [[get]] I16 value -> GetValue(),
    [[set]] I16 value -> SetValue(I16 value).
    Raises VelaError if a user-defined method conflicts with a
    tag-generated name.
    """
    # collect existing method names for conflict detection
    existing: set[str] = {m.name for m in cls.methods}

    new_methods: list[FunctionDecl] = []
    for fld in cls.fields:
        for tag in fld.tags:
            if tag == "get":
                name = _pascal("Get", fld.name)
                _check_conflict(cls.name, name, "[[get]]", fld.name, existing, fld.location)
                new_methods.append(_make_getter(fld, name))
            elif tag == "set":
                name = _pascal("Set", fld.name)
                _check_conflict(cls.name, name, "[[set]]", fld.name, existing, fld.location)
                new_methods.append(_make_setter(fld, name))
    cls.methods.extend(new_methods)


def _pascal(prefix: str, field_name: str) -> str:
    return prefix + field_name[0].upper() + field_name[1:]


def _check_conflict(cls_name: str, method_name: str, tag: str,
                     field_name: str, existing: set[str],
                     location) -> None:
    if method_name in existing:
        raise VelaError(
            f"class '{cls_name}': tag {tag} on field '{field_name}' "
            f"generates method '{method_name}()' which is already "
            f"explicitly defined",
            location=location,
        )


def _make_getter(fld: VarDecl, name: str) -> FunctionDecl:
    assert fld.type_expr is not None
    return FunctionDecl(
        return_type=fld.type_expr,
        name=name,
        params=[],
        body=[
            ReturnStmt(
                value=FieldAccessExpr(
                    obj=IdentifierExpr(name="this"),
                    field_name=fld.name,
                ),
            ),
        ],
        location=fld.location,
    )


def _make_setter(fld: VarDecl, name: str) -> FunctionDecl:
    assert fld.type_expr is not None
    return FunctionDecl(
        return_type=NamedType(name="U0"),
        name=name,
        params=[ParamDecl(type_expr=fld.type_expr, name="value")],
        body=[
            Assignment(
                target=FieldAccessExpr(
                    obj=IdentifierExpr(name="this"),
                    field_name=fld.name,
                ),
                value=IdentifierExpr(name="value"),
            ),
        ],
        location=fld.location,
    )


def has_tag(tags: list[str], tag: str) -> bool:
    return tag in tags
