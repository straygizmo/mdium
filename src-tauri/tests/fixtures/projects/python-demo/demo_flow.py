"""Stages of the python-demo fixture project."""
import json
import os
import struct
import zlib

from mdium_worker import Context, stage


@stage("demo.add", description="Adds two numbers",
       inputs={"a": {"type": "number", "required": True}, "b": {"type": "number", "default": 1}},
       outputs={"sum": {"type": "number"}})
def add(ctx: Context, a: float, b: float = 1) -> None:
    ctx.progress("adding", fraction=0.5)
    ctx.log("hello from demo.add")
    ctx.output("sum", a + b)


@stage("demo.ask", description="Asks for approval")
def ask(ctx: Context) -> None:
    ctx.needs_approval("continue?")


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid-colour PNG built with the standard library only."""
    row = b"\x00" + bytes(rgb) * width
    raw = row * height

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


@stage("demo.render", description="Writes an image, a markdown note and a JSON file as artifacts",
       inputs={"text": {"type": "string", "default": "hello"}},
       outputs={"count": {"type": "number"}},
       artifacts=[{"label": "pic", "mediaType": "image/png"}, {"label": "notes"}, {"label": "data"}])
def render(ctx: Context, text: str = "hello") -> None:
    os.makedirs("out", exist_ok=True)
    with open("out/pic.png", "wb") as f:
        f.write(_png(96, 64, (70, 110, 220)))
    with open("out/notes.md", "w", encoding="utf-8") as f:
        f.write(f"# Notes\n\n{text}\n")
    with open("out/data.json", "w", encoding="utf-8") as f:
        json.dump({"text": text, "width": 96, "height": 64}, f, indent=2)
    ctx.progress("rendered", fraction=1.0)
    ctx.artifact("out/pic.png", label="pic", media_type="image/png")
    ctx.artifact("out/notes.md", label="notes")
    ctx.artifact("out/data.json", label="data")
    ctx.output("count", 3)


@stage("demo.echo", description="Logs the reviewer's decision and comment",
       inputs={"note": {"type": "string", "default": ""}, "choice": {"type": "string", "default": ""}},
       outputs={"echoed": {"type": "string"}})
def echo(ctx: Context, note: str = "", choice: str = "") -> None:
    ctx.log(f"review choice={choice!r} comment={note!r}")
    ctx.output("echoed", f"{choice}: {note}")
