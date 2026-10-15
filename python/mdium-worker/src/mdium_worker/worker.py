"""The worker loop: reads requests on stdin, runs stages, writes events on stdout."""
from __future__ import annotations

import collections
import importlib
import json
import os
import queue
import sys
import threading
import time
import traceback
from typing import Iterator, TextIO

from . import registry
from .context import Context, NeedsApproval, StageFailed, Stopped
from .protocol import InputError, error_message, manifest_message, outcome_message, validate_inputs

ENTRY_UNKNOWN = "FLOW_PYTHON_ENTRY_UNKNOWN"
INPUT_INVALID = "FLOW_PYTHON_INPUT_INVALID"
PROTOCOL = "FLOW_PYTHON_PROTOCOL"


class Emitter:
    def __init__(self, stdout: TextIO) -> None:
        self._stdout = stdout
        self._lock = threading.Lock()

    def __call__(self, message: dict) -> None:
        # `allow_nan=False`: NaN/Infinity are not JSON; the caller gets a
        # ValueError (inside a stage it becomes a failed outcome).
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self._lock:
            self._stdout.write(line + "\n")
            self._stdout.flush()


def _windows_pipe_lines(stdin: TextIO) -> "Iterator[str] | None":
    """Lines of `stdin` when it is a Windows pipe, read without a pending read.

    A synchronous `ReadFile` left waiting on the pipe (what `for line in stdin`
    does from the reader thread) blocks every other operation on that handle
    until a line arrives - including the one OpenBLAS makes while numpy loads,
    so a stage's first `import numpy` hung forever. Polling `PeekNamedPipe`
    and reading only the bytes already there leaves the handle free. Returns
    None when stdin is not a pipe (a file or the console): plain reads then.
    """
    try:
        import msvcrt
        import _winapi
    except ImportError:  # pragma: no cover - not Windows
        return None
    fd = stdin.fileno()
    handle = msvcrt.get_osfhandle(fd)
    encoding = getattr(stdin, "encoding", None) or "utf-8"
    errors = getattr(stdin, "errors", None) or "surrogateescape"
    try:
        _winapi.PeekNamedPipe(handle)
    except OSError as err:
        if err.winerror == 109:  # ERROR_BROKEN_PIPE: the writer is already gone
            return iter(())
        return None  # not a pipe

    def lines() -> Iterator[str]:
        pending = b""
        while True:
            try:
                available = _winapi.PeekNamedPipe(handle)[0]
            except OSError:  # the writer closed the pipe
                break
            if not available:
                time.sleep(0.02)
                continue
            chunk = os.read(fd, min(available, 65536))
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                yield line.decode(encoding, errors)
        if pending:
            yield pending.decode(encoding, errors)

    return lines()


def _lines(stdin: TextIO) -> Iterator[str]:
    if sys.platform == "win32":
        pipe = _windows_pipe_lines(stdin)
        if pipe is not None:
            return pipe
    return iter(stdin)


def _reader(stdin: TextIO, inbox: "queue.Queue[dict | None]") -> None:
    for raw in _lines(stdin):
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            inbox.put({"type": "__invalid__", "raw": raw, "why": "invalid JSON"})
            continue
        if not isinstance(message, dict):
            inbox.put({"type": "__invalid__", "raw": raw, "why": "line is not a JSON object"})
            continue
        inbox.put(message)
    inbox.put(None)


def _run_call(message: dict, emit: Emitter, cancel: threading.Event) -> None:
    request_id = message.get("requestId")
    call_id = str(message.get("callId", ""))
    entry = str(message.get("entry", ""))
    stage = registry.get(entry)
    if stage is None:
        emit(error_message(request_id, ENTRY_UNKNOWN, f"no stage named {entry!r}"))
        return
    try:
        inputs = validate_inputs(stage, dict(message.get("inputs") or {}))
    except InputError as err:
        emit(error_message(request_id, INPUT_INVALID, str(err)))
        return
    ctx = Context(call_id, dict(message.get("context") or {}), emit, cancel)
    try:
        stage.fn(ctx, **inputs)
    except StageFailed as err:
        emit(outcome_message(call_id, "fail", reason=str(err)))
    except Stopped:
        emit(outcome_message(call_id, "stopped"))
    except NeedsApproval as err:
        emit(outcome_message(call_id, "needs_approval", message=err.message))
    except SystemExit as err:
        # Reused CLI code calling sys.exit() must not end the worker.
        emit(outcome_message(call_id, "fail", reason=f"SystemExit: {err.code}"))
    except Exception as err:  # noqa: BLE001 - any stage error becomes a failed outcome
        ctx.log(traceback.format_exc(), level="error")
        emit(outcome_message(call_id, "fail", reason=f"{type(err).__name__}: {err}"))
    else:
        emit(outcome_message(call_id, "ok"))


def run_loop(module_name: str, stdin: TextIO, stdout: TextIO, stderr: TextIO, describe_only: bool = False) -> int:
    emit = Emitter(stdout)
    try:
        importlib.import_module(module_name)
    except Exception as err:  # noqa: BLE001
        emit(error_message(None, PROTOCOL, f"cannot import {module_name!r}: {type(err).__name__}: {err}"))
        stderr.write(traceback.format_exc())
        return 2
    if describe_only:
        emit(manifest_message("describe", module_name, registry.stages()))
        return 0
    inbox: "queue.Queue[dict | None]" = queue.Queue()
    threading.Thread(target=_reader, args=(stdin, inbox), daemon=True).start()
    # Messages a call's watcher held back, handled (in order) before the inbox.
    backlog: "collections.deque[dict | None]" = collections.deque()
    cancel = threading.Event()
    while True:
        message = backlog.popleft() if backlog else inbox.get()
        if message is None:
            return 0
        kind = message.get("type")
        if kind == "describe":
            emit(manifest_message(str(message.get("requestId", "")), module_name, registry.stages()))
        elif kind == "call":
            cancel.clear()
            # Messages that arrive during the call are read by the reader thread;
            # a helper thread watches for this call's `cancel` and holds the rest.
            stop_watch = threading.Event()
            held: "list[dict | None]" = []

            def watch() -> None:
                while not stop_watch.is_set():
                    try:
                        pending = inbox.get(timeout=0.05)
                    except queue.Empty:
                        continue
                    if pending is None:
                        # stdin closed: stop the stage; the loop ends after it.
                        cancel.set()
                        held.append(None)
                        return
                    if pending.get("type") == "cancel" and str(pending.get("callId", "")) == str(message.get("callId", "")):
                        cancel.set()
                        continue
                    if pending.get("type") == "shutdown":
                        cancel.set()
                    held.append(pending)

            watcher = threading.Thread(target=watch, daemon=True)
            watcher.start()
            try:
                _run_call(message, emit, cancel)
            finally:
                stop_watch.set()
                watcher.join()
                backlog.extend(held)
        elif kind == "cancel":
            pass  # nothing is running
        elif kind == "shutdown":
            return 0
        elif kind == "__invalid__":
            emit(error_message(None, PROTOCOL, f"{message.get('why')}: {str(message.get('raw'))[:200]}"))
        else:
            emit(error_message(message.get("requestId"), PROTOCOL, f"unknown message type {kind!r}"))
