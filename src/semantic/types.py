from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class VelaType:
    """Base class for all Vela types."""
    def size(self) -> int:
        return 0

    def is_numeric(self) -> bool:
        return False

    def is_signed(self) -> bool:
        return False

    def is_float(self) -> bool:
        return False


@dataclass(frozen=True)
class VoidType(VelaType):
    def size(self) -> int:
        return 0

    def __str__(self) -> str:
        return "U0"


@dataclass(frozen=True)
class IntType(VelaType):
    bits: int = 16
    signed: bool = False

    def size(self) -> int:
        return self.bits // 8

    def is_numeric(self) -> bool:
        return True

    def is_signed(self) -> bool:
        return self.signed

    def __str__(self) -> str:
        prefix = "I" if self.signed else "U"
        return f"{prefix}{self.bits}"


@dataclass(frozen=True)
class FloatType(VelaType):
    bits: int = 16

    def size(self) -> int:
        return 2

    def is_numeric(self) -> bool:
        return True

    def is_float(self) -> bool:
        return True

    def __str__(self) -> str:
        return f"F{self.bits}"


@dataclass(frozen=True)
class PtrType_(VelaType):
    inner: VelaType = field(default_factory=VoidType)

    def size(self) -> int:
        return 2  # 16-bit address

    def __str__(self) -> str:
        return f"Ptr<{self.inner}>"


@dataclass(frozen=True)
class BoolType(VelaType):
    """Distinct boolean type.  Same runtime footprint as U8 but NOT
    implicitly convertible to/from any integer type."""

    def size(self) -> int:
        return 1

    def is_numeric(self) -> bool:
        return False

    def __str__(self) -> str:
        return "Bool"


@dataclass(frozen=True)
class ClassType(VelaType):
    name: str = ""
    parent: str | None = None
    fields: tuple[tuple[str, VelaType], ...] = ()
    methods: tuple[str, ...] = ()
    vtable_index: dict[str, int] = field(default_factory=dict, hash=False, compare=False)
    total_size: int = 0

    def size(self) -> int:
        return self.total_size

    def __str__(self) -> str:
        return self.name


@dataclass(frozen=True)
class TypeDeclType(VelaType):
    """Represents a 'type' (interface/abstract)."""
    name: str = ""
    methods: tuple[str, ...] = ()

    def __str__(self) -> str:
        return self.name


# singleton primitive types
U0 = VoidType()
U8 = IntType(bits=8, signed=False)
I8 = IntType(bits=8, signed=True)
U16 = IntType(bits=16, signed=False)
I16 = IntType(bits=16, signed=True)
F16 = FloatType(bits=16)
BOOL = BoolType()
NULL_PTR = PtrType_(inner=VoidType())

PRIMITIVE_MAP: dict[str, VelaType] = {
    "U0": U0, "U8": U8, "I8": I8, "U16": U16, "I16": I16,
    "F16": F16,
}


def is_bool_like(ty: VelaType) -> bool:
    """True for internal BoolType *and* the stdlib Bool class (Ptr<Bool>)."""
    if isinstance(ty, BoolType):
        return True
    if isinstance(ty, PtrType_) and isinstance(ty.inner, ClassType):
        return ty.inner.name == "Bool"
    if isinstance(ty, ClassType):
        return ty.name == "Bool"
    return False


def types_compatible(target: VelaType, source: VelaType) -> bool:
    """Check if source can be assigned to target."""
    if target == source:
        return True
    # numeric widening
    if isinstance(target, IntType) and isinstance(source, IntType):
        return target.bits >= source.bits
    if isinstance(target, FloatType) and isinstance(source, (IntType, FloatType)):
        return True
    # pointer compatibility
    if isinstance(target, PtrType_) and isinstance(source, PtrType_):
        if isinstance(target.inner, VoidType) or isinstance(source.inner, VoidType):
            return True
        return target.inner == source.inner
    # Null to any pointer
    if isinstance(target, PtrType_) and source == NULL_PTR:
        return True
    return False
