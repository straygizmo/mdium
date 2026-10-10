# V3: `python` Node, Resident Worker and `mdium-worker` Package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a flow call Python functions as first-class nodes: a `python` node names a runtime from `.mdium/project.yaml` and a stage; the engine keeps one resident worker per run and runtime, talks JSON lines over its stdio, and treats the call like a command (events, outputs, approval, timeout, retry, stop); a small stdlib-only Python package implements the worker side.

**Architecture:** In the Tauri-free crate `src-tauri/crates/flow-core`: the node kind is added to `model`/`parse`/`validate`/`load` (with project-aware checks); a new `run/worker.rs` holds the worker protocol (`mdium-worker-v1`), manifest types, input validation, interpreter resolution and a piped child-process launcher behind a `WorkerLauncher` trait (so engine tests use a fake worker built into the test binary, as command tests already do); the driver gains a worker map and a running-call list that reuse the existing protocol-item handling; `RunMeta` snapshots the manifest so the driver knows the runtimes; the service adds `flow_runtime_describe`. The Python package `python/mdium-worker/` provides `@stage`, `Context` and the `python -m mdium_worker` loop. The frontend mirrors the kind (types, node details, theme colour, confirmation section) and the API.

**Tech Stack:** Rust 2021 (std process/threads/mpsc, serde, serde_json), Python ≥ 3.10 stdlib (package built with hatchling, tests with pytest via `uv run --project python/mdium-worker pytest`), Tauri 2, TypeScript 5.9, React 19, Vitest 4.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` — chapter 3 (`python` ノード), chapter 4 (`mdium-worker`), 3.7 error codes, chapter 12 row V3 and the V2 carry-overs recorded in row V2 (invalid manifest at run start; symlink rejection for `python` / `cwd`). Base spec `.superpowers/specs/2026-10-06-generic-flow-engine-design.md` 5.3 (protocol items), 7.2 (confirmation).

## Global Constraints

- `flow-core` must not depend on `tauri`; `src/features/flow/` imports `@tauri-apps/*` only in `lib/tauri-transport.ts`.
- New Tauri commands live in `src-tauri/src/commands/flow.rs`, are listed in `flow_core::service::COMMAND_NAMES` and have a `call()` arm with the same camelCase JSON arguments.
- Every new constant in `flow-core/src/issues.rs` is mirrored in `FLOW_ERROR_CODES` (`src/shared/types/flow.ts`) with `issue.<CODE>` in both locales; every new driver reason code gets `reason.<CODE>` and every new service/engine operation code gets `runError.<CODE>` in both `src/shared/i18n/locales/{ja,en}/flow.json` (identical key sets and placeholders).
- `python` node attributes: `runtime` (required; must name a manifest runtime → `FLOW_RUNTIME_UNKNOWN`; a project without `.mdium/project.yaml` → `FLOW_PROJECT_REQUIRED`), `entry` (required; `[a-z0-9_.]+`; checked against the manifest at run time → `FLOW_PYTHON_ENTRY_UNKNOWN`), `with` (map; templated; a value that is exactly one `${{ }}` keeps its type). Exits `success` / `failure`; `needs_approval` behaves like a command (spec 3.1).
- Worker lifecycle (spec 3.2): at most one worker per run per runtime, started at the first `python` node; launched as `<python> -m mdium_worker --module <module>` in `runtimes.<name>.cwd` with MDium's environment plus `runtimes.<name>.env`, `PYTHONUTF8=1`, `MDIUM_FLOW_RUN_ID`, `MDIUM_FLOW_STOP_FILE`, `MDIUM_PROJECT_ROOT`; `describe` first (`FLOW_RUNTIME_START_FAILED` on failure); attached, never detached; app exit → node `interrupted`; one call at a time; worker death mid-call → `FLOW_PYTHON_WORKER_EXITED`; timeout/cancel → `cancel` then kill after the grace; STOP → no `cancel`, wait for `stopped`; at run end `shutdown`, then kill after `limits.stopGrace`.
- Protocol (spec 3.3, 3.4): JSON lines with `v: 1`; MDium → worker `describe {requestId}`, `call {requestId, callId, entry, inputs, context{runId,nodeKey,nodeDir,projectRoot,stopFile,attempt}}`, `cancel {callId}`, `shutdown`; worker → MDium `manifest {requestId, module, stages[]}`, `progress|cost|output|artifact` (+ `callId`, same fields as base spec 5.3, `artifact.mediaType` optional), `log {callId, level, text}`, `outcome {callId, status ok|fail|needs_approval|stopped, reason|message}`, `error {requestId, code, message}`. Limits: 64 KiB per line, 100 000 lines per call; invalid lines are dropped with a warning (base spec 5.3). Manifest input types: `string|number|bool|path|object|array` with `required`/`default`; inputs are validated before `call` (`FLOW_PYTHON_INPUT_INVALID`) and again by the worker.
- Storage (spec 3.5): `<run>/runtimes/<name>/stdout.log` and `stderr.log`; per attempt `events.jsonl` (worker items with `callId` removed), `inputs.json` (expanded `with`), `stdout.log` (worker `log` lines), `outputs.json`.
- Safety (spec 3.6): no templates in `runtimes.<name>.python` / `module` (already validated); `with` may be templated; the confirmation (2.3) lists runtimes and, from this PR, the stages each flow calls.
- V2 carry-overs: `python` candidates and `cwd` must resolve to regular files/directories inside the project with no symlink on the resolved path; a run must not start when `.mdium/project.yaml` exists but has validation errors (`FLOW_PROJECT_INVALID` with the issues as details).
- `mdium-worker` (spec 4): `python/mdium-worker/` with `pyproject.toml` and `src/mdium_worker/`; stdlib only; Python ≥ 3.10; API `stage`, `Context`, `StageFailed`, `Stopped`; `python -m mdium_worker --module <module> [--describe]`.
- Code comments in English; no hardcoded UI strings; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; existing tests keep passing. Rust sources use CRLF — no line-ending churn.

## Review Focus

1. **A worker that prints a non-JSON line (a stray `print()`) between protocol lines** — the node must not fail; the line goes to `runtimes/<name>/stdout.log` (outside a call) or is dropped with a `FLOW_PROTOCOL_WARNING` (inside a call). Pinned in Task 3 (parser) and Task 6 (driver test "stray output").
2. **The interpreter candidates list where only the second candidate exists** (`[.venv/Scripts/python.exe, .venv/bin/python]` on Linux) — resolution picks the first existing regular file; none existing → `FLOW_RUNTIME_START_FAILED` naming all candidates. Pinned in Task 4.
3. **Two python nodes on the same runtime in one run** — the second must reuse the worker (no second `describe`), and after the first call's worker died, the second must start a fresh worker. Pinned in Task 6.
4. **App exit while a stage runs** — the worker process must be killed and the node and run become `interrupted` with `FLOW_APP_EXITED`; on restart the node is `interrupted` (never left `running`). Pinned in Task 6.
5. **`with` input of the wrong type for a `number` stage input** (string `"3"`) — the node fails with `FLOW_PYTHON_INPUT_INVALID` naming the input, before the worker is called; the worker is still alive for later nodes. Pinned in Task 6.

---

## File Structure

**Created**
- `src-tauri/crates/flow-core/src/run/worker.rs` — protocol messages/manifest types/input validation (`parse_worker_line`, `Manifest`, `StageDef`, `validate_inputs`, request builders), interpreter/cwd resolution (`resolve_python`, `resolve_cwd`), the piped launcher (`WorkerSpec`, `WorkerHandle`, `WorkerLauncher`, `PipedWorkerLauncher`, `spawn_piped`) and `describe_runtime`.
- `python/mdium-worker/pyproject.toml`, `python/mdium-worker/src/mdium_worker/{__init__,__main__,registry,protocol,context,worker}.py`, `python/mdium-worker/tests/{test_registry,test_validation,test_worker_loop,sample_module}.py`.
- `src-tauri/tests/fixtures/projects/python-demo/` — a runnable demo project (`.mdium/project.yaml`, `.mdium/flows/demo.flow.yaml`, `demo_flow.py`) for the ignored end-to-end test and the desktop smoke.
- `src-tauri/tests/fixtures/flows/invalid/python-without-project.flow.yaml`.

**Modified**
- `flow-core/src/{issues,model,parse,validate,load,service,lib}.rs`, `run/{driver,engine,prepare,store,model,test_helper,tests,mod}.rs`, `src-tauri/src/commands/flow.rs`, `src-tauri/src/lib.rs`.
- `src/shared/types/{flow,flow-run}.ts`, `src/features/flow/lib/{flow-graph,flow-api}.ts`, `src/features/flow/components/{FlowNodes,RunStartDialog}.tsx`, `src/features/flow/components/Flow.css`, `src/shared/themes/{apply-theme,types}.ts`, `src/shared/i18n/locales/{ja,en}/flow.json`, tests.
- `.gitignore` (Python artifacts).

---

### Task 1: The `python` node kind — model, parsing, validation, project-aware load checks

**Files:**
- Modify: `src-tauri/crates/flow-core/src/issues.rs`, `model.rs` (`NodeKind` ~L189, `name()` ~L201), `parse.rs` (`kind_keys` ~L100), `validate.rs` (`node()` match ~L311, `node_ports` ~L131), `load.rs` (`check_content_at` ~L183, `RefChecker`), `run/prepare.rs` (`check_runnable` ~L45), `tests.rs`
- Create: `src-tauri/tests/fixtures/flows/invalid/python-without-project.flow.yaml`

**Interfaces:**
- Produces:
  - `issues.rs`: `pub const FLOW_PROJECT_REQUIRED: &str = "FLOW_PROJECT_REQUIRED";` (error; a `python` node in a project without a manifest), `pub const FLOW_RUNTIME_UNKNOWN: &str = "FLOW_RUNTIME_UNKNOWN";` (error; params `runtime`).
  - `model.rs`: `NodeKind::Python(PythonNode)` with `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")] pub struct PythonNode { pub runtime: String, pub entry: String, #[serde(default, rename = "with", skip_serializing_if = "BTreeMap::is_empty")] pub with_args: BTreeMap<String, Value> }`; `NodeKind::name()` returns `"python"`.
  - `parse.rs`: `"python" => &["runtime", "entry", "with"]`.
  - `validate.rs`: `pub fn is_entry_name(text: &str) -> bool` (`[a-z0-9_.]+`, non-empty, no leading/trailing/double dots); the `Python` arm validates `runtime` non-empty & untemplated (`FLOW_INVALID_VALUE` reason `empty` / `template-not-allowed`), `entry` with `is_entry_name` (`FLOW_INVALID_VALUE` reason `bad-entry-name`), `with` via `value_templates`.
  - `load.rs`: `check_content_at` loads the manifest once (`crate::project::load_project(project_root)`) and passes `runtimes: Option<BTreeSet<String>>` (`None` = no manifest, `Some(names)` = manifest decoded; a manifest with errors counts as `Some(empty)` — the runtime names are unknown, and the run start reports the manifest errors) to a new `RefChecker` field; for each `python` node: `None` → `FLOW_PROJECT_REQUIRED` at `<node>.runtime`; `Some(names)` not containing the runtime → `FLOW_RUNTIME_UNKNOWN` at `<node>.runtime` with param `runtime`.
  - `run/prepare.rs` `check_runnable`: `NodeKind::Python(_)` is runnable (no `FLOW_RUN_UNSUPPORTED`).
- Consumes: `crate::project::load_project`.

- [ ] **Step 1: Write the failing tests**

Fixture `src-tauri/tests/fixtures/flows/invalid/python-without-project.flow.yaml`:

```yaml
schemaVersion: 1
id: python-without-project
name: Python node without a manifest
nodes:
  - { id: render, kind: python, runtime: video_gen, entry: video.render }
```

Add `("python-without-project", FLOW_PROJECT_REQUIRED)` to the `cases` table of `invalid_fixtures_report_exactly_their_error` in `tests.rs` (the fixture root `fixtures/invalid` has no `.mdium/project.yaml`).

Add to `tests.rs`:

```rust
const MANIFEST_WITH_RUNTIME: &str = "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  video_gen: { kind: python, python: .venv/bin/python, module: video_gen_flow }\n";

#[test]
fn python_node_needs_a_declared_runtime() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(&root.join(".mdium/project.yaml"), MANIFEST_WITH_RUNTIME);
    let file = root.join(".mdium/flows/a.flow.yaml");
    let ok = check_content(root, &file, &flow("nodes:\n  - { id: r, kind: python, runtime: video_gen, entry: video.render, with: { title: '${{ params.t }}' } }\nparams: { t: { type: string } }\n"));
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
    let bad = check_content(root, &file, &flow("nodes:\n  - { id: r, kind: python, runtime: nope, entry: video.render }\n"));
    assert_eq!(codes(&bad.errors), vec![FLOW_RUNTIME_UNKNOWN]);
    assert_eq!(bad.errors[0].path, "nodes[0].runtime");
    assert_eq!(bad.errors[0].params["runtime"], "nope");
}

#[test]
fn python_node_attributes_are_validated() {
    assert_eq!(
        reasons_of(&flow("nodes:\n  - { id: r, kind: python, runtime: '', entry: video.render }\n"))[0],
        (FLOW_INVALID_VALUE.to_string(), "nodes[0].runtime".to_string(), "empty".to_string())
    );
    assert_eq!(
        reasons_of(&flow("nodes:\n  - { id: r, kind: python, runtime: x, entry: 'Video.Render' }\n"))[0],
        (FLOW_INVALID_VALUE.to_string(), "nodes[0].entry".to_string(), "bad-entry-name".to_string())
    );
    assert_eq!(
        errors_of(&flow("nodes:\n  - { id: r, kind: python, runtime: x, entry: a.b, with: { k: '${{ nodes.zzz.outputs.q }}' } }\n")),
        vec![FLOW_UNKNOWN_NODE_REF]
    );
    assert_eq!(
        errors_of(&flow("nodes:\n  - { id: r, kind: python, runtime: x, entry: a.b, module: m }\n")),
        vec![FLOW_UNKNOWN_FIELD]
    );
}
```

(`reasons_of` / `errors_of` use `check_text`, which has no manifest; the runtime/project checks live in `check_content`, so these text-only cases must not report `FLOW_PROJECT_REQUIRED`.) Add to `run/prepare.rs` test `rejects_what_this_version_cannot_run_anywhere_in_the_bundle` (or a sibling) an assertion that a flow with a `python` node yields no `FLOW_RUN_UNSUPPORTED` reason.

- [ ] **Step 2: Run them to verify they fail**

Run (from `src-tauri/`): `cargo test -p flow-core python_node` → Expected: compile error / `FLOW_UNKNOWN_NODE_KIND` failures.

- [ ] **Step 3: Implement**

`issues.rs` (after `FLOW_PARAM_TYPE`):

```rust
/// A `python` node exists but the project has no `.mdium/project.yaml`.
pub const FLOW_PROJECT_REQUIRED: &str = "FLOW_PROJECT_REQUIRED";
/// A `python` node names a runtime the manifest does not declare (`params.runtime`).
pub const FLOW_RUNTIME_UNKNOWN: &str = "FLOW_RUNTIME_UNKNOWN";
```

`model.rs`: add the variant `Python(PythonNode)` to `NodeKind` (between `Command` and `Approval`), the struct above with doc comments (`/// Calls a stage of a Python runtime declared in the project manifest (spec 3.1).`), and `NodeKind::Python(_) => "python"` in `name()`.

`parse.rs` `kind_keys`: `"python" => &["runtime", "entry", "with"],`.

`validate.rs`:

```rust
/// A stage name: lowercase identifiers joined by single dots (`video.render`).
pub fn is_entry_name(text: &str) -> bool {
    !text.is_empty()
        && text.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
}
```

and in `node()`'s match:

```rust
            NodeKind::Python(py) => {
                let runtime_path = join(path, "runtime");
                if py.runtime.trim().is_empty() {
                    self.issues.error(invalid(&runtime_path, "empty"));
                } else if template::has_template(&py.runtime) {
                    self.issues.error(invalid(&runtime_path, "template-not-allowed"));
                }
                if !is_entry_name(&py.entry) {
                    self.issues.error(invalid(join(path, "entry"), "bad-entry-name"));
                }
                for (key, value) in &py.with_args {
                    let p = format!("{path}.with.{key}");
                    if !is_ident(key) {
                        self.issues.error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", key.clone()));
                    }
                    self.value_templates(value, &p, ctx);
                }
            }
```

`node_ports`: no change (default `[success]` + `failure`).

`load.rs`: in `check_content_at`, before building `RefChecker`:

```rust
        let runtimes: Option<BTreeSet<String>> = crate::project::load_project(project_root).map(|report| {
            report
                .project
                .map(|p| p.runtimes.keys().cloned().collect())
                .unwrap_or_default()
        });
```

add `runtimes: Option<BTreeSet<String>>` to `RefChecker` (set from the value above), and in `RefChecker::nodes` add the arm:

```rust
                NodeKind::Python(py) => {
                    let p = format!("{node_path}.runtime");
                    match &self.runtimes {
                        None => self.issues.error(FlowIssue::new(FLOW_PROJECT_REQUIRED, &p)),
                        Some(names) if !names.contains(&py.runtime) => self.issues.error(
                            FlowIssue::new(FLOW_RUNTIME_UNKNOWN, &p).with("runtime", py.runtime.clone()),
                        ),
                        Some(_) => {}
                    }
                }
```

(`RefChecker` is created per file; sub-flow recursion goes through `check_content_at`, which loads the manifest again — acceptable, it is one small file.)

`run/prepare.rs` `check_runnable`: add `NodeKind::Python(_)` to the arm that is a no-op for `Approval | Loop | Branch | Subflow`.

Fix every exhaustive `match` on `NodeKind` the compiler reports (`driver.rs` `start_node` will fall into its `other =>` arm until Task 6 — leave it; `flow-graph` is TS and comes in Task 2).

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test -p flow-core` → all pass; `cargo build` → no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src src-tauri/tests/fixtures
git commit -m "feat(flow): add the python node kind with project-aware validation"
```

---

### Task 2: Frontend mirror of the `python` kind

**Files:**
- Modify: `src/shared/types/flow.ts` (node union, `FLOW_ERROR_CODES`), `src/features/flow/lib/flow-graph.ts` (`nodeDetails`), `src/shared/themes/apply-theme.ts` + `types.ts` (+ `apply-theme.test.ts`), `src/features/flow/components/Flow.css` (`.flow-node--python`), `src/shared/i18n/locales/{ja,en}/flow.json` (`kind.python`, `detail.runtime`, `detail.entry`, `issue.FLOW_PROJECT_REQUIRED`, `issue.FLOW_RUNTIME_UNKNOWN`), `src/features/flow/lib/__tests__/flow-graph.test.ts`

**Interfaces:**
- Produces: `export interface FlowPythonNode extends FlowNodeCommon { kind: "python"; runtime: string; entry: string; with?: Record<string, unknown> }` in the `FlowNode` union; `nodeDetails` returns `[{ key: "runtime", value: node.runtime }, { key: "entry", value: node.entry }]`; theme colour key `python` (`--flow-node-python`).

- [ ] **Step 1: Write the failing test**

In `flow-graph.test.ts` add:

```ts
it("describes python nodes by runtime and entry", () => {
  const node = { id: "r", kind: "python", runtime: "video_gen", entry: "video.render", with: { title: "x" } } as const;
  expect(nodeDetails(node)).toEqual([
    { key: "runtime", value: "video_gen" },
    { key: "entry", value: "video.render" },
  ]);
});
```

Run: `npx vitest run src/features/flow/lib/__tests__/flow-graph.test.ts` → FAIL (type error / missing case).

- [ ] **Step 2: Implement**

`flow.ts`: add `FlowPythonNode` and include it in `FlowNode`; append `"FLOW_PROJECT_REQUIRED", "FLOW_RUNTIME_UNKNOWN"` to `FLOW_ERROR_CODES` (after `"FLOW_PARAM_TYPE"`). Note `runError.FLOW_PROJECT_REQUIRED` already exists (service code); the `issue.*` entry is new.

`flow-graph.ts` `nodeDetails`: `case "python": return [{ key: "runtime", value: node.runtime }, { key: "entry", value: node.entry }];`.

Theme: add `python` to the flow node colour map in `apply-theme.ts` (`FlowNodeColorKey`, `flowNodeDefaults` — pick a distinct colour, e.g. the yellow/green hue not used yet, light and dark variants matching the neighbours' format), `types.ts`, the `apply-theme.test.ts` expectation, and `Flow.css` `.flow-node--python { --flow-accent: var(--flow-node-python); }`.

i18n — en: `"kind": { ..., "python": "Python stage" }`, `"detail": { ..., "runtime": "Runtime", "entry": "Stage" }`, `"issue": { ..., "FLOW_PROJECT_REQUIRED": "A python node needs .mdium/project.yaml in this folder.", "FLOW_RUNTIME_UNKNOWN": "Runtime \"{{runtime}}\" is not declared in project.yaml." }`; ja: `"python": "Python 段階"`, `"runtime": "ランタイム"`, `"entry": "段階"`, `"FLOW_PROJECT_REQUIRED": "python ノードには .mdium/project.yaml が必要です。"`, `"FLOW_RUNTIME_UNKNOWN": "ランタイム「{{runtime}}」は project.yaml に宣言されていません。"`.

- [ ] **Step 3: Run the frontend suite**

Run: `npm test` and `npx tsc --noEmit -p tsconfig.json` → pass (the issue-code mirror test, the i18n existence test, parity, theme test).

- [ ] **Step 4: Commit**

```bash
git add src/shared src/features/flow
git commit -m "feat(flow): mirror the python node kind in the UI types, details and theme"
```

---

### Task 3: Worker protocol, manifest types and input validation (`run/worker.rs`, part 1)

**Files:**
- Create: `src-tauri/crates/flow-core/src/run/worker.rs`
- Modify: `src-tauri/crates/flow-core/src/run/mod.rs` (`pub mod worker;`), `run/process.rs` (`parse_line` must accept an `artifact.mediaType` field — it ignores unknown fields already; confirm and leave)

**Interfaces:**
- Produces (all `pub` in `flow_core::run::worker`):
  - `pub const WORKER_PROTOCOL_VERSION: u64 = 1;`
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "lowercase")] pub enum StageInputType { String, Number, Bool, Path, Object, Array }`
  - `pub struct StageInput { #[serde(rename = "type")] pub ty: StageInputType, #[serde(default)] pub required: bool, pub default: Option<Value>, pub description: Option<String> }`
  - `pub struct StageOutput { #[serde(rename = "type")] pub ty: Option<StageInputType>, pub description: Option<String> }`
  - `pub struct StageArtifact { pub label: String, pub media_type: Option<String> }` (camelCase)
  - `pub struct StageDef { pub name: String, pub description: Option<String>, pub inputs: BTreeMap<String, StageInput>, pub outputs: BTreeMap<String, StageOutput>, pub artifacts: Vec<StageArtifact> }` (all collections `#[serde(default)]`)
  - `pub struct Manifest { pub module: String, pub stages: Vec<StageDef> }` with `pub fn stage(&self, name: &str) -> Option<&StageDef>`
  - `pub enum WorkerMessage { Manifest { request_id: String, manifest: Manifest }, Error { request_id: Option<String>, code: String, message: String }, Log { call_id: Option<String>, level: String, text: String }, Item { call_id: Option<String>, item: ProtocolItem, line: String /* the line with callId removed, re-serialized */ }, Invalid { reason: &'static str } }`
  - `pub fn parse_worker_line(line: &str) -> WorkerMessage` — `v != 1` → `Invalid("unsupported-version")`; non-JSON → `Invalid("invalid-json")`; `type` `manifest` / `error` / `log` as above; `progress|cost|output|artifact|outcome` → strip `callId`, re-serialize, delegate to `process::parse_line` (an `Err(reason)` from it → `Invalid(reason)`); other → `Invalid("unknown-type")`.
  - `pub fn validate_inputs(stage: &StageDef, given: &serde_json::Map<String, Value>) -> Result<serde_json::Map<String, Value>, Vec<Reason>>` — unknown key → `Reason::new(FLOW_PYTHON_INPUT_INVALID).with("input", key).with("reason", "unknown")`; missing required (no default, absent or `null`) → `reason: "missing"`; type mismatch (`string`/`path` ⇒ string, `number` ⇒ number, `bool` ⇒ boolean, `object` ⇒ object, `array` ⇒ array; `null` ⇒ use the default or `missing`) → `reason: "type"` with `expected` and `found`; the returned map has defaults filled in.
  - Request builders returning one JSON line (no trailing newline): `pub fn describe_request(request_id: &str) -> String`, `pub fn call_request(request_id: &str, call_id: &str, entry: &str, inputs: &serde_json::Map<String, Value>, ctx: &CallContext) -> String`, `pub fn cancel_request(call_id: &str) -> String`, `pub fn shutdown_request() -> String`, with `pub struct CallContext { pub run_id: String, pub node_key: String, pub node_dir: String, pub project_root: String, pub stop_file: String, pub attempt: u32 }` (camelCase when serialized).
  - Reason/operation codes (in `worker.rs`): `pub const FLOW_RUNTIME_START_FAILED: &str = "FLOW_RUNTIME_START_FAILED"; pub const FLOW_PYTHON_ENTRY_UNKNOWN: &str = "FLOW_PYTHON_ENTRY_UNKNOWN"; pub const FLOW_PYTHON_INPUT_INVALID: &str = "FLOW_PYTHON_INPUT_INVALID"; pub const FLOW_PYTHON_PROTOCOL: &str = "FLOW_PYTHON_PROTOCOL"; pub const FLOW_PYTHON_WORKER_EXITED: &str = "FLOW_PYTHON_WORKER_EXITED";`
- Consumes: `process::{parse_line, ProtocolItem}`, `model::Reason`.

- [ ] **Step 1: Write the failing tests** (test module at the bottom of `worker.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::process::{ProtocolItem, ProtocolOutcome};
    use serde_json::json;

    fn manifest() -> Manifest {
        serde_json::from_value(json!({
            "module": "demo",
            "stages": [{
                "name": "video.render",
                "description": "Render",
                "inputs": {
                    "videoDir": { "type": "path", "required": true },
                    "title": { "type": "string", "default": "video" },
                    "n": { "type": "number" },
                    "flags": { "type": "object" }
                },
                "outputs": { "videoPath": { "type": "path" } },
                "artifacts": [{ "label": "video", "mediaType": "video/mp4" }]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn parses_manifest_error_log_and_items() {
        let m = parse_worker_line(r#"{"v":1,"type":"manifest","requestId":"1","module":"demo","stages":[]}"#);
        assert!(matches!(m, WorkerMessage::Manifest { ref request_id, ref manifest } if request_id == "1" && manifest.module == "demo"));
        let e = parse_worker_line(r#"{"v":1,"type":"error","requestId":"2","code":"FLOW_PYTHON_ENTRY_UNKNOWN","message":"no such stage"}"#);
        assert!(matches!(e, WorkerMessage::Error { ref code, .. } if code == "FLOW_PYTHON_ENTRY_UNKNOWN"));
        let l = parse_worker_line(r#"{"v":1,"type":"log","callId":"c1","level":"warning","text":"hi"}"#);
        assert!(matches!(l, WorkerMessage::Log { ref level, ref text, .. } if level == "warning" && text == "hi"));
        let p = parse_worker_line(r#"{"v":1,"type":"progress","callId":"c1","text":"t","fraction":0.5}"#);
        match p {
            WorkerMessage::Item { call_id, item: ProtocolItem::Progress { text, fraction }, line } => {
                assert_eq!(call_id.as_deref(), Some("c1"));
                assert_eq!((text.as_str(), fraction), ("t", Some(0.5)));
                assert!(!line.contains("callId"), "{line}");
                assert!(line.contains("\"type\":\"progress\""));
            }
            other => panic!("{other:?}"),
        }
        let o = parse_worker_line(r#"{"v":1,"type":"outcome","callId":"c1","status":"needs_approval","message":"ok?"}"#);
        assert!(matches!(o, WorkerMessage::Item { item: ProtocolItem::Outcome(ProtocolOutcome::NeedsApproval(Some(ref m))), .. } if m == "ok?"));
        let a = parse_worker_line(r#"{"v":1,"type":"artifact","callId":"c1","path":"out/x.mp4","label":"video","mediaType":"video/mp4"}"#);
        assert!(matches!(a, WorkerMessage::Item { item: ProtocolItem::Artifact { .. }, .. }));
    }

    #[test]
    fn rejects_bad_lines_with_a_reason() {
        // Review Focus 1: a stray print() is an invalid line, never a panic.
        assert!(matches!(parse_worker_line("hello from print()"), WorkerMessage::Invalid { reason: "invalid-json" }));
        assert!(matches!(parse_worker_line(r#"{"v":2,"type":"log"}"#), WorkerMessage::Invalid { reason: "unsupported-version" }));
        assert!(matches!(parse_worker_line(r#"{"v":1,"type":"dance"}"#), WorkerMessage::Invalid { reason: "unknown-type" }));
        assert!(matches!(parse_worker_line(r#"{"v":1,"type":"output","key":"bad key","value":1}"#), WorkerMessage::Invalid { .. }));
    }

    #[test]
    fn validates_inputs_against_the_stage() {
        let stage = manifest().stage("video.render").unwrap().clone();
        let given = json!({ "videoDir": "/v", "n": 2, "flags": { "a": true } });
        let filled = validate_inputs(&stage, given.as_object().unwrap()).unwrap();
        assert_eq!(filled["title"], "video");
        assert_eq!(filled["n"], 2);
        let bad = json!({ "title": "t", "n": "3", "extra": 1 });
        let errs = validate_inputs(&stage, bad.as_object().unwrap()).unwrap_err();
        let reasons: Vec<(String, String)> = errs
            .iter()
            .map(|r| (r.params["input"].as_str().unwrap().to_string(), r.params["reason"].as_str().unwrap().to_string()))
            .collect();
        assert!(reasons.contains(&("videoDir".into(), "missing".into())), "{reasons:?}");
        assert!(reasons.contains(&("n".into(), "type".into())), "{reasons:?}");
        assert!(reasons.contains(&("extra".into(), "unknown".into())), "{reasons:?}");
        assert!(errs.iter().all(|r| r.code == FLOW_PYTHON_INPUT_INVALID));
        let null_default = json!({ "videoDir": "/v", "title": null });
        assert_eq!(validate_inputs(&stage, null_default.as_object().unwrap()).unwrap()["title"], "video");
    }

    #[test]
    fn builds_requests_as_single_lines() {
        let ctx = CallContext { run_id: "r".into(), node_key: "a".into(), node_dir: "/d".into(), project_root: "/p".into(), stop_file: "/p/STOP".into(), attempt: 1 };
        let call = call_request("7", "c7", "video.render", json!({ "x": 1 }).as_object().unwrap(), &ctx);
        let v: Value = serde_json::from_str(&call).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["type"], "call");
        assert_eq!(v["requestId"], "7");
        assert_eq!(v["callId"], "c7");
        assert_eq!(v["entry"], "video.render");
        assert_eq!(v["inputs"]["x"], 1);
        assert_eq!(v["context"]["nodeKey"], "a");
        assert_eq!(v["context"]["attempt"], 1);
        assert!(!call.contains('\n'));
        assert_eq!(serde_json::from_str::<Value>(&describe_request("1")).unwrap()["type"], "describe");
        assert_eq!(serde_json::from_str::<Value>(&cancel_request("c7")).unwrap()["callId"], "c7");
        assert_eq!(serde_json::from_str::<Value>(&shutdown_request()).unwrap()["type"], "shutdown");
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core worker::` → compile error (module missing).

- [ ] **Step 3: Implement the module (part 1)**

```rust
//! The resident Python worker of `python` nodes (spec 2026-10-10, chapter 3):
//! the `mdium-worker-v1` JSON-line protocol, the manifest a worker returns
//! to `describe`, input validation against a stage, interpreter resolution
//! and the piped child process behind [`WorkerLauncher`].

use crate::model::Reason;
use crate::run::process::{parse_line, ProtocolItem};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const WORKER_PROTOCOL_VERSION: u64 = 1;

pub const FLOW_RUNTIME_START_FAILED: &str = "FLOW_RUNTIME_START_FAILED";
pub const FLOW_PYTHON_ENTRY_UNKNOWN: &str = "FLOW_PYTHON_ENTRY_UNKNOWN";
pub const FLOW_PYTHON_INPUT_INVALID: &str = "FLOW_PYTHON_INPUT_INVALID";
pub const FLOW_PYTHON_PROTOCOL: &str = "FLOW_PYTHON_PROTOCOL";
pub const FLOW_PYTHON_WORKER_EXITED: &str = "FLOW_PYTHON_WORKER_EXITED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageInputType { String, Number, Bool, Path, Object, Array }

impl StageInputType {
    fn accepts(self, value: &Value) -> bool {
        match self {
            StageInputType::String | StageInputType::Path => value.is_string(),
            StageInputType::Number => value.is_number(),
            StageInputType::Bool => value.is_boolean(),
            StageInputType::Object => value.is_object(),
            StageInputType::Array => value.is_array(),
        }
    }
    fn name(self) -> &'static str {
        match self {
            StageInputType::String => "string", StageInputType::Number => "number", StageInputType::Bool => "bool",
            StageInputType::Path => "path", StageInputType::Object => "object", StageInputType::Array => "array",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInput {
    #[serde(rename = "type")]
    pub ty: StageInputType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutput {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<StageInputType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArtifact {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, StageInput>,
    #[serde(default)]
    pub outputs: BTreeMap<String, StageOutput>,
    #[serde(default)]
    pub artifacts: Vec<StageArtifact>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub module: String,
    #[serde(default)]
    pub stages: Vec<StageDef>,
}

impl Manifest {
    pub fn stage(&self, name: &str) -> Option<&StageDef> {
        self.stages.iter().find(|s| s.name == name)
    }
}

/// One line received from a worker.
#[derive(Debug)]
pub enum WorkerMessage {
    Manifest { request_id: String, manifest: Manifest },
    Error { request_id: Option<String>, code: String, message: String },
    Log { call_id: Option<String>, level: String, text: String },
    /// A node-level protocol item; `line` is the JSON without `callId`
    /// (what the attempt's `events.jsonl` records).
    Item { call_id: Option<String>, item: ProtocolItem, line: String },
    Invalid { reason: &'static str },
}

pub fn parse_worker_line(line: &str) -> WorkerMessage {
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(line) else {
        return WorkerMessage::Invalid { reason: "invalid-json" };
    };
    if obj.get("v").and_then(Value::as_u64) != Some(WORKER_PROTOCOL_VERSION) {
        return WorkerMessage::Invalid { reason: "unsupported-version" };
    }
    let s = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    match obj.get("type").and_then(Value::as_str) {
        Some("manifest") => {
            let Some(request_id) = s(&obj, "requestId") else { return WorkerMessage::Invalid { reason: "missing-request-id" } };
            match serde_json::from_value::<Manifest>(Value::Object(obj.clone())) {
                Ok(manifest) => WorkerMessage::Manifest { request_id, manifest },
                Err(_) => WorkerMessage::Invalid { reason: "bad-manifest" },
            }
        }
        Some("error") => WorkerMessage::Error {
            request_id: s(&obj, "requestId"),
            code: s(&obj, "code").unwrap_or_else(|| FLOW_PYTHON_PROTOCOL.to_string()),
            message: s(&obj, "message").unwrap_or_default(),
        },
        Some("log") => WorkerMessage::Log {
            call_id: s(&obj, "callId"),
            level: s(&obj, "level").unwrap_or_else(|| "info".to_string()),
            text: s(&obj, "text").unwrap_or_default(),
        },
        Some("progress") | Some("cost") | Some("output") | Some("artifact") | Some("outcome") => {
            let call_id = s(&obj, "callId");
            obj.remove("callId");
            let line = Value::Object(obj).to_string();
            match parse_line(&line) {
                Ok(item) => WorkerMessage::Item { call_id, item, line },
                Err(reason) => WorkerMessage::Invalid { reason },
            }
        }
        _ => WorkerMessage::Invalid { reason: "unknown-type" },
    }
}

/// Checks `given` against the stage's inputs and fills defaults (spec 3.4).
pub fn validate_inputs(stage: &StageDef, given: &Map<String, Value>) -> Result<Map<String, Value>, Vec<Reason>> {
    let mut errors = Vec::new();
    let mut out = Map::new();
    let bad = |input: &str, reason: &str| Reason::new(FLOW_PYTHON_INPUT_INVALID).with("input", input).with("reason", reason);
    for key in given.keys() {
        if !stage.inputs.contains_key(key) {
            errors.push(bad(key, "unknown"));
        }
    }
    for (name, def) in &stage.inputs {
        let value = given.get(name).filter(|v| !v.is_null()).cloned().or_else(|| def.default.clone());
        match value {
            None if def.required => errors.push(bad(name, "missing")),
            None => {}
            Some(v) if !def.ty.accepts(&v) => errors.push(
                bad(name, "type").with("expected", def.ty.name()).with("found", json_type_name(&v)),
            ),
            Some(v) => {
                out.insert(name.clone(), v);
            }
        }
    }
    if errors.is_empty() { Ok(out) } else { Err(errors) }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null", Value::Bool(_) => "bool", Value::Number(_) => "number",
        Value::String(_) => "string", Value::Array(_) => "array", Value::Object(_) => "object",
    }
}

/// Where a call runs, as the worker sees it (`context` of `call`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    pub run_id: String,
    pub node_key: String,
    pub node_dir: String,
    pub project_root: String,
    pub stop_file: String,
    pub attempt: u32,
}

pub fn describe_request(request_id: &str) -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "describe", "requestId": request_id }).to_string()
}

pub fn call_request(request_id: &str, call_id: &str, entry: &str, inputs: &Map<String, Value>, ctx: &CallContext) -> String {
    serde_json::json!({
        "v": WORKER_PROTOCOL_VERSION, "type": "call", "requestId": request_id, "callId": call_id,
        "entry": entry, "inputs": inputs, "context": ctx,
    })
    .to_string()
}

pub fn cancel_request(call_id: &str) -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "cancel", "callId": call_id }).to_string()
}

pub fn shutdown_request() -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "shutdown" }).to_string()
}
```

(`Reason::with` takes `impl Into<Value>`; `&str` converts.) Add `pub mod worker;` to `run/mod.rs`.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core worker::` → 4 passed; `cargo build` → no warnings (if `StageInputType::name` or constants are unused until Task 6, the compiler may warn — keep them `pub` so they are not dead code).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/run
git commit -m "feat(flow): worker protocol messages, manifest types and input validation"
```

---

### Task 4: Piped worker process, interpreter resolution, `describe_runtime` (`run/worker.rs`, part 2) and the fake worker

**Files:**
- Modify: `src-tauri/crates/flow-core/src/run/worker.rs`, `run/test_helper.rs` (new `flow_test_worker_entry` and `worker_script_env`), `run/driver.rs` (`DriverEnv` gains `worker_launcher`), the three `DriverEnv` literals (`src-tauri/src/commands/flow_run.rs`, `flow-core/src/service.rs` tests, `run/tests.rs` `make_engine`)

**Interfaces:**
- Produces:
  - `pub struct WorkerSpec { pub python_candidates: Vec<PathBuf> /* absolute */, pub module: String, pub working_dir: PathBuf, pub env: Vec<(String, String)>, pub stderr: PathBuf, pub stdout_log: PathBuf }`
  - `pub enum WorkerEvent { Line(String), Exited(Option<i32>) }`
  - `pub trait WorkerHandle: Send { fn pid(&self) -> u32; fn send(&mut self, line: &str) -> std::io::Result<()>; fn try_recv(&mut self) -> Option<WorkerEvent>; fn try_wait(&mut self) -> std::io::Result<Option<i32>>; fn kill_tree(&mut self); }`
  - `pub trait WorkerLauncher: Send + Sync { fn launch(&self, spec: &WorkerSpec) -> std::io::Result<Box<dyn WorkerHandle>>; }`
  - `pub struct PipedWorkerLauncher;` — resolves the first existing candidate (`resolve_python_candidates`), builds `Command::new(python).args(["-m", "mdium_worker", "--module", &spec.module])` with `current_dir`, `envs`, stdin/stdout piped, stderr → `File::create(spec.stderr)`, Windows `CREATE_NO_WINDOW`, then `spawn_piped`.
  - `pub fn spawn_piped(cmd: Command) -> std::io::Result<Box<dyn WorkerHandle>>` — spawns, takes stdin/stdout, starts a reader thread that sends `WorkerEvent::Line` per line over an `mpsc` channel and `WorkerEvent::Exited(code)` after EOF + `wait()`; `PipedWorker { child, stdin: ChildStdin, rx: Receiver<WorkerEvent>, pid, exited: Option<Option<i32>> }`; `try_recv` = `rx.try_recv().ok()` (remembering `Exited`); `kill_tree` = `process::kill_tree_by_pid(pid)` + `child.kill()` + `wait()`.
  - `pub fn resolve_python(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String>` — first candidate whose `symlink_metadata` is a regular file (not a symlink) after `project_root.join(candidate)`; error text lists all candidates. `pub fn resolve_cwd(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String>` — must be a directory, not a symlink.
  - `pub fn worker_spec(project_root: &Path, name: &str, def: &RuntimeDef, run_dir: &Path, extra_env: &[(String, String)]) -> Result<WorkerSpec, Reason>` — builds candidates (all, absolute), `working_dir` from `resolve_cwd`, env = `def.env` + `PYTHONUTF8=1` + `MDIUM_PROJECT_ROOT` + `extra_env`, logs under `run_dir/runtimes/<name>/` (created).
  - `pub fn describe_runtime(launcher: &dyn WorkerLauncher, spec: &WorkerSpec, timeout: Duration) -> Result<Manifest, Reason>` — launches, sends `describe_request("1")`, polls `try_recv` every 20 ms until a `Manifest` for request `1`, an `Error`, `Exited`, or the timeout (`FLOW_RUNTIME_START_FAILED` with `message`), then sends `shutdown_request()` and `kill_tree`s after 1 s if still alive.
  - `DriverEnv.worker_launcher: Arc<dyn WorkerLauncher>` (Tauri: `PipedWorkerLauncher`; tests: the fake below).
  - Fake worker in `test_helper.rs`: `pub fn worker_script_env(script: &Value) -> (String, String)` → `("FLOW_TEST_WORKER", json)`; `#[test] fn flow_test_worker_entry()` returns unless `FLOW_TEST_WORKER` is set, then reads stdin lines and answers: `describe` → `manifest` with `script["stages"]`; `call` → runs `script["behaviour"][entry]` steps (`emit` {item JSON, `callId` added}, `log` {level,text}, `raw` (a verbatim line, e.g. non-JSON), `sleep_ms`, `wait_cancel_ms` (poll stdin for `cancel` up to N ms → outcome `stopped`), `wait_stop_ms` (poll `MDIUM_FLOW_STOP_FILE` → outcome `stopped`), `exit` {code} (process exits, no outcome), `outcome` {status, reason?, message?}, `fail_before_attempt` {n} (reads `context.attempt` from the `call`; if it is below `n`, emits outcome `fail` with reason `attempt too low` and stops running further steps of this call)); unknown entry → `error` `FLOW_PYTHON_ENTRY_UNKNOWN`; `shutdown` → exit 0. Two top-level script flags: `exit_on_describe: <code>` and `ignore_describe: true`. Bookkeeping for engine tests: when the env var `FLOW_TEST_WORKER_PID_FILE` is set (the fake launcher sets it to `spec.stdout_log.with_file_name("pid")`), the entry writes `std::process::id()` to that file at start and appends one line to the sibling file `describes.log` per `describe` handled. Also `pub struct FakeWorkerLauncher { pub script: Value }` implementing `WorkerLauncher` by spawning `helper_argv()` with `FLOW_TEST_WORKER` plus `spec.env` through `spawn_piped` (ignoring `python_candidates`/`module`; it does set `current_dir(spec.working_dir)` and stderr to `spec.stderr`). Expose `pub fn fake_worker_launcher(script: Value) -> Arc<dyn WorkerLauncher>`.

- [ ] **Step 1: Write the failing tests** (append to the `worker.rs` test module)

```rust
    use crate::project::{check_project_text, RuntimeDef};
    use crate::run::test_helper::{fake_worker_launcher, worker_script_env};
    use std::time::Duration;

    fn runtime(text: &str) -> RuntimeDef {
        let project = check_project_text(&format!("schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: {text}\n")).project.unwrap();
        project.runtimes["r"].clone()
    }

    #[test]
    fn resolves_the_first_existing_regular_file_candidate() {
        // Review Focus 2.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        let def = runtime("{ kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: m }");
        assert_eq!(resolve_python(root, &def).unwrap(), root.join(".venv/bin/python"));
        let none = runtime("{ kind: python, python: [.venv/Scripts/python.exe], module: m }");
        let err = resolve_python(root, &none).unwrap_err();
        assert!(err.contains(".venv/Scripts/python.exe"), "{err}");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let cwd = runtime("{ kind: python, python: .venv/bin/python, module: m, cwd: sub }");
        assert_eq!(resolve_cwd(root, &cwd).unwrap(), root.join("sub"));
        let bad_cwd = runtime("{ kind: python, python: .venv/bin/python, module: m, cwd: missing }");
        assert!(resolve_cwd(root, &bad_cwd).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_interpreter_and_cwd_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("real-python"), "").unwrap();
        std::os::unix::fs::symlink(root.join("real-python"), root.join("link-python")).unwrap();
        let def = runtime("{ kind: python, python: link-python, module: m }");
        assert!(resolve_python(root, &def).is_err());
    }

    #[test]
    fn describe_runtime_returns_the_manifest_from_a_live_worker() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let script = serde_json::json!({ "stages": [{ "name": "a.b", "inputs": {}, "outputs": {} }], "behaviour": {} });
        let launcher = fake_worker_launcher(script);
        let def = runtime("{ kind: python, python: nope, module: m }");
        let spec = worker_spec(root, "r", &def, &root.join(".mdium/flow-runs/x"), &[]).unwrap();
        let manifest = describe_runtime(launcher.as_ref(), &spec, Duration::from_secs(10)).unwrap();
        assert_eq!(manifest.stages[0].name, "a.b");
        assert!(root.join(".mdium/flow-runs/x/runtimes/r/stderr.log").exists());
    }

    #[test]
    fn describe_runtime_fails_when_the_worker_exits_or_times_out() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let def = runtime("{ kind: python, python: nope, module: m }");
        let spec = worker_spec(root, "r", &def, &root.join("run"), &[]).unwrap();
        let exits = fake_worker_launcher(serde_json::json!({ "exit_on_describe": 3 }));
        let err = describe_runtime(exits.as_ref(), &spec, Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
        let silent = fake_worker_launcher(serde_json::json!({ "ignore_describe": true }));
        let err = describe_runtime(silent.as_ref(), &spec, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
    }
```

(`worker_spec` for the fake launcher must not fail when no candidate exists — resolution happens inside `PipedWorkerLauncher::launch`, not in `worker_spec`; `worker_spec` only resolves `cwd`, so `cwd: .` → the project root.) The fake worker honours two top-level script flags: `exit_on_describe: <code>` (exit immediately with that code when `describe` arrives) and `ignore_describe: true` (never answer).

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core worker::` → compile errors.

- [ ] **Step 3: Implement**

Append to `worker.rs`:

```rust
use crate::project::RuntimeDef;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub python_candidates: Vec<PathBuf>,
    pub module: String,
    pub working_dir: PathBuf,
    pub env: Vec<(String, String)>,
    pub stderr: PathBuf,
    pub stdout_log: PathBuf,
}

#[derive(Debug)]
pub enum WorkerEvent {
    Line(String),
    Exited(Option<i32>),
}

pub trait WorkerHandle: Send {
    fn pid(&self) -> u32;
    fn send(&mut self, line: &str) -> std::io::Result<()>;
    fn try_recv(&mut self) -> Option<WorkerEvent>;
    fn try_wait(&mut self) -> std::io::Result<Option<i32>>;
    fn kill_tree(&mut self);
}

pub trait WorkerLauncher: Send + Sync {
    fn launch(&self, spec: &WorkerSpec) -> std::io::Result<Box<dyn WorkerHandle>>;
}

struct PipedWorker {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<WorkerEvent>,
    pid: u32,
    exited: Option<Option<i32>>,
}

impl WorkerHandle for PipedWorker {
    fn pid(&self) -> u32 { self.pid }
    fn send(&mut self, line: &str) -> std::io::Result<()> {
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }
    fn try_recv(&mut self) -> Option<WorkerEvent> {
        let event = self.rx.try_recv().ok()?;
        if let WorkerEvent::Exited(code) = &event {
            self.exited = Some(*code);
        }
        Some(event)
    }
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        if let Some(code) = self.exited { return Ok(Some(code.unwrap_or(-1))); }
        Ok(self.child.try_wait()?.map(|s| s.code().unwrap_or(-1)))
    }
    fn kill_tree(&mut self) {
        crate::run::process::kill_tree_by_pid(self.pid);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawns `cmd` with piped stdin/stdout and a reader thread; `stderr` must
/// already be set on `cmd` (a file). Lines arrive through `try_recv`.
pub fn spawn_piped(mut cmd: Command) -> std::io::Result<Box<dyn WorkerHandle>> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
    let pid = child.id();
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(WorkerEvent::Line(line)).is_err() { return; }
                }
                Err(_) => break,
            }
        }
        // EOF: the exit code is read by the owner through `try_wait`.
        let _ = tx.send(WorkerEvent::Exited(None));
    });
    Ok(Box::new(PipedWorker { child, stdin, rx, pid, exited: None }))
}

