import os
import threading
from pathlib import Path

from mdium_worker.context import Context


def make_context(sent: list[dict]) -> Context:
    return Context("c1", {}, sent.append, threading.Event())


def test_artifact_sends_an_absolute_path_resolved_against_the_cwd(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    sent: list[dict] = []
    make_context(sent).artifact(os.path.join("out", "x.png"), label="pic")
    [message] = sent
    assert message["type"] == "artifact"
    assert os.path.isabs(message["path"])
    assert message["path"].endswith(os.path.join("out", "x.png"))
    assert Path(message["path"]) == tmp_path / "out" / "x.png"
    assert message["label"] == "pic"


def test_artifact_keeps_an_absolute_path(tmp_path) -> None:
    sent: list[dict] = []
    target = tmp_path / "y.txt"
    make_context(sent).artifact(target)
    assert sent[0]["path"] == str(target)
