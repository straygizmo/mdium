"""Stages of the python-demo fixture project."""
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
