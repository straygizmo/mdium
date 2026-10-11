# python-demo

A sample project with two python stages that run through `mdium-worker`.

## Set up

From this directory, create the virtual environment and install the worker package:

```
uv venv .venv
uv pip install --python .venv -e ../../../../../python/mdium-worker
```

(The `setup` section of `.mdium/project.yaml` runs the same two commands.)

When MDium runs under `tauri dev`, writes under `src-tauri/` would restart the
app; `src-tauri/.taurignore` excludes `tests/` so Setup and runs of this fixture
do not trigger a restart. Restart `tauri dev` after adding or changing that file.

## Run

Open this folder in MDium, then run the `main` flow. `demo.add` computes `a + 1`
(default `a` is 2, so the `sum` output is 3), and `demo.ask` waits for your
approval before the run completes.
