from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from src.errors import SourceLocation, SourceSpan

@dataclass
class ASTNode:
    location: SourceLocation | None = field(default=None, repr=False, kw_only=True)
    span: SourceSpan | None = field(default=None, repr=False, kw_only=True)


@dataclass
class Program(ASTNode):
    modules: list[ModuleDecl] = field(default_factory=list)


@dataclass
class ModuleDecl(ASTNode):
    name: str = ""
    imports: list[ImportDecl] = field(default_factory=list)
    body: list[ASTNode] = field(default_factory=list)


@dataclass
class ImportDecl(ASTNode):
    package: list[str] = field(default_factory=list)
    modules: list[str] = field(default_factory=list)


@dataclass
class AliasDecl(ASTNode):
    name: str = ""
    target_type: TypeExpr | None = None


@dataclass
class VarDecl(ASTNode):
    type_expr: TypeExpr | None = None
    name: str = ""
    initializer: Expr | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class FunctionDecl(ASTNode):
    return_type: TypeExpr | None = None
    name: str = ""
    params: list[ParamDecl] = field(default_factory=list)
    body: list[Stmt] = field(default_factory=list)
    is_skeleton: bool = False


@dataclass
class ParamDecl(ASTNode):
    type_expr: TypeExpr | None = None
    name: str = ""


@dataclass
class ClassDecl(ASTNode):
    name: str = ""
    parent: str | None = None
    fields: list[VarDecl] = field(default_factory=list)
    methods: list[FunctionDecl] = field(default_factory=list)
    on_alloc: FunctionDecl | None = None
    on_free: FunctionDecl | None = None


@dataclass
class TypeDecl(ASTNode):
    name: str = ""
    parent: str | None = None
    methods: list[FunctionDecl] = field(default_factory=list)


@dataclass
class TypeExpr(ASTNode):
    pass


@dataclass
class NamedType(TypeExpr):
    name: str = ""


@dataclass
class PtrType(TypeExpr):
    inner: TypeExpr | None = None


@dataclass
class ArrayType(TypeExpr):
    elem: TypeExpr | None = None
    size: Expr | None = None  # for fixed arrays


@dataclass
class Stmt(ASTNode):
    pass


@dataclass
class ExprStmt(Stmt):
    expr: Expr | None = None


@dataclass
class ReturnStmt(Stmt):
    value: Expr | None = None


@dataclass
class IfStmt(Stmt):
    condition: Expr | None = None
    then_body: list[Stmt] = field(default_factory=list)
    else_body: list[Stmt] = field(default_factory=list)


@dataclass
class ForStmt(Stmt):
    init: Stmt | None = None
    condition: Expr | None = None
    update: Stmt | None = None
    body: list[Stmt] = field(default_factory=list)


@dataclass
class WhileStmt(Stmt):
    condition: Expr | None = None
    body: list[Stmt] = field(default_factory=list)


@dataclass
class Assignment(Stmt):
    target: Expr | None = None
    value: Expr | None = None
    op: str = "="  # =, +=, -=, *=, /=


@dataclass
class FreeStmt(Stmt):
    expr: Expr | None = None


@dataclass
class PrintStmt(Stmt):
    value: Expr | None = None
    fmt: Expr | None = None


@dataclass
class AsmBlock(Stmt):
    inputs: list[AsmBinding] = field(default_factory=list)
    outputs: list[AsmBinding] = field(default_factory=list)
    body: list[str] = field(default_factory=list)


@dataclass
class AsmBinding(ASTNode):
    register: str = ""
    variable: str = ""


@dataclass
class Expr(ASTNode):
    inferred_type: Any = field(default=None, repr=False)


@dataclass
class IntLiteral(Expr):
    value: int = 0


@dataclass
class FloatLiteral(Expr):
    value: float = 0.0


@dataclass
class StringLiteral(Expr):
    value: str = ""


@dataclass
class CharLiteral(Expr):
    value: str = ""


@dataclass
class BoolLiteral(Expr):
    value: bool = False


@dataclass
class NullLiteral(Expr):
    pass


@dataclass
class IdentifierExpr(Expr):
    name: str = ""


@dataclass
class BinaryExpr(Expr):
    op: str = ""
    left: Expr | None = None
    right: Expr | None = None


@dataclass
class UnaryExpr(Expr):
    op: str = ""
    operand: Expr | None = None


@dataclass
class CallExpr(Expr):
    callee: Expr | None = None
    args: list[Expr] = field(default_factory=list)


@dataclass
class MethodCallExpr(Expr):
    obj: Expr | None = None
    method: str = ""
    args: list[Expr] = field(default_factory=list)
    method_location: SourceLocation | None = field(default=None, repr=False)


@dataclass
class FieldAccessExpr(Expr):
    obj: Expr | None = None
    field_name: str = ""
    field_location: SourceLocation | None = field(default=None, repr=False)


@dataclass
class IndexExpr(Expr):
    obj: Expr | None = None
    index: Expr | None = None


@dataclass
class DerefExpr(Expr):
    operand: Expr | None = None


@dataclass
class AddressOfExpr(Expr):
    operand: Expr | None = None


@dataclass
class CastExpr(Expr):
    target_type: TypeExpr | None = None
    operand: Expr | None = None


@dataclass
class InitExpr(Expr):
    class_name: str = ""
    kwargs: list[tuple[str, Expr]] = field(default_factory=list)


@dataclass
class MallocExpr(Expr):
    size: Expr | None = None


@dataclass
class SizeOfExpr(Expr):
    target_type: TypeExpr | None = None


@dataclass
class MultiDispatchExpr(Expr):
    targets: list[Expr] = field(default_factory=list)
    method: str = ""
    args: list[Expr] = field(default_factory=list)
