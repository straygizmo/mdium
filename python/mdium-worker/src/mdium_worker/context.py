"""The Context handed to a stage: event emission, stop checks, control-flow exceptions."""
from __future__ import annotations

import os
import threading
from typing import Any, Callable

# Longest `log.text` / `outcome.reason` / `outcome.message` sent (characters),
# well inside MDium's 64 KiB line limit.
MAX_TEXT = 8 * 1024
TRUNCATED = "… [truncated]"


def truncate_text(text: str, limit: int = MAX_TEXT) -> str:
    """`text` cut to `limit` characters, marked when cut."""
    return text if len(text) <= limit else text[:limit] + TRUNCATED


class StageFailed(Exception):
    """The stage failed; the message is reported as the outcome's reason."""


class Stopped(Exception):
    """The stage stopped at a boundary because a stop was requested."""


class NeedsApproval(Exception):
    """The stage wants a human decision before it counts as done."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class Context:
    def __init__(self, call_id: str, context: dict, emit: Callable[[dict], None], cancel: threading.Event) -> None:
        self._call_id = call_id
        self._ctx = context
        self._emit = emit
        self._cancel = cancel

    @property
    def run_id(self) -> str:
        return str(self._ctx.get("runId", ""))

    @property
    def node_dir(self) -> str:
        return str(self._ctx.get("nodeDir", ""))

    @property
    def project_root(self) -> str:
        return str(self._ctx.get("projectRoot", ""))

    @property
    def attempt(self) -> int:
        return int(self._ctx.get("attempt", 1))

    def _send(self, message: dict) -> None:
        self._emit({"v": 1, "callId": self._call_id, **message})

    def progress(self, text: str, fraction: float | None = None) -> None:
        message: dict = {"type": "progress", "text": text}
        if fraction is not None:
            message["fraction"] = fraction
        self._send(message)

    def cost(self, usd: float, kind: str = "actual", provider: str | None = None, model: str | None = None, units: dict | None = None) -> None:
        message: dict = {"type": "cost", "usd": usd, "kind": kind}
        for key, value in (("provider", provider), ("model", model), ("units", units)):
            if value is not None:
                message[key] = value
        self._send(message)

    def output(self, key: str, value: Any) -> None:
        self._send({"type": "output", "key": key, "value": value})

    def artifact(self, path: str | os.PathLike, label: str | None = None, media_type: str | None = None) -> None:
        """Records a file the stage produced.

        A relative `path` is resolved against the worker's current directory
        (the runtime `cwd`), and MDium receives the absolute path; it must lie
        inside the project, otherwise MDium ignores it with a warning.
        """
        message: dict = {"type": "artifact", "path": os.path.abspath(os.fspath(path))}
        if label is not None:
            message["label"] = label
        if media_type is not None:
            message["mediaType"] = media_type
        self._send(message)

    def log(self, text: str, level: str = "info") -> None:
        self._send({"type": "log", "level": level, "text": truncate_text(str(text))})

    def should_stop(self) -> bool:
        stop_file = self._ctx.get("stopFile") or os.environ.get("MDIUM_FLOW_STOP_FILE")
        return self._cancel.is_set() or bool(stop_file and os.path.exists(stop_file))

    def needs_approval(self, message: str) -> None:
        raise NeedsApproval(message)
