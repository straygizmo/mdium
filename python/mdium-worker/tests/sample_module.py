"""A module with a few stages, used by the worker-loop tests."""
import sys
import time

from mdium_worker import Context, StageFailed, Stopped, stage


@stage("demo.add", description="Adds two numbers",
       inputs={"a": {"type": "number", "required": True}, "b": {"type": "number", "default": 1}},
       outputs={"sum": {"type": "number"}})
def add(ctx: Context, a: float, b: float = 1) -> None:
    ctx.progress("adding", fraction=0.5)
    ctx.log("hello from add")
    ctx.output("sum", a + b)


@stage("demo.fail")
def fail(ctx: Context) -> None:
    raise StageFailed("boom")


@stage("demo.crash")
def crash(ctx: Context) -> None:
    raise ValueError("unexpected")


@stage("demo.ask")
def ask(ctx: Context) -> None:
    ctx.needs_approval("go?")


@stage("demo.wait")
def wait(ctx: Context) -> None:
    for _ in range(200):
        if ctx.should_stop():
            raise Stopped()
        time.sleep(0.05)
    ctx.output("done", True)


@stage("demo.echo", inputs={"text": {"type": "string", "required": True}}, outputs={"text": {"type": "string"}})
def echo(ctx: Context, text: str) -> None:
    ctx.log(text)
    ctx.output("text", text)


@stage("demo.optional", inputs={"x": {"type": "string", "default": None}}, outputs={"got": {"type": "bool"}})
def optional(ctx: Context, x: "str | None" = None) -> None:
    ctx.output("got", x is not None)


@stage("demo.exit")
def exits(ctx: Context) -> None:
    sys.exit(3)


@stage("demo.surrogate")
def surrogate(ctx: Context) -> None:
    # A lone surrogate, as os.fsdecode gives for an undecodable filename.
    ctx.log("file \udcff")
    raise StageFailed("cannot open \udcff")


@stage("demo.nan")
def nan(ctx: Context) -> None:
    ctx.output("x", float("nan"))
