"""Stage registry filled by the @stage decorator."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

INPUT_TYPES = ("string", "number", "bool", "path", "object", "array")


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
        defs: dict[str, InputDef] = {}
        for key, spec in (inputs or {}).items():
            ty = spec.get("type", "string")
            if ty not in INPUT_TYPES:
                raise ValueError(f"stage {name!r}: input {key!r} has unknown type {ty!r}")
            defs[key] = InputDef(
                type=ty,
                required=bool(spec.get("required", False)),
                default=spec.get("default"),
                has_default="default" in spec,
                description=spec.get("description"),
            )
        return cls(name, description, defs, dict(outputs or {}), list(artifacts or []), fn or (lambda *a, **k: None))

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
