# V8 Improvement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MDium improves video_gen in a loop: the bundled `improve-app` template (entry flow + two parts) reads the latest completed run of the project's main flow, an agent proposes a change, a human approves it, the `dev-workflow` template implements it in a worktree, the main flow is re-run inside that worktree at a reduced scale, `metrics-compare` reports the metric changes, and a human merges or discards. video_gen gets its copy (`improve.flow.yaml`) and the ledger fixes that make its video metrics real.

**Architecture:** Four pieces. (1) Engine additions in `flow-core`: the flow reference `project:main` (the project manifest's `flows.main`, resolved against the scope's project root, so a template can call "the project's main flow" without knowing its file name) and the template reference `project.metrics` (the manifest's `metrics` array, so the analysis prompt receives the metric definitions). (2) The `builtin:improve-analyze` prompt and the `improve-app` template under `resources/flow-templates/improve-app/` (spec 8.2 expanded form, shipped in the 16.5 split form: `flows/improve-app.flow.yaml`, `flows/lib/improve-app/improve-propose.flow.yaml`, `flows/lib/improve-app/improve-verify.flow.yaml`). (3) video_gen: `improve.flow.yaml` copied from the template with a narrowed verification, `production_ledger` rolling chapter-layout videos up into the `video_*` fields (today they stay `None`, so `avgVideoCoherence` is always 0), and chapter progress for `video.chapters`. (4) Two carry-overs: `driver.rs` (5,100 lines) split into `run/driver/` modules first, and the flow editor keeping comments and key order when it writes YAML.

**Tech Stack:** Rust `flow-core` (serde, serde_yaml_ng, sha2), Tauri 2 desktop crate, TypeScript React 19 (vitest, the `yaml` package's `Document` API), YAML flow files, Python 3 (`mdium-worker`, pytest, `uv`) on the video_gen side.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` — chapter 8 (8.1 placement, 8.2 flow, 8.3 comparison, 8.4 prompt), 9.4 (video_gen `improve.flow.yaml`), 16.5 (template split), 7.2 (actions used), 7.3 (templates), 12 row V8, 13 (tests: V8 one real iteration), 14 (risks). Requires V7 merged (`docs/portable-projects-spec` at d6f361c or later).

## Global Constraints

- Spec 10.1: `flow-core` never depends on `tauri`. `src/features/flow/` never imports `@tauri-apps/*` (`no-tauri-imports.test.ts`).
- Spec 7.4 (2026-10-06): no video_gen-specific code in MDium. The template is generic; video_gen's narrowing lives in video_gen's copy.
- Spec 7.2: `KNOWN_ACTIONS` stays exactly the ten V7 names, in the same order, in Rust (`ACTION_SPECS`) and TS (`known-actions.ts`). V8 adds no action.
- Spec 7.3 / 8.1: `improve-app` is a copy-only template (it is copied into the project and edited there). Template flows contain no `command` / `python` node and only `builtin:` or inline prompts (`templates::check_template_flow`). The template's flow files are English and not localized; the UI strings for it (`template.improve-app.title` / `.description`) go through `src/shared/i18n/locales/{ja,en}/flow.json` (`locale-parity.test.ts` checks key equality).
- Engine additions are limited to: the flow reference `project:main` (valid in `subflow.flow`, a file `loop.body` and `mdium/flow-run-latest`'s `with.flow`) and the template reference `project.metrics`. Everything else in the engine is unchanged; the V7 rules (lenient template rendering of unrun nodes as `""`/`{}`/`[]`, strict conditions and flow outputs, approval reruns with the acknowledged `show`, `subflow.projectRoot` worktree-only) stay.
- 8.2: `nodes.<id>.costUsd` and the single-reference `with` rule (a `with` value that is exactly one `${{ }}` keeps the referenced type) are already implemented; the template relies on both.
- Flow i18n: every user-visible UI string goes through the `flow` namespace. Code comments in English. Rust sources are CRLF (new files too).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VCBjEbkrsXPtET2YNCnFZG`. Never commit `src-tauri/gen/schemas/*.json` or a tauri-rewritten `src-tauri/Cargo.toml` line-ending change.
- video_gen (Task 7) is a separate repository at `C:\Users\mtmar\source\repos\video_gen`: work on a new branch `feat/improve-flow` created from the current branch `feat/production-cycle-resume-dir` (its two commits — `resumeDir`, `chapters` — are not yet on `main` and the improve flow needs `chapters`). Never commit to `main`. Never stage the user's uncommitted files there: `.claude/settings.local.json`, `Improvements.txt`, the untracked `video/` directory, and the working-tree copy of `.mdium/flows/production-cycle.flow.yaml` (the user's editor reformatted it; the committed version is the authority — do not touch that file in V8). Never push video_gen without the user's approval. Its scoped test command is `uv run pytest tests/test_video_gen_flow_*.py tests/test_production_ledger.py tests/test_video_revise.py -q -p no:cacheprovider` (run from the video_gen root; `mdium_worker` must be importable there — it is installed into `.venv` by the project setup; if `tests/test_video_gen_flow_*.py` are skipped, re-run `uv pip install -e ../mdium/python/mdium-worker`).
- Baselines on `docs/portable-projects-spec` d6f361c: `cargo test -p flow-core` 528 passed / 2 ignored; `cargo test -p mdium --lib` 529 passed / 1 ignored (run from `src-tauri`); `npx vitest run` 2062 passed / 2 skipped; `npx tsc --noEmit` clean; video_gen scoped suite green at `feat/production-cycle-resume-dir` cdf5ce3 (record the count before Task 7). New tests only add. Task 1 conserves the flow-core count exactly (it moves code, not tests).
- Execution note for the controller: work in a worktree on branch `feat/v8-improvement-loop` from `docs/portable-projects-spec`. Tasks 1–6 and 8 are in mdium; Task 7 is in video_gen; Task 9 is a human desktop smoke that costs real API money (one story, one chapter) and needs a logged-in `claude` CLI, `GOOGLE_API_KEY` and `ELEVENLABS_API_KEY`.

## Review Focus

1. `project:main` in a project that has no `.mdium/project.yaml`, or whose manifest declares no `flows.main`, or whose `flows.main` file is missing, must be a validation error (`FLOW_REF_NOT_FOUND` with `ref: project:main` and a `reason`), never a panic or a silently empty bundle — Task 2 test `project_main_reference_needs_a_manifest_with_a_main_flow`.
2. `mdium/flow-run-latest` given `flow: project:main` must find the same runs as the explicit display path (`run.json`'s `flow_path`, forward slashes), including on Windows where the manifest may use backslashes — Task 2 test `flow_run_latest_accepts_the_project_main_reference`.
3. The back-edge `discard → propose` (and `merge → propose`) must run the `propose` sub-flow again as `propose@2`, and its `baseline` action must then see the run that completed meanwhile — Task 4 test `improve_app_runs_one_iteration_and_tries_again_after_a_discard`.
4. A failed verification (project setup fails in the worktree) must still reach `adopt_gate` through the `failure` port with the report shown as null, and `discard` must remove the worktree — Task 4 test `improve_app_offers_the_gate_when_the_verification_fails`.
5. Editing one attribute of a node in the editor must not touch the comments, key order or quoting of anything else in the YAML file; deleting a node must remove it (and only it) — Task 6 test `merge keeps comments and key order and drops removed nodes`.

## File Structure

`src-tauri/crates/flow-core/src/`
- `run/driver/mod.rs` — the `Driver` struct, its types and constants, open/state/events/scopes/controls/settling/budget/main loop/node start, generic approval and retry helpers, `Editor`, free helper fns (Task 1, moved from `run/driver.rs`).
- `run/driver/composite.rs` — sub-flow and loop scopes: `start_subflow` … `open_file_scope`, `progress_*`, `start_iteration`, `finish_loop` (Task 1).
- `run/driver/command.rs` — `RunningCommand` and the command launch/poll/finish path (Task 1).
- `run/driver/python.rs` — `LiveWorker`, `RunningCall`, worker lifecycle and the python call path (Task 1).
- `run/driver/agent.rs` — `RunningAgent`, `PreparedAgent`, screening/question/integrity and the agent turn path (Task 1).
- `run/driver/action.rs` — `RunningAction` and the action path (Task 1).
- `run/driver/lifecycle.rs` — stop / cancel / shutdown / reconnect (Task 1).
- `load.rs` — `PROJECT_MAIN_REF`, `resolve_project_main`, `project:main` in `flow_ref` (Task 2).
- `validate.rs` — `flow_ref_text` accepts `project:main` (Task 2).
- `run/engine.rs` — `project:main` in the bundle (`load_bundle_at`, the reference loop) (Task 2).
- `run/actions/project.rs` — `flow-run-latest` accepts `project:main` (Task 2).
- `template.rs`, `run/prepare.rs`, `run/driver/mod.rs` — `Reference::ProjectMetrics`, `TemplateContext.metrics` (Task 2).
- `prompts.rs` — `IMPROVE_ANALYZE_PROMPT`, `IMPROVE_ANALYZE_CRITERIA`, `builtin("improve-analyze")` (Task 3).
- `run/tests.rs` — the improve-app engine tests (Task 4).

`resources/flow-templates/`
- `dev-workflow/flows/dev-workflow.flow.yaml` — new output `worktree` (the worktree object) (Task 2).
- `improve-app/project.yaml`, `improve-app/flows/improve-app.flow.yaml`, `improve-app/flows/lib/improve-app/improve-propose.flow.yaml`, `improve-app/flows/lib/improve-app/improve-verify.flow.yaml` (Task 4). `src-tauri/tauri.conf.json` already bundles `../resources/flow-templates/**/*`.

`src/features/flow/`
- `lib/extract-subflow.ts`, `lib/flow-graph.ts` — `project:` references are opaque like `mdium:` (Task 5).
- `lib/flow-yaml.ts` — `mergeFlowIntoText` (Task 6); `editor-store.ts` — uses it for YAML edits, drops the comment warning (Task 6).
- `src/shared/i18n/locales/{ja,en}/flow.json` — `template.improve-app.*`, `attrs.flowProjectMainHint`; the comment-warning keys removed (Tasks 5, 6).

`C:\Users\mtmar\source\repos\video_gen\` (Task 7)
- `production_ledger.py` — chapter-layout video rollup; `tests/test_production_ledger.py`.
- `video_gen_flow/video.py` — chapter progress watcher; `tests/test_video_gen_flow_video.py`.
- `.mdium/flows/improve.flow.yaml`, `.mdium/flows/lib/improve-app/improve-propose.flow.yaml`, `.mdium/flows/lib/improve-app/improve-verify.flow.yaml`; `tests/test_video_gen_flow_definitions.py`; `CLAUDE.md`.

`.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` — 12 row V8 memo, 8 章 bullets (Task 8).

### Rulings taken while planning (recorded here so the executor and the reviewer argue from the same text)

- R1 `project:main`: the spec's `flows/main.flow.yaml` in 8.2 means "the project's main flow". A template cannot know its name, and `subflow.flow` is static (not a template), so the engine gains the reference `project:main` = the manifest's `flows.main` of the scope's project root (the worktree's manifest under `projectRoot`). It is valid only in project flows and in copied templates, not inside a template referenced as `mdium:<name>` (the template directory has no project manifest; `improve-app` is copy-only).
- R2 the proposal is the analyze agent's response body, not a file. 8.4 asks for `outputs.proposalPath` + an artifact, but a `read-only` agent cannot write a file. The part's output `proposal` is `nodes.analyze.outputs.body`; the run keeps the full response in the node's `response.md` (the "応答" button). `develop` receives the proposal text as `requirement`.
- R3 `metrics` reach the prompt through the new template reference `project.metrics` (the manifest's `metrics` array). The baseline run's logs and artifacts are read by the agent itself from `baseline.runDir` (it is read-only in the project root); the engine does not pre-assemble log tails.
- R4 `maxIterations` is dropped from the template: 8.2 keeps it "for display only" synced with the back-edges' `maxTraversals`; a parameter that does nothing misleads, and the edges carry the limit.
- R5 the outer iteration passes the previous proposal and the previous comparison report into the next analysis (`previousProposal`, `previousReport`), so "try a different proposal" after a discard has something to differ from. On the first pass both render as `""` (8.2 rule).
- R6 `dev-workflow` gains the output `worktree` (the `git-worktree-create` object) so the outer `merge` / `discard` actions get the full `WorktreeInfo` (`path`, `branch`, `baseBranch`, `baseCommit`, `integrityBaseline`) and the merge keeps its integrity check; `worktreePath` / `branch` stay for compatibility.
- R7 the verification narrowing (`verify.params`) is edited in the project's copy of the part, as 8.2's comment says; the template ships `params: {}`.
- R8 carry-overs folded in: the `driver.rs` split (Task 1, first), the editor's YAML reformatting (Task 6), the ledger's `video_*` for the chapter layout and the `video.chapters` progress (Task 7). The parked V7 minors stay parked.

---

### Task 1: Split `driver.rs` into `run/driver/` modules

**Files:**
- Move (git mv): `src-tauri/crates/flow-core/src/run/driver.rs` → `src-tauri/crates/flow-core/src/run/driver/mod.rs`
- Create: `src-tauri/crates/flow-core/src/run/driver/{composite,command,python,agent,action,lifecycle}.rs`
- Test: no new tests; `cargo test -p flow-core` must stay at 528 passed / 2 ignored and `cargo test -p mdium --lib` at 529 / 1.

**Interfaces:**
- Consumes: nothing new.
- Produces: the same public surface as before (`flow_core::run::driver::{Control, DriverEnv, Driver, Editor, FLOW_* consts, BUDGET_OPTIONS, COMMAND_APPROVAL_OPTIONS}`); every `pub` item keeps its path `crate::run::driver::<name>`. Later tasks add to `mod.rs` (`with_ctx`) and `composite.rs` (nothing) only.

Rust visibility makes this mechanical: a child module (`driver::command`) sees the private items of its parent (`driver`), so `impl Driver { … }` blocks in the child files use `self.running`, `self.emit(..)` etc. unchanged. Only items that a *sibling* file needs must become `pub(super)`.

- [ ] **Step 1: Move the file** with `git mv src-tauri/crates/flow-core/src/run/driver.rs src-tauri/crates/flow-core/src/run/driver/mod.rs` and confirm `cargo test -p flow-core` still passes (`run/mod.rs` keeps `pub mod driver;`). Commit: `refactor(driver): move driver.rs to driver/mod.rs`.

- [ ] **Step 2: Cut the kind-specific sections into files.** Add to the top of `mod.rs`:

```rust
mod action;
mod agent;
mod command;
mod composite;
mod lifecycle;
mod python;
```

Each new file starts with a module doc comment and `use super::*;` plus the imports it needs, and holds one `impl Driver { … }` block (several are fine) with exactly these functions, moved verbatim (the `// ----- section` comments move with them):

| File | Moves |
|---|---|
| `composite.rs` | `start_subflow`, `subflow_root_decided`, `resolve_scope_root`, `load_worktree_child`, `confirmed_differences`, `open_worktree_scope`, `open_file_scope`, `progress_composites`, `progress_subflow`, `iterations`, `progress_loop`, `start_iteration`, `finish_loop` |
| `command.rs` | `struct RunningCommand`, `launch_command`, `track`, `poll_running`, `poll_one`, `finish_command`, `prepare_launch` |
| `python.rs` | `struct LiveWorker`, `struct RunningCall` + its `impl`, `enum WorkerStartError`, `launch_call`, `still_starting`, `worker_start_error`, `ensure_worker`, `await_manifest`, `drop_worker`, `kill_workers`, `shutdown_workers`, `poll_calls`, `worker_alive`, `poll_worker`, `worker_line`, `active_call`, `worker_line_too_long`, `count_line`, `call_item`, `finish_call`, `cancel_calls`, free fn `call_failure_reason` |
| `agent.rs` | `struct RunningAgent`, `struct PreparedAgent`, `enum AgentFinish`, `const SCREENED_SHA256`, `launch_agent`, `request_agent_screening`, `agent_screening_decided`, `previous_turn`, `request_agent_question`, `agent_question_answered`, `prepare_agent`, `start_agent_turn`, `take_integrity_baseline`, `integrity_violation`, `warn_integrity`, `poll_agents`, `poll_agent`, `finish_agent`, `agent_completed`, free fns `resolve_working_dir`, `screening_text`, `integrity_snapshot_failed`, `read_answer` |
| `action.rs` | `struct RunningAction`, `enum ActionFinish`, `launch_action`, `action_approval_decided`, `poll_actions`, `action_progress`, `finish_action`, `end_actions` |
| `lifecycle.rs` | `stop_grace`, `begin_stop`, `cancel_all`, `shutdown`, `reconnect_running` |

Everything else stays in `mod.rs`: `Control`, `DriverEnv`, the constants, `ItemState`, `Finish`, `ProtocolCursor`, `Driver` and its `open` / state / events / scopes / controls / `apply_approval` / `settle` / `open_pass` / `rearm` / `retire` / `close_children` / `fail_node` / `fail_scope` / budget / `run` / `in_flight` / `advance` / `resolve_pending` / `check_scope` / `render_outputs` / `start_ready` / `start_node` / `retry_policy` / `node_timeout` / `request_node_approval` / `after_failure` / `retry_due` / `apply_item` / `flush_progress` / `record_artifact` / `protocol_warning` / `write_outputs` / `emit_outputs` / `new_pass`, `Editor`, and the free helpers `show_value`, `runtimes_and_setup`, `append_line`, `elapsed_since`, `far_future`. Moved structs referenced from `mod.rs` (`RunningCommand`, `LiveWorker`, `RunningCall`, `RunningAgent`, `RunningAction`, `ActionFinish`, `AgentFinish`, `WorkerStartError`) and their fields become `pub(super)`. Private items of `mod.rs` used by the children need no change. Do not reorder statements inside a function; do not rename anything; do not change a signature. If a free fn is used by two files, leave it in `mod.rs`.

- [ ] **Step 3: Build and test.** Run from `src-tauri`: `cargo build -p flow-core 2>&1 | grep -E "^(warning|error)"` must print nothing (fix unused imports by trimming the `use` lines, not with `#[allow]`); `cargo test -p flow-core` → 528 passed / 2 ignored; `cargo test -p mdium --lib` → 529 passed / 1 ignored. Check the sizes: `wc -l src-tauri/crates/flow-core/src/run/driver/*.rs` — `mod.rs` must be under 2,000 lines and no file over 1,400.

- [ ] **Step 4: Commit** `refactor(driver): split the driver into kind modules` (one commit for the split; `git diff --stat HEAD~1` shows only moves plus `mod`/`use`/`pub(super)` lines).

---

### Task 2: `project:main` flow reference, `project.metrics` template reference, `dev-workflow` `worktree` output

**Files:**
- Modify: `src-tauri/crates/flow-core/src/load.rs` (`flow_ref` ~line 299; new fns), `src-tauri/crates/flow-core/src/validate.rs` (`flow_ref_text` ~line 411), `src-tauri/crates/flow-core/src/run/engine.rs` (`load_bundle_at` ~line 391; the reference loop ~line 425), `src-tauri/crates/flow-core/src/run/actions/project.rs` (`flow_run_latest`), `src-tauri/crates/flow-core/src/template.rs` (`Reference`, parsing ~line 150), `src-tauri/crates/flow-core/src/run/prepare.rs` (`TemplateContext`, the resolver ~line 341, the two test contexts), `src-tauri/crates/flow-core/src/run/driver/mod.rs` (`with_ctx`), `src-tauri/crates/flow-core/src/project.rs` (helper), `resources/flow-templates/dev-workflow/flows/dev-workflow.flow.yaml` (outputs)
- Test: `src-tauri/crates/flow-core/src/load.rs` (tests module), `src-tauri/crates/flow-core/src/template.rs` (tests), `src-tauri/crates/flow-core/src/run/tests.rs`

**Interfaces:**
- Consumes: `project::load_project(root) -> Option<ProjectReport>` (`report.project: Option<ProjectDef>`, `report.errors`), `ProjectDef.flows: BTreeMap<String, String>` (`flows.main` is relative to `.mdium/`, e.g. `flows/production-cycle.flow.yaml`), `ProjectDef.metrics: Vec<MetricDef { reference (serialized as "ref"), better }>`, `load::resolve_in_project(project_root, base, reference) -> Result<PathBuf, PathProblem>`, `load::relative_display(root, file) -> String` (forward slashes, e.g. `.mdium/flows/main.flow.yaml`), `RunMeta.project: Option<ProjectDef>`, `ActionContext.project: Option<ProjectDef>`, `RunMeta.flow_path` (the display path).
- Produces: `load::PROJECT_MAIN_REF: &str = "project:main"`; `load::resolve_project_main(project_root: &Path) -> Result<PathBuf, FlowIssue>` (the main flow's absolute path; `FlowIssue::new(FLOW_REF_NOT_FOUND, "").with("ref", "project:main").with("reason", <"no-project" | "project-invalid" | "no-main-flow" | "main-flow-missing">)`); `project::main_flow_display(project: &ProjectDef) -> Option<String>` (`.mdium/<flows.main>` with `\` → `/`); `template::Reference::ProjectMetrics` (`${{ project.metrics }}`); `TemplateContext.metrics: &'a [MetricDef]`; `dev-workflow` output `worktree` (object).

- [ ] **Step 1: Failing tests for the reference (load.rs tests module).** Add to the existing `#[cfg(test)] mod tests` of `load.rs`:

```rust
#[test]
fn project_main_reference_needs_a_manifest_with_a_main_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join(".mdium/flows")).unwrap();
    let outer = root.join(".mdium/flows/outer.flow.yaml");
    std::fs::write(&outer, "schemaVersion: 1\nid: outer\nname: O\nnodes:\n  - { id: v, kind: subflow, flow: 'project:main' }\n").unwrap();
    // No manifest at all.
    let report = check_file(root, &outer);
    let issue = report.errors.iter().find(|i| i.code == FLOW_REF_NOT_FOUND).expect("no-project");
    assert_eq!(issue.params["reason"], serde_json::json!("no-project"));
    assert_eq!(issue.params["ref"], serde_json::json!("project:main"));
    // A manifest without flows.main.
    std::fs::write(root.join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\n").unwrap();
    let report = check_file(root, &outer);
    assert_eq!(report.errors.iter().find(|i| i.code == FLOW_REF_NOT_FOUND).unwrap().params["reason"], serde_json::json!("no-main-flow"));
    // flows.main names a missing file.
    std::fs::write(root.join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nflows:\n  main: flows/main.flow.yaml\n").unwrap();
    let report = check_file(root, &outer);
    assert_eq!(report.errors.iter().find(|i| i.code == FLOW_REF_NOT_FOUND).unwrap().params["reason"], serde_json::json!("main-flow-missing"));
    // The main flow exists: resolved like a file reference (its params are checked).
    std::fs::write(root.join(".mdium/flows/main.flow.yaml"), "schemaVersion: 1\nid: main\nname: M\nparams:\n  n: { type: number, required: true }\nnodes: []\n").unwrap();
    let report = check_file(root, &outer);
    assert!(report.errors.iter().all(|i| i.code != FLOW_REF_NOT_FOUND), "{:?}", report.errors);
    assert!(report.errors.iter().any(|i| i.code == "FLOW_PARAM_MISSING" || i.path.contains("params")), "the callee's required param is checked: {:?}", report.errors);
    assert_eq!(resolve_project_main(root).unwrap(), root.join(".mdium/flows/main.flow.yaml").canonicalize().unwrap_or(root.join(".mdium/flows/main.flow.yaml")));
}
```

(Use whatever code the existing loader emits for a missing required sub-flow param — read the `subflow` branch of `flow_ref` and assert that exact code; the point is that `project:main` goes through the same param check as a path.) Run `cargo test -p flow-core project_main_reference` → FAIL (`resolve_project_main` undefined).

- [ ] **Step 2: Implement the reference.**

`project.rs`:

```rust
/// The project-relative display path of the manifest's main flow
/// (`flows.main` is relative to `.mdium/`), forward slashes.
pub fn main_flow_display(project: &ProjectDef) -> Option<String> {
    let main = project.flows.get("main")?;
    Some(format!("{}/{}", PROJECT_DIR, main.replace('\\', "/")))
}
```

(Add `pub const PROJECT_DIR: &str = ".mdium";` next to the existing `PROJECT_FILE` (`.mdium/project.yaml`).)

`load.rs`:

```rust
/// The flow reference naming the project manifest's main flow.
pub const PROJECT_MAIN_REF: &str = "project:main";

/// Resolves `project:main` under `project_root`: the manifest's `flows.main`.
pub fn resolve_project_main(project_root: &Path) -> Result<PathBuf, FlowIssue> {
    let not_found = |reason: &str| {
        FlowIssue::new(FLOW_REF_NOT_FOUND, "")
            .with("ref", PROJECT_MAIN_REF)
            .with("reason", reason)
    };
    let report = crate::project::load_project(project_root).ok_or_else(|| not_found("no-project"))?;
    let project = match report.project {
        Some(project) if report.errors.is_empty() => project,
        _ => return Err(not_found("project-invalid")),
    };
    let main = project.flows.get("main").ok_or_else(|| not_found("no-main-flow"))?;
    let base = project_root.join(crate::project::PROJECT_DIR);
    resolve_in_project(project_root, &base, main).map_err(|_| not_found("main-flow-missing"))
}
```

In `flow_ref` (line ~299), before `let is_template = …`:

```rust
let (file, child_root) = if reference == PROJECT_MAIN_REF {
    match resolve_project_main(self.project_root) {
        Ok(file) => (file, self.project_root.to_path_buf()),
        Err(issue) => {
            self.issues.error(FlowIssue { path: path.to_string(), ..issue });
            return;
        }
    }
} else if is_template { … existing … } else { … existing … };
```

(Restructure the existing `if is_template {…} else {…}` into this three-way `if`.) `validate.rs` `flow_ref_text`: first line `if text == crate::load::PROJECT_MAIN_REF { return; }`.

`engine.rs`: in `load_bundle_at(root, rel)` map the reference before `read_flow`:

```rust
let rel = if rel == load::PROJECT_MAIN_REF {
    let file = load::resolve_project_main(root)
        .map_err(|issue| EngineError::new(FLOW_FILE_NOT_FOUND, format!("project:main ({})", issue.params.get("reason").and_then(|v| v.as_str()).unwrap_or(""))))?;
    load::relative_display(root, &file)
} else {
    rel.to_string()
};
let rel = rel.as_str();
```

In the reference loop (~line 431), add a first branch:

```rust
let (child, child_display, child_template) = if reference == load::PROJECT_MAIN_REF {
    let child = load::resolve_project_main(root).map_err(|_| cannot_resolve())?;
    (child.clone(), load::relative_display(root, &child), None)
} else if crate::templates::is_template_ref(&reference) { … } …
```

(`refs` then maps `ref_key(owner, "project:main")` to the display path, so `open_file_scope` works unchanged; `open_worktree_scope` goes through `load_bundle_at(worktree, "project:main")`, which resolves the *worktree's* manifest.)

`actions/project.rs` `flow_run_latest`: after `let flow = required_str(with, "flow")?.replace('\\', "/");`:

```rust
let flow = if flow == crate::load::PROJECT_MAIN_REF {
    ctx.project
        .as_ref()
        .and_then(crate::project::main_flow_display)
        .ok_or_else(|| failed(FLOW_RUN_NOT_FOUND, "the project declares no main flow"))?
} else {
    flow
};
```

Run the Step 1 test → PASS. Run `cargo test -p flow-core` → all green.

- [ ] **Step 3: Failing engine tests (run/tests.rs, after `flow_run_latest_picks_the_latest_completed_run`-style tests).**

```rust
#[test]
fn flow_run_latest_accepts_the_project_main_reference() {
    let f = fixture();
    std::fs::create_dir_all(f.root.join(".mdium")).unwrap();
    std::fs::write(f.root.join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nflows:\n  main: flows\\main.flow.yaml\n").unwrap();
    let main = write_flow(&f.root, "main", json!({ "outputs": { "score": "${{ nodes.a.outputs.score }}" } }),
        vec![cmd("a", json!([ev(json!({ "v": 1, "type": "output", "key": "score", "value": 5 }))]))], vec![]);
    let first = f.confirm_and_start(&main, json!({}));
    f.wait_settled(&first, RunStatus::Completed);
    let outer = write_flow(&f.root, "outer", json!({}),
        vec![json!({ "id": "base", "kind": "action", "uses": "mdium/flow-run-latest", "with": { "flow": "project:main" } }),
             json!({ "id": "v", "kind": "subflow", "flow": "project:main" })],
        vec![json!({ "from": "base", "to": "v" })]);
    let run_id = f.confirm_and_start(&outer, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "base").outputs["runId"], json!(first));
    assert_eq!(node(&snap, "v").outputs["score"], json!(5));
    assert_eq!(node(&snap, "v/a").status, NodeStatus::Succeeded);
}

#[test]
fn project_metrics_render_as_the_manifest_array() {
    let f = fixture();
    std::fs::create_dir_all(f.root.join(".mdium")).unwrap();
    std::fs::write(f.root.join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nmetrics:\n  - { ref: outputs.score, better: higher }\n  - { ref: costUsd, better: lower }\n").unwrap();
    let rel = write_flow(&f.root, "m", json!({ "outputs": { "m": "${{ project.metrics }}", "n": "${{ project.metrics }} items" } }), vec![cmd("a", json!([]))], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    let outputs = &snap.state.scopes[""].outputs;
    assert_eq!(outputs["m"], json!([{ "ref": "outputs.score", "better": "higher" }, { "ref": "costUsd", "better": "lower" }]));
    assert!(outputs["n"].as_str().unwrap().starts_with("[{"), "{:?}", outputs["n"]);
}
```

Also, in `template.rs` tests: `parse("project.metrics")` yields `Reference::ProjectMetrics` and `project.nope` stays a `BadReference`. Run → FAIL.

- [ ] **Step 4: Implement `project.metrics`.** `template.rs`: `["project", "metrics"] => Reference::ProjectMetrics,` and the enum variant (doc: "The project manifest's `metrics` (an array; empty without a manifest)"). `prepare.rs`: `pub metrics: &'a [MetricDef],` on `TemplateContext` (import `crate::project::MetricDef`), resolver arm `Reference::ProjectMetrics => Some(serde_json::to_value(self.metrics).unwrap_or(Value::Array(Vec::new()))),`; the two test contexts in `prepare.rs` get `metrics: &[]`. `driver/mod.rs` `with_ctx`: `let metrics: &[MetricDef] = self.meta.project.as_ref().map(|p| p.metrics.as_slice()).unwrap_or(&[]);` and `metrics,` in the struct literal. `Better` already serializes lowercase (`#[serde(rename_all = "lowercase")]`). Run the tests → PASS.

- [ ] **Step 5: `dev-workflow` output.** In `resources/flow-templates/dev-workflow/flows/dev-workflow.flow.yaml` `outputs:` add `worktree: "${{ nodes.worktree.outputs }}"` as the first line (keep the other three). Extend the existing test `the_dev_workflow_template_runs_without_the_plan_approval` with `assert!(node(&snap, "dev").outputs["worktree"]["baseBranch"].as_str().is_some());`. Run `cargo test -p flow-core dev_workflow` → PASS.

- [ ] **Step 6: Commit** `feat(flow): project:main flow reference and project.metrics` (one commit, or two: reference / metrics+output).

---

### Task 3: `builtin:improve-analyze` prompt

**Files:**
- Modify: `src-tauri/crates/flow-core/src/prompts.rs` (new constants; `builtin` match arm)
- Test: `src-tauri/crates/flow-core/src/prompts.rs` (tests module)

**Interfaces:**
- Consumes: `builtin(name) -> Option<&'static str>`, `compose(instructions, inputs, contract, previous)` (unchanged: inputs appear as `## Inputs` data blocks, the outcome contract is appended).
- Produces: `builtin("improve-analyze")`; `IMPROVE_ANALYZE_PROMPT`, `IMPROVE_ANALYZE_CRITERIA`. The prompt names the input keys the template passes: `goal`, `metrics`, `baseline`, `revision`, `previousProposal`, `previousReport`.

- [ ] **Step 1: Failing test.** In the `prompts.rs` tests module:

```rust
#[test]
fn improve_analyze_is_a_builtin_prompt_naming_its_inputs() {
    let text = builtin("improve-analyze").expect("builtin");
    for key in ["goal", "metrics", "baseline", "revision", "previousProposal", "previousReport", "runDir", "outputs.json", "stdout.log", "artifacts.json"] {
        assert!(text.contains(key), "missing {key}");
    }
    assert!(text.contains("## Completion criteria"));
    assert!(text.contains("Do not modify, create or delete any file"));
    // The outcome contract is appended by compose, not part of the builtin text.
    assert!(!text.contains("outcome:"));
}
```

Run `cargo test -p flow-core improve_analyze` → FAIL.

- [ ] **Step 2: Write the prompt.** Add after `REVIEW_CRITERIA`:

```rust
/// Stage instructions for the analysis stage of the improvement loop
/// (read-only in the project root).
pub const IMPROVE_ANALYZE_PROMPT: &str = r###"You are the analysis stage of an automated improvement loop for this project. Your job is to propose exactly one change to the project that is likely to improve its metrics towards the goal, written so that a separate design -> implement -> review pipeline can carry it out in a git worktree without asking you anything.

Do not modify, create or delete any file, and do not run commands that change the repository, its git state or the project's data. You may read files and run read-only commands.

The inputs are:
- goal: what the user wants to improve, in their words.
- metrics: the project's metric definitions as a JSON array of { "ref", "better" }. "ref" is "outputs.<key>" (an output of the project's main flow) or "costUsd" (the run's total cost); "better" is "higher" or "lower".
- baseline: the latest completed run of the main flow as a JSON object: runId, runDir (an absolute directory), status, outputs (the run's outputs, where the metrics are read from), costUsd and failedNodes.
- revision: the user's comment on your previous proposal in this pass, when they asked for a revision; otherwise empty. A non-empty revision means: keep what they did not object to and change what they asked for.
- previousProposal and previousReport: in a later iteration, the proposal that was tried before and the metric comparison it produced; otherwise empty. A discarded proposal must not be proposed again; a merged one is now part of the project.

How to work:
1. Read the goal and the metrics. Decide which metric(s) the goal is about and which direction counts as better.
2. Study the baseline run under runDir: run.json (the flow, its nodes and their states), each node directory's outputs.json, the last part of its stdout.log and stderr.log, and artifacts.json (the files it produced; open the ones relevant to the goal). Note what the run did, where time and cost went, where quality was lost and what failed.
3. Explore the project: its layout, how the main flow's stages are implemented (the flow files under .mdium/flows and the code they call), prompts, configuration and tests. Find the smallest change whose effect on the metrics you can argue from what you observed.
4. Consider at least two candidate changes, compare them on expected metric effect, risk, size and testability, and choose one.
5. Write the proposal as your final response body, in Markdown, with exactly these sections:

## Goal
The user's goal restated, the metric(s) it maps to and the direction that counts as better.

## Observations
What the baseline run shows that motivates the change, with the concrete evidence (file paths under runDir, values from outputs.json, log excerpts).

## Proposal
The one change to make: what and why, in a few paragraphs.

## Files
A list per file: the repository-relative path, whether it is new or modified, and what changes in it.

## Verification
How the next run of the main flow (at a reduced scale) will show the effect, and what else to test.

## Expected metric change
For each metric: the baseline value, the expected direction and a rough magnitude, and the main risk of making another metric worse.

Keep it specific to this project: name real paths and identifiers. Prefer the smallest change that can plausibly move the metric. If the goal is too ambiguous to analyse responsibly, ask one precise question (using the awaiting_user outcome) instead of guessing."###;

/// Completion criteria for the analysis stage.
pub const IMPROVE_ANALYZE_CRITERIA: &str = r###"The analysis is complete only when all of the following hold:
- Exactly one change is proposed, and every file it names as existing does exist in the repository.
- Every claim in Observations points at a file under the baseline's runDir or in the repository.
- Expected metric change covers every metric in the input and names the baseline value of each.
- The revision comment (if any) is addressed, and a previously discarded proposal is not repeated.
- No file in the repository was modified."###;
```

In `builtin`, add `static ANALYZE: OnceLock<String>` and the arm `"improve-analyze" => ANALYZE.get_or_init(|| with_criteria(IMPROVE_ANALYZE_PROMPT, IMPROVE_ANALYZE_CRITERIA)),`. Run the test → PASS; `cargo test -p flow-core` green (the existing `builtin` tests that enumerate names, if any, get the fifth name).

- [ ] **Step 3: Commit** `feat(prompts): builtin:improve-analyze`.

---

### Task 4: The `improve-app` template and its engine tests

**Files:**
- Create: `resources/flow-templates/improve-app/project.yaml`, `resources/flow-templates/improve-app/flows/improve-app.flow.yaml`, `resources/flow-templates/improve-app/flows/lib/improve-app/improve-propose.flow.yaml`, `resources/flow-templates/improve-app/flows/lib/improve-app/improve-verify.flow.yaml`
- Modify: `src-tauri/crates/flow-core/src/templates.rs` (tests: the list/copy test covers both templates)
- Test: `src-tauri/crates/flow-core/src/run/tests.rs` (new section `// ---- improve-app`)

**Interfaces:**
- Consumes: `project:main` (Task 2), `project.metrics` (Task 2), `builtin:improve-analyze` (Task 3), `dev-workflow` output `worktree` (Task 2), the V7 actions `mdium/flow-run-latest` (`{ flow }` → `{ runId, runDir, status, outputs, costUsd, failedNodes }`), `mdium/project-setup` (`{ projectRoot }`), `mdium/metrics-compare` (`{ baseline: { outputs, costUsd }, candidate: { outputs, costUsd } }` → `{ improved, report, reportPath }` + artifact `report`), `mdium/git-merge-local` / `mdium/git-worktree-discard` (`{ worktree: WorktreeInfo }`), `templates::copy_into(project_root, "improve-app", file_name)` (copies the main flow and `flows/lib/improve-app/*` to `.mdium/flows/lib/improve-app/`), test helpers `fixture_at_with_agent`, `FakeAgentRunner`, `FakeTurn::Respond`, `write_flow`, `cmd`, `ev`, `confirm_and_start`, `wait_settled`, `wait_for`, `node`, `GitFixture` (`crate::gitops::test_support::Fixture`: `new`, `root`, `write`, `run`).
- Produces: the template files below (their node ids are the names Task 7's copy and Task 9's smoke use).

- [ ] **Step 1: Write the template.**

`resources/flow-templates/improve-app/project.yaml`:

```yaml
schemaVersion: 1
id: improve-app
name: Improve this project
description: Reads the latest run of the project's main flow, proposes one change, implements it with the development workflow in a worktree, re-runs the main flow there and compares the metrics before a human merges or discards.
flows:
  main: flows/improve-app.flow.yaml
```

`resources/flow-templates/improve-app/flows/improve-app.flow.yaml`:

```yaml
schemaVersion: 1
id: improve-app
name: Improve this project
description: propose (baseline -> analyze -> approve) -> develop (dev-workflow, no merge) -> verify (setup -> main flow in the worktree -> compare) -> adopt gate -> merge or discard, then the next iteration.
params:
  goal: { type: string, required: true }
  provider: { type: string, default: claude }
  requiresApproval: { type: bool, default: true }
limits: { maxConcurrentNodes: 1, budgetUsd: 50 }
nodes:
  - id: propose
    kind: subflow
    flow: lib/improve-app/improve-propose.flow.yaml
    params:
      goal: "${{ params.goal }}"
      provider: "${{ params.provider }}"
      # Empty on the first pass; the next iteration sees what was tried.
      previousProposal: "${{ nodes.propose.outputs.proposal }}"
      previousReport: "${{ nodes.verify.outputs.report }}"
    timeout: 2h
  - id: proceed
    kind: branch
    cases:
      - { when: { ref: nodes.propose.outputs.choice, op: "==", value: stop }, port: stopped }
    default: go
  - id: develop
    kind: subflow
    flow: mdium:dev-workflow
    params:
      title: "${{ params.goal }}"
      requirement: "${{ nodes.propose.outputs.proposal }}"
      mergeGate: false
      provider: "${{ params.provider }}"
      requiresApproval: "${{ params.requiresApproval }}"
    timeout: 6h
  - id: verify
    kind: subflow
    flow: lib/improve-app/improve-verify.flow.yaml
    params:
      worktreePath: "${{ nodes.develop.outputs.worktreePath }}"
      baselineOutputs: "${{ nodes.propose.outputs.baselineOutputs }}"
      baselineCostUsd: "${{ nodes.propose.outputs.baselineCostUsd }}"
    timeout: 24h
  - id: adopt_gate
    kind: approval
    message: Adopt the change? The report compares the verification run in the worktree with the baseline run.
    show: [nodes.verify.outputs.report, nodes.verify.outputs.improved, nodes.develop.outputs.branch]
    options: [merge, discard]
  - { id: merge, kind: action, uses: mdium/git-merge-local, with: { worktree: "${{ nodes.develop.outputs.worktree }}" } }
  - { id: discard, kind: action, uses: mdium/git-worktree-discard, with: { worktree: "${{ nodes.develop.outputs.worktree }}" } }
edges:
  - { from: propose, to: proceed }
  - { from: proceed, to: develop, port: go }
  - { from: develop, to: verify }
  - { from: verify, to: adopt_gate }
  # A failed verification is still the human's call.
  - { from: verify, to: adopt_gate, port: failure }
  - { from: adopt_gate, to: merge, port: merge }
  - { from: adopt_gate, to: discard, port: discard }
  # The next iteration starts from the new baseline (merge) or tries another proposal (discard).
  - { from: merge, to: propose, maxTraversals: 3 }
  - { from: discard, to: propose, maxTraversals: 3 }
outputs:
  lastChoice: "${{ nodes.adopt_gate.outputs.choice }}"
  lastBranch: "${{ nodes.develop.outputs.branch }}"
```

(`proceed`'s `stopped` port has no edge on purpose: `stop` at the proposal ends the run normally, 8.2. The engine does not require an edge per declared port — the V6 `video.flow.yaml` already has an approval port without one.) Flow-level `outputs` are strict: `adopt_gate` and `develop` are reached on every path except `stop` on the very first pass — when they are unrun the output is omitted with the `FLOW_OUTPUT_UNRESOLVED` warning (V7 rule), which is acceptable for that path.

`resources/flow-templates/improve-app/flows/lib/improve-app/improve-propose.flow.yaml`:

```yaml
schemaVersion: 1
id: improve-propose
name: Propose an improvement
description: baseline (latest completed run of the main flow) -> analyze (read-only agent) -> approve_proposal (approve / revise / stop).
params:
  goal: { type: string, required: true }
  provider: { type: string, default: claude }
  previousProposal: { type: string, default: "" }
  previousReport: { type: string, default: "" }
nodes:
  - { id: baseline, kind: action, uses: mdium/flow-run-latest, with: { flow: "project:main" } }
  - id: analyze
    kind: agent
    provider: "${{ params.provider }}"
    permission: read-only
    promptRef: builtin:improve-analyze
    outputContract: outcome
    with:
      goal: "${{ params.goal }}"
      metrics: "${{ project.metrics }}"
      baseline: "${{ nodes.baseline.outputs }}"
      revision: "${{ nodes.approve_proposal.outputs.comment }}"
      previousProposal: "${{ params.previousProposal }}"
      previousReport: "${{ params.previousReport }}"
    timeout: 30m
  - id: approve_proposal
    kind: approval
    message: Review the improvement proposal. Approve to implement it, revise with a comment, or stop the loop.
    show: [nodes.analyze.outputs.body]
    options: [approve, { name: revise, commentRequired: true }, stop]
edges:
  - { from: baseline, to: analyze }
  - { from: analyze, to: approve_proposal }
  - { from: approve_proposal, to: analyze, port: revise, maxTraversals: 5 }
outputs:
  proposal: "${{ nodes.analyze.outputs.body }}"
  choice: "${{ nodes.approve_proposal.outputs.choice }}"
  baselineOutputs: "${{ nodes.baseline.outputs.outputs }}"
  baselineCostUsd: "${{ nodes.baseline.outputs.costUsd }}"
```

`resources/flow-templates/improve-app/flows/lib/improve-app/improve-verify.flow.yaml`:

```yaml
schemaVersion: 1
id: improve-verify
name: Verify an improvement
description: setup (project setup in the worktree) -> verify (the project's main flow run inside the worktree) -> compare (metrics against the baseline).
params:
  worktreePath: { type: string, required: true }
  baselineOutputs: { type: object, required: true }
  baselineCostUsd: { type: number, required: true }
nodes:
  - { id: setup, kind: action, uses: mdium/project-setup, with: { projectRoot: "${{ params.worktreePath }}" } }
  - id: verify
    kind: subflow
    flow: project:main
    projectRoot: "${{ params.worktreePath }}"
    # The project's copy narrows the scale here (for example one story, one chapter, no review).
    params: {}
    timeout: 24h
  - id: compare
    kind: action
    uses: mdium/metrics-compare
    with:
      baseline: { outputs: "${{ params.baselineOutputs }}", costUsd: "${{ params.baselineCostUsd }}" }
      candidate: { outputs: "${{ nodes.verify.outputs }}", costUsd: "${{ nodes.verify.costUsd }}" }
edges:
  - { from: setup, to: verify }
  - { from: verify, to: compare }
outputs:
  improved: "${{ nodes.compare.outputs.improved }}"
  report: "${{ nodes.compare.outputs.report }}"
  candidate: "${{ nodes.verify.outputs }}"
```

- [ ] **Step 2: Template registry tests.** In `templates.rs` tests, extend `resolves_and_lists_the_bundled_templates`: `list()` contains `improve-app` with `main == "flows/improve-app.flow.yaml"`; `copy_into(tmp, "improve-app", "improve")` returns exactly `[".mdium/flows/improve.flow.yaml", ".mdium/flows/lib/improve-app/improve-propose.flow.yaml", ".mdium/flows/lib/improve-app/improve-verify.flow.yaml"]` (or the project-relative form the function returns for `dev-workflow` today — match that), the copied main's text starts with `id: improve` after the `schemaVersion` line and the parts are byte-identical to the template's. Add to `template_flows_refuse_commands_python_and_prompt_files` (or a new test) that `check_template_flow` on all three improve-app files reports no issue. Run → FAIL until the files exist (Step 1 wrote them, so these pass immediately; keep them as regression).

- [ ] **Step 3: Failing engine tests.** Append to `run/tests.rs`:

```rust
// ------------------------------------------------------------ improve-app

/// A git project whose main flow is one command emitting `score`, with a
/// manifest declaring `flows.main` and a `score` metric, committed so that
/// worktrees carry it; the improve-app template copied in as `improve`.
fn improve_fixture(setup_exit: Option<i32>) -> (GitFixture, Fixture, Arc<FakeAgentRunner>, String) {
    use crate::gitops::test_support::Fixture as GitFixture;
    crate::templates::test_templates();
    let repo = GitFixture::new();
    let setup = match setup_exit {
        None => String::new(),
        Some(code) => format!("setup:\n  - {{ run: [{}] }}\n", setup_step_exiting(code)),
    };
    repo.write(".mdium/project.yaml", &format!("schemaVersion: 1\nid: p\nname: P\nflows:\n  main: flows/main.flow.yaml\n{setup}metrics:\n  - {{ ref: outputs.score, better: higher }}\n"));
    repo.write(".gitignore", ".mdium/flow-runs/\n.mdium/setup-runs/\n");
    let runner = Arc::new(FakeAgentRunner::new(Vec::new()));
    let f = fixture_at_with_agent(repo.root(), runner.clone());
    write_flow(&f.root, "main", json!({ "outputs": { "score": "${{ nodes.a.outputs.score }}" } }),
        vec![cmd("a", json!([ev(json!({ "v": 1, "type": "output", "key": "score", "value": 5 }))]))], vec![]);
    crate::templates::copy_into(&f.root, "improve-app", "improve").unwrap();
    repo.run(&["add", "."]);
    repo.run(&["commit", "-qm", "project"]);
    (repo, f, runner, ".mdium/flows/improve.flow.yaml".to_string())
}
```

`setup_step_exiting(_code)` returns the JSON array of the test helper binary's argv with an extra `--no-such-flag` element (libtest rejects it, so the step exits non-zero) — exactly what `project_setup_reports_the_failing_step` does with `helper_argv()`: `serde_json::to_string(&bad_argv).unwrap()`. The absolute helper path is committed into the manifest, so the worktree's copy runs the same binary. With `setup_exit == None` the manifest has no `setup` key (the action then runs no step and reports `ok: true`).

```rust
#[test]
fn improve_app_runs_one_iteration_and_tries_again_after_a_discard() {
    let (_repo, f, runner, improve) = improve_fixture(None);
    let main = ".mdium/flows/main.flow.yaml";
    let first = f.confirm_and_start(main, json!({}));
    f.wait_settled(&first, RunStatus::Completed);
    runner.push_turns(vec![
        FakeTurn::Respond("---\noutcome: completed\n---\n# Proposal\nBump the score".into()), // analyze
        FakeTurn::Respond("---\noutcome: completed\n---\n# Design".into()),                  // design
        FakeTurn::Respond("---\noutcome: completed\n---\n# Done".into()),                    // implement
        FakeTurn::Respond("---\noutcome: completed\n---\nLGTM".into()),                      // review
        FakeTurn::Respond("---\noutcome: completed\n---\n# Proposal 2\nAnother idea".into()), // analyze@2
    ]);
    let run_id = f.confirm_and_start(&improve, json!({ "goal": "raise the score", "requiresApproval": false }));
    // Pass 1: the proposal waits for approval.
    let snap = f.wait_for(&run_id, "proposal", |s| s.state.status == RunStatus::AwaitingApproval);
    assert_eq!(snap.state.approvals[0].node_key.as_deref(), Some("propose/approve_proposal"));
    let prompts = runner.prompts();
    assert!(prompts[0].contains("raise the score") && prompts[0].contains("\"ref\": \"outputs.score\"") && prompts[0].contains(&first), "{}", prompts[0]);
    f.engine.approve(&f.root, &run_id, Some("propose/approve_proposal"), "approve", None).unwrap();
    // The dev-workflow runs without the plan approval, then the verification runs the main flow in the worktree.
    let snap = f.wait_for(&run_id, "adopt gate", |s| s.state.status == RunStatus::AwaitingApproval);
    assert_eq!(snap.state.approvals[0].node_key.as_deref(), Some("adopt_gate"));
    assert_eq!(node(&snap, "verify/setup").outputs["ok"], json!(true));
    assert_eq!(node(&snap, "verify/verify/a").status, NodeStatus::Succeeded);
    let worktree = node(&snap, "develop").outputs["worktreePath"].as_str().unwrap().to_string();
    assert!(snap.state.scopes.values().any(|s| s.init.project_root.as_deref() == Some(worktree.as_str())), "the verification ran in the worktree");
    assert_eq!(node(&snap, "verify/compare").outputs["improved"], json!(false), "same score is not an improvement");
    assert!(node(&snap, "verify/compare").outputs["report"].as_str().unwrap().contains("| outputs.score | 5 | 5 | same |"));
    assert_eq!(snap.state.approvals[0].show["nodes.verify.outputs.improved"], ShowValue::Value(json!(false)));
    f.engine.approve(&f.root, &run_id, Some("adopt_gate"), "discard", None).unwrap();
    // Pass 2: the back-edge re-runs the propose part; the analysis sees what was tried.
    let snap = f.wait_for(&run_id, "proposal 2", |s| s.state.status == RunStatus::AwaitingApproval);
    assert_eq!(snap.state.approvals[0].node_key.as_deref(), Some("propose@2/approve_proposal"));
    let prompts = runner.prompts();
    assert_eq!(prompts.len(), 5, "{prompts:?}");
    assert!(prompts[4].contains("Bump the score") && prompts[4].contains("| same |"), "{}", prompts[4]);
    assert!(!std::path::Path::new(&worktree).exists(), "discard removed the worktree");
    f.engine.approve(&f.root, &run_id, Some("propose@2/approve_proposal"), "stop", None).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "proceed@2").port.as_deref(), Some("stopped"));
    assert_eq!(node(&snap, "develop").status, NodeStatus::Succeeded, "pass 1's develop is untouched");
}

#[test]
fn improve_app_revises_the_proposal_with_the_comment() {
    let (_repo, f, runner, improve) = improve_fixture(None);
    let first = f.confirm_and_start(".mdium/flows/main.flow.yaml", json!({}));
    f.wait_settled(&first, RunStatus::Completed);
    runner.push_turns(vec![
        FakeTurn::Respond("---\noutcome: completed\n---\n# Proposal".into()),
        FakeTurn::Respond("---\noutcome: completed\n---\n# Proposal, revised".into()),
    ]);
    let run_id = f.confirm_and_start(&improve, json!({ "goal": "g" }));
    f.wait_for(&run_id, "proposal", |s| s.state.status == RunStatus::AwaitingApproval);
    f.engine.approve(&f.root, &run_id, Some("propose/approve_proposal"), "revise", Some("smaller please".into())).unwrap();
    let snap = f.wait_for(&run_id, "proposal 2", |s| s.state.status == RunStatus::AwaitingApproval);
    assert_eq!(snap.state.approvals[0].node_key.as_deref(), Some("propose/approve_proposal@2"));
    assert!(runner.prompts()[1].contains("smaller please"));
    f.engine.approve(&f.root, &run_id, Some("propose/approve_proposal@2"), "stop", None).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "develop").status, NodeStatus::Skipped);
    assert_eq!(node(&snap, "propose").outputs["choice"], json!("stop"));
}

#[test]
fn improve_app_offers_the_gate_when_the_verification_fails() {
    let (_repo, f, runner, improve) = improve_fixture(Some(3));
    let first = f.confirm_and_start(".mdium/flows/main.flow.yaml", json!({}));
    f.wait_settled(&first, RunStatus::Completed);
    runner.push_turns(vec![
        FakeTurn::Respond("---\noutcome: completed\n---\n# Proposal".into()),
        FakeTurn::Respond("---\noutcome: completed\n---\n# Design".into()),
        FakeTurn::Respond("---\noutcome: completed\n---\n# Done".into()),
        FakeTurn::Respond("---\noutcome: completed\n---\nLGTM".into()),
    ]);
    let run_id = f.confirm_and_start(&improve, json!({ "goal": "g", "requiresApproval": false }));
    f.wait_for(&run_id, "proposal", |s| s.state.status == RunStatus::AwaitingApproval);
    f.engine.approve(&f.root, &run_id, Some("propose/approve_proposal"), "approve", None).unwrap();
    let snap = f.wait_for(&run_id, "adopt gate", |s| s.state.status == RunStatus::AwaitingApproval);
    assert_eq!(snap.state.approvals[0].node_key.as_deref(), Some("adopt_gate"));
    assert_eq!(node(&snap, "verify/setup").reason.unwrap().code, "FLOW_SETUP_FAILED");
    assert_eq!(node(&snap, "verify").status, NodeStatus::Failed);
    assert_eq!(snap.state.approvals[0].show["nodes.verify.outputs.report"], ShowValue::Value(Value::Null));
    let worktree = node(&snap, "develop").outputs["worktreePath"].as_str().unwrap().to_string();
    f.engine.approve(&f.root, &run_id, Some("adopt_gate"), "discard", None).unwrap();
    f.wait_for(&run_id, "proposal 2", |s| s.state.status == RunStatus::AwaitingApproval);
    assert!(!std::path::Path::new(&worktree).exists());
    f.engine.cancel(&f.root, &run_id).unwrap();
    f.wait_settled(&run_id, RunStatus::Cancelled);
}
```

Add `pub fn push_turns(&self, turns: Vec<FakeTurn>)` to `FakeAgentRunner` in `test_helper.rs` (appends to the `turns` deque). `ShowValue::Value`, `ScopeInit.project_root: Option<String>`, `NodeState.port: Option<String>` and `engine.cancel(root, run_id)` are the real names (`run/model.rs`, `run/engine.rs`). The approval node key of the second pass of a node inside a sub-flow follows the V7 convention (`<scope>/<node>@2` or `<scope>@2/<node>`): read `the_dev_workflow_review_loop_reopens_the_design_without_an_issue` and `new_pass` for the exact form before asserting. Run `cargo test -p flow-core improve_app` → FAIL (template or helpers missing).

- [ ] **Step 4: Make them pass.** Expect to fix only test plumbing and, if the engine refuses something the template needs, exactly these two engine points are allowed: (a) a back-edge into a `subflow` node must open a new pass of the composite (`open_pass` → `new_pass` → `close_children`; add the test `a_back_edge_reruns_a_subflow_as_a_new_pass` with a 3-node flow if it does not already work), (b) nothing else — any other engine change is a ruling for the controller. Run the three tests and the whole suite → green.

- [ ] **Step 5: Commit** `feat(templates): improve-app template` (template files + registry tests) and `test(flow): improve-app runs an iteration` (engine tests; plus `fix(flow): …` if (a) was needed).

---

### Task 5: UI: template strings and `project:` references

**Files:**
- Modify: `src/features/flow/lib/extract-subflow.ts` (`isRelativeFileRef`), `src/features/flow/lib/flow-graph.ts` (`nodeSignature`), `src/features/flow/components/attrs/kinds/SubflowForm.tsx` (hint), `src/shared/i18n/locales/ja/flow.json`, `src/shared/i18n/locales/en/flow.json`
- Test: `src/features/flow/lib/__tests__/extract-subflow.test.ts`, `src/features/flow/lib/__tests__/flow-graph.test.ts`

**Interfaces:**
- Consumes: `NewFlowDialog` reads `template.<name>.title` / `.description` from the `flow` namespace (line ~84); `nodeSignature(node, currentFile, signatures)` returns `{ file, params, outputs }`.
- Produces: i18n keys `template.improve-app.title` = ja「改善ループ」/ en "Improvement loop", `template.improve-app.description` = ja「主フローの最新実行を読んで変更を提案し、開発ワークフローで worktree に実装して主フローを再実行し、指標を比べてからマージまたは破棄します。」/ en "Reads the latest run of the main flow, proposes a change, implements it with the development workflow in a worktree, re-runs the main flow there and compares the metrics before merging or discarding."; `attrs.flowProjectMainHint` = ja「`project:main` はプロジェクトの主フロー（project.yaml の flows.main）を指します。」/ en "`project:main` names the project's main flow (flows.main in project.yaml)."

- [ ] **Step 1: Failing tests.** `extract-subflow.test.ts`: extracting nodes whose `subflow.flow` is `project:main` (and `mdium:dev-workflow`) keeps the reference text unchanged in the new part (find the existing test that checks `mdium:` or `builtin:` refs survive `rebase` and add `project:main` to it). `flow-graph.test.ts`: `nodeSignature` for `{ kind: "subflow", flow: "project:main", params: { a: 1 } }` returns `file: "project:main"` (not a path joined onto the current file) with the given params marked undeclared and empty outputs; same for `mdium:dev-workflow`. Run `npx vitest run src/features/flow/lib` → FAIL.

- [ ] **Step 2: Implement.** `isRelativeFileRef`: add `!ref.startsWith("project:")`. `flow-graph.ts`: `const file = /^(mdium|project):/.test(ref) ? ref : resolvePartPath(currentFile, ref);`. `SubflowForm.tsx`: under the flow field add `<div className="flow-attrs__hint">{t("attrs.flowProjectMainHint")}</div>`. Add the i18n keys to both locales. Run the two test files and `locale-parity` → PASS; `npx tsc --noEmit` clean.

- [ ] **Step 3: Commit** `feat(flow-ui): improve-app template strings and project:main references`.

---

### Task 6: The editor keeps comments and key order when writing YAML (carry-over)

**Files:**
- Modify: `src/features/flow/lib/flow-yaml.ts` (new `mergeFlowIntoText`; refactor the style visitor into `applyFlowStyle`), `src/features/flow/editor-store.ts` (`applyEdit` uses the merge; remove `commentWarningPending` and its selector), the component that shows the comment warning (grep `commentWarning` under `src/features/flow`), `src/shared/i18n/locales/{ja,en}/flow.json` (remove the warning's keys)
- Test: `src/features/flow/lib/__tests__/flow-yaml.test.ts`, the editor-store test file if one exists (grep `editor-store` under `src/features/flow/**/__tests__`)

**Interfaces:**
- Consumes: `canonicalTop(def)`, `stringifyFlow(def)`, `parseDocument` / `Document` / `isMap` / `isSeq` / `isScalar` / `visit` from `yaml`, `FlowDef`.
- Produces: `mergeFlowIntoText(text: string, def: FlowDef): string` — the YAML `text` updated in place to represent `def`: existing nodes keep their comments, key order and scalar styles; new keys are appended to their map; nodes (items with an `id`) are matched by id and reordered to `def`'s order; removed keys and nodes are deleted; unparsable `text` falls back to `stringifyFlow(def)`.

- [ ] **Step 1: Failing tests** (`flow-yaml.test.ts`):

```ts
import { mergeFlowIntoText, parseFlowText, stringifyFlow } from "../flow-yaml";

const SOURCE = `# Production flow
schemaVersion: 1
id: demo
name: Demo   # the display name
params:
  n: { type: number, default: 1 }
nodes:
  # First step
  - id: a
    kind: command
    run: [echo, a]
    timeout: 5m
  - id: b
    kind: command
    run: [echo, b]
edges:
  - { from: a, to: b }
`;

function def(text: string) {
  const r = parseFlowText(text);
  if ("error" in r) throw new Error(r.error.message);
  return r.value as FlowDef;
}

describe("mergeFlowIntoText", () => {
  it("merge keeps comments and key order and drops removed nodes", () => {
    const d = def(SOURCE);
    d.nodes[0] = { ...d.nodes[0], timeout: "10m" } as FlowNode;
    d.nodes = [d.nodes[0]];
    d.edges = [];
    const out = mergeFlowIntoText(SOURCE, d);
    expect(out).toContain("# Production flow");
    expect(out).toContain("name: Demo   # the display name");
    expect(out).toContain("  # First step\n  - id: a");
    expect(out).toContain("timeout: 10m");
    expect(out).not.toContain("id: b");
    expect(out).not.toContain("edges:");
    expect(out.indexOf("schemaVersion")).toBeLessThan(out.indexOf("id: demo"));
    expect(def(out)).toEqual(def(stringifyFlow(d)));
  });

  it("appends new nodes and keys in flow style with templates double-quoted", () => {
    const d = def(SOURCE);
    d.nodes.push({ id: "c", kind: "command", run: ["echo", "c"], with: { x: "${{ params.n }}", y: 2 } } as unknown as FlowNode);
    d.outputs = { done: "${{ nodes.c.outputs.ok }}" };
    const out = mergeFlowIntoText(SOURCE, d);
    expect(out).toContain('with: { x: "${{ params.n }}", y: 2 }');
    expect(out).toContain('done: "${{ nodes.c.outputs.ok }}"');
    expect(out.indexOf("id: b")).toBeLessThan(out.indexOf("id: c"));
    expect(def(out)).toEqual(def(stringifyFlow(d)));
  });

  it("reorders nodes by the definition and keeps each node's comment", () => {
    const d = def(SOURCE);
    d.nodes = [d.nodes[1], d.nodes[0]];
    const out = mergeFlowIntoText(SOURCE, d);
    expect(out.indexOf("id: b")).toBeLessThan(out.indexOf("id: a"));
    expect(out).toContain("  # First step\n  - id: a");
    expect(def(out)).toEqual(def(stringifyFlow(d)));
  });

  it("falls back to a full rewrite when the text does not parse", () => {
    const d = def(SOURCE);
    expect(mergeFlowIntoText("nodes: [", d)).toEqual(stringifyFlow(d));
  });
});
```

Run `npx vitest run src/features/flow/lib/__tests__/flow-yaml.test.ts` → FAIL.

- [ ] **Step 2: Implement.** In `flow-yaml.ts`, extract the `visit` callbacks of `stringifyFlow` into `function applyFlowStyle(node: Node): void` (same two rules: double-quote single-line scalars containing `${{`; flow style for `with` / `params` maps with ≤ `FLOW_MAP_MAX_ENTRIES` scalar entries and for `edges` items) and call it from `stringifyFlow` on `doc.contents`. Then:

```ts
/** Update `text` in place to represent `def`, keeping comments, key order and styles of what stays. */
export function mergeFlowIntoText(text: string, def: FlowDef): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return stringifyFlow(def);
  mergeMap(doc, doc.contents, canonicalTop(def));
  return doc.toString({ lineWidth: 0, indent: 2 });
}

function keyOf(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function created(doc: Document, value: unknown): Node {
  const node = doc.createNode(value) as Node;
  applyFlowStyle(node);
  return node;
}

function mergeMap(doc: Document, map: YAMLMap, obj: Rec): void {
  for (const pair of [...map.items]) {
    const k = keyOf(pair);
    if (!(k in obj) || obj[k] === undefined) map.delete(pair.key);
    else pair.value = mergeValue(doc, pair.value as Node | null, obj[k], k);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || map.has(k)) continue;
    const pair = doc.createPair(k, created(doc, v));
    if ((k === "with" || k === "params") && isMap(pair.value)) applyFlowStyle(pair.value as Node);
    map.items.push(pair as Pair);
  }
}

function mergeValue(doc: Document, existing: Node | null, value: unknown, key: string): Node {
  if (isPlainObject(value) && isMap(existing)) {
    mergeMap(doc, existing, value as Rec);
    return existing;
  }
  if (Array.isArray(value) && isSeq(existing)) {
    if (value.every((v) => isPlainObject(v) && typeof (v as Rec).id === "string")) {
      const byId = new Map<string, Node>();
      for (const item of existing.items) if (isMap(item)) byId.set(String(item.get("id")), item);
      existing.items = value.map((v) => {
        const prev = byId.get(String((v as Rec).id));
        return prev ? mergeValue(doc, prev, v, key) : created(doc, v);
      });
      return existing;
    }
    if (JSON.stringify(existing.toJSON()) === JSON.stringify(value)) return existing;
    const node = created(doc, value);
    if (key === "edges" && isSeq(node)) for (const item of node.items) if (isMap(item)) item.flow = true;
    return node;
  }
  if (isScalar(existing) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)) {
    if (existing.value === value) return existing;
    existing.value = value;
    if (typeof value === "string" && value.includes("${{") && !value.includes("\n")) existing.type = "QUOTE_DOUBLE";
    return existing;
  }
  return created(doc, value);
}

function isPlainObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

(Import `Node`, `Pair`, `YAMLMap` types from `yaml`. `map.delete(key)` / `map.has(key)` / `map.get("id")` are the `YAMLMap` API; `doc.createPair` exists on `Document`. The `edges` flow-style rule applies to new edge sequences; existing edge items keep their style. Keep `hasComments` exported if anything else uses it; otherwise delete it with the warning.)

`editor-store.ts` `applyEdit`: `const serialized = s.format === "json" || !s.format ? stringifyFlowAs(next, s.format ?? "yaml") : mergeFlowIntoText(s.text, next);` (keep the `eol` normalisation after it). Remove `commentWarningPending` from the state, `initial`, `loadInto` and the selector at line ~162, the component that renders it, and its i18n keys in both locales (`locale-parity` stays equal). `openNew` keeps `stringifyFlowAs`.

Run the Step 1 tests → PASS; `npx vitest run src/features/flow` and `npx tsc --noEmit` → green. If an existing editor-store test asserted the warning, delete that test (the behaviour is gone on purpose).

- [ ] **Step 3: Commit** `feat(flow-editor): write YAML edits in place, keeping comments and key order`.

---

### Task 7: video_gen — chapter-layout video metrics, chapter progress, `improve.flow.yaml`

Work in `C:\Users\mtmar\source\repos\video_gen` on branch `feat/improve-flow` (`git switch -c feat/improve-flow` from `feat/production-cycle-resume-dir`). Record the scoped suite's count first.

**Files:**
- Modify: `production_ledger.py` (`video_metrics_from_story_dir`), `video_gen_flow/video.py` (`chapters` progress), `tests/test_production_ledger.py`, `tests/test_video_gen_flow_video.py`, `tests/test_video_gen_flow_definitions.py`, `CLAUDE.md` (the `### mdium フロー（V6）` section → V6/V8)
- Create: `.mdium/flows/improve.flow.yaml`, `.mdium/flows/lib/improve-app/improve-propose.flow.yaml`, `.mdium/flows/lib/improve-app/improve-verify.flow.yaml`

**Interfaces:**
- Consumes: `video_metrics_from_story_dir(story_dir, video_subdir="video") -> dict` (keys `video_scene_count`, `video_anchored_scenes`, `video_duration_sec`, `video_rendered`, `video_coherence`, `video_weak_scene_count`, `video_weak_dimensions`, `video_quality_kept`, `video_quality_reverted`; `{}` when absent), the chapter layout `story/video/chapters/ch_NN/{composition.json, quality_report.json, <title>_chNN.mp4}` (video.py `chapter_dirs`, `_CH_DIR`), `Context.progress(text, fraction)` (thread-safe: the worker's `Emitter` locks), the test helpers `make_ctx`, `outputs`, `artifacts`, `FakeMain`, `_story` in `tests/test_video_gen_flow_video.py` and `_make_story`, `_write_video` in `tests/test_production_ledger.py`; the template files from Task 4 (copy them from the mdium checkout: `../mdium/resources/flow-templates/improve-app/flows/`).
- Produces: `production_ledger._video_metrics_from_dir(vdir) -> dict` (the old body, one directory), `production_ledger._merge_chapter_metrics(chapters: list[dict]) -> dict`; `video_gen_flow.video._chapter_progress(ctx, story_dir, title, wanted)` context manager and module constant `PROGRESS_INTERVAL_SEC = 5.0`.

- [ ] **Step 1: Failing ledger test** (`tests/test_production_ledger.py`; make `_write_video` take a keyword `subdir="video"` used instead of the literal `"video"` so a chapter directory can be written with `subdir="video/chapters/ch_01"`):

```python
def test_video_metrics_roll_up_the_chapter_layout(tmp_path):
    run = str(tmp_path / "A1_20261013_season_01")
    story = _make_story(run, 1, "Comedy")
    _write_video(story, subdir="video/chapters/ch_01", scenes=4, anchored=2, duration=40.0, coherence=8.0,
                 weak_scene_count=1, weak_dims={"style": 1}, kept=1, reverted=0)
    _write_video(story, subdir="video/chapters/ch_02", scenes=6, anchored=3, duration=60.0, coherence=6.0,
                 weak_scene_count=2, weak_dims={"style": 1, "continuity": 2}, kept=2, reverted=1)
    r = records_from_run_dir(run)[0]
    assert r.video_rendered is True
    assert r.video_scene_count == 10 and r.video_anchored_scenes == 5
    assert r.video_duration_sec == 100.0
    assert r.video_coherence == 7.0 and r.video_weak_scene_count == 3
    assert r.video_weak_dimensions == {"style": 2, "continuity": 2}
    assert r.video_quality_kept == 3 and r.video_quality_reverted == 1


def test_video_metrics_chapter_layout_without_reports(tmp_path):
    run = str(tmp_path / "A1_20261013_season_01")
    story = _make_story(run, 1, "Comedy")
    _write_video(story, subdir="video/chapters/ch_01", scenes=3, anchored=1, with_report=False)
    _write_video(story, subdir="video/chapters/ch_02", scenes=2, anchored=0, with_report=False, with_mp4=False)
    r = records_from_run_dir(run)[0]
    assert r.video_rendered is True and r.video_scene_count == 5
    assert r.video_coherence is None and r.video_weak_dimensions is None
```

Run `uv run pytest tests/test_production_ledger.py -q -p no:cacheprovider` → FAIL (`video_coherence` is `None`, counts `None`).

- [ ] **Step 2: Implement the rollup.** In `production_ledger.py` rename the current body to `_video_metrics_from_dir(vdir: str) -> Dict[str, object]` (unchanged logic, takes the directory that holds `composition.json`), and:

```python
_CHAPTER_DIR = re.compile(r"ch_\d+")


def _chapter_video_dirs(vdir: str) -> List[str]:
    """``<vdir>/chapters/ch_NN`` directories that hold a composition (the chapter layout)."""
    root = os.path.join(vdir, "chapters")
    if not os.path.isdir(root):
        return []
    try:
        names = sorted(n for n in os.listdir(root) if _CHAPTER_DIR.fullmatch(n))
    except OSError:
        return []
    return [os.path.join(root, n) for n in names if os.path.exists(os.path.join(root, n, "composition.json"))]


def _merge_chapter_metrics(chapters: List[Dict[str, object]]) -> Dict[str, object]:
    """One story's video metrics from its chapters: counts and durations add up,
    the coherence is the mean over the chapters that have one, weak dimensions
    add up per key. A quality key stays absent when no chapter has it."""
    def _sum(key):
        vals = [c[key] for c in chapters if c.get(key) is not None]
        return sum(vals) if vals else None
    out: Dict[str, object] = {
        "video_scene_count": sum(int(c.get("video_scene_count") or 0) for c in chapters),
        "video_anchored_scenes": sum(int(c.get("video_anchored_scenes") or 0) for c in chapters),
        "video_duration_sec": _sum("video_duration_sec"),
        "video_rendered": any(bool(c.get("video_rendered")) for c in chapters),
    }
    if out["video_duration_sec"] is not None:
        out["video_duration_sec"] = round(float(out["video_duration_sec"]), 2)
    coherences = [float(c["video_coherence"]) for c in chapters if c.get("video_coherence") is not None]
    if coherences:
        out["video_coherence"] = round(sum(coherences) / len(coherences), 3)
    for key in ("video_weak_scene_count", "video_quality_kept", "video_quality_reverted"):
        total = _sum(key)
        if total is not None:
            out[key] = total
    dims: Dict[str, int] = {}
    seen = False
    for c in chapters:
        if c.get("video_weak_dimensions") is not None:
            seen = True
            for k, v in (c["video_weak_dimensions"] or {}).items():
                dims[k] = dims.get(k, 0) + int(v or 0)
    if seen:
        out["video_weak_dimensions"] = dims
    return out


def video_metrics_from_story_dir(story_dir: str, video_subdir: str = "video") -> Dict[str, object]:
    """Roll up a story's video metrics from ``video/`` (one composition, the
    single-video layout) or from ``video/chapters/ch_NN/`` (one composition per
    chapter, the production layout). ``{}`` when there is no video."""
    vdir = os.path.join(story_dir, video_subdir)
    if not os.path.isdir(vdir):
        return {}
    if os.path.exists(os.path.join(vdir, "composition.json")):
        return _video_metrics_from_dir(vdir)
    chapters = [m for m in (_video_metrics_from_dir(d) for d in _chapter_video_dirs(vdir)) if m]
    return _merge_chapter_metrics(chapters) if chapters else {}
```

(Keep the original docstring's intent on `_video_metrics_from_dir`; `import re` and `List` if missing.) Run the ledger tests → PASS (all of `tests/test_production_ledger.py`).

- [ ] **Step 3: Failing progress test** (`tests/test_video_gen_flow_video.py`):

```python
def test_chapters_reports_progress_while_the_chapters_render(tmp_path, monkeypatch):
    story = _story(tmp_path)
    monkeypatch.setattr(vg, "PROGRESS_INTERVAL_SEC", 0.02)

    class SlowMain(FakeMain):
        def __call__(self, argv):
            _write_chapter(story, 1, 8.0)          # the first chapter lands...
            time.sleep(0.15)                       # ...and the watcher sees it before the second
            return super().__call__(argv)

    fake = SlowMain(story, [([(1, 8.0), (2, 6.0)], 0)])
    monkeypatch.setattr(vg, "chapters_main", fake)
    ctx, events = make_ctx(tmp_path)
    vg.chapters(ctx, storyDir=str(story), chapters="1-2", force=True)
    progress = [e for e in events if e["type"] == "progress" and e.get("fraction") is not None]
    assert any(e["fraction"] == 0.5 and e["text"] == "chapter 1/2" for e in progress), progress
    assert progress[-1]["fraction"] == 1.0
```

(`_write_chapter` is whatever `FakeMain` uses to create `video/chapters/ch_NN` with an mp4 and a quality report — read `FakeMain` and reuse or extract that helper; `import time`.) Run → FAIL.

- [ ] **Step 4: Implement the watcher** in `video_gen_flow/video.py`:

```python
PROGRESS_INTERVAL_SEC = 5.0


@contextlib.contextmanager
def _chapter_progress(ctx: Context, story_dir: str, title: str, wanted: set[int] | None):
    """Reports ``chapter <done>/<total>`` while video_chapters runs: a chapter is done
    once its mp4 exists; the total is the wanted chapters, else the chapter dirs seen
    so far. Runs on a thread (the worker's emitter is locked), polling the directory."""
    stop = threading.Event()

    def snapshot() -> tuple[int, int]:
        dirs = [d for d in chapter_dirs(story_dir) if wanted is None or _number(d) in wanted]
        done = sum(1 for d in dirs if _chapter_mp4(d, title).exists())
        total = len(wanted) if wanted else len(dirs)
        return done, total

    def run() -> None:
        last: tuple[int, int] | None = None
        while not stop.wait(PROGRESS_INTERVAL_SEC):
            done, total = snapshot()
            if total and (done, total) != last:
                last = (done, total)
                ctx.progress(f"chapter {done}/{total}", fraction=done / total)

    thread = threading.Thread(target=run, name="chapter-progress", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(PROGRESS_INTERVAL_SEC + 1)
        done, total = snapshot()
        if total:
            ctx.progress(f"chapter {done}/{total}", fraction=done / total)
```

In `chapters()`, replace `ctx.progress("video_chapters", fraction=0.0)` + the two `_run_chapters_main(...)` calls with the same calls wrapped: `with _chapter_progress(ctx, storyDir, title, wanted): rc = _run_chapters_main(...)` (compute `wanted = _wanted(chapters)` before the first call; the retry call is wrapped the same way). Keep the initial `ctx.progress("video_chapters", fraction=0.0)`. `import threading`. Run the test and the whole video test file → PASS.

- [ ] **Step 5: The improve flow.** Copy `../mdium/resources/flow-templates/improve-app/flows/improve-app.flow.yaml` to `.mdium/flows/improve.flow.yaml` and change only its `id:` line to `id: improve` and its `name:` to `Improve video_gen`. Copy the two parts to `.mdium/flows/lib/improve-app/` byte-identical, then edit the copied `improve-verify.flow.yaml`'s `verify` node:

```yaml
  - id: verify
    kind: subflow
    flow: project:main
    projectRoot: "${{ params.worktreePath }}"
    # Reduced scale: one story, its first chapter, no human video review.
    params: { maxStories: 1, chapters: "1", review: false, title: verify }
    timeout: 24h
```

(`outputRoot` stays the default `output`, which is relative to the worktree, so the verification generates into the worktree and never touches the production `output/`.) `tests/test_video_gen_flow_definitions.py`: in `test_part_references_resolve_and_params_are_declared` skip references that start with `mdium:` or `project:` (they are not files), and add:

```python
def test_improve_flow_verifies_at_a_reduced_scale():
    verify = next(n for n in _flow(Path(".mdium/flows/lib/improve-app/improve-verify.flow.yaml"))["nodes"] if n["id"] == "verify")
    assert verify["flow"] == "project:main" and verify["projectRoot"] == "${{ params.worktreePath }}"
    assert verify["params"] == {"maxStories": 1, "chapters": "1", "review": False, "title": "verify"}
    main = _flow(Path(".mdium/flows/production-cycle.flow.yaml"))
    assert set(verify["params"]) <= set(main["params"]), "the narrowed params exist on the main flow"
    improve = _flow(Path(".mdium/flows/improve.flow.yaml"))
    assert improve["id"] == "improve"
    assert [n["id"] for n in improve["nodes"]] == ["propose", "proceed", "develop", "verify", "adopt_gate", "merge", "discard"]
```

Also check that `test_approval_ports_without_edges_are_intentional` (line ~75) lists `approve_proposal`'s `approve` / `stop` and `proceed`'s `stopped` as intentional, in whatever form that test expects. Run the definitions tests → PASS.

- [ ] **Step 6: CLAUDE.md.** Rename the section to `### mdium フロー（V6 / V8）` and add after the usage list:

```markdown
改善ループ（V8）: `Improve video_gen`（`improve.flow.yaml`、部品は `lib/improve-app/`）を実行する。
`goal` に改善したいこと（例:「レビュー動画で指摘された台詞の間延びを減らす」「継続性ゲートの誤検出を減らす」）、
`provider`（既定 `claude`）、`requiresApproval`（開発ワークフローの計画承認。既定 true）。
流れ: `Production cycle` の最新の完了実行を基準に `builtin:improve-analyze` が提案 → 承認（approve / revise / stop）
→ `mdium:dev-workflow` が worktree に実装（マージしない）→ worktree で `project.yaml` の setup と
`Production cycle` を縮小（1 話・第 1 章・レビューなし。`lib/improve-app/improve-verify.flow.yaml` の `verify.params`）
→ `metrics-compare` が `project.yaml` の `metrics`（avgVideoCoherence / coverage / costUsd）で比較
→ `adopt_gate` で merge / discard。merge 後は次の周回が新しい基準から始まる（後退エッジ、最大 3 周）。
worktree は `%LOCALAPPDATA%\mdium\worktrees\` 配下。検証の出力は worktree の `output/` に入り、制作の `output/` には触れない。
```

Update the "移行していないもの" line (drop `improve.flow.yaml（後続の V8）`) and the stage list's `portfolio.record` line: `章別レイアウト（video/chapters/ch_NN/）の動画指標も台帳に集計する（章の平均 coherence、シーン数の合計）`. Add to the stage list for `video.chapters`: `進捗は mp4 の揃った章数（chapter n/N）`.

- [ ] **Step 7: Run the scoped suite and commit.** `uv run pytest tests/test_video_gen_flow_*.py tests/test_production_ledger.py tests/test_video_revise.py -q -p no:cacheprovider` → green, count ≥ baseline + 5. Commit in three commits on `feat/improve-flow`: `fix(ledger): roll chapter-layout videos up into the video metrics`, `feat(flow): chapter progress for video.chapters`, `feat(flow): improve flow from the improve-app template`. Stage files by name (`git add production_ledger.py tests/test_production_ledger.py` …); `git status` must still show the user's files untouched and unstaged.

---

### Task 8: Spec memo and plan bookkeeping

**Files:**
- Modify: `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` (12 章 V8 row; 8 章 bullets; 7.3 bullet)

- [ ] **Step 1: Record the implementation in the spec.** In the 12 章 table, replace the V8 row's first cell with `V8（V8 実装 <date>。本文からの差分: …）` listing R1–R8 from this plan's "Rulings taken while planning" in the same style as the V7 row (one sentence each), plus anything the executor ruled during implementation. Add under 8.2 a bullet `- V8 実装メモ: テンプレートの実体は 16.5 の分割形（\`flows/improve-app.flow.yaml\` + \`lib/improve-app/improve-propose.flow.yaml\` / \`improve-verify.flow.yaml\`）。主フローは \`project:main\`（project.yaml の \`flows.main\`）で参照し、提案は analyze の応答本文（read-only のため ファイルは書かない）。\`maxIterations\` は持たない（後退エッジの \`maxTraversals\` が正）。` and under 8.4 `- V8 実装メモ: 入力は \`goal\` / \`metrics\`（\`project.metrics\`）/ \`baseline\`（flow-run-latest の出力）/ \`revision\` / \`previousProposal\` / \`previousReport\`。ログと成果物はエージェントが \`baseline.runDir\` を自分で読む。`. Under 7.3 add `- V8 実装メモ: フロー参照 \`project:main\`（subflow.flow・ループ本体・flow-run-latest）と テンプレート参照 \`project.metrics\` を追加。`

- [ ] **Step 2: Commit** `docs(spec): record the V8 implementation`.

---

### Task 9: Desktop smoke — one real iteration on video_gen (human)

**Files:** none (manual). Needs: mdium started with `npm run tauri dev` from the branch, the video_gen checkout on `feat/improve-flow` with its setup done (`.venv` with `mdium-worker`), at least one **completed** `Production cycle` run in video_gen's `.mdium/flow-runs/` (the V6 smoke run qualifies if it completed; otherwise run `Production cycle` with `maxStories: 1`, `chapters: "1"`, `review: false` first), a logged-in `claude` CLI, `GOOGLE_API_KEY` and `ELEVENLABS_API_KEY` exported before `tauri dev`, a clean video_gen working tree on the branch the merge should land on (commit or set aside the uncommitted files first — `git-merge-local` refuses a dirty checkout).

- [ ] **Step 1:** Open video_gen in mdium → Flows: `Improve video_gen` is listed as an entry; `lib/improve-app/*` as parts. Open it: no validation errors; the `verify` node of the verify part shows `flow: project:main` with the hint.
- [ ] **Step 2:** Run it with `goal: レビュー動画で指摘された台詞の間延びを減らす` (or a goal of your choice), `provider: claude`, `requiresApproval: true`. Expected: `propose/baseline` succeeds within seconds and its outputs show the latest completed `Production cycle` run (`runId`, `outputs.avgVideoCoherence`, `costUsd`); `propose/analyze` runs read-only (the "プロンプト" shows `## Inputs` with `goal`, `metrics` as a JSON array of three entries, `baseline`, empty `revision` / `previousProposal` / `previousReport`); `approve_proposal` pauses showing the proposal body. Choose `revise` with a comment once → `analyze@2`'s prompt carries the comment; then `approve`.
- [ ] **Step 3:** `develop` runs the dev-workflow (screen, worktree, design, plan, `approve_plan` → approve, implement full-access, review) and completes without a merge gate; its outputs show `worktree` (object), `worktreePath`, `branch`.
- [ ] **Step 4:** `verify/setup` runs `uv sync` and the `mdium-worker` install in the worktree (progress `setup 1/2`, `2/2`; if the agent changed `project.yaml` it asks first); `verify/verify` runs `Production cycle` inside the worktree: `approve_order` pauses (approve), one story is generated, `ch_01` is produced (`force_gate` may pause — choose `force`), no review loop, `record` completes; the run tree shows the worktree path as the scope's project root; `verify/compare` produces `report.md` with three rows (avgVideoCoherence / coverage / costUsd) and `improved`.
- [ ] **Step 5:** `adopt_gate` shows the report, `improved` and the branch. Choose `discard` (or `merge` if the change is good): the worktree is removed (`git worktree list` in video_gen) or the branch is merged into the current branch; the back-edge starts `propose@2`, whose analysis prompt contains the previous proposal and the report; choose `stop` → the run completes.
- [ ] **Step 6:** Record the results and anything that differed in the spec row V8 memo (Task 8) and in the project memory. Note the total cost shown for the run.

---

## Self-review notes (kept for the executor)

- Spec coverage: 8.1 placement → Task 4 (copy-only template) + Task 7 (video_gen copy); 8.2 flow → Task 4 (split form per 16.5), `nodes.<id>.costUsd` already in V7; the `revise` comment into the next analysis → `improve-propose` `with.revision`; `stop` with no edge → `proceed` branch; 8.3 → V7 `metrics-compare` (unchanged); 8.4 → Task 3 (inputs per R2/R3); 9.4 → Task 7 Step 5; 16.5 split → Task 4 file layout; 12 row V8 → Task 8; 13 "V8 one real iteration" → Task 9; 7.3 `project:main` addition → Task 2 (R1). Carry-overs (memory): driver split → Task 1; ledger `video_*` → Task 7 Steps 1–2; `video.chapters` progress → Task 7 Steps 3–4; editor YAML reformatting → Task 6.
- Type consistency: `nodes.propose.outputs.{proposal, choice, baselineOutputs, baselineCostUsd}` are declared in `improve-propose` `outputs` and consumed by the entry (`develop.params.requirement`, `proceed`, `verify.params`); `improve-verify` params `{worktreePath, baselineOutputs: object, baselineCostUsd: number}` match the entry's `verify.params`; `nodes.verify.outputs.{report, improved}` are declared in `improve-verify` `outputs` and shown by `adopt_gate` / passed as `previousReport`; `nodes.develop.outputs.worktree` is the Task 2 output and the `WorktreeInfo` shape `worktree_of` deserializes; `project:main` is `load::PROJECT_MAIN_REF` everywhere; `project.metrics` is `Reference::ProjectMetrics` → `TemplateContext.metrics`.
- Review Focus items 1–5 each name their test: Task 2 `project_main_reference_needs_a_manifest_with_a_main_flow`, Task 2 `flow_run_latest_accepts_the_project_main_reference`, Task 4 `improve_app_runs_one_iteration_and_tries_again_after_a_discard`, Task 4 `improve_app_offers_the_gate_when_the_verification_fails`, Task 6 `merge keeps comments and key order and drops removed nodes`.
- Not in V8 by design: a `branch` on `nodes.compare.outputs.improved` (8.3: the human reads the report), usage-based agent cost, the `verify` sub-flow's own approvals being auto-approved, worktree cleanup after `merge` (the merge action leaves the worktree; the user prunes), `mdium:improve-app` as a `subflow` reference (R1).
