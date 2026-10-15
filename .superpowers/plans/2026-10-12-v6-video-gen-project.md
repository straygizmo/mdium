# V6 video_gen Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run video_gen's production cycle (observe → evaluate → plan → approve → generate stories → produce videos → record) as a portable mdium project: a `.mdium/project.yaml`, one entry flow plus four parts, and a `video_gen_flow/` package that exposes the existing Python functions as worker stages without changing their behaviour.

**Architecture:** Two repositories. In **mdium**, flow `params` gain the `object` and `array` types so that a planner's genre list and constraints can be passed to parts (the engine already preserves JSON types for single-reference templates). In **video_gen**, `run_video_pipeline` is rewritten as a sequence of module-level stage functions over a small `PipelineRun` record (same files, same `run_state.json` marks, same keyword arguments, existing tests untouched), and `video_gen_flow/{portfolio,story,video}.py` wrap those functions plus the orchestrator / planner / evaluator / multi-story / audit / revise entry points as `@stage`s. Every stage reads and writes the files the pipeline already persists (`run_state.json`, `script.json`, `composition.json`, …) so consecutive stages are independent worker calls and resume for free. The flows are the spec's 9.3 shapes with three adjustments: the video dir is derived from the story dir by `video.label`, the review loop closes on a `video.review_ready` node so outputs are always resolved, and `quality` / `pacing` / `review_build` run unconditionally as no-ops when disabled (a `when`-skipped node would leave the part's outputs unresolved).

**Tech Stack:** mdium: Rust `flow-core` (serde, cargo test), TypeScript (vitest). video_gen: Python 3.12, `uv`, pytest, `mdium-worker` (path dependency on the sibling mdium checkout), existing fakes in `tests/test_video_pipeline.py`.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` — chapters 2 (manifest), 3 (python node), 4 (worker API), 5.1 (artifacts), 9 (video_gen project: 9.1 layout, 9.2 stages, 9.3 flows, 9.5 not migrated), 12 row V6, 13 (tests: "existing `run_video_pipeline` tests keep passing; stage unit tests use the existing fake providers"), 14 (risk: "rewrite `run_video_pipeline` as a sequence of stage functions, keep the per-stage `_mark`"), 16.6 (loop bodies). Requires V5b merged (`docs/portable-projects-spec` at afec34e).

## Global Constraints

- Spec 7.4 / 1.2: **no video_gen-specific code in mdium.** The only mdium change is Task 1 (param types). Everything else lives in `C:\Users\mtmar\source\repos\video_gen`.
- Spec 9.2 / 14: existing video_gen behaviour is preserved. `run_video_pipeline(story_text, out_dir, cfg=None, *, labeler=None, script_provider=None, image_provider=None, tts=None, renderer=None, evaluator=None, repace_synth=None, title="video", resume=True, story_dir=None, continuity_gate=False, force_continuity=False, auditor=None, min_continuity_score=None) -> VideoRunResult` keeps its signature, keyword names, stage marks (`label`, `script`, `voice`, `assets`, `ir`, `render`, `improve`, `pacing`, `review`) and the files it writes. `orchestrator.run_cycle` / `_generate` / `_observe` and the `generate_fn(...)` kwargs stay unchanged. All existing tests in the **scoped suite** keep passing. The whole `tests/` directory has many pre-existing failures on main (and one crashes pytest's reporter), and `uv run pytest -q` from the root also collects a stray junk directory, so the suite for this plan is the 17 modules that cover the touched code plus this plan's new files — the SCOPED SUITE command: `uv run pytest tests/test_orchestrator.py tests/test_orchestrator_e2e.py tests/test_production_planner.py tests/test_portfolio_evaluator.py tests/test_production_ledger.py tests/test_multi_story_resume_scan.py tests/test_multi_story_finalize.py tests/test_video_pipeline.py tests/test_story_continuity_audit.py tests/test_video_revise.py tests/test_video_repace.py tests/test_video_composition.py tests/test_video_evaluator.py tests/test_video_ffmpeg_compiler.py tests/test_video_mlt_exporter.py tests/test_rate_limit_retry.py tests/test_quota_error_handling.py tests/test_video_gen_flow_*.py tests/test_video_pipeline_stages.py -q -p no:cacheprovider` (glob files that do not exist yet are simply absent). Baseline on main 93af470: 379 passed. There is no conftest; the repo root is the import root.
- Spec 4: stages are `@stage("<group>.<name>", description=..., inputs={...}, outputs={...}, artifacts=[...])` functions `fn(ctx: Context, **inputs)`; input types are `string` / `number` / `bool` / `path` / `object` / `array`; failures raise `mdium_worker.StageFailed(reason)`; `ctx.should_stop()` is checked at story and scene boundaries; `ctx.artifact(path, label=, media_type=)` records files (relative paths resolve against the runtime `cwd`, which is the project root).
- Spec 9.2: stage names are exactly `portfolio.observe`, `portfolio.evaluate`, `portfolio.plan`, `portfolio.record`, `story.init_run`, `story.generate_next`, `story.list_stories`, `story.continuity_audit`, `video.label`, `video.script`, `video.voice`, `video.assets`, `video.ir`, `video.render`, `video.quality`, `video.pacing`, `video.review_build`, `video.revise`, plus the added `video.review_ready` (see Task 7). `video.assets` records scene images and audio with `label: scene_NN` and character references with `label: char_<name>`.
- Spec 2.1 / 9.1: `.mdium/project.yaml` has `schemaVersion: 1`, `id: video-gen`, `runtimes.video_gen: { kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: video_gen_flow, cwd: ., env: { PYTHONUTF8: "1" } }`, `setup: [{ run: [uv, sync] }]`, `secrets: [GOOGLE_API_KEY, ANTHROPIC_API_KEY]`, `flows: { main: flows/production-cycle.flow.yaml }`, `metrics` as in 2.1. `pyproject.toml` adds `mdium-worker` as a path dependency on `../mdium/python/mdium-worker` (editable, `[tool.uv.sources]`).
- Spec 9.1 / 16.2: flow files are `.mdium/flows/production-cycle.flow.yaml` (entry) and `.mdium/flows/lib/{story-run,video,video-assets,video-review}.flow.yaml` (parts). Node ids `[a-z0-9_]+`, flow ids `[a-z0-9-]+`; file-bodied loops receive only `params`; `maxIterations` is a literal number (not templatable); `python` nodes name `runtime: video_gen`.
- Spec 9.4 / 12: `improve.flow.yaml` is **not** part of V6 (it needs V7's `agent` nodes and `mdium:` templates and V8's actions); V6 delivers one entry flow and four parts. Record this in spec chapter 12 row V6 (Task 8).
- Spec 9.5: no chapter-level nodes; Gradio UIs and `run_story_loop.ps1` untouched; `rate_limit_retry` untouched (its sleeps are bounded by node `timeout`).
- Env: `video_gen_flow/__init__.py` calls `load_dotenv()` once (the repo keeps optional keys in `.env`); the two secrets are still required in the machine environment (mdium checks them before starting a run).
- Rust sources are CRLF: no line-ending churn. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never commit `src-tauri/gen/schemas/*.json` in mdium. Baselines: mdium on afec34e — flow-core 242 / mdium 731 / vitest 2048 / pytest 31; video_gen SCOPED SUITE — 379 passed on main; new tests only add.
- Execution note for the controller: Task 1 runs in an mdium worktree (branch `feat/param-object-array` from `docs/portable-projects-spec`); Tasks 2–8 run in the video_gen repository on a new branch `feat/mdium-flow` (create a worktree `video_gen/.worktrees/feat-mdium-flow` only if the main checkout is dirty; `.venv` is in-repo, so a worktree needs its own `uv sync`). The video_gen tasks import `mdium_worker` from the mdium checkout at `../mdium` (path dependency).

## Review Focus

1. Re-running `video.label` on a story whose `video/` already has `run_state.json` with `label` done must not redo the labelling (and the same for every later stage): the pipeline's resume marks are honoured by the stage wrappers — Task 6 test `stages honour existing run_state marks`.
2. `story.generate_next` on a run dir that already holds `count` completed stories must report `done: true` without calling `run_multi_story` — Task 4 test `generate_next is done when the run already has count stories`.
3. `story.continuity_audit` when the auditor raises `AuditError` must produce `eligible: false, score: 0` (the flow's `blocked` branch), not a failed node — Task 4 test `continuity_audit maps AuditError to not eligible`.
4. `video.revise` with a comment that is not valid revision JSON must fail with a readable reason and leave the rendered video untouched — Task 6 test `revise rejects malformed feedback without touching the video`.
5. Rejecting `approve_order` must end the flow with no error and no stories generated (the `reject` port has no edge) — covered structurally by Task 7's flow consistency test `approval ports without edges are intentional` (asserts `approve_order` has exactly one outgoing edge, on `approve`), and by the desktop smoke in Task 8.

---

### Task 1 (mdium): `object` and `array` flow parameter types

**Files:**
- Modify: `src-tauri/crates/flow-core/src/model.rs` (`ParamType`), `src-tauri/crates/flow-core/src/validate.rs:200-212` (default type check), `src-tauri/crates/flow-core/src/load.rs:395-402` and `:430-436` (static subflow param check and the type-name mapping), `src-tauri/crates/flow-core/src/run/prepare.rs:128-136` (`prepare_params`), `src-tauri/crates/flow-core/src/tests.rs`, `src-tauri/crates/flow-core/src/run/tests.rs`
- Modify: `src/shared/types/flow.ts:18` (`FlowParamType`), `src/features/flow/components/attrs/FlowAttrsForm.tsx:17-40` (`PARAM_TYPES`, `parseDefault`, `formatDefault` if present), `src/features/flow/components/__tests__/AttributeForms.test.tsx`
- Modify: `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` 16.1 (one sentence: flow `params` accept `object` / `array`, matching the manifest input types of 3.4) and chapter 12 row V5 memo (the "`string` only" deviation now has a follow-up: parts can declare `object` / `array`; extraction still infers `string`).

**Interfaces:**
- Produces: `ParamType::{String, Number, Bool, Path, Object, Array}` (serde lowercase `object` / `array`); `prepare_params` accepts `Value::Object` for `Object`, `Value::Array` for `Array`; the validator's `default` check and `load.rs`'s constant check do the same; `param_type_name` maps to `"object"` / `"array"`. TS `FlowParamType = "string" | "number" | "bool" | "path" | "object" | "array"`; `parseDefault("object", text)` / `parseDefault("array", text)` parse JSON and reject a non-matching shape.

- [ ] **Step 1: Write the failing Rust tests** in `src-tauri/crates/flow-core/src/run/tests.rs` (next to the existing `prepare_params` tests) and `src-tauri/crates/flow-core/src/tests.rs` (next to the `params.*.default` type-mismatch test):

```rust
#[test]
fn prepare_params_accepts_object_and_array_values() {
    let flow = parse_flow(
        "schemaVersion: 1\nid: p\nname: P\nparams:\n  genres: { type: array }\n  constraints: { type: object, default: {} }\nnodes:\n  - { id: a, kind: command, run: [echo] }\n",
    );
    let mut given = BTreeMap::new();
    given.insert("genres".to_string(), serde_json::json!(["Mystery", "Comedy"]));
    let out = prepare_params(&flow, &given).expect("array accepted");
    assert_eq!(out["genres"], serde_json::json!(["Mystery", "Comedy"]));
    assert_eq!(out["constraints"], serde_json::json!({}));
    let mut bad = BTreeMap::new();
    bad.insert("genres".to_string(), serde_json::json!("Mystery"));
    let err = prepare_params(&flow, &bad).unwrap_err();
    assert_eq!(err[0].code, FLOW_PARAM_INVALID);
}
```

```rust
#[test]
fn object_param_default_must_be_an_object() {
    let issues = validate_text("schemaVersion: 1\nid: p\nname: P\nparams:\n  c: { type: object, default: [1] }\nnodes:\n  - { id: a, kind: command, run: [echo] }\n");
    assert_eq!(reasons_of(&issues)[0].2, "type-mismatch");
    let ok = validate_text("schemaVersion: 1\nid: p\nname: P\nparams:\n  c: { type: object, default: { x: 1 } }\n  l: { type: array, default: [] }\nnodes:\n  - { id: a, kind: command, run: [echo] }\n");
    assert!(ok.errors.is_empty());
}
```

(Use the file's existing helpers — `parse_flow` / `validate_text` / `reasons_of` are the names used by neighbouring tests; adopt whatever those tests actually call.)

- [ ] **Step 2: Run to verify they fail**: `cd src-tauri && cargo test -p flow-core object_and_array -- --nocapture` and `cargo test -p flow-core object_param_default` → FAIL (`unknown variant object`).

- [ ] **Step 3: Implement** — add the two variants to `ParamType`; extend the three `match def.ty` sites with `ParamType::Object => value.is_object(), ParamType::Array => value.is_array()`; extend `param_type_name` (load.rs ~432) with `"object"` / `"array"`. Nothing else in the engine inspects `ParamType`.

- [ ] **Step 4: Run** `cargo test -p flow-core` → green (244 tests).

- [ ] **Step 5: Write the failing TS test** in `AttributeForms.test.tsx`:

```ts
it("parses object and array defaults as JSON", () => {
  expect(parseDefault("array", '["a", "b"]')).toEqual(["a", "b"]);
  expect(parseDefault("object", '{"x": 1}')).toEqual({ x: 1 });
  expect(parseDefault("array", '{"x": 1}')).toBeUndefined();
  expect(parseDefault("object", "not json")).toBeUndefined();
});
```

Run: `npx vitest run src/features/flow/components/__tests__/AttributeForms.test.tsx` → FAIL (type error / undefined behaviour).

- [ ] **Step 6: Implement** — extend `FlowParamType`, `PARAM_TYPES = ["string", "number", "bool", "path", "object", "array"]`, `parseDefault` (`JSON.parse` in try/catch; `array` requires `Array.isArray`, `object` requires a non-null non-array object; otherwise `undefined`), and the inverse formatter (`JSON.stringify` for the two new types). Export `parseDefault` if it is not exported yet.

- [ ] **Step 7: Run** `npx vitest run src/features/flow` and `npx tsc --noEmit -p tsconfig.json` → green. Then the spec edits.

- [ ] **Step 8: Commit** `feat(flow): object and array parameter types`.

---

### Task 2 (video_gen): scaffold — package, dependency, manifest, test harness, portfolio stages

**Files:**
- Modify: `pyproject.toml` (add `mdium-worker` dependency + `[tool.uv.sources]` path entry), `.gitignore` (add `.mdium/flow-runs/` and `.mdium/setup-runs/`)
- Create: `.mdium/project.yaml`, `video_gen_flow/__init__.py`, `video_gen_flow/portfolio.py`, `tests/flow_support.py`, `tests/test_video_gen_flow_portfolio.py`

**Interfaces:**
- Produces (used by Tasks 3–7):
  - `tests/flow_support.py`: `make_ctx(tmp_path, project_root=None) -> tuple[Context, list[dict]]` — a real `mdium_worker.Context(call_id="t", context={"runId": "r", "nodeDir": str(tmp_path / "node"), "projectRoot": str(project_root or tmp_path)}, emit=events.append, cancel=threading.Event())` whose `events` list records every message; helpers `outputs(events) -> dict` (`{e["key"]: e["value"] for e in events if e["type"] == "output"}`) and `artifacts(events) -> list[dict]`.
  - `video_gen_flow/__init__.py`: `from dotenv import load_dotenv; load_dotenv()` then `from . import portfolio, story, video  # noqa: F401` (story and video are added by Tasks 4 and 6 — import only the modules that exist at each task; the final file imports all three).
  - `video_gen_flow/portfolio.py` stages:
    - `portfolio.observe` inputs `{outputRoot: {type: path, default: "output"}, ledgerPath: {type: path, default: "output/production_ledger.json"}}` → outputs `ledgerPath (path)`, `statePath (path)`, `recordCount (number)`, `coverageByLevel (object)`; artifact `state` (`<nodeDir>/state.json`).
    - `portfolio.evaluate` inputs `{ledgerPath: {type: path, required: true}, comments: {type: array, default: []}}` → outputs `reportPath (path)`, `findingsPath (path)`; artifacts `report`, `findings`.
    - `portfolio.plan` inputs `{ledgerPath: {type: path, required: true}, reportPath: {type: path, required: true}, constraints: {type: object, default: {}}, planner: {type: string, default: "mcp"}}` → outputs `orderPath (path)`, `order (object)`, `level (string)`, `genres (array)`, `count (number)`, `relationship (string)`, `durationMode (string)`, `imageStyle (string)`, `ttsEngine (string)`; artifact `order`.
    - `portfolio.record` inputs like `observe` → outputs `recordedCount (number)`, `avgVideoCoherence (number)`, `coverage (number)`.
  - Module-level injection points (tests monkeypatch them): `portfolio.agent_runner_factory: Callable[[], AgentRunner]` (default `lambda: claude_agent_runner.ClaudeAgentRunner()`), `portfolio.planner_llm_factory: Callable[[str], Callable[[str], str]]` (default `orchestrate._make_planner_llm`), `portfolio.total_vocab: Callable[[list[str]], dict[str, int]]` (default `orchestrator.load_total_vocab`).

- [ ] **Step 1: Baseline** — `cd C:\Users\mtmar\source\repos\video_gen && git checkout -b feat/mdium-flow` (already done by the controller) and run the SCOPED SUITE command from Global Constraints; record the count in the ledger (379 on main).

- [ ] **Step 2: Dependency** — in `pyproject.toml` add `"mdium-worker"` to `dependencies` and under `[tool.uv.sources]` add `mdium-worker = { path = "../mdium/python/mdium-worker", editable = true }`; run `uv sync`; verify `uv run python -c "import mdium_worker; print(mdium_worker.__name__)"`.

- [ ] **Step 3: Manifest** — write `.mdium/project.yaml`:

```yaml
schemaVersion: 1
id: video-gen
name: CEFR video generator
description: Generates CEFR-graded stories and produces narrated videos from them.
runtimes:
  video_gen:
    kind: python
    python: [.venv/Scripts/python.exe, .venv/bin/python]
    module: video_gen_flow
    cwd: .
    env: { PYTHONUTF8: "1" }
setup:
  - { run: [uv, sync] }
secrets: [GOOGLE_API_KEY, ANTHROPIC_API_KEY]
flows:
  main: flows/production-cycle.flow.yaml
metrics:
  - { ref: outputs.avgVideoCoherence, better: higher }
  - { ref: outputs.coverage, better: higher }
  - { ref: costUsd, better: lower }
```

Add `.mdium/flow-runs/` and `.mdium/setup-runs/` to `.gitignore`.

- [ ] **Step 4: Write the failing tests** `tests/test_video_gen_flow_portfolio.py` (the fixtures mirror `tests/test_orchestrator.py`: a `tmp_path` run dir with one `story_01/` containing `beatsheet.json`, `diagnostics/chapter_01_attempt_01.json` with `{"verdict": {"passed": true}, ...}` and `story.txt`; copy the minimal shape that `production_ledger.records_from_run_dir` needs from `test_production_ledger.py`):

```python
import json
import threading
from pathlib import Path

import pytest

import video_gen_flow.portfolio as pf
from mdium_worker import registry
from tests.flow_support import artifacts, make_ctx, outputs


def test_portfolio_stages_are_registered():
    names = {s.name for s in registry.stages()}
    assert {"portfolio.observe", "portfolio.evaluate", "portfolio.plan", "portfolio.record"} <= names


def test_observe_writes_state_and_outputs(tmp_path, monkeypatch, sample_run):
    monkeypatch.setattr(pf, "total_vocab", lambda levels: {lvl: 100 for lvl in levels})
    ctx, events = make_ctx(tmp_path)
    ledger = tmp_path / "output" / "production_ledger.json"
    pf.observe(ctx, outputRoot=str(sample_run.parent), ledgerPath=str(ledger))
    out = outputs(events)
    assert out["recordCount"] == 1
    assert Path(out["statePath"]).exists()
    assert json.loads(Path(out["statePath"]).read_text(encoding="utf-8"))["coverage_by_level"]
    assert artifacts(events)[0]["label"] == "state"


def test_evaluate_uses_injected_runner_and_writes_report(tmp_path, monkeypatch, sample_ledger):
    monkeypatch.setattr(pf, "total_vocab", lambda levels: {lvl: 100 for lvl in levels})
    monkeypatch.setattr(pf, "agent_runner_factory", lambda: _FakeRunner())
    ctx, events = make_ctx(tmp_path)
    pf.evaluate(ctx, ledgerPath=str(sample_ledger), comments=["too slow"])
    out = outputs(events)
    report = json.loads(Path(out["reportPath"]).read_text(encoding="utf-8"))
    assert report["summary"] == "ok"
    assert {a["label"] for a in artifacts(events)} == {"report", "findings"}


def test_plan_outputs_order_fields(tmp_path, monkeypatch, sample_ledger, sample_report):
    monkeypatch.setattr(pf, "total_vocab", lambda levels: {lvl: 100 for lvl in levels})
    monkeypatch.setattr(pf, "planner_llm_factory", lambda kind: (lambda prompt: _ORDER_JSON))
    ctx, events = make_ctx(tmp_path)
    pf.plan(ctx, ledgerPath=str(sample_ledger), reportPath=str(sample_report), constraints={"max_stories": 3}, planner="mcp")
    out = outputs(events)
    assert out["level"] == "A2" and out["genres"] == ["Mystery"] and out["count"] == 2
    assert out["relationship"] == "independent" and out["durationMode"] == "3min"
    assert out["imageStyle"] == "Anime" and out["ttsEngine"] == "Gemini"
    assert json.loads(Path(out["orderPath"]).read_text(encoding="utf-8"))["cefr_level"] == "A2"
    assert out["order"]["count"] == 2


def test_record_reports_coherence_and_coverage(tmp_path, monkeypatch, sample_run_with_video):
    monkeypatch.setattr(pf, "total_vocab", lambda levels: {lvl: 100 for lvl in levels})
    ctx, events = make_ctx(tmp_path)
    pf.record(ctx, outputRoot=str(sample_run_with_video.parent), ledgerPath=str(tmp_path / "ledger.json"))
    out = outputs(events)
    assert out["recordedCount"] == 1
    assert out["avgVideoCoherence"] == pytest.approx(0.8)
    assert 0 <= out["coverage"] <= 100
```

with `_FakeRunner.__call__(self, request)` returning the evaluation JSON `tests/test_portfolio_evaluator.py` already uses (summary `"ok"`), and `_ORDER_JSON` = the order JSON `tests/test_production_planner.py` uses (level `a2`, genres `["Mystery"]`, count 2, relationship `independent`, `voice_policy: "gemini"`). Fixtures `sample_run`, `sample_ledger`, `sample_report`, `sample_run_with_video` build the minimal directory shapes (`sample_run_with_video` adds `story_01/video/composition.json` and `quality_report.json` so `video_metrics_from_story_dir` yields `video_coherence = 0.8`; copy the shape from `test_production_ledger.py`).

- [ ] **Step 5: Run to verify they fail**: `uv run pytest tests/test_video_gen_flow_portfolio.py -q` → FAIL (`ModuleNotFoundError: video_gen_flow`).

- [ ] **Step 6: Implement** `tests/flow_support.py` (as specified in Interfaces) and `video_gen_flow/portfolio.py`:

```python
"""Portfolio stages: observe the ledger, evaluate, plan, record (spec 9.2)."""
from __future__ import annotations

import dataclasses
import json
import os
from pathlib import Path
from typing import Callable

import orchestrator
import portfolio_evaluator as pe
import production_ledger as pl
import production_planner as pp
from genre_policy import VALID_LEVELS
from mdium_worker import Context, StageFailed, stage

# Injection points (tests replace these).
agent_runner_factory: Callable[[], pe.AgentRunner] = lambda: _default_agent_runner()
planner_llm_factory: Callable[[str], Callable[[str], str]] = lambda kind: _default_planner_llm(kind)
total_vocab: Callable[[list[str]], dict[str, int]] = orchestrator.load_total_vocab

VOICE_POLICY_ENGINE = {"google": "Google", "gemini": "Gemini", "minimax": "MiniMax"}


def _default_agent_runner():
    from claude_agent_runner import ClaudeAgentRunner
    return ClaudeAgentRunner()


def _default_planner_llm(kind: str):
    import orchestrate
    return orchestrate._make_planner_llm(kind)


def _state_from_ledger(ledger_path: str) -> tuple[list[pl.ContentRecord], pl.PortfolioState]:
    records = pl.load(ledger_path)
    state = pl.compute_portfolio_state(records, total_vocab_by_level=total_vocab(list(VALID_LEVELS)))
    return records, state


def _state_json(state: pl.PortfolioState) -> dict:
    data = dataclasses.asdict(state)
    data["distribution"] = {"/".join(k): v for k, v in state.distribution.items()}
    return data


def _node_file(ctx: Context, name: str) -> Path:
    base = Path(ctx.node_dir or ".")
    base.mkdir(parents=True, exist_ok=True)
    return base / name


@stage("portfolio.observe", description="Scans the output root into the ledger and summarises the portfolio",
       inputs={"outputRoot": {"type": "path", "default": "output"},
               "ledgerPath": {"type": "path", "default": pl.DEFAULT_LEDGER_PATH}},
       outputs={"ledgerPath": {"type": "path"}, "statePath": {"type": "path"},
                "recordCount": {"type": "number"}, "coverageByLevel": {"type": "object"}},
       artifacts=[{"label": "state", "mediaType": "application/json"}])
def observe(ctx: Context, outputRoot: str = "output", ledgerPath: str = pl.DEFAULT_LEDGER_PATH) -> None:
    ctx.progress("observing", fraction=0.1)
    records = orchestrator._observe(outputRoot, ledgerPath)
    state = pl.compute_portfolio_state(records, total_vocab_by_level=total_vocab(list(VALID_LEVELS)))
    state_path = _node_file(ctx, "state.json")
    state_path.write_text(json.dumps(_state_json(state), indent=2), encoding="utf-8")
    ctx.artifact(state_path, label="state", media_type="application/json")
    ctx.output("ledgerPath", ledgerPath)
    ctx.output("statePath", str(state_path))
    ctx.output("recordCount", len(records))
    ctx.output("coverageByLevel", dict(state.coverage_by_level))
```

`evaluate`: `records, state = _state_from_ledger(ledgerPath)`; `report, findings = pe.evaluate(state, records, agent_runner_factory(), comments=list(comments) or None)` inside `try/except (pe.EvaluationError, pe.EvaluationParseError) as exc: raise StageFailed(f"evaluation failed: {exc}")`; write `evaluation.json` / `findings.json` (`report.to_dict()` / `findings.to_dict()`) into the node dir; artifacts `report` / `findings`; outputs `reportPath` / `findingsPath`.

`plan`: reload `report = pe.EvaluationReport(**{f.name: data.get(f.name, [] if f.name != "summary" else "") for f in dataclasses.fields(pe.EvaluationReport)})` from `reportPath`; `order = pp.plan(state, report, dict(constraints), planner_llm_factory(planner))` inside `try/except pp.ProductionOrderError as exc: raise StageFailed(str(exc))`; write `order.json` (`order.to_dict()`) to the node dir, artifact `order`; outputs `orderPath`, `order` (dict), `level = order.cefr_level`, `genres = list(order.genres)`, `count = order.count`, `relationship = order.story_relationship`, `durationMode = order.duration_mode`, `imageStyle = order.image_style`, `ttsEngine = VOICE_POLICY_ENGINE.get((order.voice_policy or "gemini").lower(), "Gemini")`.

`record`: `records = orchestrator._observe(outputRoot, ledgerPath)`; `state = compute…`; `coherences = [r.video_coherence for r in records if r.video_coherence is not None]`; outputs `recordedCount = len(records)`, `avgVideoCoherence = sum(coherences)/len(coherences) if coherences else 0.0`, `coverage = sum(state.coverage_by_level.values())/len(state.coverage_by_level) if state.coverage_by_level else 0.0`.

- [ ] **Step 7: Run** `uv run pytest tests/test_video_gen_flow_portfolio.py -q` → PASS; `uv run python -m mdium_worker --module video_gen_flow --describe | head -c 400` prints a manifest containing `portfolio.observe`; the SCOPED SUITE → baseline + new tests.

- [ ] **Step 8: Commit** `feat(flow): mdium project manifest and portfolio stages`.

---

### Task 3 (video_gen): story stages

**Files:**
- Create: `video_gen_flow/story.py`, `tests/test_video_gen_flow_story.py`
- Modify: `video_gen_flow/__init__.py` (import `story`)

**Interfaces:**
- Produces:
  - `story.init_run` inputs `{level: {type: string, required: true}, resumeDir: {type: string, default: ""}, outputRoot: {type: path, default: "output"}}` → outputs `runDir (path)`. With `resumeDir` set, the directory must exist (`StageFailed` otherwise) and is returned as-is; otherwise the next free `<outputRoot>/<LEVEL>_<YYYYMMDD>_season_<NN>` (NN from 01, two digits, the same scheme `multi_story.run_multi_story` uses) is created and returned.
  - `story.generate_next` inputs `{runDir: path required, level: string required, genres: {type: array, default: []}, relationship: {type: string, default: "independent"}, durationMode: {type: string, default: "3min"}, count: {type: number, default: 1}, targetCoverage: {type: number, default: 95}, topicHints: {type: array, default: []}}` → outputs `storyDir (path)`, `index (number)`, `coverage (number)`, `done (bool)`. Behaviour: `completed, _ = multi_story._scan_run_directory(runDir)`; if `len(completed) >= count` → outputs `done: true`, `index = len(completed)`, `storyDir` = last completed dir, `coverage` from `list_stories`'s computation, and returns **without** calling `run_multi_story`; else calls `run_multi_story(level, max_stories=len(completed) + 1, resume_parent_dir=runDir, genres=list(genres) or None, story_relationship=relationship, chapter_duration_mode=durationMode, topic_hints=list(topicHints) or None, target_coverage=targetCoverage)`, raises `StageFailed(result.failure_reason)` when `not result.success`, else outputs the new story (`result.stories[-1].output_dir`, its `index`, `result.cumulative_coverage`) and `done = result.coverage_target_met or len(result.stories) >= count`. Checks `ctx.should_stop()` before starting (raises `mdium_worker.Stopped()`).
  - `story.list_stories` inputs `{runDir: path required, level: string required}` → outputs `storyDirs (array)` (completed story dirs sorted by index, as absolute path strings), `storyCount (number)`, `coverage (number)` (`len(union of used_words) / total_vocab[level] * 100`, 0 when no vocab).
  - `story.continuity_audit` inputs `{storyDir: path required, minScore: {type: number, default: 7}}` → outputs `eligible (bool)`, `score (number)`; artifact `audit` (`<storyDir>/continuity_audit.json`). `AuditError` → `eligible: false`, `score: 0`, `ctx.log(..., level="error")`.
  - Injection points: `story.run_multi_story` (module attribute, default `multi_story.run_multi_story`), `story.gate_story_dir` (default `story_continuity_audit.gate_story_dir`), `story.total_vocab` (default `orchestrator.load_total_vocab`).

- [ ] **Step 1: Write the failing tests** `tests/test_video_gen_flow_story.py`:

```python
import json
from pathlib import Path
from types import SimpleNamespace

import video_gen_flow.story as st
from tests.flow_support import artifacts, make_ctx, outputs


def _completed_story(run_dir: Path, index: int, words: list[str]) -> Path:
    d = run_dir / f"story_{index:02d}"
    d.mkdir(parents=True)
    (d / "checkpoint.json").write_text(json.dumps({"chapters_completed": 1, "total_chapters": 1, "used_words": words}), encoding="utf-8")
    (d / "story.txt").write_text("once upon a time", encoding="utf-8")
    (d / "beatsheet.json").write_text(json.dumps({"title": f"S{index}", "genre": "Mystery"}), encoding="utf-8")
    return d


def test_init_run_creates_next_free_season_dir(tmp_path):
    ctx, events = make_ctx(tmp_path)
    st.init_run(ctx, level="A2", resumeDir="", outputRoot=str(tmp_path / "output"))
    run_dir = Path(outputs(events)["runDir"])
    assert run_dir.is_dir() and run_dir.name.startswith("A2_") and run_dir.name.endswith("_season_01")
    ctx2, events2 = make_ctx(tmp_path)
    st.init_run(ctx2, level="A2", resumeDir="", outputRoot=str(tmp_path / "output"))
    assert Path(outputs(events2)["runDir"]).name.endswith("_season_02")


def test_init_run_resumes_an_existing_dir_and_rejects_a_missing_one(tmp_path):
    existing = tmp_path / "run"
    existing.mkdir()
    ctx, events = make_ctx(tmp_path)
    st.init_run(ctx, level="A2", resumeDir=str(existing))
    assert outputs(events)["runDir"] == str(existing)
    import pytest
    from mdium_worker import StageFailed
    with pytest.raises(StageFailed):
        st.init_run(make_ctx(tmp_path)[0], level="A2", resumeDir=str(tmp_path / "missing"))


def test_generate_next_is_done_when_the_run_already_has_count_stories(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    _completed_story(run_dir, 1, ["a", "b"])
    monkeypatch.setattr(st, "total_vocab", lambda levels: {"A2": 4})
    calls = []
    monkeypatch.setattr(st, "run_multi_story", lambda *a, **k: calls.append(k))
    ctx, events = make_ctx(tmp_path)
    st.generate_next(ctx, runDir=str(run_dir), level="A2", count=1)
    out = outputs(events)
    assert out["done"] is True and out["index"] == 1 and calls == []
    assert out["coverage"] == 50.0


def test_generate_next_adds_one_story_and_reports_done_on_target(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    def fake_run(level, **kwargs):
        d = _completed_story(run_dir, 1, ["a", "b", "c", "d"])
        return SimpleNamespace(success=True, failure_reason=None, coverage_target_met=True,
                               cumulative_coverage=100.0, stories=[SimpleNamespace(index=1, output_dir=str(d))])
    seen = {}
    monkeypatch.setattr(st, "run_multi_story", lambda level, **k: seen.update(k) or fake_run(level, **k))
    ctx, events = make_ctx(tmp_path)
    st.generate_next(ctx, runDir=str(run_dir), level="A2", genres=["Mystery"], count=3, targetCoverage=95)
    out = outputs(events)
    assert out["done"] is True and out["index"] == 1 and out["storyDir"].endswith("story_01")
    assert seen["max_stories"] == 1 and seen["resume_parent_dir"] == str(run_dir) and seen["genres"] == ["Mystery"]


def test_generate_next_fails_when_multi_story_fails(tmp_path, monkeypatch):
    (tmp_path / "run").mkdir()
    monkeypatch.setattr(st, "run_multi_story", lambda level, **k: SimpleNamespace(success=False, failure_reason="boom", stories=[]))
    import pytest
    from mdium_worker import StageFailed
    with pytest.raises(StageFailed, match="boom"):
        st.generate_next(make_ctx(tmp_path)[0], runDir=str(tmp_path / "run"), level="A2")


def test_list_stories_sorts_by_index_and_computes_coverage(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    _completed_story(run_dir, 2, ["c"])
    _completed_story(run_dir, 1, ["a", "b"])
    monkeypatch.setattr(st, "total_vocab", lambda levels: {"A2": 6})
    ctx, events = make_ctx(tmp_path)
    st.list_stories(ctx, runDir=str(run_dir), level="A2")
    out = outputs(events)
    assert [Path(p).name for p in out["storyDirs"]] == ["story_01", "story_02"]
    assert out["storyCount"] == 2 and out["coverage"] == 50.0


def test_continuity_audit_maps_AuditError_to_not_eligible(tmp_path, monkeypatch):
    import story_continuity_audit as sca
    def boom(story_dir, **kwargs):
        raise sca.AuditError("no verdict")
    monkeypatch.setattr(st, "gate_story_dir", boom)
    ctx, events = make_ctx(tmp_path)
    st.continuity_audit(ctx, storyDir=str(tmp_path), minScore=7)
    out = outputs(events)
    assert out["eligible"] is False and out["score"] == 0
    assert any(e["type"] == "log" and e["level"] == "error" for e in events)


def test_continuity_audit_reports_score_and_artifact(tmp_path, monkeypatch):
    (tmp_path / "continuity_audit.json").write_text("{}", encoding="utf-8")
    report = SimpleNamespace(consistency_score=8.5)
    monkeypatch.setattr(st, "gate_story_dir", lambda story_dir, **k: (True, report))
    ctx, events = make_ctx(tmp_path)
    st.continuity_audit(ctx, storyDir=str(tmp_path), minScore=7)
    out = outputs(events)
    assert out["eligible"] is True and out["score"] == 8.5
    assert artifacts(events)[0]["label"] == "audit" and artifacts(events)[0]["path"].endswith("continuity_audit.json")
```

(`_scan_run_directory` reads `checkpoint.json`'s `chapters_completed` / `total_chapters` and the used words; check `multi_story._CompletedStory` / `_scan_run_directory` for the exact keys it reads for `used_words` and match them in `_completed_story` — adjust the fixture, not the production code.)

- [ ] **Step 2: Run to verify they fail**: `uv run pytest tests/test_video_gen_flow_story.py -q` → FAIL (`No module named video_gen_flow.story`).

- [ ] **Step 3: Implement** `video_gen_flow/story.py` per the Interfaces block. `init_run`'s season naming: `base = f"{level.upper()}_{datetime.date.today():%Y%m%d}_season_"`; `n = 1; while os.path.exists(os.path.join(outputRoot, f"{base}{n:02d}")): n += 1`; `os.makedirs(path)`. `list_stories` uses `multi_story._scan_run_directory(runDir)[0]` sorted by `.index`; coverage from the union of `c.used_words` over the completed stories and `total_vocab([level]).get(level, 0)`. Add `from . import story` to `video_gen_flow/__init__.py`.

- [ ] **Step 4: Run** the file → PASS; the SCOPED SUITE → all green.

- [ ] **Step 5: Commit** `feat(flow): story stages (init, generate next, list, continuity audit)`.

---

### Task 4 (video_gen): decompose `run_video_pipeline` into stage functions

**Files:**
- Modify: `video_pipeline.py` (`run_video_pipeline` ~L1214-1470 and the helpers it inlines)
- Create: `tests/test_video_pipeline_stages.py`

**Interfaces:**
- Produces (module-level, in `video_pipeline.py`):

```python
@dataclass
class PipelineRun:
    video_dir: Path
    cfg: VideoPipelineConfig
    title: str
    state: dict                      # run_state.json content: {"stages_completed": [...], "voice_map": {...}}
    result: VideoRunResult
    labeler: Any = None
    script_provider: Any = None
    image_provider: Any = None
    tts: Any = None
    renderer: Any = None
    evaluator: Any = None
    repace_synth: Any = None

    def done(self, stage: str) -> bool: ...            # stage in state["stages_completed"]
    def mark(self, stage: str) -> None: ...            # append + _save_run_state + result.stages_completed

def open_pipeline_run(video_dir: Path, cfg: VideoPipelineConfig, title: str, *, labeler=None, script_provider=None,
                      image_provider=None, tts=None, renderer=None, evaluator=None, repace_synth=None) -> PipelineRun
    # mkdir, _load_run_state, VideoRunResult(story_dir=str(video_dir)), _default_clients(cfg) when any of the four is None

def stage_label(run: PipelineRun, story_text: str) -> str                 # returns labeled text; writes labeled.txt; mark("label")
def stage_script(run: PipelineRun, labeled: str) -> dict                   # script.json; mark("script")
def stage_voice(run: PipelineRun, script_json: dict) -> dict               # voice map into run.state["voice_map"]; mark("voice")
def stage_assets(run: PipelineRun, script_json: dict, *, resume: bool = True) -> list[VideoSceneResult]
                                                                            # images/, audio/; writes scenes.json; run.result.scenes; mark("assets")
def stage_ir(run: PipelineRun, script_json: dict, scenes: list[VideoSceneResult]) -> None   # composition.json, edit_history.json; mark("ir")
def stage_render(run: PipelineRun) -> Path                                  # <title>.mp4 (+ .mlt); run.result.video_path; mark("render")
def stage_quality(run: PipelineRun, script_json: dict) -> None             # only when cfg.enable_quality_loop; quality_report.json; mark("improve")
def stage_pacing(run: PipelineRun) -> None                                  # only when cfg.audio_pacing; mark("pacing")
def stage_review(run: PipelineRun) -> None                                  # <title>_review.mp4 when review_overlay and not audio_paced; mark("review")

def save_scenes(video_dir: Path, scenes: list[VideoSceneResult]) -> None    # video/scenes.json (dataclasses.asdict, Paths as str)
def load_scenes(video_dir: Path) -> list[VideoSceneResult] | None          # None when the file is missing
def load_script(video_dir: Path) -> dict                                    # script.json + validate_script_schema
def load_labeled(video_dir: Path) -> str                                    # labeled.txt
```

Each `stage_*` keeps the exact body of the corresponding block of today's `run_video_pipeline` (including its `if run.done(stage)` resume branch and the file it reads on resume), with only these changes: it takes its inputs from `run` / its arguments, returns the value the next block needs, and `stage_assets` additionally calls `save_scenes`. `run_video_pipeline` becomes: the continuity gate exactly as today → `open_pipeline_run(...)` → `labeled = stage_label(...)`, `script_json = stage_script(...)`, `stage_voice(...)`, `scenes = stage_assets(...)`, `stage_ir(...)`, `stage_render(...)`, `stage_quality(...)`, `stage_pacing(...)`, `stage_review(...)`, all inside the existing `try/except VideoPipelineError` that sets `success` / `failure_reason`. Every `_mark` happens at the same point as before. The `voice` mark semantics stay as they are today (only on the first run).

- [ ] **Step 1: Write the failing tests** `tests/test_video_pipeline_stages.py`, reusing the fakes of `tests/test_video_pipeline.py` (import them: `from tests.test_video_pipeline import FakeImageProvider, FakeTTS, _Provider, SAMPLE_SCRIPT` — use the actual names of that file's fakes and sample script; if they are module-private, import them anyway, this is a test):

```python
from pathlib import Path

import video_pipeline as vp


def _run(tmp_path, **clients):
    cfg = vp.VideoPipelineConfig(enable_quality_loop=False, audio_pacing=False)
    return vp.open_pipeline_run(tmp_path / "video", cfg, "video", labeler=clients.get("labeler", _FakeLabeler()),
                                script_provider=clients.get("script_provider", _Provider(SAMPLE_SCRIPT)),
                                image_provider=clients.get("image_provider", FakeImageProvider()),
                                tts=clients.get("tts", FakeTTS()), renderer=clients.get("renderer", _fake_renderer))


def test_stage_label_writes_and_marks(tmp_path):
    run = _run(tmp_path)
    labeled = vp.stage_label(run, "Once upon a time.")
    assert (tmp_path / "video" / "labeled.txt").read_text(encoding="utf-8") == labeled
    assert run.done("label")


def test_stage_label_resumes_from_file_without_calling_the_labeler(tmp_path):
    run = _run(tmp_path)
    vp.stage_label(run, "Once upon a time.")
    calls = []
    run2 = _run(tmp_path, labeler=_CountingLabeler(calls))
    assert vp.stage_label(run2, "ignored") == (tmp_path / "video" / "labeled.txt").read_text(encoding="utf-8")
    assert calls == []


def test_assets_persist_scenes_and_ir_can_reload_them(tmp_path, stub_probe):
    run = _run(tmp_path)
    script = vp.stage_script(run, vp.stage_label(run, "Once upon a time."))
    vp.stage_voice(run, script)
    scenes = vp.stage_assets(run, script)
    reloaded = vp.load_scenes(tmp_path / "video")
    assert [s.scene_id for s in reloaded] == [s.scene_id for s in scenes]
    vp.stage_ir(run, script, reloaded)
    assert (tmp_path / "video" / "composition.json").exists() and run.done("ir")


def test_run_video_pipeline_result_is_unchanged(tmp_path, stub_probe):
    # Same call the existing suite makes; the stage marks and files must be identical.
    res = vp.run_video_pipeline("Once upon a time.", tmp_path / "video", vp.VideoPipelineConfig(),
                                labeler=_FakeLabeler(), script_provider=_Provider(SAMPLE_SCRIPT),
                                image_provider=FakeImageProvider(), tts=FakeTTS(), renderer=_fake_renderer)
    assert res.success and res.stages_completed == ["label", "script", "voice", "assets", "ir", "render", "review"]
    assert vp.load_scenes(tmp_path / "video") is not None
```

(`stub_probe`, `_fake_renderer`, `_FakeLabeler` — take them from `tests/test_video_pipeline.py`; if that file defines them as fixtures, re-declare equivalent fixtures here rather than changing the existing file. The expected `stages_completed` list must match what the existing suite asserts today; copy it from there.)

- [ ] **Step 2: Run to verify they fail**: `uv run pytest tests/test_video_pipeline_stages.py -q` → FAIL (`module 'video_pipeline' has no attribute 'open_pipeline_run'`).

- [ ] **Step 3: Implement** the decomposition in `video_pipeline.py` as specified. Add `save_scenes` / `load_scenes` (`dataclasses.asdict`; convert `Path` fields to `str` on save and back on load — look at `VideoSceneResult`'s field types), `load_script` (`json.load` + `validate_script_schema`), `load_labeled`.

- [ ] **Step 4: Run** `uv run pytest tests/test_video_pipeline.py tests/test_video_pipeline_stages.py tests/test_video_revise.py tests/test_video_repace.py -q` → PASS, then the SCOPED SUITE → all green (baseline + new).

- [ ] **Step 5: Commit** `refactor(video): run the pipeline as a sequence of stage functions`.

---

### Task 5 (video_gen): revise and review-ready helpers

**Files:**
- Modify: `video_revise.py` (add `revision_count(video_dir) -> int`), `tests/test_video_revise.py` (one test)

**Interfaces:**
- Produces: `video_revise.revision_count(video_dir: Path | str) -> int` — the number of `source == "human"` entries in `<video_dir>/edit_history.json` (0 when the file is missing). Used by `video.review_ready` (Task 6).

- [ ] **Step 1: Write the failing test** in `tests/test_video_revise.py`:

```python
def test_revision_count_counts_human_entries(tmp_path):
    import json
    import video_revise as vr
    assert vr.revision_count(tmp_path) == 0
    (tmp_path / "edit_history.json").write_text(json.dumps({"entries": [{"source": "human"}, {"source": "agent"}, {"source": "human"}]}), encoding="utf-8")
    assert vr.revision_count(tmp_path) == 2
```

(Match the real shape `save_edit_history` writes — open `video_composition.py`'s `genesis_history` / `save_edit_history` and use the same top-level key and entry field; if the history is a bare list, adjust the test fixture, not the production reader's semantics.)

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `revision_count` next to `revise_video`. **Step 4: Run** `uv run pytest tests/test_video_revise.py -q` → PASS. **Step 5: Commit** `feat(video): count human revisions in the edit history`.

---

### Task 6 (video_gen): video stages

**Files:**
- Create: `video_gen_flow/video.py`, `tests/test_video_gen_flow_video.py`
- Modify: `video_gen_flow/__init__.py` (import `video`)

**Interfaces:**
- Produces:
  - `flow_config.json` in the video dir: `{"title": str, "cfg": {<VideoPipelineConfig fields>, "resolution": [w, h]}}` written by `video.label`, read by every later stage. Helpers `cfg_to_dict(cfg) -> dict`, `cfg_from_dict(data) -> VideoPipelineConfig` (tuple back for `resolution`), `write_flow_config(video_dir, cfg, title)`, `read_flow_config(video_dir) -> tuple[VideoPipelineConfig, str]`.
  - `make_clients: Callable[[VideoPipelineConfig], tuple]` module attribute (default `video_pipeline._default_clients`) returning `(labeler, script_provider, image_provider, tts)`; tests replace it. `make_renderer: Callable[[], Any]` (default `lambda: None`), `make_evaluator` (default `lambda: None`), `make_repace_synth` (default `lambda: None`).
  - `_open(videoDir: str) -> PipelineRun`: `cfg, title = read_flow_config(video_dir)`; `clients = make_clients(cfg)`; `video_pipeline.open_pipeline_run(video_dir, cfg, title, labeler=..., script_provider=..., image_provider=..., tts=..., renderer=make_renderer(), evaluator=make_evaluator(), repace_synth=make_repace_synth())`.
  - Stages (all take `videoDir: path required` unless stated; all check `ctx.should_stop()` first and raise `Stopped()`):
    - `video.label` inputs `{storyDir: path required, title: {string, default "video"}, imageStyle: {string, default "Anime"}, ttsEngine: {string, default "Gemini"}, qualityIters: {number, default 3}, audioPacing: {bool, default true}}` → derives `video_dir = Path(storyDir) / "video"`, builds `cfg = VideoPipelineConfig(image_style=imageStyle, tts_engine=ttsEngine, enable_quality_loop=qualityIters > 0, quality_max_iters=int(qualityIters), audio_pacing=audioPacing)`, writes `flow_config.json`, reads `<storyDir>/story.txt` (`StageFailed` when missing), runs `stage_label` → outputs `videoDir (path)`, `labeledPath (path)`; artifact `labeled` (`labeled.txt`, `text/plain`).
    - `video.script` → `stage_script(run, load_labeled(video_dir))` → outputs `scriptPath`, `sceneCount` (`len(script_json["scenes"])` — use the key the schema validator uses); artifact `script` (`application/json`).
    - `video.voice` → `stage_voice(run, load_script(video_dir))` → outputs `speakerCount (number)` (`len(voice_map)`).
    - `video.assets` → `scenes = stage_assets(run, load_script(video_dir), resume=True)`; records artifacts: every `images/char_*.png` as `label=f"char_{name}"` (`image/png`), each scene's `image_path` as `label=f"scene_{scene_id:02d}"` and each of its `audio_paths` with the same label (`audio/mpeg`) → outputs `sceneCount`, `imageCount`, `audioCount`. Calls `ctx.progress(f"scene {i}/{n}")` is not possible inside `generate_assets`, so progress is reported once before and once after; `ctx.should_stop()` is checked before the call (scene-level stop stays a known gap — note in the report).
    - `video.ir` → `scenes = load_scenes(video_dir) or stage_assets(run, script, resume=True)`; `stage_ir(run, script, scenes)` → outputs `compositionPath`; artifact `composition` (`application/json`).
    - `video.render` → `path = stage_render(run)` → outputs `videoPath`; artifact `video` (`video/mp4`).
    - `video.quality` → `stage_quality(run, load_script(video_dir))` → outputs `coherence (number)` (`run.result.quality_coherence` or `0`), `iterations`, `kept`, `reverted`; artifact `quality_report` when the file exists. When `cfg.enable_quality_loop` is false the stage is a no-op that outputs `coherence: 0, iterations: 0, kept: 0, reverted: 0`.
    - `video.pacing` → `stage_pacing(run)` → outputs `videoPath`, `reviewVideoPath` (both from `run.result`); artifacts `video`, `review`. No-op (outputs the existing paths) when `cfg.audio_pacing` is false.
    - `video.review_build` → `stage_review(run)` (idempotent: when `<title>_review.mp4` already exists — pacing made it — it only sets the path) → outputs `reviewVideoPath`; artifact `review` (`video/mp4`).
    - `video.review_ready` inputs `{videoDir: path required}` → locates `<title>.mp4` and `<title>_review.mp4` (falls back to `<title>.mp4` for the review path when the overlay build does not exist) → outputs `videoPath`, `reviewVideoPath`, `revisionCount` (`video_revise.revision_count`); artifacts `video`, `review`.
    - `video.revise` inputs `{videoDir: path required, feedback: {string, required}, title: {string, default "video"}}` → `data = json.loads(feedback)` (`StageFailed("feedback is not JSON: …")` on error), `revisions = video_revise.parse_revisions(data)` (`RevisionError` → `StageFailed`), `comp = load_composition(video_dir / "composition.json")`, `cfg = video_revise.infer_cfg_from_comp(comp)`, `image_provider, tts = make_revise_clients(cfg)` (module attribute, default `video_revise._build_clients`), `res = video_revise.revise_video(video_dir, revisions, image_provider=..., tts=..., cfg=cfg, renderer=make_renderer(), title=title)`; `StageFailed(res.failure_reason)` when not `res.success` → outputs `videoPath`, `reviewVideoPath`, `revisedAssets (array)` (`res.touched`), `unresolved (array)`; artifacts `video`, `review`.

- [ ] **Step 1: Write the failing tests** `tests/test_video_gen_flow_video.py` (fakes from `tests/test_video_pipeline.py` as in Task 4; `monkeypatch.setattr(vg, "make_clients", lambda cfg: (_FakeLabeler(), _Provider(SAMPLE_SCRIPT), FakeImageProvider(), FakeTTS()))`, `monkeypatch.setattr(vg, "make_renderer", lambda: _fake_renderer)`):

```python
import json
from pathlib import Path

import video_gen_flow.video as vg
import video_pipeline as vp
from tests.flow_support import artifacts, make_ctx, outputs


def _story(tmp_path) -> Path:
    d = tmp_path / "story_01"
    d.mkdir()
    (d / "story.txt").write_text("Once upon a time.", encoding="utf-8")
    return d


def test_label_derives_video_dir_and_writes_flow_config(tmp_path, fakes):
    story = _story(tmp_path)
    ctx, events = make_ctx(tmp_path)
    vg.label(ctx, storyDir=str(story), title="video", imageStyle="Anime", ttsEngine="Gemini", qualityIters=0, audioPacing=False)
    out = outputs(events)
    assert out["videoDir"] == str(story / "video") and Path(out["labeledPath"]).exists()
    cfg, title = vg.read_flow_config(story / "video")
    assert cfg.enable_quality_loop is False and cfg.audio_pacing is False and title == "video"


def test_stages_honour_existing_run_state_marks(tmp_path, fakes, counting_labeler):
    story = _story(tmp_path)
    ctx, events = make_ctx(tmp_path)
    vg.label(ctx, storyDir=str(story), qualityIters=0, audioPacing=False)
    vg.label(make_ctx(tmp_path)[0], storyDir=str(story), qualityIters=0, audioPacing=False)
    assert counting_labeler.calls == 1


def test_full_chain_produces_video_and_review(tmp_path, fakes, stub_probe):
    story = _story(tmp_path)
    video_dir = str(story / "video")
    vg.label(make_ctx(tmp_path)[0], storyDir=str(story), qualityIters=0, audioPacing=False)
    for fn in (vg.script, vg.voice, vg.assets, vg.ir, vg.render, vg.quality, vg.pacing, vg.review_build):
        ctx, events = make_ctx(tmp_path)
        fn(ctx, videoDir=video_dir)
    out = outputs(events)
    assert out["reviewVideoPath"].endswith("video_review.mp4")
    assert vp._load_run_state(Path(video_dir))["stages_completed"][-1] == "review"
    ctx, events = make_ctx(tmp_path)
    vg.review_ready(ctx, videoDir=video_dir)
    assert outputs(events)["revisionCount"] == 0 and {a["label"] for a in artifacts(events)} == {"video", "review"}


def test_assets_record_scene_and_character_artifacts(tmp_path, fakes, stub_probe):
    story = _story(tmp_path)
    video_dir = str(story / "video")
    vg.label(make_ctx(tmp_path)[0], storyDir=str(story), qualityIters=0, audioPacing=False)
    vg.script(make_ctx(tmp_path)[0], videoDir=video_dir)
    vg.voice(make_ctx(tmp_path)[0], videoDir=video_dir)
    ctx, events = make_ctx(tmp_path)
    vg.assets(ctx, videoDir=video_dir)
    labels = [a["label"] for a in artifacts(events)]
    assert any(l.startswith("scene_01") for l in labels)
    assert outputs(events)["sceneCount"] >= 1


def test_revise_rejects_malformed_feedback_without_touching_the_video(tmp_path, fakes, stub_probe):
    import pytest
    from mdium_worker import StageFailed
    story = _story(tmp_path)
    video_dir = story / "video"
    vg.label(make_ctx(tmp_path)[0], storyDir=str(story), qualityIters=0, audioPacing=False)
    for fn in (vg.script, vg.voice, vg.assets, vg.ir, vg.render):
        fn(make_ctx(tmp_path)[0], videoDir=str(video_dir))
    before = (video_dir / "video.mp4").stat().st_mtime_ns
    with pytest.raises(StageFailed, match="not JSON"):
        vg.revise(make_ctx(tmp_path)[0], videoDir=str(video_dir), feedback="not json at all")
    with pytest.raises(StageFailed):
        vg.revise(make_ctx(tmp_path)[0], videoDir=str(video_dir), feedback=json.dumps({"revisions": [{"target": "tts"}]}))
    assert (video_dir / "video.mp4").stat().st_mtime_ns == before


def test_revise_applies_a_revision(tmp_path, fakes, stub_probe, monkeypatch):
    story = _story(tmp_path)
    video_dir = story / "video"
    vg.label(make_ctx(tmp_path)[0], storyDir=str(story), qualityIters=0, audioPacing=False)
    for fn in (vg.script, vg.voice, vg.assets, vg.ir, vg.render):
        fn(make_ctx(tmp_path)[0], videoDir=str(video_dir))
    monkeypatch.setattr(vg, "make_revise_clients", lambda cfg: (FakeImageProvider(), FakeTTS()))
    ctx, events = make_ctx(tmp_path)
    vg.revise(ctx, videoDir=str(video_dir), feedback=json.dumps({"revisions": [{"scene": 1, "target": "image"}]}))
    out = outputs(events)
    assert out["videoPath"].endswith("video.mp4") and out["revisedAssets"]
    ctx2, events2 = make_ctx(tmp_path)
    vg.review_ready(ctx2, videoDir=str(video_dir))
    assert outputs(events2)["revisionCount"] == 1
```

(`fakes` is a fixture that installs the four `make_*` monkeypatches; `counting_labeler` a fixture whose labeler counts calls; `stub_probe` as in Task 4. The revision scene id and the expected `touched` list follow `tests/test_video_revise.py`'s existing `revise_video` test — copy its feedback.)

- [ ] **Step 2: Run to verify they fail** → FAIL (`No module named video_gen_flow.video`).

- [ ] **Step 3: Implement** `video_gen_flow/video.py` per the Interfaces block; add `from . import video` to `video_gen_flow/__init__.py`.

- [ ] **Step 4: Run** `uv run pytest tests/test_video_gen_flow_video.py -q` → PASS; the SCOPED SUITE → all green; `uv run python -m mdium_worker --module video_gen_flow --describe` lists all 19 stages.

- [ ] **Step 5: Commit** `feat(flow): video stages over the pipeline stage functions`.

---

### Task 7 (video_gen): the flows and their consistency test

**Files:**
- Create: `.mdium/flows/production-cycle.flow.yaml`, `.mdium/flows/lib/story-run.flow.yaml`, `.mdium/flows/lib/video.flow.yaml`, `.mdium/flows/lib/video-assets.flow.yaml`, `.mdium/flows/lib/video-review.flow.yaml`, `tests/test_video_gen_flow_definitions.py`
- Modify: `pyproject.toml` (add `pyyaml` to dependencies if not present — check `uv pip list`; `ruamel`/`pyyaml` may already be transitive, but declare it)

**Interfaces:**
- Consumes: the stage names, inputs and outputs of Tasks 2–6 exactly as declared in their `@stage` decorators.

- [ ] **Step 1: Write the failing test** `tests/test_video_gen_flow_definitions.py` — it loads every flow file, walks nodes (including inline loop bodies), and checks: every `python` node's `entry` is a registered stage; its `with` keys ⊆ the stage's declared inputs and every `required` input without a default is present; every `subflow` / file-bodied `loop` reference resolves to an existing file and the params it passes ⊆ the part's declared `params`; every part declares `outputs`; `production-cycle`'s `approve_order` has exactly one outgoing edge, on port `approve`:

```python
import glob
from pathlib import Path

import yaml

import video_gen_flow  # noqa: F401  (registers the stages)
from mdium_worker import registry

FLOWS = Path(".mdium/flows")


def _stages():
    return {s.name: s for s in registry.stages()}


def _walk(nodes, scope_path=""):
    for n in nodes:
        yield n
        body = n.get("body")
        if n.get("kind") == "loop" and isinstance(body, dict):
            yield from _walk(body.get("nodes", []))


def _flow(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_every_python_node_matches_a_stage_manifest():
    stages = _stages()
    for path in FLOWS.rglob("*.flow.yaml"):
        for n in _walk(_flow(path)["nodes"]):
            if n.get("kind") != "python":
                continue
            assert n["runtime"] == "video_gen", f"{path}:{n['id']}"
            assert n["entry"] in stages, f"{path}:{n['id']} unknown entry {n['entry']}"
            inputs = stages[n["entry"]].inputs
            given = set((n.get("with") or {}).keys())
            assert given <= set(inputs), f"{path}:{n['id']} passes unknown inputs {given - set(inputs)}"
            for name, spec in inputs.items():
                if spec.required and spec.default is None:
                    assert name in given, f"{path}:{n['id']} misses required input {name}"


def test_part_references_resolve_and_params_are_declared():
    for path in FLOWS.rglob("*.flow.yaml"):
        for n in _walk(_flow(path)["nodes"]):
            ref = n.get("flow") if n.get("kind") == "subflow" else (n.get("body") if n.get("kind") == "loop" and isinstance(n.get("body"), str) else None)
            if ref is None:
                continue
            target = (path.parent / ref).resolve()
            assert target.exists(), f"{path}:{n['id']} -> {ref}"
            part = _flow(target)
            assert "outputs" in part, f"{target} declares no outputs"
            declared = set((part.get("params") or {}).keys())
            assert set((n.get("params") or {}).keys()) <= declared, f"{path}:{n['id']} passes undeclared params"


def test_approval_ports_without_edges_are_intentional():
    flow = _flow(FLOWS / "production-cycle.flow.yaml")
    out = [e for e in flow["edges"] if e["from"] == "approve_order"]
    assert [e.get("port") for e in out] == ["approve"]
```

(`registry.StageDef.inputs` / `InputDef.required` / `.default` — use the attribute names `registry.py` actually defines; adjust the test to them.)

- [ ] **Step 2: Run** → FAIL (no flow files).

- [ ] **Step 3: Write the flows.**

`.mdium/flows/production-cycle.flow.yaml`:

```yaml
schemaVersion: 1
id: production-cycle
name: Production cycle
description: Observe the portfolio, evaluate it, plan an order, generate stories and produce their videos, then record the results.
params:
  outputRoot: { type: path, default: output }
  comments: { type: array, default: [] }
  maxStories: { type: number, default: 10 }
  title: { type: string, default: video }
  qualityIters: { type: number, default: 3 }
  audioPacing: { type: bool, default: true }
  minContinuityScore: { type: number, default: 7 }
limits: { maxConcurrentNodes: 1 }
nodes:
  - { id: observe, kind: python, runtime: video_gen, entry: portfolio.observe, with: { outputRoot: "${{ params.outputRoot }}" } }
  - id: evaluate
    kind: python
    runtime: video_gen
    entry: portfolio.evaluate
    timeout: 30m
    with: { ledgerPath: "${{ nodes.observe.outputs.ledgerPath }}", comments: "${{ params.comments }}" }
  - id: plan
    kind: python
    runtime: video_gen
    entry: portfolio.plan
    timeout: 30m
    with:
      ledgerPath: "${{ nodes.observe.outputs.ledgerPath }}"
      reportPath: "${{ nodes.evaluate.outputs.reportPath }}"
      constraints: { max_stories: "${{ params.maxStories }}" }
  - id: approve_order
    kind: approval
    message: "Review the production order (order.json). Approve to generate the stories and their videos."
    show: [nodes.plan.outputs.order, nodes.plan.artifacts.order]
    options: [approve, reject]
  - id: stories
    kind: subflow
    flow: lib/story-run.flow.yaml
    timeout: 24h
    params:
      level: "${{ nodes.plan.outputs.level }}"
      genres: "${{ nodes.plan.outputs.genres }}"
      count: "${{ nodes.plan.outputs.count }}"
      relationship: "${{ nodes.plan.outputs.relationship }}"
      durationMode: "${{ nodes.plan.outputs.durationMode }}"
  - id: videos
    kind: loop
    mode: foreach
    items: "${{ nodes.stories.outputs.storyDirs }}"
    maxIterations: 50
    onItemFailure: continue
    body: lib/video.flow.yaml
    params:
      storyDir: "${{ item }}"
      title: "${{ params.title }}"
      imageStyle: "${{ nodes.plan.outputs.imageStyle }}"
      ttsEngine: "${{ nodes.plan.outputs.ttsEngine }}"
      qualityIters: "${{ params.qualityIters }}"
      audioPacing: "${{ params.audioPacing }}"
      minContinuityScore: "${{ params.minContinuityScore }}"
  - { id: record, kind: python, runtime: video_gen, entry: portfolio.record, with: { outputRoot: "${{ params.outputRoot }}" } }
edges:
  - { from: observe, to: evaluate }
  - { from: evaluate, to: plan }
  - { from: plan, to: approve_order }
  - { from: approve_order, to: stories, port: approve }
  - { from: stories, to: videos }
  - { from: videos, to: record }
outputs:
  coverage: "${{ nodes.record.outputs.coverage }}"
  avgVideoCoherence: "${{ nodes.record.outputs.avgVideoCoherence }}"
  storyCount: "${{ nodes.stories.outputs.storyCount }}"
```

`.mdium/flows/lib/story-run.flow.yaml`:

```yaml
schemaVersion: 1
id: story-run
name: Story run
description: Creates (or resumes) a run directory and generates stories one at a time until the order count or the coverage target is reached.
params:
  level: { type: string, required: true }
  genres: { type: array, default: [] }
  count: { type: number, default: 1 }
  relationship: { type: string, default: independent }
  durationMode: { type: string, default: 3min }
  targetCoverage: { type: number, default: 95 }
  resumeDir: { type: string, default: "" }
nodes:
  - { id: init_run, kind: python, runtime: video_gen, entry: story.init_run, with: { level: "${{ params.level }}", resumeDir: "${{ params.resumeDir }}" } }
  - id: stories
    kind: loop
    mode: while
    until: { ref: iteration.outputs.done, op: "==", value: true }
    maxIterations: 50
    body:
      nodes:
        - id: generate_next
          kind: python
          runtime: video_gen
          entry: story.generate_next
          timeout: 6h
          with:
            runDir: "${{ nodes.init_run.outputs.runDir }}"
            level: "${{ params.level }}"
            genres: "${{ params.genres }}"
            relationship: "${{ params.relationship }}"
            durationMode: "${{ params.durationMode }}"
            count: "${{ params.count }}"
            targetCoverage: "${{ params.targetCoverage }}"
      outputs:
        done: "${{ nodes.generate_next.outputs.done }}"
  - { id: list_stories, kind: python, runtime: video_gen, entry: story.list_stories, with: { runDir: "${{ nodes.init_run.outputs.runDir }}", level: "${{ params.level }}" } }
edges:
  - { from: init_run, to: stories }
  - { from: stories, to: list_stories }
outputs:
  runDir: "${{ nodes.init_run.outputs.runDir }}"
  storyDirs: "${{ nodes.list_stories.outputs.storyDirs }}"
  storyCount: "${{ nodes.list_stories.outputs.storyCount }}"
  coverage: "${{ nodes.list_stories.outputs.coverage }}"
```

`.mdium/flows/lib/video.flow.yaml`:

```yaml
schemaVersion: 1
id: video
name: Video for one story
description: Audits the story's continuity, produces the video, then runs the human review loop.
params:
  storyDir: { type: path, required: true }
  title: { type: string, default: video }
  imageStyle: { type: string, default: Anime }
  ttsEngine: { type: string, default: Gemini }
  qualityIters: { type: number, default: 3 }
  audioPacing: { type: bool, default: true }
  minContinuityScore: { type: number, default: 7 }
nodes:
  - { id: audit, kind: python, runtime: video_gen, entry: story.continuity_audit, timeout: 1h, with: { storyDir: "${{ params.storyDir }}", minScore: "${{ params.minContinuityScore }}" } }
  - id: gate
    kind: branch
    cases:
      - { when: { ref: nodes.audit.outputs.eligible, op: "==", value: false }, port: blocked }
    default: ok
  - id: force_gate
    kind: approval
    message: "The continuity audit is below the threshold. Force the video production anyway?"
    show: [nodes.audit.outputs.score, nodes.audit.artifacts.audit]
    options: [force, stop]
  - id: produce
    kind: subflow
    flow: video-assets.flow.yaml
    timeout: 12h
    params:
      storyDir: "${{ params.storyDir }}"
      title: "${{ params.title }}"
      imageStyle: "${{ params.imageStyle }}"
      ttsEngine: "${{ params.ttsEngine }}"
      qualityIters: "${{ params.qualityIters }}"
      audioPacing: "${{ params.audioPacing }}"
  - id: review
    kind: subflow
    flow: video-review.flow.yaml
    params:
      videoDir: "${{ nodes.produce.outputs.videoDir }}"
      title: "${{ params.title }}"
edges:
  - { from: audit, to: gate }
  - { from: gate, to: force_gate, port: blocked }
  - { from: gate, to: produce, port: ok }
  - { from: force_gate, to: produce, port: force }
  - { from: produce, to: review }
outputs:
  videoPath: "${{ nodes.review.outputs.videoPath }}"
  coherence: "${{ nodes.produce.outputs.coherence }}"
  continuityScore: "${{ nodes.audit.outputs.score }}"
```

`.mdium/flows/lib/video-assets.flow.yaml`:

```yaml
schemaVersion: 1
id: video-assets
name: Video assets
description: Labels the story, writes the script, casts voices, generates images and audio, composes, renders, optionally improves and re-paces, and builds the review video.
params:
  storyDir: { type: path, required: true }
  title: { type: string, default: video }
  imageStyle: { type: string, default: Anime }
  ttsEngine: { type: string, default: Gemini }
  qualityIters: { type: number, default: 3 }
  audioPacing: { type: bool, default: true }
nodes:
  - id: label
    kind: python
    runtime: video_gen
    entry: video.label
    timeout: 30m
    with:
      storyDir: "${{ params.storyDir }}"
      title: "${{ params.title }}"
      imageStyle: "${{ params.imageStyle }}"
      ttsEngine: "${{ params.ttsEngine }}"
      qualityIters: "${{ params.qualityIters }}"
      audioPacing: "${{ params.audioPacing }}"
  - { id: script, kind: python, runtime: video_gen, entry: video.script, timeout: 30m, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: voice, kind: python, runtime: video_gen, entry: video.voice, timeout: 10m, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: assets, kind: python, runtime: video_gen, entry: video.assets, timeout: 4h, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: ir, kind: python, runtime: video_gen, entry: video.ir, timeout: 10m, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: render, kind: python, runtime: video_gen, entry: video.render, timeout: 2h, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: quality, kind: python, runtime: video_gen, entry: video.quality, timeout: 4h, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: pacing, kind: python, runtime: video_gen, entry: video.pacing, timeout: 2h, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
  - { id: review_build, kind: python, runtime: video_gen, entry: video.review_build, timeout: 2h, with: { videoDir: "${{ nodes.label.outputs.videoDir }}" } }
edges:
  - { from: label, to: script }
  - { from: script, to: voice }
  - { from: voice, to: assets }
  - { from: assets, to: ir }
  - { from: ir, to: render }
  - { from: render, to: quality }
  - { from: quality, to: pacing }
  - { from: pacing, to: review_build }
outputs:
  videoDir: "${{ nodes.label.outputs.videoDir }}"
  videoPath: "${{ nodes.render.outputs.videoPath }}"
  reviewVideoPath: "${{ nodes.review_build.outputs.reviewVideoPath }}"
  coherence: "${{ nodes.quality.outputs.coherence }}"
```

`.mdium/flows/lib/video-review.flow.yaml`:

```yaml
schemaVersion: 1
id: video-review
name: Video review
description: Shows the review video for approval; a "revise" answer carries revision JSON that is applied before the next review round.
params:
  videoDir: { type: path, required: true }
  title: { type: string, default: video }
nodes:
  - { id: ready, kind: python, runtime: video_gen, entry: video.review_ready, with: { videoDir: "${{ params.videoDir }}" } }
  - id: review
    kind: approval
    message: "Watch the review video. Choose revise and paste revision JSON such as {\"revisions\":[{\"scene\":11,\"target\":\"tts\",\"speaker\":\"Narrator\"}]} (target: image or tts; scene or asset_id)."
    show: [nodes.ready.artifacts.review, nodes.ready.outputs.revisionCount]
    options: [accept, { name: revise, commentRequired: true }]
  - id: revise
    kind: python
    runtime: video_gen
    entry: video.revise
    timeout: 2h
    with:
      videoDir: "${{ params.videoDir }}"
      feedback: "${{ nodes.review.outputs.comment }}"
      title: "${{ params.title }}"
edges:
  - { from: ready, to: review }
  - { from: review, to: revise, port: revise }
  - { from: revise, to: ready, maxTraversals: 5 }
outputs:
  videoPath: "${{ nodes.ready.outputs.videoPath }}"
  reviewVideoPath: "${{ nodes.ready.outputs.reviewVideoPath }}"
  revisionCount: "${{ nodes.ready.outputs.revisionCount }}"
```

- [ ] **Step 4: Run** `uv run pytest tests/test_video_gen_flow_definitions.py -q` → PASS; the SCOPED SUITE → all green.

- [ ] **Step 5: Validate with the engine** — open `C:\Users\mtmar\source\repos\video_gen` in the mdium desktop app (built from a branch that includes Task 1). The flow list must show `Production cycle` (main) and the four parts with **no validation errors or warnings**; open each file in the editor and check the validation panel. Fix the YAML until clean (`FLOW_OUTPUT_UNKNOWN`, `FLOW_PARAM_MISMATCH`, `FLOW_PARAM_TYPE` and `FLOW_REF_NOT_FOUND` are the likely findings). Record the result in the task report.

- [ ] **Step 6: Commit** `feat(flow): production-cycle entry flow and its four parts`.

---

### Task 8 (video_gen + mdium docs): final verification, docs, smoke

**Files:**
- Modify (video_gen): `CLAUDE.md` (a short "mdium flow" section after the meta-orchestration section: how to open the project in mdium, run Setup, run `Production cycle`, where the run data lives, the revise JSON example, what is not migrated — 9.5)
- Modify (mdium, on `docs/portable-projects-spec`): `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` chapter 12 row V6 — append the deviations: `improve.flow.yaml` deferred to V8; `video.review_ready` added and the review loop closes on it; `quality` / `pacing` / `review_build` run unconditionally (the stages are no-ops when `qualityIters` is 0 / `audioPacing` is false; `review_build` is idempotent) so the part's outputs always resolve, instead of the spec's `when` conditions; the video dir is derived by `video.label` and later stages take only `videoDir` (config persisted in `flow_config.json`); `portfolio.evaluate` / `plan` take `ledgerPath` (state recomputed) instead of `statePath`; `story.generate_next` takes the whole `genres` list and `count` (the loop's `maxIterations` is a literal cap of 50); `video.assets` reports stop only at the stage boundary (no per-scene stop); `mdium-worker` is a path dependency on the sibling checkout.

- [ ] **Step 1: Final verification (video_gen)**: the SCOPED SUITE (all green; count = 379 + new), `uv run ruff check video_gen_flow tests/test_video_gen_flow_*.py tests/test_video_pipeline_stages.py` (clean), `uv run python -m mdium_worker --module video_gen_flow --describe > /dev/null` (exit 0).
- [ ] **Step 2: Final verification (mdium)**: `cargo test --workspace` (flow-core 244 / mdium 731), `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `uv run --project python/mdium-worker pytest -q`.
- [ ] **Step 3: Docs** as listed; commit `docs: mdium flow usage and V6 deviations` (video_gen) and `docs(spec): record the V6 deviations` (mdium).
- [ ] **Step 4: Desktop smoke (human)**, with `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` in the environment and the `claude` CLI on PATH: open `video_gen` in mdium → Setup (`uv sync`) → run `Production cycle` with `maxStories: 1`, `qualityIters: 0`, `audioPacing: false` → confirm the runtime in the confirmation dialog → `observe` / `evaluate` / `plan` complete and `approve_order` shows `order.json` → approve → `stories` generates one story (long) → `videos` produces its video → `review` shows the review video → answer `revise` with `{"revisions":[{"scene":1,"target":"image"}]}` → the back edge re-renders and `review` shows again → `accept` → `record` completes and the run outputs show `coverage` / `avgVideoCoherence` / `storyCount`. Also: reject at `approve_order` ends the run cleanly; stop during `stories` and re-run with `resumeDir` set to the run dir continues the same run.

---

## Self-review notes

- Spec coverage: 9.1 layout (Tasks 2, 7), 9.2 stages (2, 3, 6; `video.review_ready` added, `portfolio.plan` inputs changed — recorded in Task 8), 9.3 flows (7), 9.4 deferred (Global Constraints, Task 8), 9.5 honoured, 14 risk mitigation (4 keeps `_mark` and the existing tests), 13 test policy (4, 6 use the existing fakes), 16.1 param types (1).
- Placeholder scan: the stage bodies that are not spelled out in full (`evaluate`, `plan`, `record`, the `video.*` wrappers) are specified by exact inputs, outputs, artifacts, the functions they call and their failure mapping; the pipeline decomposition is specified by the function signatures and the rule "move each block verbatim". Fixture shapes are delegated to the existing tests by file name.
- Type consistency: `videoDir` is output by `video.label` and consumed by every later video stage and by `video-review` (via `produce.outputs.videoDir`); `storyDirs` is an array output of `story.list_stories` → `story-run.outputs.storyDirs` → `videos.items`; `genres` is `array` end to end (Task 1 enables it); `ttsEngine` is produced by `portfolio.plan` and threaded through `video.flow.yaml` → `video-assets` → `video.label`.
- Review Focus 1–5 each name their test and task.
