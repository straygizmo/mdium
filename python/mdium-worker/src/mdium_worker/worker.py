"""The worker loop: reads requests on stdin, runs stages, writes events on stdout."""
from __future__ import annotations

import importlib
import json
import queue
import threading
import traceback
from typing import TextIO

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
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._stdout.write(line + "\n")
            self._stdout.flush()


def _reader(stdin: TextIO, inbox: "queue.Queue[dict | None]") -> None:
    for raw in stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            inbox.put({"type": "__invalid__", "raw": raw})
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
    cancel = threading.Event()
    while True:
        message = inbox.get()
        if message is None:
            return 0
        kind = message.get("type")
        if kind == "describe":
            emit(manifest_message(str(message.get("requestId", "")), module_name, registry.stages()))
        elif kind == "call":
            cancel.clear()
            # Cancel requests that arrive during the call are read by the reader thread
            # and handled here: drain the inbox non-blockingly from a helper thread.
            stop_watch = threading.Event()

            def watch() -> None:
                while not stop_watch.is_set():
                    try:
                        pending = inbox.get(timeout=0.05)
                    except queue.Empty:
                        continue
                    if pending is None:
                        cancel.set()
                        inbox.put(None)
                        return
                    if pending.get("type") == "cancel" and str(pending.get("callId", "")) == str(message.get("callId", "")):
                        cancel.set()
                    elif pending.get("type") == "shutdown":
                        cancel.set()
                        inbox.put(pending)
                    else:
                        inbox.put(pending)

            watcher = threading.Thread(target=watch, daemon=True)
            watcher.start()
            try:
                _run_call(message, emit, cancel)
            finally:
                stop_watch.set()
                watcher.join()
        elif kind == "cancel":
            pass  # nothing is running
        elif kind == "shutdown":
            return 0
        else:
            emit(error_message(message.get("requestId"), PROTOCOL, f"unknown message type {kind!r}"))
