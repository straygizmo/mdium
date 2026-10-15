"""Worker side of MDium's python flow nodes (spec 2026-10-10, chapter 4)."""
from __future__ import annotations

from typing import Any, Callable

from . import registry
from .context import Context, NeedsApproval, StageFailed, Stopped
from .registry import StageDef

__all__ = ["stage", "Context", "StageFailed", "Stopped", "NeedsApproval", "registry"]


def stage(name: str, *, description: str | None = None, inputs: dict[str, dict] | None = None,
          outputs: dict[str, dict] | None = None, artifacts: list[dict] | None = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Registers `fn` as the stage `name`; the function receives a Context plus the inputs as keyword arguments."""
    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        registry.register(StageDef.from_decorator(name, description, inputs, outputs, artifacts, fn))
        return fn
    return decorate