fn no_link_metadata(path: &Path) -> Option<std::fs::Metadata> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    (!meta.file_type().is_symlink()).then_some(meta)
}

/// The first interpreter candidate that is an existing regular file (no link).
pub fn resolve_python(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String> {
    let candidates = def.python.candidates();
    for candidate in &candidates {
        let path = project_root.join(candidate);
        if no_link_metadata(&path).is_some_and(|m| m.is_file()) {
            return Ok(path);
        }
    }
    Err(format!("no interpreter found among {}", candidates.join(", ")))
}

/// The runtime's working directory (an existing directory, no link).
pub fn resolve_cwd(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String> {
    let path = project_root.join(&def.cwd);
    if no_link_metadata(&path).is_some_and(|m| m.is_dir()) {
        Ok(path)
    } else {
        Err(format!("working directory {} is not a directory in the project", def.cwd))
    }
}

/// Everything needed to launch the worker of runtime `name` for a run.
pub fn worker_spec(project_root: &Path, name: &str, def: &RuntimeDef, run_dir: &Path, extra_env: &[(String, String)]) -> Result<WorkerSpec, Reason> {
    let working_dir = resolve_cwd(project_root, def).map_err(|m| Reason::new(FLOW_RUNTIME_START_FAILED).with("runtime", name).with("message", m))?;
    let log_dir = run_dir.join("runtimes").join(name);
    std::fs::create_dir_all(&log_dir).map_err(|e| Reason::new(FLOW_RUNTIME_START_FAILED).with("runtime", name).with("message", e.to_string()))?;
    let mut env: Vec<(String, String)> = def.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    env.push(("PYTHONUTF8".into(), "1".into()));
    env.push(("MDIUM_PROJECT_ROOT".into(), project_root.to_string_lossy().into_owned()));
    env.extend(extra_env.iter().cloned());
    Ok(WorkerSpec {
        python_candidates: def.python.candidates().iter().map(|c| project_root.join(c)).collect(),
        module: def.module.clone(),
        working_dir,
        env,
        stderr: log_dir.join("stderr.log"),
        stdout_log: log_dir.join("stdout.log"),
    })
}

pub struct PipedWorkerLauncher;

impl WorkerLauncher for PipedWorkerLauncher {
    fn launch(&self, spec: &WorkerSpec) -> std::io::Result<Box<dyn WorkerHandle>> {
        let python = spec
            .python_candidates
            .iter()
            .find(|p| no_link_metadata(p).is_some_and(|m| m.is_file()))
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!(
                "no interpreter found among {}",
                spec.python_candidates.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join(", ")
            )))?;
        let mut cmd = Command::new(python);
        cmd.args(["-m", "mdium_worker", "--module", &spec.module])
            .current_dir(&spec.working_dir)
            .envs(spec.env.iter().cloned())
            .stderr(File::create(&spec.stderr)?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        spawn_piped(cmd)
    }
}

/// Launches a worker only to read its manifest (`flow_runtime_describe`).
pub fn describe_runtime(launcher: &dyn WorkerLauncher, spec: &WorkerSpec, timeout: Duration) -> Result<Manifest, Reason> {
    let fail = |message: String| Reason::new(FLOW_RUNTIME_START_FAILED).with("message", message);
    let mut handle = launcher.launch(spec).map_err(|e| fail(e.to_string()))?;
    handle.send(&describe_request("1")).map_err(|e| fail(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    let result = loop {
        match handle.try_recv() {
            Some(WorkerEvent::Line(line)) => match parse_worker_line(&line) {
                WorkerMessage::Manifest { request_id, manifest } if request_id == "1" => break Ok(manifest),
                WorkerMessage::Error { message, .. } => break Err(fail(message)),
                _ => {}
            },
            Some(WorkerEvent::Exited(_)) => break Err(fail("the worker exited before answering describe".into())),
            None => {
                if Instant::now() >= deadline { break Err(fail("timed out waiting for the manifest".into())); }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    let _ = handle.send(&shutdown_request());
    let grace = Instant::now() + Duration::from_secs(1);
    while Instant::now() < grace {
        if matches!(handle.try_wait(), Ok(Some(_))) { return result; }
        std::thread::sleep(Duration::from_millis(20));
    }
    handle.kill_tree();
    result
}
```

`DriverEnv`: add `pub worker_launcher: Arc<dyn WorkerLauncher>,` and set it in the three literals (`Arc::new(PipedWorkerLauncher)` in `flow_run.rs` and `service.rs` tests; `run/tests.rs` `make_engine` takes it from a new `Fixture` field defaulting to `fake_worker_launcher(json!({"stages": [], "behaviour": {}}))` so existing tests compile — give `fixture()` a sibling `fixture_with_worker(script)`).

`test_helper.rs`: implement `flow_test_worker_entry` (reads `std::io::stdin().lock().lines()`; a background thread is not needed because the entry handles `cancel` only inside `wait_cancel_ms`, which polls stdin via a `Receiver` fed by a reader thread started at entry — spawn one reader thread at the top, dispatch on a channel), `worker_script_env`, `FakeWorkerLauncher` + `fake_worker_launcher`. Print each reply with `println!` and `flush`. The `exit` step calls `std::process::exit(code)`. All step names and the two top-level flags are listed in the Interfaces block above — implement every one.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core worker::` and `cargo test --workspace` → pass; `cargo build` → no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src src-tauri/src/commands/flow_run.rs
git commit -m "feat(flow): piped worker launcher, interpreter resolution and a fake worker for tests"
```

---

### Task 5: The manifest travels with the run; start-time checks; stages in the confirmation

**Files:**
- Modify: `src-tauri/crates/flow-core/src/run/store.rs` (`RunMeta`), `run/engine.rs` (`start`, `require_confirmed`, `CommandReview`, `Bundle`), `run/prepare.rs` (`stage_summaries`), `service.rs` (tests), the `RunMeta {` literals (`store.rs` test, `run/tests.rs` ×3)
- Modify: `src/shared/types/flow-run.ts`, `src/features/flow/components/RunStartDialog.tsx`, `__tests__/RunViews.test.tsx`, `src/shared/i18n/locales/{ja,en}/flow.json` (`run.stagesTitle`, `run.stageEntry`)

**Interfaces:**
- Produces:
  - `RunMeta` gains `#[serde(default, skip_serializing_if = "Option::is_none")] pub project: Option<crate::project::ProjectDef>` (the manifest as decoded at start; `None` when the project has no manifest). `RUN_SCHEMA_VERSION` stays `1` (the field is optional).
  - `pub const FLOW_PROJECT_INVALID: &str = "FLOW_PROJECT_INVALID";` in `engine.rs` (operation code): `start` refuses with it (details = the manifest's issues as `Reason { code, params + path }`) when `.mdium/project.yaml` exists but has errors.
  - `prepare.rs`: `pub struct StageSummary { pub file: String, pub within: Vec<String>, pub node_id: String, pub runtime: String, pub entry: String }` (camelCase) and `pub fn stage_summaries(bundle: &[(&str, &FlowDef)]) -> Vec<StageSummary>` (python nodes, inline bodies included, like `command_summaries`).
  - `CommandReview` gains `pub stages: Vec<StageSummary>`; `Bundle::needs_confirmation()` also counts stages; `require_confirmed(root, meta)` needs confirmation when `command_summaries` or `stage_summaries` of the meta's files is non-empty or `meta.project` declares runtimes/setup.
  - TS: `StageSummary { file; within?; nodeId; runtime; entry }`, `CommandReview.stages: StageSummary[]`; the dialog renders a "Stages" section and counts them in `reviewItems`.
- Consumes: Task 1 (`NodeKind::Python`).

- [ ] **Step 1: Write the failing tests**

`service.rs` tests:

```rust
    const PY_FLOW: &str = "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: r, kind: python, runtime: r, entry: a.b, with: { x: 1 } }\n";

    #[test]
    fn python_stages_appear_in_the_review_and_need_confirmation() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: { kind: python, python: nope, module: m }\n").unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), PY_FLOW).unwrap();
        let review = svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap();
        assert!(!review.confirmed);
        assert_eq!(review.stages.len(), 1);
        assert_eq!((review.stages[0].runtime.as_str(), review.stages[0].entry.as_str(), review.stages[0].node_id.as_str()), ("r", "a.b", "r"));
        let json = serde_json::to_value(&review).unwrap();
        assert_eq!(json["stages"][0]["nodeId"], "r");
    }

    #[test]
    fn start_refuses_an_invalid_manifest() {
        use crate::run::engine::FLOW_PROJECT_INVALID;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: Bad Id\nname: P\n").unwrap();
        let review = svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap();
        let err = svc.run_start(root, ".mdium/flows/a.flow.yaml", &BTreeMap::new(), &review.sha256).unwrap_err();
        assert_eq!(err.code, FLOW_PROJECT_INVALID);
        assert_eq!(err.details[0].code, crate::issues::FLOW_INVALID_ID);
    }

    #[test]
    fn run_meta_snapshots_the_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nmetrics: [{ ref: costUsd, better: lower }]\n").unwrap();
        let review = svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap();
        let started = svc.run_start(root, ".mdium/flows/a.flow.yaml", &BTreeMap::new(), &review.sha256).unwrap();
        let snap = svc.run_get(root, &started.run_id).unwrap();
        assert_eq!(snap.meta.project.as_ref().unwrap().id, "p");
        svc.run_cancel(root, &started.run_id).unwrap();
    }
```

(`NO_COMMANDS` exists from V2's tests.) `RunViews.test.tsx`: every `CommandReview` mock gains `stages: []`; add a test where `stages: [{ file: PATH, nodeId: "r", runtime: "video_gen", entry: "video.render" }]` with empty commands/runtimes/setup renders `i18n.t("run.stagesTitle", { ns: "flow" })` and the confirmation checkbox.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core service::` → compile errors.

- [ ] **Step 3: Implement**

`store.rs`: add the field to `RunMeta` (after `refs`); add `project: None` to the test literal; `run/tests.rs` literals likewise.

`prepare.rs`:

```rust
/// A `python` node as shown for confirmation (spec 2.3 / 3.6).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageSummary {
    pub file: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub within: Vec<String>,
    pub node_id: String,
    pub runtime: String,
    pub entry: String,
}

pub fn stage_summaries(bundle: &[(&str, &FlowDef)]) -> Vec<StageSummary> {
    let mut out = Vec::new();
    for (file, flow) in bundle {
        walk(&flow.nodes, "", &mut Vec::new(), &mut |_, within, node| {
            if let NodeKind::Python(py) = &node.kind {
                out.push(StageSummary {
                    file: file.to_string(),
                    within: within.to_vec(),
                    node_id: node.id.clone(),
                    runtime: py.runtime.clone(),
                    entry: py.entry.clone(),
                });
            }
        });
    }
    out
}
```

`engine.rs`:
- `pub const FLOW_PROJECT_INVALID: &str = "FLOW_PROJECT_INVALID";` beside the other operation codes.
- `ProjectInBundle` gains `issues: Vec<FlowIssue>` (the report's errors) so `start` can refuse: in `load_bundle` keep `report.errors`.
- `CommandReview` gains `pub stages: Vec<StageSummary>`; `review_commands` fills it with `stage_summaries(&bundle.files())`; `needs_confirmation()` adds `|| !stage_summaries(&self.files()).is_empty()`.
- `start`: after the part check and before the hash check, add:

```rust
        if let Some(project) = &bundle.project {
            if !project.issues.is_empty() {
                let details = project.issues.iter().map(|i| Reason { code: i.code.clone(), params: i.params.clone() }.with("path", i.path.clone())).collect();
                return Err(EngineError::new(FLOW_PROJECT_INVALID, ".mdium/project.yaml has validation errors").with_details(details));
            }
        }
```

and set `project: bundle_project_def` in the `RunMeta` literal (destructure `project` out of the bundle before `let Bundle { flow, others, refs, .. }`; `bundle.project.and_then(|p| p.project)`).
- `require_confirmed`: compute `needs = !command_summaries(&files).is_empty() || !stage_summaries(&files).is_empty() || meta.project.as_ref().is_some_and(|p| !p.runtimes.is_empty() || !p.setup.is_empty())`.

TS `flow-run.ts`: `StageSummary` interface and `stages: StageSummary[]` on `CommandReview`. `RunStartDialog.tsx`: `reviewItems` adds `review.stages.length`; new section after the runtimes section:

```tsx
      {review && review.stages.length > 0 && (
        <section className="flow-dialog__section">
          <h3 className="flow-dialog__heading">{t("run.stagesTitle")}</h3>
          <ul className="flow-dialog__commands">
            {review.stages.map((s) => (
              <li key={`${s.file}|${(s.within ?? []).join("/")}|${s.nodeId}`} className="flow-dialog__command">
                <div className="flow-dialog__command-head">
                  <strong>{[...(s.within ?? []), s.nodeId].join(" / ")}</strong>
                  {s.file !== flowPath && <span className="flow-dialog__badge">{s.file}</span>}
                </div>
                <code className="flow-dialog__code">{t("run.stageEntry", { runtime: s.runtime, entry: s.entry })}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
```

Also hide `run.noCommands` when stages exist (extend the all-empty condition). i18n — en: `"stagesTitle": "Python stages this flow calls"`, `"stageEntry": "{{runtime}} → {{entry}}"`; ja: `"stagesTitle": "このフローが呼ぶ Python 段階"`, `"stageEntry": "{{runtime}} → {{entry}}"`.

- [ ] **Step 4: Run everything**

Run: `cargo test --workspace`, `cargo build`, `npm test`, `npx tsc --noEmit -p tsconfig.json` → pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri src/shared src/features/flow
git commit -m "feat(flow): snapshot the manifest in runs, refuse invalid manifests, confirm python stages"
```

---

### Task 6: Driver — running `python` nodes through resident workers

**Files:**
- Modify: `src-tauri/crates/flow-core/src/run/driver.rs` (struct `Driver`, `RunningCommand` → shared `ItemState`, `start_ready`, `start_node`, new `ensure_worker` / `launch_call` / `poll_calls` / `finish_call` / `shutdown_workers`, `begin_stop`, `cancel_all`, `shutdown`, `reconnect_running`, `retire`), `run/tests.rs`

**Interfaces:**
- Produces (driver internals; names used by tests only through behaviour):
  - `struct ItemState { outcome: Option<ProtocolOutcome>, last_progress: Option<Instant>, pending_progress: Option<(String, Option<f64>)> }` extracted from `RunningCommand` (which keeps an `items: ItemState` field); `fn apply_item(&mut self, key: &str, item: ProtocolItem, st: &mut ItemState)` replaces the body of `protocol_item` (which becomes a thin wrapper or is removed).
  - `struct LiveWorker { runtime: String, handle: Box<dyn WorkerHandle>, manifest: Manifest, next_request: u64, stdout_log: PathBuf }` in `Driver.workers: BTreeMap<String, LiveWorker>`.
  - `struct RunningCall { key: String, attempt: u32, dir: PathBuf, runtime: String, call_id: String, request_id: String, items: ItemState, started: Instant, timeout: Option<Duration>, grace_deadline: Option<Instant>, cancel_sent: bool, lines: usize, limit_warned: bool }` in `Driver.calls: Vec<RunningCall>`.
  - Constants: `WORKER_READY_TIMEOUT: Duration = 30s`, `DEFAULT_CANCEL_GRACE: Duration = 5s` (used when `limits.stopGrace` is unset for timeout/cancel of a call), `WORKER_SHUTDOWN_GRACE: Duration = 2s` (run end).
  - Behaviour (spec 3.1–3.5), all through `emit` so every state change is an event:
    1. `start_ready` counts `Python` nodes against `MAX_RUNNING_COMMANDS` like commands.
    2. `start_node` `Python` arm → `launch_call(prefix, key, node, py, attempt)`:
       a. `meta.project` must be `Some` and contain the runtime, else `fail_node(FLOW_RUNTIME_UNKNOWN)` (defensive; validation normally prevents it).
       b. `ensure_worker(runtime)`: if absent, build `worker_spec(project_root, name, def, run_dir, &[MDIUM_FLOW_RUN_ID, MDIUM_FLOW_STOP_FILE])`, `worker_launcher.launch`, send `describe_request("1")`, wait up to `WORKER_READY_TIMEOUT` polling every `env.poll` (blocking; the driver thread sleeps), on success insert `LiveWorker`; on failure `fail_node(FLOW_RUNTIME_START_FAILED{message})` and discard the handle (`kill_tree`).
       c. `manifest.stage(entry)` missing → `fail_node(FLOW_PYTHON_ENTRY_UNKNOWN{entry})`.
       d. Create the attempt dir (`store.node_attempt_dir`), render `with` via `with_ctx(... render_json)`; a render failure → `fail_node` with that reason; the rendered value must be an object (it is, from a map). `validate_inputs(stage, &rendered)` → errors → write `inputs.json` with the rendered map anyway and `fail_node(FLOW_PYTHON_INPUT_INVALID)` with the first reason plus `details` (all reasons) — the worker stays alive (Review Focus 5).
       e. Write `inputs.json` (the validated/filled inputs), create empty `events.jsonl` and `stdout.log`.
       f. `send(call_request(request_id, call_id, entry, inputs, &CallContext{...}))` where `call_id = format!("{key}#{attempt}")` and `request_id = next_request` ; send failure → `fail_node(FLOW_PYTHON_WORKER_EXITED)` and drop the worker. Push `RunningCall`.
    3. `poll_calls` (called from the main loop next to `poll_running`): for every worker, drain `try_recv`:
       - `Line` → `parse_worker_line`: `Item { call_id, item, line }` → if `call_id` matches a running call of this runtime: append `line` + `\n` to `dir/events.jsonl` (count lines; over `MAX_LINES` → drop + one `FLOW_PROTOCOL_WARNING{reason:"too-many-lines"}`; a line over `MAX_LINE_BYTES` → drop + warning `line-too-long`), then `apply_item(key, item, &mut call.items)`; items after an `outcome` or with an unknown `call_id` → `FLOW_PROTOCOL_WARNING{reason:"unexpected-call-id"}`. `Log { call_id: Some(id) }` → append `[{level}] {text}\n` to that call's `dir/stdout.log`; `Log { call_id: None }` → append to the worker's `stdout_log`. `Error { request_id }` matching a running call's `request_id` → `call.items.outcome = Some(ProtocolOutcome::Fail(Some(message)))` with the error `code` remembered (`call.error_code = Some(code)`); `Error` with no match → worker `stdout_log`. `Invalid { reason }` inside a call (any call running on this worker) → `FLOW_PROTOCOL_WARNING{reason}`; outside → append the raw line to the worker's `stdout_log` (Review Focus 1). `Manifest` after start → ignored.
       - `Exited(_)` → every running call on this runtime fails with `FLOW_PYTHON_WORKER_EXITED` (after `finish` bookkeeping below), the worker is removed.
       `apply_item` for an `Output` whose key is not in the stage's manifest `outputs` additionally emits `FLOW_PROTOCOL_WARNING{reason:"undeclared-output", key}` (spec 3.1: accepted with a warning).
       Then for each call: `items.outcome` present → `finish_call(call, if call.timed_out { Finish::Timeout } else { Finish::Exited(0) })` (an outcome that arrives after the timeout's `cancel` still counts as a timeout); `grace_deadline` passed → `kill` the worker, remove it, `finish_call(call, Finish::GraceKilled)` (STOP case) or `Finish::Timeout` (timeout/cancel case — track with a `timed_out: bool` on the call); `timeout` elapsed and `!cancel_sent` → `send(cancel_request)`, `cancel_sent = true`, `grace_deadline = now + stop_grace.unwrap_or(DEFAULT_CANCEL_GRACE)`, `timed_out = true`.
    4. `finish_call`: flush pending progress; write `outputs.json`; result: `Timeout` → `after_failure(FLOW_NODE_TIMEOUT, timed_out = true)`; `GraceKilled` → `set_node(Ready, FLOW_STOP_GRACE_EXCEEDED)`; `Exited` → by outcome: `Ok` → `settle(Succeeded, PORT_SUCCESS)`; `Fail(reason)` → if `error_code` is set → `after_failure(Reason::new(code).with("detail", reason))` else `after_failure(Reason::new(FLOW_NODE_FAILED).with("detail", reason))`; `NeedsApproval(msg)` → exactly as commands (`AwaitingApproval` + `ApprovalRequested` with `FLOW_COMMAND_NEEDS_APPROVAL`, `COMMAND_APPROVAL_OPTIONS`); `Stopped` → `set_node(Ready, FLOW_NODE_STOPPED)`. `apply_approval` for a python node works unchanged (it is kind-agnostic).
    5. `begin_stop`: calls get `grace_deadline` like commands (no `cancel`). `cancel_all`: send `cancel` is skipped — kill every worker, calls → `Cancelled(FLOW_RUN_CANCELLED)`. `shutdown` (app exit): kill every worker, calls → `Interrupted(FLOW_APP_EXITED)`. `retire(key)` (pass reset) for a running call → kill that worker and mark the call cancelled like commands.
    6. Run end (after the main loop exits, before the final checkpoint) and after `cancel_all`/`shutdown`: `shutdown_workers()` — for each worker send `shutdown_request()`, then wait up to `WORKER_SHUTDOWN_GRACE` polling `try_wait`, then `kill_tree`.
    7. `reconnect_running`: a `Running` python node with no live call → `Interrupted(FLOW_PROCESS_LOST)` (workers never survive a restart), like a lost command.
    8. Retry: `after_failure` → `RetryWait` → `retry_due` → `start_node` again; the new attempt reuses the live worker if present (Review Focus 3), or starts one if the previous died.
- Consumes: Tasks 3–5.

- [ ] **Step 1: Write the failing engine tests** (`run/tests.rs`; use the fixture helpers `write_flow`, `confirm_and_start`, `wait_settled`, `snapshot`, `node`, plus a new `fixture_with_worker(script)` from Task 4 and a helper that writes a manifest `write_manifest(root)` with `runtimes: { r: { kind: python, python: nope, module: m } }`)

```rust
fn py(id: &str, entry: &str, with: Value) -> Value {
    json!({ "id": id, "kind": "python", "runtime": "r", "entry": entry, "with": with })
}

fn stage(name: &str, inputs: Value) -> Value {
    json!({ "name": name, "inputs": inputs, "outputs": {} })
}

fn item(v: Value) -> Value { json!({ "emit": v }) }

#[test]
fn python_node_runs_a_stage_and_records_events() {
    let script = json!({
        "stages": [stage("a.ok", { "n": { "type": "number", "required": true }, "t": { "type": "string", "default": "x" } })],
        "behaviour": { "a.ok": [
            item(json!({ "type": "progress", "text": "half", "fraction": 0.5 })),
            { "log": { "level": "info", "text": "hello" } },
            item(json!({ "type": "output", "key": "sum", "value": 3 })),
            item(json!({ "type": "cost", "usd": 0.5, "kind": "actual" })),
            item(json!({ "type": "artifact", "path": "out.txt", "label": "out", "mediaType": "text/plain" })),
            { "outcome": { "status": "ok" } }
        ] }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let rel = write_flow(&f.root, "p", "{}", &[py("s", "a.ok", json!({ "n": "${{ params.n }}" }))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({ "n": 3 }));
    f.wait_settled(&run_id, RunStatus::Completed);
    let snap = f.snapshot(&run_id);
    let s = node(&snap, "s");
    assert_eq!(s.status, NodeStatus::Succeeded);
    assert_eq!(s.outputs["sum"], 3);
    assert!((s.cost.actual - 0.5).abs() < 1e-9);
    assert_eq!(s.artifacts[0].label.as_deref(), Some("out"));
    let dir = f.engine_store().node_attempt_dir(&run_id, "s", 1).unwrap();
    let inputs: Value = serde_json::from_str(&fs::read_to_string(dir.join("inputs.json")).unwrap()).unwrap();
    assert_eq!(inputs, json!({ "n": 3, "t": "x" }));
    let events = fs::read_to_string(dir.join("events.jsonl")).unwrap();
    assert!(events.contains("\"type\":\"output\"") && !events.contains("callId"));
    assert!(fs::read_to_string(dir.join("stdout.log")).unwrap().contains("[info] hello"));
    assert!(f.root.join(".mdium/flow-runs").join(&run_id).join("runtimes/r/stderr.log").exists());
}

#[test]
fn stage_failure_unknown_entry_and_invalid_inputs_fail_the_node() {
    let script = json!({
        "stages": [stage("a.fail", {}), stage("a.num", { "n": { "type": "number", "required": true } })],
        "behaviour": { "a.fail": [ { "outcome": { "status": "fail", "reason": "boom" } } ] }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let rel = write_flow(&f.root, "p", "{}", &[py("a", "a.fail", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Failed);
    let r = node(&f.snapshot(&run_id), "a").reason.clone().unwrap();
    assert_eq!(r.code, FLOW_NODE_FAILED);
    assert_eq!(r.params["detail"], "boom");

    let rel = write_flow(&f.root, "q", "{}", &[py("u", "a.nope", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(node(&f.snapshot(&run_id), "u").reason.as_ref().unwrap().code, FLOW_PYTHON_ENTRY_UNKNOWN);

    // Review Focus 5: a wrong input type fails before the call; the worker stays usable.
    let rel = write_flow(&f.root, "w", "{}", &[py("i", "a.num", json!({ "n": "3" })), py("ok", "a.fail", json!({}))], &[json!({ "from": "i", "to": "ok", "port": "failure" })]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Failed);
    let snap = f.snapshot(&run_id);
    assert_eq!(node(&snap, "i").reason.as_ref().unwrap().code, FLOW_PYTHON_INPUT_INVALID);
    assert_eq!(node(&snap, "ok").reason.as_ref().unwrap().params["detail"], "boom", "second node reached the same worker");
}

#[test]
fn python_needs_approval_and_stop_work_like_commands() {
    let script = json!({
        "stages": [stage("a.ask", {}), stage("a.stop", {})],
        "behaviour": {
            "a.ask": [ { "outcome": { "status": "needs_approval", "message": "go?" } } ],
            "a.stop": [ { "wait_stop_ms": 10000 } ]
        }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let rel = write_flow(&f.root, "p", "{}", &[py("a", "a.ask", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_status(&run_id, RunStatus::AwaitingApproval);
    f.engine.approve(&f.root, &run_id, Some("a"), "approve", None).unwrap();
    f.wait_settled(&run_id, RunStatus::Completed);

    let rel = write_flow(&f.root, "s", "{}", &[py("st", "a.stop", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| node(s, "st").status == NodeStatus::Running);
    f.engine.stop(&f.root, &run_id).unwrap();
    f.wait_status(&run_id, RunStatus::Paused);
    assert_eq!(node(&f.snapshot(&run_id), "st").status, NodeStatus::Ready);
}

#[test]
fn worker_exit_mid_call_fails_the_node_and_the_next_node_gets_a_new_worker() {
    // Review Focus 3.
    let script = json!({
        "stages": [stage("a.die", {}), stage("a.ok", {})],
        "behaviour": { "a.die": [ { "exit": 7 } ], "a.ok": [ { "outcome": { "status": "ok" } } ] }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let rel = write_flow(&f.root, "p", "{}", &[py("d", "a.die", json!({})), py("o", "a.ok", json!({}))], &[json!({ "from": "d", "to": "o", "port": "failure" })]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let snap = f.snapshot(&run_id);
    assert_eq!(node(&snap, "d").reason.as_ref().unwrap().code, FLOW_PYTHON_WORKER_EXITED);
    assert_eq!(node(&snap, "o").status, NodeStatus::Succeeded);
    let log = fs::read_to_string(f.root.join(".mdium/flow-runs").join(&run_id).join("runtimes/r/stdout.log")).unwrap_or_default();
    let _ = log; // two workers wrote to the same runtime log directory
}

#[test]
fn two_nodes_share_one_worker_and_retry_reuses_it() {
    let script = json!({
        "stages": [stage("a.ok", {}), stage("a.flaky", {})],
        "behaviour": {
            "a.ok": [ { "outcome": { "status": "ok" } } ],
            "a.flaky": [ { "fail_before_attempt": 2 }, { "outcome": { "status": "ok" } } ]
        }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let mut flaky = py("fl", "a.flaky", json!({}));
    flaky["retry"] = json!({ "max": 1 });
    let rel = write_flow(&f.root, "p", "{}", &[py("a", "a.ok", json!({})), flaky], &[json!({ "from": "a", "to": "fl" })]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let snap = f.snapshot(&run_id);
    assert_eq!(node(&snap, "fl").attempt, 2);
    let describes = f.worker_describe_count();
    assert_eq!(describes, 1, "one worker served both nodes and the retry");
}

#[test]
fn python_timeout_cancels_then_kills_and_cancel_kills_the_worker() {
    let script = json!({
        "stages": [stage("a.hang", {}), stage("a.polite", {})],
        "behaviour": { "a.hang": [ { "sleep_ms": 60000 } ], "a.polite": [ { "wait_cancel_ms": 10000 } ] }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let mut polite = py("p", "a.polite", json!({}));
    polite["timeout"] = json!("200ms");
    let rel = write_flow(&f.root, "t", r#"{"limits":{"stopGrace":"2s"}}"#, &[polite], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(node(&f.snapshot(&run_id), "p").reason.as_ref().unwrap().code, FLOW_NODE_TIMEOUT);

    let mut hang = py("h", "a.hang", json!({}));
    hang["timeout"] = json!("200ms");
    let rel = write_flow(&f.root, "u", r#"{"limits":{"stopGrace":"300ms"}}"#, &[hang], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(node(&f.snapshot(&run_id), "h").reason.as_ref().unwrap().code, FLOW_NODE_TIMEOUT);

    let rel = write_flow(&f.root, "c", "{}", &[py("h2", "a.hang", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| node(s, "h2").status == NodeStatus::Running);
    let pid = f.worker_pid(&run_id, "r");
    f.engine.cancel(&f.root, &run_id).unwrap();
    f.wait_settled(&run_id, RunStatus::Cancelled);
    assert!(!process_alive(pid), "worker killed on cancel");
}

#[test]
fn app_exit_interrupts_a_running_stage_and_restart_marks_it_interrupted() {
    // Review Focus 4.
    let script = json!({ "stages": [stage("a.hang", {})], "behaviour": { "a.hang": [ { "sleep_ms": 60000 } ] } });
    let f = fixture_with_worker(script.clone());
    write_manifest(&f.root);
    let rel = write_flow(&f.root, "p", "{}", &[py("h", "a.hang", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| node(s, "h").status == NodeStatus::Running);
    let pid = f.worker_pid(&run_id, "r");
    f.engine.shutdown(Duration::from_secs(5));
    assert!(!process_alive(pid));
    let f2 = f.reopen(script);
    let snap = f2.snapshot(&run_id);
    assert_eq!(snap.state.status, RunStatus::Interrupted);
    assert_eq!(node(&snap, "h").status, NodeStatus::Interrupted);
}

#[test]
fn stray_worker_output_is_logged_not_fatal() {
    // Review Focus 1.
    let script = json!({
        "stages": [stage("a.noisy", {})],
        "behaviour": { "a.noisy": [ { "raw": "print() output" }, item(json!({ "type": "output", "key": "k", "value": 1 })), { "outcome": { "status": "ok" } } ] }
    });
    let f = fixture_with_worker(script);
    write_manifest(&f.root);
    let rel = write_flow(&f.root, "p", "{}", &[py("n", "a.noisy", json!({}))], &[]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let events = f.events(&run_id);
    assert!(events.iter().any(|e| matches!(&e.body, EventBody::Warning(r) if r.code == FLOW_PROTOCOL_WARNING)));
    assert_eq!(node(&f.snapshot(&run_id), "n").outputs["k"], 1);
}
```

Helpers to add to the fixture: `engine_store()` (a `RunStore::new(&root)`), `worker_pid(run_id, runtime)` (read from a `workers.json` the driver writes? — simpler: the fake worker writes its pid to `<run>/runtimes/<name>/pid` on start; have `flow_test_worker_entry` write `std::process::id()` to the file named by env `FLOW_TEST_WORKER_PID_FILE`, which `FakeWorkerLauncher` sets to `spec.stdout_log.with_file_name("pid")`), `worker_describe_count()` (the fake worker appends a line to `<pid file dir>/describes.log` on each `describe`; count lines across the run's `runtimes/r/`), `reopen(script)` (new engine on the same root, calls `attach` via `list`). `fail_before_attempt` for the fake worker reads `context.attempt` from the `call` message.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core python_` → failures (`FLOW_RUN_UNSUPPORTED` from `start_node`'s fallthrough, missing helpers).

- [ ] **Step 3: Implement the driver changes**

Follow the behaviour list in the Interfaces block exactly. Concrete anchors:

- Extract `ItemState` and `apply_item` from `protocol_item` (keep the 1 s progress throttle and `pending_progress` flush semantics identical; `finish_command` and `finish_call` both flush via a shared `fn flush_progress(&mut self, key, st: &mut ItemState)`).
- `Driver` gains `workers: BTreeMap<String, LiveWorker>` and `calls: Vec<RunningCall>`; initialise empty in the constructor(s).
- Main loop: call `self.poll_calls()` right after `self.poll_running()`; treat `!self.calls.is_empty()` the same as `!self.running.is_empty()` wherever the loop checks for in-flight work (stop → Paused, idle detection, `FLOW_RUN_STUCK`).
- `start_ready`: `matches!(node.kind, NodeKind::Command(_) | NodeKind::Python(_))` for the concurrency count, and `self.running.len() + self.calls.len()` as the running count.
- `ensure_worker` blocks with `std::thread::sleep(self.env.poll)` between `try_recv` polls, up to `WORKER_READY_TIMEOUT`.
- Event file writes use `OpenOptions::new().append(true).create(true)`.
- `shutdown_workers` is called at the end of `run()` (all exits), in `cancel_all` and in `shutdown`.
- `reconnect_running`: add `NodeKind::Python(_)` → `set_node(Interrupted, attempt, FLOW_PROCESS_LOST)` before the existing `continue` for other kinds.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` (the new tests spawn the test binary as the fake worker; they must pass on Windows) and `cargo test --workspace`; `cargo build` → no warnings. `cargo fmt -p flow-core`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src
git commit -m "feat(flow): run python nodes through resident workers"
```

---

### Task 7: `flow_runtime_describe` command and the frontend API

**Files:**
- Modify: `src-tauri/crates/flow-core/src/service.rs` (`runtime_describe`, `COMMAND_NAMES` → 20, `call` arm `{ projectRoot, runtime }`), `src-tauri/src/commands/flow.rs`, `src-tauri/src/lib.rs`
- Modify: `src/shared/types/flow.ts` (`StageInputType`, `StageInput`, `StageOutput`, `StageArtifact`, `StageDef`, `Manifest`), `src/features/flow/lib/flow-api.ts` (`runtimeDescribe(projectRoot, runtime)`), `src/features/flow/lib/__tests__/flow-api.test.ts`, `src/shared/i18n/locales/{ja,en}/flow.json` (`runError.FLOW_RUNTIME_UNKNOWN`, `runError.FLOW_RUNTIME_START_FAILED`, `reason.*` for `FLOW_RUNTIME_START_FAILED`, `FLOW_PYTHON_ENTRY_UNKNOWN`, `FLOW_PYTHON_INPUT_INVALID`, `FLOW_PYTHON_PROTOCOL`, `FLOW_PYTHON_WORKER_EXITED`; `runError.FLOW_PROJECT_INVALID`)

**Interfaces:**
- Produces: `FlowService::runtime_describe(&self, project_root: &str, runtime: &str) -> Result<Manifest, FlowCommandError>` — loads the manifest (`FLOW_PROJECT_REQUIRED` when missing/invalid), finds the runtime (`FLOW_RUNTIME_UNKNOWN`), builds `worker_spec(root, name, def, <temp dir under .mdium/flow-runs/.describe/<id>>, &[])`, calls `describe_runtime(&PipedWorkerLauncher, &spec, 30s)` (`FLOW_RUNTIME_START_FAILED` with the reason's message), removes the temp dir; Tauri `flow_runtime_describe(state, project_root, runtime)`; TS `flowApi.runtimeDescribe(projectRoot, runtime): Promise<Manifest>`.
- Consumes: Task 4.

- [ ] **Step 1: Write the failing tests**

`service.rs`: 

```rust
    #[test]
    fn runtime_describe_rejects_unknown_runtimes_and_missing_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert_eq!(svc.runtime_describe(root, "r").unwrap_err().code, FLOW_PROJECT_REQUIRED);
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: { kind: python, python: nope, module: m }\n").unwrap();
        assert_eq!(svc.runtime_describe(root, "zzz").unwrap_err().code, crate::issues::FLOW_RUNTIME_UNKNOWN);
        // No interpreter at `nope`: the launcher fails before any process starts.
        let err = svc.runtime_describe(root, "r").unwrap_err();
        assert_eq!(err.code, crate::run::worker::FLOW_RUNTIME_START_FAILED);
        assert!(!tmp.path().join(".mdium/flow-runs/.describe").exists() || fs::read_dir(tmp.path().join(".mdium/flow-runs/.describe")).unwrap().next().is_none(), "temp dir cleaned");
        let via_call = svc.call("flow_runtime_describe", serde_json::json!({ "projectRoot": root, "runtime": "zzz" })).unwrap_err();
        assert_eq!(via_call.code, crate::issues::FLOW_RUNTIME_UNKNOWN);
    }
```

`flow-api.test.ts`: table row `["runtimeDescribe", () => flowApi.runtimeDescribe(ROOT, "r"), "flow_runtime_describe", { projectRoot: ROOT, runtime: "r" }]`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core runtime_describe` → compile error; `npx vitest run src/features/flow/lib/__tests__/flow-api.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`service.rs`:

```rust
use crate::run::worker::{describe_runtime, worker_spec, Manifest, PipedWorkerLauncher, FLOW_RUNTIME_START_FAILED};

pub const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(30);

impl FlowService {
    /// Starts the runtime's worker only to read its manifest (spec 3.4).
    pub fn runtime_describe(&self, project_root_arg: &str, runtime: &str) -> Result<Manifest, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let project = match load_project(&root) {
            Some(report) if report.errors.is_empty() => report.project,
            _ => None,
        }
        .ok_or_else(|| FlowCommandError::new(FLOW_PROJECT_REQUIRED, "no valid .mdium/project.yaml"))?;
        let def = project
            .runtimes
            .get(runtime)
            .ok_or_else(|| FlowCommandError::new(crate::issues::FLOW_RUNTIME_UNKNOWN, runtime))?;
        let scratch = root.join(".mdium/flow-runs/.describe").join(crate::fsutil::new_id());
        let spec = worker_spec(&root, runtime, def, &scratch, &[])
            .map_err(|r| FlowCommandError::new(FLOW_RUNTIME_START_FAILED, r.params.get("message").and_then(|v| v.as_str()).unwrap_or("")))?;
        let result = describe_runtime(&PipedWorkerLauncher, &spec, DESCRIBE_TIMEOUT)
            .map_err(|r| FlowCommandError::new(FLOW_RUNTIME_START_FAILED, r.params.get("message").and_then(|v| v.as_str()).unwrap_or("")));
        let _ = std::fs::remove_dir_all(&scratch);
        result
    }
}
```

(`DescribeArgs { project_root, runtime }` with `deny_unknown_fields`; `COMMAND_NAMES` → 20 with `"flow_runtime_describe"`; `call` arm `reply(self.runtime_describe(&a.project_root, &a.runtime)?)`.) Tauri wrapper `flow_runtime_describe(state, project_root, runtime)` in `commands/flow.rs` + registration in `lib.rs`. TS types mirroring the Rust structs with camelCase (`mediaType`, `type`), `flowApi.runtimeDescribe: (projectRoot: string, runtime: string) => call<Manifest>("flow_runtime_describe", { projectRoot, runtime })`. i18n entries — en examples: `runError.FLOW_RUNTIME_START_FAILED: "The Python runtime could not be started: {{message}}"` is not interpolated by `describeError` (it uses the code only) so keep it plain: `"The Python runtime could not be started."`; `reason.FLOW_PYTHON_INPUT_INVALID: "Input \"{{input}}\" is invalid ({{reason}})."`, `reason.FLOW_PYTHON_ENTRY_UNKNOWN: "Stage \"{{entry}}\" is not provided by the runtime."`, `reason.FLOW_PYTHON_WORKER_EXITED: "The Python worker exited during the stage."`, `reason.FLOW_PYTHON_PROTOCOL: "The Python worker sent an invalid message."`, `reason.FLOW_RUNTIME_START_FAILED: "The Python runtime could not be started: {{message}}"`, `runError.FLOW_PROJECT_INVALID: ".mdium/project.yaml has errors; fix them before running."`, `runError.FLOW_RUNTIME_UNKNOWN: "The runtime is not declared in project.yaml."`; ja equivalents with the same placeholders).

- [ ] **Step 4: Run everything** (`cargo test --workspace`, `npm test`, `tsc`) and **Step 5: Commit** `feat(flow): flow_runtime_describe command and worker error messages`.

---

### Task 8: The `mdium-worker` Python package

**Files:**
- Create: `python/mdium-worker/pyproject.toml`, `python/mdium-worker/README.md`, `python/mdium-worker/src/mdium_worker/__init__.py`, `__main__.py`, `registry.py`, `protocol.py`, `context.py`, `worker.py`, `python/mdium-worker/tests/sample_module.py`, `tests/test_registry.py`, `tests/test_validation.py`, `tests/test_worker_loop.py`
- Modify: `.gitignore` (append `__pycache__/`, `*.pyc`, `.pytest_cache/`, `python/mdium-worker/.venv/`, `python/mdium-worker/dist/`)

**Interfaces:**
- Produces (spec 4):
  - `mdium_worker.stage(name: str, *, description: str | None = None, inputs: dict[str, dict] | None = None, outputs: dict[str, dict] | None = None, artifacts: list[dict] | None = None)` decorator registering a function in a module-level `Registry` (`registry.py`: `register(stage_def, fn)`, `stages() -> list[StageDef]`, `get(name) -> StageDef | None`, `clear()`); duplicate names raise `ValueError`.
  - `mdium_worker.Context` with `progress(text, fraction=None)`, `cost(usd, kind="actual", provider=None, model=None, units=None)`, `output(key, value)`, `artifact(path, label=None, media_type=None)`, `log(text, level="info")`, `should_stop() -> bool`, `needs_approval(message)` (raises `NeedsApproval`), properties `node_dir`, `run_id`, `project_root`, `attempt`; every emit writes one JSON line with `v: 1` and the call's `callId` to the `emit` sink (stdout) and flushes.
  - Exceptions: `StageFailed(reason)`, `Stopped`, `NeedsApproval(message)`.
  - `protocol.py`: `manifest_message(request_id, module, stages)`, `validate_inputs(stage_def, inputs) -> dict` (same rules as the Rust side: unknown → error, missing required → error, type mismatch → error, defaults filled; raises `InputError(list[str])`), `error_message(request_id, code, message)`, `outcome_message(call_id, status, **extra)`.
  - `worker.py`: `run_loop(module_name: str, stdin, stdout, stderr) -> int` — imports the module (import failure → one `error` line with code `FLOW_PYTHON_PROTOCOL` and exit 2), reads stdin lines, dispatches `describe` / `call` / `cancel` / `shutdown`; `call` runs the stage **in the main thread** while a reader thread keeps consuming stdin so `cancel` sets a `threading.Event` the `Context.should_stop()` checks (together with the stop file's existence); exceptions map to outcomes (`StageFailed` → `fail` with reason; `Stopped` → `stopped`; `NeedsApproval` → `needs_approval`; other → `fail` with `reason=f"{type}: {msg}"` and a `log` `error` line carrying the traceback); unknown entry → `error` `FLOW_PYTHON_ENTRY_UNKNOWN` for that `requestId`; invalid inputs → `error` `FLOW_PYTHON_INPUT_INVALID`; `shutdown` → return 0.
  - `__main__.py`: `python -m mdium_worker --module <m> [--describe]`; `--describe` prints the manifest line (requestId `"describe"`) and exits 0.
- Tests run with: `uv run --project python/mdium-worker pytest -q` (from the repo root).

- [ ] **Step 1: Package skeleton and failing tests**

`pyproject.toml`:

```toml
[project]
name = "mdium-worker"
version = "0.1.0"
description = "Worker side of MDium's python flow nodes (mdium-worker-v1 protocol)."
readme = "README.md"
requires-python = ">=3.10"
dependencies = []

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/mdium_worker"]

[dependency-groups]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`tests/sample_module.py`:

```python
"""A module with a few stages, used by the worker-loop tests."""
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
```

`tests/test_registry.py`:

```python
import pytest

from mdium_worker import registry, stage


def setup_function() -> None:
    registry.clear()


def test_stage_registers_definition_and_function() -> None:
    @stage("x.y", inputs={"n": {"type": "number", "required": True}}, outputs={"o": {"type": "string"}})
    def fn(ctx, n):
        return None

    defs = registry.stages()
    assert [d.name for d in defs] == ["x.y"]
    assert defs[0].inputs["n"].type == "number" and defs[0].inputs["n"].required is True
    assert registry.get("x.y").fn is fn


def test_duplicate_names_are_rejected() -> None:
    @stage("dup")
    def one(ctx):
        return None

    with pytest.raises(ValueError):
        @stage("dup")
        def two(ctx):
            return None


def test_bad_input_type_in_definition_is_rejected() -> None:
    with pytest.raises(ValueError):
        @stage("bad", inputs={"n": {"type": "integer"}})
        def fn(ctx, n):
            return None
```

`tests/test_validation.py`:

```python
import pytest

from mdium_worker.protocol import InputError, validate_inputs
from mdium_worker.registry import StageDef


def stage_def() -> StageDef:
    return StageDef.from_decorator("s", None, {"a": {"type": "number", "required": True}, "t": {"type": "string", "default": "x"}, "o": {"type": "object"}}, {}, [])


def test_fills_defaults_and_accepts_valid_inputs() -> None:
    assert validate_inputs(stage_def(), {"a": 1, "o": {"k": 1}}) == {"a": 1, "t": "x", "o": {"k": 1}}


def test_reports_unknown_missing_and_type_errors() -> None:
    with pytest.raises(InputError) as info:
        validate_inputs(stage_def(), {"t": 1, "extra": True})
    messages = " ".join(info.value.errors)
    assert "a" in messages and "missing" in messages
    assert "t" in messages and "type" in messages
    assert "extra" in messages and "unknown" in messages


def test_null_uses_the_default() -> None:
    assert validate_inputs(stage_def(), {"a": 2, "t": None})["t"] == "x"
```

`tests/test_worker_loop.py` (drives the real `python -m mdium_worker` as a subprocess; `sys.executable` is the interpreter):

```python
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
```

- [ ] **Step 2: Run them to verify they fail**

Run (repo root): `uv run --project python/mdium-worker pytest -q` → ImportError / failures.

- [ ] **Step 3: Implement the package**

`registry.py`:

```python
"""Stage registry filled by the @stage decorator."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

INPUT_TYPES = ("string", "number", "bool", "path", "object", "array")


@dataclass
class InputDef:
    type: str
    required: bool = False
    default: Any = None
    has_default: bool = False
    description: str | None = None

    def to_json(self) -> dict:
        out: dict = {"type": self.type, "required": self.required}
        if self.has_default:
            out["default"] = self.default
        if self.description:
            out["description"] = self.description
        return out


@dataclass
class StageDef:
    name: str
    description: str | None
    inputs: dict[str, InputDef]
    outputs: dict[str, dict]
    artifacts: list[dict]
    fn: Callable[..., Any] = field(default=lambda *a, **k: None, repr=False)

    @classmethod
    def from_decorator(cls, name, description, inputs, outputs, artifacts, fn=None) -> "StageDef":
        defs: dict[str, InputDef] = {}
        for key, spec in (inputs or {}).items():
            ty = spec.get("type", "string")
            if ty not in INPUT_TYPES:
                raise ValueError(f"stage {name!r}: input {key!r} has unknown type {ty!r}")
            defs[key] = InputDef(
                type=ty,
                required=bool(spec.get("required", False)),
                default=spec.get("default"),
                has_default="default" in spec,
                description=spec.get("description"),
            )
        return cls(name, description, defs, dict(outputs or {}), list(artifacts or []), fn or (lambda *a, **k: None))

    def to_json(self) -> dict:
        out: dict = {"name": self.name, "inputs": {k: v.to_json() for k, v in self.inputs.items()},
                     "outputs": self.outputs, "artifacts": self.artifacts}
        if self.description:
            out["description"] = self.description
        return out


_STAGES: dict[str, StageDef] = {}


def register(stage_def: StageDef) -> None:
    if stage_def.name in _STAGES:
        raise ValueError(f"stage {stage_def.name!r} is already registered")
    _STAGES[stage_def.name] = stage_def


def stages() -> list[StageDef]:
    return list(_STAGES.values())


def get(name: str) -> StageDef | None:
    return _STAGES.get(name)


def clear() -> None:
    _STAGES.clear()
```

`__init__.py`:

```python
"""Worker side of MDium's python flow nodes (spec 2026-10-10, chapter 4)."""
from __future__ import annotations

from typing import Any, Callable

from . import registry
from .context import Context, NeedsApproval, StageFailed, Stopped
from .registry import StageDef

__all__ = ["stage", "Context", "StageFailed", "Stopped", "NeedsApproval", "registry"]


def stage(name: str, *, description: str | None = None, inputs: dict[str, dict] | None = None,
          outputs: dict[str, dict] | None = None, artifacts: list[dict] | None = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Registers `fn` as the stage `name`; the function receives a Context plus the inputs as keyword arguments."""
    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        registry.register(StageDef.from_decorator(name, description, inputs, outputs, artifacts, fn))
        return fn
    return decorate
```

`context.py`:

```python
"""The Context handed to a stage: event emission, stop checks, control-flow exceptions."""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable


class StageFailed(Exception):
    """The stage failed; the message is reported as the outcome's reason."""


class Stopped(Exception):
    """The stage stopped at a boundary because a stop was requested."""


class NeedsApproval(Exception):
    """The stage wants a human decision before it counts as done."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class Context:
    def __init__(self, call_id: str, context: dict, emit: Callable[[dict], None], cancel: threading.Event) -> None:
        self._call_id = call_id
        self._ctx = context
        self._emit = emit
        self._cancel = cancel

    @property
    def run_id(self) -> str:
        return str(self._ctx.get("runId", ""))

    @property
    def node_dir(self) -> str:
        return str(self._ctx.get("nodeDir", ""))

    @property
    def project_root(self) -> str:
        return str(self._ctx.get("projectRoot", ""))

    @property
    def attempt(self) -> int:
        return int(self._ctx.get("attempt", 1))

    def _send(self, message: dict) -> None:
        self._emit({"v": 1, "callId": self._call_id, **message})

    def progress(self, text: str, fraction: float | None = None) -> None:
        message: dict = {"type": "progress", "text": text}
        if fraction is not None:
            message["fraction"] = fraction
        self._send(message)

    def cost(self, usd: float, kind: str = "actual", provider: str | None = None, model: str | None = None, units: dict | None = None) -> None:
        message: dict = {"type": "cost", "usd": usd, "kind": kind}
        for key, value in (("provider", provider), ("model", model), ("units", units)):
            if value is not None:
                message[key] = value
        self._send(message)

    def output(self, key: str, value: Any) -> None:
        self._send({"type": "output", "key": key, "value": value})

    def artifact(self, path: str | os.PathLike, label: str | None = None, media_type: str | None = None) -> None:
        message: dict = {"type": "artifact", "path": os.fspath(path)}
        if label is not None:
            message["label"] = label
        if media_type is not None:
            message["mediaType"] = media_type
        self._send(message)

    def log(self, text: str, level: str = "info") -> None:
        self._send({"type": "log", "level": level, "text": text})

    def should_stop(self) -> bool:
        stop_file = self._ctx.get("stopFile") or os.environ.get("MDIUM_FLOW_STOP_FILE")
        return self._cancel.is_set() or bool(stop_file and os.path.exists(stop_file))

    def needs_approval(self, message: str) -> None:
        raise NeedsApproval(message)
```

`protocol.py`:

```python
"""Messages of the mdium-worker-v1 protocol and input validation."""
from __future__ import annotations

from typing import Any

from .registry import StageDef

TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "path": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
}


class InputError(Exception):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def validate_inputs(stage: StageDef, given: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    out: dict[str, Any] = {}
    for key in given:
        if key not in stage.inputs:
            errors.append(f"{key}: unknown input")
    for name, spec in stage.inputs.items():
        value = given.get(name)
        if value is None:
            if spec.has_default:
                value = spec.default
            elif spec.required:
                errors.append(f"{name}: missing")
                continue
            else:
                continue
        if not TYPE_CHECKS[spec.type](value):
            errors.append(f"{name}: wrong type (expected {spec.type}, got {type(value).__name__})")
            continue
        out[name] = value
    if errors:
        raise InputError(errors)
    return out


def manifest_message(request_id: str, module: str, stages: list[StageDef]) -> dict:
    return {"v": 1, "type": "manifest", "requestId": request_id, "module": module, "stages": [s.to_json() for s in stages]}


def error_message(request_id: str | None, code: str, message: str) -> dict:
    out = {"v": 1, "type": "error", "code": code, "message": message}
    if request_id is not None:
        out["requestId"] = request_id
    return out


def outcome_message(call_id: str, status: str, **extra: Any) -> dict:
    return {"v": 1, "type": "outcome", "callId": call_id, "status": status, **{k: v for k, v in extra.items() if v is not None}}
```

`worker.py`:

```python
"""The worker loop: reads requests on stdin, runs stages, writes events on stdout."""
from __future__ import annotations

import importlib
import json
import queue
import sys
import threading
import traceback
from typing import Any, TextIO

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
```

`__main__.py`:

```python
"""`python -m mdium_worker --module <module> [--describe]`."""
from __future__ import annotations

import argparse
import sys

from .worker import run_loop


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mdium_worker")
    parser.add_argument("--module", required=True, help="module that registers the stages")
    parser.add_argument("--describe", action="store_true", help="print the manifest and exit")
    args = parser.parse_args(argv)
    return run_loop(args.module, sys.stdin, sys.stdout, sys.stderr, describe_only=args.describe)


if __name__ == "__main__":
    sys.exit(main())
```

`README.md`: two paragraphs (what it is, the `@stage` example from spec 4, how to run tests).

- [ ] **Step 4: Run the tests**

Run: `uv run --project python/mdium-worker pytest -q` → all pass (the worker-loop tests spawn the interpreter with `PYTHONPATH=tests`). Commit `python/mdium-worker/uv.lock` if uv created it.

- [ ] **Step 5: Commit**

```bash
git add python/mdium-worker .gitignore
git commit -m "feat(worker): mdium-worker Python package implementing mdium-worker-v1"
```

---

### Task 9: Demo project fixture and the end-to-end check

**Files:**
- Create: `src-tauri/tests/fixtures/projects/python-demo/.mdium/project.yaml`, `.mdium/flows/demo.flow.yaml`, `demo_flow.py`, `README.md`
- Modify: `src-tauri/crates/flow-core/src/run/tests.rs` (one `#[ignore]` test)

**Interfaces:**
- Produces a runnable sample: `project.yaml` with `runtimes: { demo: { kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: demo_flow } }`, `setup: [{ run: [uv, venv, .venv] }, { run: [uv, pip, install, --python, .venv, -e, ../../../../python/mdium-worker] }]` (paths relative to the fixture dir), `demo.flow.yaml` with two python nodes (`demo.add` then `demo.ask`) and `outputs: { sum: "${{ nodes.add.outputs.sum }}" }`; `demo_flow.py` registering `demo.add` and `demo.ask` with `mdium_worker`.
- The ignored test `python_demo_end_to_end` copies the fixture to a temp dir, creates the venv with `uv` (skips with a message when `uv` is not on PATH), runs the flow through the real `PipedWorkerLauncher`, approves, and asserts `outputs.sum == 3`. Run manually with `cargo test -p flow-core python_demo_end_to_end -- --ignored --nocapture`.

- [ ] **Step 1: Write the fixture**

`src-tauri/tests/fixtures/projects/python-demo/.mdium/project.yaml`:

```yaml
schemaVersion: 1
id: python-demo
name: Python demo
description: Two python stages through mdium-worker
runtimes:
  demo:
    kind: python
    python: [.venv/Scripts/python.exe, .venv/bin/python]
    module: demo_flow
setup:
  - { run: [uv, venv, .venv] }
  - { run: [uv, pip, install, --python, .venv, -e, ../../../../python/mdium-worker] }
flows:
  main: flows/demo.flow.yaml
```

`.mdium/flows/demo.flow.yaml`:

```yaml
schemaVersion: 1
id: demo
name: Python demo flow
params:
  a: { type: number, default: 2 }
nodes:
  - { id: add, kind: python, runtime: demo, entry: demo.add, with: { a: "${{ params.a }}", b: 1 } }
  - { id: ask, kind: python, runtime: demo, entry: demo.ask }
edges:
  - { from: add, to: ask }
outputs:
  sum: "${{ nodes.add.outputs.sum }}"
```

`demo_flow.py`:

```python
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
```

`README.md`: how to set up (`uv venv .venv` then `uv pip install --python .venv -e ../../../../python/mdium-worker`) and run from MDium.

- [ ] **Step 2: Write the ignored test** (`run/tests.rs`)

```rust
#[test]
#[ignore = "needs uv and a Python interpreter; run with --ignored"]
fn python_demo_end_to_end() {
    if std::process::Command::new("uv").arg("--version").output().is_err() {
        eprintln!("uv not found; skipping");
        return;
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/projects/python-demo");
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("python-demo");
    copy_dir(&src, &root);
    // Install the worker package into a fresh venv (what the project's `setup` does).
    let worker_pkg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../python/mdium-worker");
    assert!(std::process::Command::new("uv").args(["venv", ".venv"]).current_dir(&root).status().unwrap().success());
    assert!(std::process::Command::new("uv").args(["pip", "install", "--python", ".venv", "-e"]).arg(&worker_pkg).current_dir(&root).status().unwrap().success());
    let f = fixture_at(&root, Arc::new(PipedWorkerLauncher)); // a Fixture over an existing root with the real launcher
    let run_id = f.confirm_and_start(".mdium/flows/demo.flow.yaml", json!({ "a": 2 }));
    f.wait_status(&run_id, RunStatus::AwaitingApproval);
    f.engine.approve(&f.root, &run_id, Some("ask"), "approve", None).unwrap();
    f.wait_settled(&run_id, RunStatus::Completed);
    let snap = f.snapshot(&run_id);
    assert_eq!(node(&snap, "add").outputs["sum"], 3);
}
```

(`copy_dir` is a small recursive helper; `fixture_at(root, launcher)` builds a `Fixture` over a given root — add both helpers next to `fixture()`.)

- [ ] **Step 3: Run the ignored test locally**

Run: `cargo test -p flow-core python_demo_end_to_end -- --ignored --nocapture` → passes on this machine (uv 0.11, Python 3.11 available).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/fixtures/projects/python-demo src-tauri/crates/flow-core/src/run/tests.rs
git commit -m "test(flow): python demo project and an ignored end-to-end run"
```

---

### Task 10: Final verification

- [ ] From `src-tauri/`: `cargo test --workspace` (no failures, no warnings), `cargo build`, `cargo clippy --workspace --all-targets` (no warnings in `worker.rs`, `driver.rs` hunks, `service.rs`, `commands/flow.rs`), `cargo tree -p flow-core -e normal | grep -i ' tauri'` → empty.
- [ ] From the root: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `uv run --project python/mdium-worker pytest -q`.
- [ ] `cargo test -p flow-core python_demo_end_to_end -- --ignored --nocapture` → passes.
- [ ] Desktop smoke (human): open `src-tauri/tests/fixtures/projects/python-demo` (or a copy) in MDium, run Setup (creates `.venv` and installs `mdium-worker`), open `demo.flow.yaml`, start it: the confirmation lists the runtime and the two stages; the run shows progress and the `sum` output, waits for approval at `demo.ask`, completes after approving; the node log shows the worker's `log` line; `runtimes/demo/stderr.log` exists under the run directory.
- [ ] Record deviations in the spec's chapter 12 row V3 only if the implementation departed from the plan's interfaces.
