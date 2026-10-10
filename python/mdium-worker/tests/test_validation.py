import pytest

from mdium_worker.protocol import InputError, validate_inputs
from mdium_worker.registry import StageDef


def stage_def() -> StageDef:
    return StageDef.from_decorator("s", None, {"a": {"type": "number", "required": True}, "t": {"type": "string", "default": "x"}, "o": {"type": "object"}}, {}, [])


def test_fills_defaults_and_accepts_valid_inputs() -> None:
    assert validate_inputs(stage_def(), {"a": 1, "o": {"k": 1}}) == {"a": 1, "t": "x", "o": {"k": 1}}


def test_reports_unknown_missing_and_type_errors() -> None:
    with pytest.raises(InputError) as info:
        validate_inputs(stage_def(), {"t": 1, "extra": True})
    messages = " ".join(info.value.errors)
    assert "a" in messages and "missing" in messages
    assert "t" in messages and "type" in messages
    assert "extra" in messages and "unknown" in messages


def test_null_uses_the_default() -> None:
    assert validate_inputs(stage_def(), {"a": 2, "t": None})["t"] == "x"


def test_a_none_default_counts_as_no_default() -> None:
    optional = StageDef.from_decorator("s", None, {"x": {"type": "string", "default": None}}, {}, [])
    assert validate_inputs(optional, {}) == {}
    assert validate_inputs(optional, {"x": None}) == {}
    assert validate_inputs(optional, {"x": "v"}) == {"x": "v"}
    required = StageDef.from_decorator("s", None, {"x": {"type": "string", "required": True, "default": None}}, {}, [])
    with pytest.raises(InputError) as info:
        validate_inputs(required, {})
    assert info.value.errors == ["x: missing"]
