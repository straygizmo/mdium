"""Messages of the mdium-worker-v1 protocol and input validation."""
from __future__ import annotations

from typing import Any

from .registry import TYPE_CHECKS, StageDef

__all__ = ["TYPE_CHECKS", "InputError", "validate_inputs", "manifest_message", "error_message", "outcome_message"]


class InputError(Exception):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def validate_inputs(stage: StageDef, given: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    out: dict[str, Any] = {}
    for key in given:
        if key not in stage.inputs:
            errors.append(f"{key}: unknown input")
    for name, spec in stage.inputs.items():
        value = given.get(name)
        if value is None:
            # A `None` default means "optional", like no default (as in Rust).
            if spec.has_default and spec.default is not None:
                value = spec.default
            elif spec.required:
                errors.append(f"{name}: missing")
                continue
            else:
                continue
        if not TYPE_CHECKS[spec.type](value):
            errors.append(f"{name}: wrong type (expected {spec.type}, got {type(value).__name__})")
            continue
        out[name] = value
    if errors:
        raise InputError(errors)
    return out


def manifest_message(request_id: str, module: str, stages: list[StageDef]) -> dict:
    return {"v": 1, "type": "manifest", "requestId": request_id, "module": module, "stages": [s.to_json() for s in stages]}


def error_message(request_id: str | None, code: str, message: str) -> dict:
    out = {"v": 1, "type": "error", "code": code, "message": message}
    if request_id is not None:
        out["requestId"] = request_id
    return out


def outcome_message(call_id: str, status: str, **extra: Any) -> dict:
    return {"v": 1, "type": "outcome", "callId": call_id, "status": status, **{k: v for k, v in extra.items() if v is not None}}
