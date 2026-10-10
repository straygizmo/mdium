# mdium-worker

The worker side of MDium's python flow nodes. MDium launches `python -m mdium_worker --module <module>` and talks to it with JSON lines over stdin/stdout (protocol `mdium-worker-v1`). The package uses only the standard library; app authors import `stage` and `Context` from it to declare stages.

```python
from mdium_worker import Context, StageFailed, stage


@stage("demo.add", description="Adds two numbers",
       inputs={"a": {"type": "number", "required": True}, "b": {"type": "number", "default": 1}},
       outputs={"sum": {"type": "number"}})
def add(ctx: Context, a: float, b: float = 1) -> None:
    ctx.progress("adding", fraction=0.5)
    ctx.output("sum", a + b)
```

Run the tests from the repository root with `uv run --project python/mdium-worker pytest -q`.
