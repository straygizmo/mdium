import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def start(tmp_path: Path, *extra: str) -> subprocess.Popen:
    env = dict(os.environ, PYTHONPATH=str(ROOT), MDIUM_FLOW_STOP_FILE=str(tmp_path / "STOP"))
    return subprocess.Popen(
        [sys.executable, "-m", "mdium_worker", "--module", "sample_module", *extra],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, bufsize=1,
    )


def send(proc: subprocess.Popen, message: dict) -> None:
    proc.stdin.write(json.dumps({"v": 1, **message}) + "\n")
    proc.stdin.flush()


def read_until(proc: subprocess.Popen, predicate, timeout: float = 10.0) -> list[dict]:
    lines: list[dict] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        lines.append(json.loads(line))
        if predicate(lines[-1]):
            return lines
    raise AssertionError(f"timed out; got {lines}")


def call(proc, request_id, call_id, entry, inputs, tmp_path):
    send(proc, {"type": "call", "requestId": request_id, "callId": call_id, "entry": entry, "inputs": inputs,
                "context": {"runId": "r", "nodeKey": "n", "nodeDir": str(tmp_path), "projectRoot": str(tmp_path),
                            "stopFile": str(tmp_path / "STOP"), "attempt": 1}})


def test_describe_and_successful_call(tmp_path):
    proc = start(tmp_path)
    try:
        send(proc, {"type": "describe", "requestId": "1"})
        [manifest] = read_until(proc, lambda m: m["type"] == "manifest")
        assert manifest["requestId"] == "1" and manifest["module"] == "sample_module"
        names = {s["name"] for s in manifest["stages"]}
        assert {"demo.add", "demo.fail", "demo.crash", "demo.ask", "demo.wait"} <= names
        add = next(s for s in manifest["stages"] if s["name"] == "demo.add")
        assert add["inputs"]["a"] == {"type": "number", "required": True}
        assert add["inputs"]["b"]["default"] == 1
        call(proc, "2", "c2", "demo.add", {"a": 2}, tmp_path)
        lines = read_until(proc, lambda m: m["type"] == "outcome")
        kinds = [m["type"] for m in lines]
        assert kinds == ["progress", "log", "output", "outcome"]
        assert all(m["callId"] == "c2" for m in lines)
        assert lines[2]["key"] == "sum" and lines[2]["value"] == 3
        assert lines[-1]["status"] == "ok"
        send(proc, {"type": "shutdown"})
        assert proc.wait(timeout=10) == 0
    finally:
        proc.kill()


def test_failures_errors_and_approval(tmp_path):
    proc = start(tmp_path)
    try:
        call(proc, "1", "c1", "demo.fail", {}, tmp_path)
        [out] = read_until(proc, lambda m: m["type"] == "outcome")
        assert out["status"] == "fail" and out["reason"] == "boom"
        call(proc, "2", "c2", "demo.crash", {}, tmp_path)
        lines = read_until(proc, lambda m: m["type"] == "outcome")
        assert lines[0]["type"] == "log" and lines[0]["level"] == "error" and "ValueError" in lines[0]["text"]
        assert lines[-1]["status"] == "fail" and "ValueError" in lines[-1]["reason"]
        call(proc, "3", "c3", "demo.ask", {}, tmp_path)
        [out] = read_until(proc, lambda m: m["type"] == "outcome")
        assert out["status"] == "needs_approval" and out["message"] == "go?"
        call(proc, "4", "c4", "demo.nope", {}, tmp_path)
        [err] = read_until(proc, lambda m: m["type"] == "error")
        assert err["requestId"] == "4" and err["code"] == "FLOW_PYTHON_ENTRY_UNKNOWN"
        call(proc, "5", "c5", "demo.add", {"a": "two"}, tmp_path)
        [err] = read_until(proc, lambda m: m["type"] == "error")
        assert err["code"] == "FLOW_PYTHON_INPUT_INVALID" and "a" in err["message"]
        # The worker is still alive after errors.
        call(proc, "6", "c6", "demo.add", {"a": 1}, tmp_path)
        assert read_until(proc, lambda m: m["type"] == "outcome")[-1]["status"] == "ok"
    finally:
        proc.kill()


def test_cancel_and_stop_file(tmp_path):
    proc = start(tmp_path)
    try:
        call(proc, "1", "c1", "demo.wait", {}, tmp_path)
        time.sleep(0.2)
        send(proc, {"type": "cancel", "callId": "c1"})
        [out] = read_until(proc, lambda m: m["type"] == "outcome")
        assert out["status"] == "stopped"
        call(proc, "2", "c2", "demo.wait", {}, tmp_path)
        time.sleep(0.2)
        (tmp_path / "STOP").write_text("")
        [out] = read_until(proc, lambda m: m["type"] == "outcome")
        assert out["status"] == "stopped"
    finally:
        proc.kill()


def test_describe_flag_prints_the_manifest_and_exits(tmp_path):
    proc = start(tmp_path, "--describe")
    out, _ = proc.communicate(timeout=20)
    assert proc.returncode == 0
    manifest = json.loads(out.strip().splitlines()[-1])
    assert manifest["type"] == "manifest" and manifest["module"] == "sample_module"
