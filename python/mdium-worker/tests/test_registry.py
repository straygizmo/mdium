import pytest

from mdium_worker import registry, stage


def setup_function() -> None:
    registry.clear()


def test_stage_registers_definition_and_function() -> None:
    @stage("x.y", inputs={"n": {"type": "number", "required": True}}, outputs={"o": {"type": "string"}})
    def fn(ctx, n):
        return None

    defs = registry.stages()
    assert [d.name for d in defs] == ["x.y"]
    assert defs[0].inputs["n"].type == "number" and defs[0].inputs["n"].required is True
    assert registry.get("x.y").fn is fn


def test_duplicate_names_are_rejected() -> None:
    @stage("dup")
    def one(ctx):
        return None

    with pytest.raises(ValueError):
        @stage("dup")
        def two(ctx):
            return None


def test_bad_input_type_in_definition_is_rejected() -> None:
    with pytest.raises(ValueError):
        @stage("bad", inputs={"n": {"type": "integer"}})
        def fn(ctx, n):
            return None
