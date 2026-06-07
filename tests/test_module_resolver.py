import pytest

from src.errors import VelaError
from src.semantic.module_resolver import ModuleResolver


def test_failed_resolve_does_not_leave_module_marked_resolving(tmp_path):
    module_path = tmp_path / "bad.vl"
    module_path.write_text("module bad { I16 f( { ret 0; } }", encoding="utf-8")

    resolver = ModuleResolver(tmp_path)

    with pytest.raises(VelaError):
        resolver.resolve([], "bad")

    module_path.write_text("module bad { I16 f() { ret 0; } }", encoding="utf-8")

    mod = resolver.resolve([], "bad")
    assert mod.name == "bad"
