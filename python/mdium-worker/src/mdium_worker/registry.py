"""Stage registry filled by the @stage decorator."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

INPUT_TYPES = ("string", "number", "bool", "path", "object", "array")

TYPE_CHECKS: dict[str, Callable[[Any], bool]] = {
    "string": lambda v: isinstance(v, str),
    "path": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
}


def _optional_str(value: Any, what: str) -> str | None:
    if value is not None and not isinstance(value, str):
        raise ValueError(f"{what} must be a string")
    return value


def _check_outputs(name: str, outputs: Any) -> dict[str, dict]:
    """Outputs as MDium reads them: {key: {type?, description?}}."""
    if not isinstance(outputs, dict):
        raise ValueError(f"stage {name!r}: outputs must be a dict")
    for key, spec in outputs.items():
        if not isinstance(spec, dict):
            raise ValueError(f"stage {name!r}: output {key!r} must be a dict")
        ty = spec.get("type")
        if ty is not None and ty not in INPUT_TYPES:
            raise ValueError(f"stage {name!r}: output {key!r} has unknown type {ty!r}")
        _optional_str(spec.get("description"), f"stage {name!r}: description of output {key!r}")
    return dict(outputs)


def _check_artifacts(name: str, artifacts: Any) -> list[dict]:
    """Artifacts as MDium reads them: [{label, mediaType?}]."""
    if not isinstance(artifacts, list):
        raise ValueError(f"stage {name!r}: artifacts must be a list")
    for i, spec in enumerate(artifacts):
        if not isinstance(spec, dict) or not isinstance(spec.get("label"), str):
            raise ValueError(f"stage {name!r}: artifact {i} needs a string label")
        _optional_str(spec.get("mediaType"), f"stage {name!r}: mediaType of artifact {i}")
    return list(artifacts)


@dataclass
class InputDef:
    type: str
    required: bool = False
    default: Any = None
    has_default: bool = False
    description: str | None = None

    def to_json(self) -> dict:
        out: dict = {"type": self.type, "required": self.required}
        if self.has_default:
            out["default"] = self.default
        if self.description:
            out["description"] = self.description
        return out


@dataclass
class StageDef:
    name: str
    description: str | None
    inputs: dict[str, InputDef]
    outputs: dict[str, dict]
    artifacts: list[dict]
    fn: Callable[..., Any] = field(default=lambda *a, **k: None, repr=False)

    @classmethod
    def from_decorator(cls, name, description, inputs, outputs, artifacts, fn=None) -> "StageDef":
        """Validates the definition so a bad stage fails at import, not as a
        manifest MDium cannot read."""
        _optional_str(description, f"stage {name!r}: description")
        defs: dict[str, InputDef] = {}
        for key, spec in (inputs or {}).items():
            ty = spec.get("type", "string")
            if ty not in INPUT_TYPES:
                raise ValueError(f"stage {name!r}: input {key!r} has unknown type {ty!r}")
            default = spec.get("default")
            if default is not None and not TYPE_CHECKS[ty](default):
                raise ValueError(f"stage {name!r}: default of input {key!r} is not a {ty}")
            defs[key] = InputDef(
                type=ty,
                required=bool(spec.get("required", False)),
                default=default,
                has_default="default" in spec,
                description=_optional_str(spec.get("description"), f"stage {name!r}: description of input {key!r}"),
            )
        return cls(name, description, defs, _check_outputs(name, outputs or {}),
                   _check_artifacts(name, artifacts or []), fn or (lambda *a, **k: None))

    def to_json(self) -> dict:
        out: dict = {"name": self.name, "inputs": {k: v.to_json() for k, v in self.inputs.items()},
                     "outputs": self.outputs, "artifacts": self.artifacts}
        if self.description:
            out["description"] = self.description
        return out


_STAGES: dict[str, StageDef] = {}


def register(stage_def: StageDef) -> None:
    if stage_def.name in _STAGES:
        raise ValueError(f"stage {stage_def.name!r} is already registered")
    _STAGES[stage_def.name] = stage_def


def stages() -> list[StageDef]:
    return list(_STAGES.values())


def get(name: str) -> StageDef | None:
    return _STAGES.get(name)


def clear() -> None:
    _STAGES.clear()
