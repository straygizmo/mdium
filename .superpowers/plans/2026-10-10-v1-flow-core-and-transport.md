# V1: flow-core Crate Split and Frontend Transport Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the generic flow engine out of the Tauri crate into a Tauri-free `flow-core` crate behind a `FlowService` facade, and route every frontend flow call through a swappable `FlowTransport`, with no change in behavior.

**Architecture:** `src-tauri/` becomes a cargo workspace whose root package `mdium` depends on a new member crate `crates/flow-core` (the whole former `src/flow/` tree plus the few helpers it borrowed from `workflow/`). `flow_core::service::FlowService` exposes every former Tauri command as a plain method (and a JSON dispatch `call(name, args)` the future HTTP server reuses); the Tauri command modules become one-line wrappers. On the frontend, `src/features/flow/lib/transport.ts` defines `FlowTransport { call, subscribe }`; the only file that imports `@tauri-apps/*` inside `src/features/flow/` is `lib/tauri-transport.ts`, and a test enforces that.

**Tech Stack:** Rust 2021 (cargo workspace, serde, serde_json, serde_yaml_ng, sha2, rand, chrono, windows-sys on Windows; tempfile for tests), Tauri 2, TypeScript 5.9, Vite 7, Vitest 4, React 19.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` (chapter 10 "flow-core クレートとトランスポート層", chapter 12 row V1). Base spec: `.superpowers/specs/2026-10-06-generic-flow-engine-design.md`.

## Global Constraints

- Behavior must not change: every existing `cargo test` and `npm test` keeps passing (spec 12, V1 "挙動変更なし").
- `flow-core` must not depend on `tauri` or any `tauri-plugin-*` crate (spec 10.1).
- Files under `src/features/flow/` must not import `@tauri-apps/*` except `src/features/flow/lib/tauri-transport.ts` (spec 10.2).
- Tauri command names, argument names (camelCase) and payload shapes stay exactly as today; the service's `call(name, args)` uses the same names and JSON argument objects (spec 10.2 "コマンド名と引数は Tauri とサーバで同じ").
- Code comments in English; no hardcoded UI strings (project CLAUDE.md). V1 adds no UI text.
- Storage paths (`.mdium/flows/`, `.mdium/flow-runs/`), event names (`flow://…`) and the confirmation file `%LOCALAPPDATA%/mdium/flow-command-confirmations.json` are unchanged (base spec 7.4, 7.2).
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **`call()` with a wrong argument shape** (missing `projectRoot`, `attempt` given as a string): the service must answer with a `FlowCommandError` whose code is `FLOW_BAD_ARGS`, never panic. Pinned in Task 6.
2. **`call()` with an unknown command name**: `FLOW_UNKNOWN_COMMAND`, not a silent `null`. Pinned in Task 6.
3. **A transport replaced at runtime while a subscription is active**: the unsubscribe function returned earlier must still detach the original listener (no leak, no call into the new transport). Pinned in Task 7.
4. **Tauri `listen` payload unwrapping**: handlers must receive `event.payload`, not the event envelope, exactly as today. Pinned in Task 7.
5. **Detached supervisor re-entry after the move**: `mdium.exe --flow-supervise <spec>` must still route into `flow_core::run::supervise::supervise_from_args` (the plan moves the module; a wrong path compiles only if someone re-points it). Pinned in Task 3 by keeping the existing supervise tests green and by a `main.rs` smoke check.

---

## File Structure

**Created**
- `src-tauri/crates/flow-core/Cargo.toml` — the new crate (package `flow-core`, lib `flow_core`).
- `src-tauri/crates/flow-core/src/lib.rs` — module list: `condition, issues, load, model, parse, run, template, validate, fsutil, provider, service`.
- `src-tauri/crates/flow-core/src/fsutil.rs` — `atomic_write`, `new_id`, `now`, `project_key`, `normalize_root` (moved from `workflow/fsutil.rs` and `workflow/state.rs`).
- `src-tauri/crates/flow-core/src/provider.rs` — the `Provider` enum (moved from `workflow/model.rs`).
- `src-tauri/crates/flow-core/src/service.rs` — `FlowService`, `FlowCommandError`, `FlowLoadResult`, `GitignoreStatus`, `COMMAND_NAMES`, `call()`.
- `src/features/flow/lib/transport.ts` — `FlowTransport` interface and registry.
- `src/features/flow/lib/tauri-transport.ts` — the Tauri implementation.
- `src/features/flow/lib/__tests__/transport.test.ts`, `src/features/flow/lib/__tests__/no-tauri-imports.test.ts`.

**Moved** (git mv, then path rewrites)
- `src-tauri/src/flow/**` → `src-tauri/crates/flow-core/src/**` (dropping the `flow/` level).

**Modified**
- `src-tauri/Cargo.toml` — `[workspace]`, dependency on `flow-core`, drop `windows-sys`.
- `src-tauri/src/lib.rs` — remove `mod flow;`, use `flow_core::…`, manage `FlowServiceState`.
- `src-tauri/src/commands/flow.rs`, `src-tauri/src/commands/flow_run.rs` — thin wrappers over `FlowService`.
- `src-tauri/src/workflow/fsutil.rs`, `workflow/state.rs`, `workflow/model.rs` — re-export the moved items.
- `src/features/flow/lib/flow-api.ts`, `flow-run-api.ts` — use the transport.

---

### Task 1: Cargo workspace with an empty `flow-core` crate

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/crates/flow-core/Cargo.toml`, `src-tauri/crates/flow-core/src/lib.rs`

**Interfaces:**
- Produces: crate `flow_core` (empty), workspace member `crates/flow-core`.

- [ ] **Step 1: Add the workspace section and the dependency**

At the top of `src-tauri/Cargo.toml`, before `[package]`, add:

```toml
[workspace]
members = ["crates/flow-core"]
```

Under `[dependencies]` add:

```toml
flow-core = { path = "crates/flow-core" }
```

- [ ] **Step 2: Create the crate manifest**

`src-tauri/crates/flow-core/Cargo.toml`:

```toml
[package]
name = "flow-core"
version = "0.1.0"
edition = "2021"
description = "Generic flow engine of MDium: definitions, validation, runs. No Tauri dependency."

[lib]
name = "flow_core"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml_ng = "0.10"
sha2 = "0.10"
rand = "0.8"
chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }

# Process creation times for reconnecting to detached flow commands.
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_System_Threading"] }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Create the crate root with a smoke test**

`src-tauri/crates/flow-core/src/lib.rs`:

```rust
//! Generic flow engine of MDium (spec 2026-10-06 and 2026-10-10 chapter 10).
//! This crate has no Tauri dependency; the desktop app and the flow server
//! both build on it.

#[cfg(test)]
mod tests {
    #[test]
    fn crate_builds() {
        assert_eq!(2 + 2, 4);
    }
}
```

- [ ] **Step 4: Build and test both packages**

Run (from `src-tauri/`): `cargo test -p flow-core` → Expected: `1 passed`.
Run: `cargo build` → Expected: success (the `mdium` package still builds with the unused dependency).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/crates/flow-core
git commit -m "chore(flow): add the flow-core workspace crate (empty)"
```

---

### Task 2: Move the shared helpers (`fsutil`, `project_key`, `Provider`) into `flow-core`

**Files:**
- Create: `src-tauri/crates/flow-core/src/fsutil.rs`, `src-tauri/crates/flow-core/src/provider.rs`
- Modify: `src-tauri/crates/flow-core/src/lib.rs`, `src-tauri/src/workflow/fsutil.rs`, `src-tauri/src/workflow/state.rs`, `src-tauri/src/workflow/model.rs`

**Interfaces:**
- Produces: `flow_core::fsutil::{atomic_write, new_id, now, project_key, normalize_root}` with the same signatures as the `workflow` originals (`atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()>`, `new_id() -> String`, `now() -> String`, `project_key(project_root: &Path) -> PathBuf`, `normalize_root(project_root: &Path) -> PathBuf`); `flow_core::provider::Provider` (enum `Codex | Copilot | Opencode | Claude`, serde lowercase).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests in `flow-core`**

Create `src-tauri/crates/flow-core/src/fsutil.rs` with only the test module for now:

```rust
//! File helpers shared by the engine: atomic writes, ids, timestamps and
//! the project identity key. Moved here from the workflow module so the
//! engine has no dependency on it (spec 2026-10-10, 10.1).

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn atomic_write_replaces_content_and_creates_parents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/file.json");
        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn new_id_is_sixteen_lowercase_hex_chars() {
        let id = new_id();
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        assert_ne!(new_id(), id);
    }

    #[test]
    fn now_is_rfc3339_with_millis_and_zulu_suffix() {
        let ts = now();
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(ts.len(), "2026-09-25T12:34:56.789Z".len(), "{ts}");
    }

    #[test]
    fn normalize_root_drops_trailing_separator() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize_root(dir.path());
        assert_eq!(normalize_root(&dir.path().join("")), root);
        assert!(!root.to_string_lossy().ends_with(std::path::MAIN_SEPARATOR));
    }

    #[test]
    fn project_key_is_case_insensitive_on_windows_only() {
        let dir = tempfile::tempdir().unwrap();
        let key = project_key(dir.path());
        let upper = PathBuf::from(dir.path().to_string_lossy().to_uppercase());
        if cfg!(windows) {
            assert_eq!(project_key(&upper), key);
        } else {
            assert_ne!(project_key(&upper), key);
        }
    }
}
```

Create `src-tauri/crates/flow-core/src/provider.rs`:

```rust
//! Which coding agent runs an agent node. Serializes as lowercase.
//! Shared with the workflow module of the desktop app.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Copilot,
    Opencode,
    Claude,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Provider::Opencode).unwrap(), "\"opencode\"");
        assert_eq!(serde_json::from_str::<Provider>("\"claude\"").unwrap(), Provider::Claude);
    }
}
```

In `lib.rs` add `pub mod fsutil;` and `pub mod provider;`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p flow-core` → Expected: compile error, `atomic_write`, `new_id`, `now`, `normalize_root`, `project_key` not found.

- [ ] **Step 3: Move the implementations**

Move these items from `src-tauri/src/workflow/fsutil.rs` into `flow-core/src/fsutil.rs` above the test module, unchanged: the `use rand::Rng; use std::io; use std::path::{Path, PathBuf};` imports, `atomic_write`, `atomic_write_impl`, `enum PlaceOutcome` (and anything between lines 26–175 that these need: `place_via_rename`, `is_retryable_rename_error`, `random_hex`), `new_id`, `now`. Also move the existing tests of `workflow/fsutil.rs` that call `atomic_write_impl`, `place_via_rename` directly (`place_via_rename_restores_original_when_retry_also_fails`, `place_via_rename_preserves_both_copies_when_restore_also_fails`, `atomic_write_impl_restores_original_and_cleans_up_temp_when_retry_fails`, `atomic_write_impl_never_deletes_both_copies_when_target_cannot_be_restored`, `concurrent_writers_never_produce_a_partial_file`) into the `flow-core` test module, since private functions are not reachable from the other crate.

Move from `src-tauri/src/workflow/state.rs` into `flow-core/src/fsutil.rs`: `normalize_root`, both `strip_verbatim` variants (keep the `#[cfg(windows)]` / `#[cfg(not(windows))]` attributes), `project_key`, and the tests `normalize_root_drops_trailing_separator_and_keeps_case` and `normalize_root_strips_the_verbatim_prefix`. Make the three functions `pub` (they were `pub(crate)` / private).

Then in `src-tauri/src/workflow/fsutil.rs` replace the moved functions with re-exports, keeping the rest of the file (`InvalidId`, `is_valid_id`, `validate_id`, `MdiumPaths`, their tests):

```rust
pub use flow_core::fsutil::{atomic_write, new_id, now};
```

In `src-tauri/src/workflow/state.rs` replace the moved functions with:

```rust
pub(crate) use flow_core::fsutil::{normalize_root, project_key};
```

In `src-tauri/src/workflow/model.rs` replace the `Provider` enum definition (and its doc comment) with:

```rust
pub use flow_core::provider::Provider;
```

- [ ] **Step 4: Run all tests**

Run: `cargo test -p flow-core` → Expected: all pass (the 5 new tests plus the moved ones).
Run: `cargo test` (workspace) → Expected: all pass; the `mdium` package compiles with the re-exports.
Run: `cargo build` → Expected: no warnings about unused imports in `workflow/fsutil.rs` (`rand::Rng` is now unused there if nothing else in the file uses it; remove the import if the compiler warns).

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/crates/flow-core src-tauri/src/workflow
git commit -m "refactor(flow): move fsutil helpers, project_key and Provider into flow-core"
```

---

### Task 3: Move `src/flow/**` into `flow-core`

**Files:**
- Move: `src-tauri/src/flow/*.rs` → `src-tauri/crates/flow-core/src/*.rs`; `src-tauri/src/flow/run/*.rs` → `src-tauri/crates/flow-core/src/run/*.rs`
- Modify: `src-tauri/crates/flow-core/src/lib.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/flow.rs`, `src-tauri/src/commands/flow_run.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `flow_core::{condition, issues, load, model, parse, run, template, validate}` with the same items as `crate::flow::*` had. `flow_core::run::supervise::supervise_from_args(&[String]) -> Option<i32>` and `DetachedLauncher::for_current_exe()` unchanged.

- [ ] **Step 1: Move the files**

From `src-tauri/`:

```bash
git mv src/flow/condition.rs crates/flow-core/src/condition.rs
git mv src/flow/issues.rs    crates/flow-core/src/issues.rs
git mv src/flow/load.rs      crates/flow-core/src/load.rs
git mv src/flow/model.rs     crates/flow-core/src/model.rs
git mv src/flow/parse.rs     crates/flow-core/src/parse.rs
git mv src/flow/template.rs  crates/flow-core/src/template.rs
git mv src/flow/validate.rs  crates/flow-core/src/validate.rs
git mv src/flow/tests.rs     crates/flow-core/src/tests.rs
git mv src/flow/run          crates/flow-core/src/run
git rm src/flow/mod.rs
```

- [ ] **Step 2: Rewrite the crate-internal paths**

From `src-tauri/crates/flow-core/src/`:

```bash
# `crate::flow::x` -> `crate::x`
grep -rl 'crate::flow::' . | xargs sed -i 's/crate::flow::/crate::/g'
# helpers that moved in Task 2
grep -rl 'crate::workflow::fsutil' . | xargs sed -i 's/crate::workflow::fsutil/crate::fsutil/g'
grep -rl 'crate::workflow::state::project_key' . | xargs sed -i 's/crate::workflow::state::project_key/crate::fsutil::project_key/g'
grep -rl 'crate::workflow::model::Provider' . | xargs sed -i 's/crate::workflow::model::Provider/crate::provider::Provider/g'
grep -rn 'crate::workflow' . && echo "STILL REFERENCES workflow" || echo "clean"
```

Expected: `clean`.

Replace the contents of `lib.rs` with:

```rust
//! Generic flow engine of MDium (spec 2026-10-06 and 2026-10-10 chapter 10).
//! This crate has no Tauri dependency; the desktop app and the flow server
//! both build on it.

pub mod condition;
pub mod fsutil;
pub mod issues;
pub mod load;
pub mod model;
pub mod parse;
pub mod provider;
pub mod run;
pub mod template;
pub mod validate;

#[cfg(test)]
mod tests;
```

(The former `flow/mod.rs` declared the same modules plus `mod tests;`; `run/mod.rs` keeps its own list including `mod test_helper;` and `mod tests;`.)

- [ ] **Step 3: Fix the two location-dependent constants**

In `crates/flow-core/src/tests.rs`, the fixture root pointed at the Tauri manifest dir; the fixtures stay where they are (`src-tauri/tests/fixtures/flows/`, also read by the frontend test `doc-digest.ts`):

```rust
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/flows")
}
```

In `crates/flow-core/src/run/test_helper.rs`, the test binary re-runs itself by test name; the module path lost its `flow::` prefix:

```rust
const TEST_NAME: &str = "run::test_helper::flow_test_helper_entry";
```

- [ ] **Step 4: Point the Tauri crate at `flow_core`**

In `src-tauri/src/lib.rs`: delete the line `mod flow;` and change

```rust
pub fn flow_supervise(args: &[String]) -> Option<i32> {
    flow_core::run::supervise::supervise_from_args(args)
}
```

In `src-tauri/src/commands/flow.rs` and `src-tauri/src/commands/flow_run.rs`:

```bash
sed -i 's/crate::flow::/flow_core::/g' src/commands/flow.rs src/commands/flow_run.rs
```

In `src-tauri/Cargo.toml` delete the `[target.'cfg(windows)'.dependencies]` block with `windows-sys` (only `supervise.rs` used it; it now lives in `flow-core`). Also delete `serde_yaml_ng = "0.10"` and `sha2 = "0.10"` from `mdium` **only if** `grep -rn 'serde_yaml_ng\|sha2' src-tauri/src` shows no remaining users; otherwise keep them.

- [ ] **Step 5: Build and run every test**

Run: `cargo test -p flow-core` → Expected: all former `flow::` tests pass, including `run::tests` (which spawn the test binary through `test_helper`) and `run::supervise` tests.
Run: `cargo test -p mdium` → Expected: pass.
Run: `cargo build` → Expected: no `unused` warnings introduced.
Smoke (Review Focus 5): `cargo run -p mdium -- --flow-supervise nonexistent.json; echo $?` → Expected: the process exits with a non-zero code immediately without opening a window (the supervisor path is still wired; the exact code is whatever `supervise_from_args` returns for a missing spec today).

- [ ] **Step 6: Commit**

```bash
git add -A src-tauri
git commit -m "refactor(flow): move the flow engine into the flow-core crate"
```

---

### Task 4: `FlowService` for definitions (list / load / validate)

**Files:**
- Create: `src-tauri/crates/flow-core/src/service.rs`
- Modify: `src-tauri/crates/flow-core/src/lib.rs`, `src-tauri/src/commands/flow.rs`

**Interfaces:**
- Produces:
  - `flow_core::service::FlowCommandError { code: String, message: String, details: Vec<Reason> }` with `FlowCommandError::new(code: &str, detail: impl Display) -> Self` (public) and `From<EngineError>`.
  - `flow_core::service::FlowLoadResult { path: String, format: FlowFormat, #[serde(flatten)] report: FlowReport }`.
  - `flow_core::service::FlowService::new(engine: Arc<FlowEngine>) -> FlowService`, `engine(&self) -> &Arc<FlowEngine>`, `list_flows(&self, project_root: &str) -> Result<Vec<FlowSummary>, FlowCommandError>`, `load_flow(&self, project_root: &str, path: &str) -> Result<FlowLoadResult, FlowCommandError>`, `validate_flow(&self, project_root: &str, path: &str, content: &str) -> Result<FlowLoadResult, FlowCommandError>`.
  - `flow_core::service::project_root(project_root: &str) -> Result<PathBuf, FlowCommandError>` (public; used by the Tauri wrappers).
  - Error code constants moved here: `FLOW_PROJECT_INVALID`, `FLOW_FILE_PATH_INVALID`, `FLOW_FILE_NOT_FOUND`, `FLOW_LIST_FAILED`, `FLOW_COMMAND_FAILED`.
- Consumes: `flow_core::load::{list_flows, check_file, check_content, resolve_flow_path, relative_display, PathProblem, FlowSummary, FlowReport}`, `flow_core::parse::FlowFormat`, `flow_core::run::engine::{FlowEngine, EngineError}`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/crates/flow-core/src/service.rs` with the test module (the implementation follows in Step 3):

```rust
//! The service facade of the flow engine: every operation the desktop app
//! exposes as a Tauri command and the flow server exposes over HTTP, as
//! plain methods on one object (spec 2026-10-10, 10.1 "FlowService").

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::driver::{ApprovalNotifier, DriverEnv, EventSink};
    use crate::run::engine::FlowEngine;
    use crate::run::model::{ApprovalRequest, NodeState, Progress, RunState};
    use crate::run::process::AttachedLauncher;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    /// A sink that drops every event (service tests never run a flow).
    struct NoopSink;
    impl EventSink for NoopSink {
        fn run_changed(&self, _: &Path, _: &str, _: &RunState) {}
        fn node_changed(&self, _: &Path, _: &str, _: &str, _: &NodeState, _: u64) {}
        fn progress(&self, _: &Path, _: &str, _: &str, _: &Progress) {}
    }
    struct NoopNotifier;
    impl ApprovalNotifier for NoopNotifier {
        fn approval_requested(&self, _: &Path, _: &str, _: &ApprovalRequest) {}
    }

    pub(super) fn service(dir: &Path) -> FlowService {
        let env = DriverEnv {
            launcher: Arc::new(AttachedLauncher),
            detached: None,
            sink: Arc::new(NoopSink),
            notifiers: Arc::new(vec![Arc::new(NoopNotifier) as Arc<dyn ApprovalNotifier>]),
            process_env: Arc::new(Default::default()),
            poll: Duration::from_millis(10),
        };
        FlowService::new(Arc::new(FlowEngine::new(env, dir.join("confirmations.json"))))
    }

    const OK: &str =
        "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: command, run: [x] }\n";

    #[test]
    fn project_root_must_be_an_existing_absolute_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        assert_eq!(svc.list_flows("").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(svc.list_flows("relative/dir").unwrap_err().code, FLOW_PROJECT_INVALID);
        let missing = tmp.path().join("missing");
        assert_eq!(
            svc.list_flows(missing.to_str().unwrap()).unwrap_err().code,
            FLOW_PROJECT_INVALID
        );
    }

    #[test]
    fn load_and_validate_return_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap().to_string();
        let dir = tmp.path().join(".mdium/flows");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.flow.yaml"), OK).unwrap();

        let loaded = svc.load_flow(&root, ".mdium/flows/a.flow.yaml").unwrap();
        assert_eq!(loaded.path, ".mdium/flows/a.flow.yaml");
        assert_eq!(loaded.format, crate::parse::FlowFormat::Yaml);
        assert!(loaded.report.errors.is_empty());
        let json = serde_json::to_value(&loaded).unwrap();
        assert_eq!(json["flow"]["id"], "t");

        let checked = svc
            .validate_flow(&root, ".mdium/flows/new.flow.yaml", "schemaVersion: 1\nid: t\nname: T\nnodes: []\n")
            .unwrap();
        assert_eq!(checked.report.errors.len(), 1);
        assert_eq!(svc.list_flows(&root).unwrap().len(), 1);
    }

    #[test]
    fn path_errors_map_to_command_codes() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap().to_string();
        assert_eq!(
            svc.load_flow(&root, ".mdium/flows/none.flow.yaml").unwrap_err().code,
            FLOW_FILE_NOT_FOUND
        );
        assert_eq!(svc.load_flow(&root, "../x.flow.yaml").unwrap_err().code, FLOW_FILE_PATH_INVALID);
        assert_eq!(svc.validate_flow(&root, "notes.md", OK).unwrap_err().code, FLOW_FILE_PATH_INVALID);
    }

    #[test]
    fn engine_errors_keep_code_and_details() {
        use crate::run::engine::{EngineError, FLOW_RUN_INVALID_ID};
        use crate::run::model::Reason;
        let err = FlowCommandError::from(EngineError {
            code: FLOW_RUN_INVALID_ID.into(),
            message: "x".into(),
            details: vec![Reason::new("D")],
        });
        assert_eq!(err.code, FLOW_RUN_INVALID_ID);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["details"][0]["code"], "D");
        let plain = serde_json::to_value(FlowCommandError::new("C", "m")).unwrap();
        assert!(plain.get("details").is_none());
    }
}
```

Add `pub mod service;` to `lib.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p flow-core service::` → Expected: compile errors (`FlowService`, `FlowCommandError` … not found).

- [ ] **Step 3: Implement the service (definitions part)**

Above the test module in `service.rs`:

```rust
use crate::load::{self, FlowReport, FlowSummary, PathProblem};
use crate::parse::FlowFormat;
use crate::run::engine::{EngineError, FlowEngine};
use crate::run::model::Reason;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The project root is empty, not absolute, or not an existing directory.
pub const FLOW_PROJECT_INVALID: &str = "FLOW_PROJECT_INVALID";
/// The flow path is not a `*.flow.{yaml,yml,json}` file inside the project
/// (or goes through a link).
pub const FLOW_FILE_PATH_INVALID: &str = "FLOW_FILE_PATH_INVALID";
/// The flow file does not exist.
pub const FLOW_FILE_NOT_FOUND: &str = "FLOW_FILE_NOT_FOUND";
/// Listing the flows directory failed.
pub const FLOW_LIST_FAILED: &str = "FLOW_LIST_FAILED";
/// The blocking task could not be joined (used by the Tauri wrappers).
pub const FLOW_COMMAND_FAILED: &str = "FLOW_COMMAND_FAILED";

/// A command failure as the UI receives it: `{ code, message, details? }`.
/// `message` is a log detail; the UI localizes by `code`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlowCommandError {
    pub code: String,
    pub message: String,
    /// Machine-readable details (validation problems, nodes needing action, ...).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<Reason>,
}

impl FlowCommandError {
    pub fn new(code: &str, detail: impl std::fmt::Display) -> Self {
        Self {
            code: code.to_string(),
            message: format!("{code}: {detail}"),
            details: Vec::new(),
        }
    }
}

impl From<EngineError> for FlowCommandError {
    fn from(err: EngineError) -> Self {
        Self {
            message: format!("{}: {}", err.code, err.message),
            code: err.code,
            details: err.details,
        }
    }
}

/// A checked flow file as returned to the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLoadResult {
    /// Project-relative path with `/` separators.
    pub path: String,
    pub format: FlowFormat,
    #[serde(flatten)]
    pub report: FlowReport,
}

/// Checks a project root argument: absolute path of an existing directory.
pub fn project_root(project_root: &str) -> Result<PathBuf, FlowCommandError> {
    let root = PathBuf::from(project_root);
    if project_root.trim().is_empty() || !root.is_absolute() || !root.is_dir() {
        return Err(FlowCommandError::new(FLOW_PROJECT_INVALID, project_root));
    }
    Ok(root)
}

fn flow_file(root: &Path, path: &str, must_exist: bool) -> Result<PathBuf, FlowCommandError> {
    load::resolve_flow_path(root, path, must_exist).map_err(|problem| match problem {
        PathProblem::NotFound => FlowCommandError::new(FLOW_FILE_NOT_FOUND, path),
        PathProblem::Outside(reason) => {
            FlowCommandError::new(FLOW_FILE_PATH_INVALID, format!("{path} ({reason})"))
        }
    })
}

fn format_of(file: &Path) -> FlowFormat {
    file.file_name()
        .and_then(|n| n.to_str())
        .and_then(FlowFormat::from_file_name)
        .unwrap_or(FlowFormat::Yaml)
}

/// Every operation of the flow engine as plain methods. One per process;
/// transports (Tauri commands, HTTP handlers) are thin wrappers over it.
pub struct FlowService {
    engine: Arc<FlowEngine>,
}

impl FlowService {
    pub fn new(engine: Arc<FlowEngine>) -> Self {
        Self { engine }
    }

    pub fn engine(&self) -> &Arc<FlowEngine> {
        &self.engine
    }

    /// Lists `<projectRoot>/.mdium/flows/*.flow.{yaml,yml,json}` with a
    /// validation summary of each.
    pub fn list_flows(&self, project_root_arg: &str) -> Result<Vec<FlowSummary>, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        load::list_flows(&root).map_err(|err| FlowCommandError::new(FLOW_LIST_FAILED, err))
    }

    /// Reads and validates one flow file (`path` is project-relative).
    pub fn load_flow(&self, project_root_arg: &str, path: &str) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, true)?;
        Ok(FlowLoadResult {
            path: load::relative_display(&root, &file),
            format: format_of(&file),
            report: load::check_file(&root, &file),
        })
    }

    /// Validates unsaved `content` as if it were the file at `path`.
    pub fn validate_flow(
        &self,
        project_root_arg: &str,
        path: &str,
        content: &str,
    ) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, false)?;
        Ok(FlowLoadResult {
            path: load::relative_display(&root, &file),
            format: format_of(&file),
            report: load::check_content(&root, &file, content),
        })
    }
}
```

- [ ] **Step 4: Run the service tests**

Run: `cargo test -p flow-core service::` → Expected: 4 passed.

- [ ] **Step 5: Turn `commands/flow.rs` into a wrapper**

Replace the whole of `src-tauri/src/commands/flow.rs` with:

```rust
// src-tauri/src/commands/flow.rs
//! Tauri commands of the generic flow engine (definitions). Every command
//! is a thin wrapper over `flow_core::service::FlowService`; the UI that
//! calls these is gated behind the `experimentalFlows` setting.

pub use flow_core::service::{FlowCommandError, FlowLoadResult, FLOW_COMMAND_FAILED};
use flow_core::load::FlowSummary;
use flow_core::service::FlowService;
use std::sync::Arc;

/// The process-wide service, managed as Tauri state.
pub type FlowServiceState = Arc<FlowService>;

pub(crate) async fn blocking<T, F>(op: F) -> Result<T, FlowCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FlowCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(op)
        .await
        .map_err(|err| FlowCommandError::new(FLOW_COMMAND_FAILED, err))?
}

/// Runs `op` on the service off the async runtime.
pub(crate) async fn with_service<T, F>(
    state: tauri::State<'_, FlowServiceState>,
    op: F,
) -> Result<T, FlowCommandError>
where
    T: Send + 'static,
    F: FnOnce(&FlowService) -> Result<T, FlowCommandError> + Send + 'static,
{
    let service = state.inner().clone();
    blocking(move || op(&service)).await
}

#[tauri::command]
pub async fn flow_list(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<Vec<FlowSummary>, FlowCommandError> {
    with_service(state, move |s| s.list_flows(&project_root)).await
}

#[tauri::command]
pub async fn flow_load(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
) -> Result<FlowLoadResult, FlowCommandError> {
    with_service(state, move |s| s.load_flow(&project_root, &path)).await
}

#[tauri::command]
pub async fn flow_validate(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
    content: String,
) -> Result<FlowLoadResult, FlowCommandError> {
    with_service(state, move |s| s.validate_flow(&project_root, &path, &content)).await
}
```

(The three tests that were in this file now live in `service.rs`.) `commands/flow_run.rs` still imports `project_root` and `FlowCommandError` from `super::flow` and manages `FlowEngineState`; Task 5 rewrites it. To keep this task compiling, add one temporary re-export to `commands/flow.rs` so the existing `use super::flow::{blocking, project_root, FlowCommandError};` in `flow_run.rs` keeps resolving:

```rust
pub use flow_core::service::project_root;
```

`lib.rs` still manages `FlowEngineState` from `flow_run.rs`. In `lib.rs` `setup`, add after the engine line

```rust
app.manage::<commands::flow::FlowServiceState>(Arc::new(
    flow_core::service::FlowService::new(flow_engine.clone()),
));
```

(keep `flow_engine` managed as well for `flow_run.rs` until Task 5).

- [ ] **Step 6: Build and test**

Run: `cargo test` (workspace) → Expected: pass.
Run: `npm run tauri dev` is not required; `cargo build` → Expected: success.

- [ ] **Step 7: Commit**

```bash
git add -A src-tauri
git commit -m "refactor(flow): add FlowService and wrap the definition commands"
```

---

### Task 5: `FlowService` for runs; `commands/flow_run.rs` becomes a wrapper

**Files:**
- Modify: `src-tauri/crates/flow-core/src/service.rs`, `src-tauri/src/commands/flow_run.rs`, `src-tauri/src/commands/flow.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces on `FlowService` (all `&self`, all returning `Result<_, FlowCommandError>`):
  - `command_review(project_root: &str, path: &str) -> CommandReview`
  - `confirm_commands(project_root: &str, path: &str, sha256: &str) -> ()`
  - `run_start(project_root: &str, path: &str, params: &BTreeMap<String, Value>, sha256: &str) -> RunSummary`
  - `run_list(project_root: &str) -> Vec<RunSummary>`
  - `run_get(project_root: &str, run_id: &str) -> RunSnapshot`
  - `run_stop / run_resume / run_cancel / run_delete(project_root: &str, run_id: &str) -> ()`
  - `run_approve(project_root: &str, run_id: &str, node_key: Option<&str>, choice: &str, comment: Option<String>) -> ()`
  - `run_rerun_node / run_mark_succeeded(project_root: &str, run_id: &str, node_key: &str) -> ()`
  - `run_log(project_root: &str, run_id: &str, node_key: &str, attempt: u32, stream: &str, max_bytes: u64) -> String`
  - `gitignore_status(project_root: &str) -> GitignoreStatus` where `GitignoreStatus { ignored: bool }` (serde camelCase) moves to `service.rs` together with `flow_runs_ignored(root: &Path) -> bool`.
  - `shutdown(&self, wait: Duration)` delegating to the engine.
- Consumes: `FlowEngine` methods listed in `src-tauri/crates/flow-core/src/run/engine.rs` (`review_commands`, `confirm_commands`, `start`, `list`, `get`, `stop`, `cancel`, `resume`, `approve`, `rerun_node`, `mark_succeeded`, `delete`, `log`, `shutdown`).

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module of `service.rs`:

```rust
    #[test]
    fn run_operations_validate_the_project_root_first() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        assert_eq!(svc.run_list("").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(svc.run_get("", "r").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(svc.command_review("", "x.flow.yaml").unwrap_err().code, FLOW_PROJECT_INVALID);
    }

    #[test]
    fn run_list_of_a_fresh_project_is_empty_and_unknown_ids_fail() {
        use crate::run::engine::FLOW_RUN_INVALID_ID;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert!(svc.run_list(root).unwrap().is_empty());
        assert_eq!(svc.run_get(root, "not-an-id").unwrap_err().code, FLOW_RUN_INVALID_ID);
    }

    #[test]
    fn detects_whether_flow_runs_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        // Not a repository: nothing to suggest.
        assert!(svc.gitignore_status(root).unwrap().ignored);
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(tmp.path())
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        assert!(!svc.gitignore_status(root).unwrap().ignored);
        std::fs::write(tmp.path().join(".gitignore"), ".mdium/flow-runs/\n").unwrap();
        assert!(svc.gitignore_status(root).unwrap().ignored);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p flow-core service::` → Expected: compile errors (`run_list`, `gitignore_status` … not found).

- [ ] **Step 3: Implement the run methods**

Add to the imports of `service.rs`:

```rust
use crate::run::engine::{CommandReview, RunSnapshot, RunSummary};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;
```

Add above `FlowService`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreStatus {
    /// `.mdium/flow-runs/` is ignored by git (or the folder is not a git repository).
    pub ignored: bool,
}

/// Whether git ignores `.mdium/flow-runs/` in `root` (the UI suggests
/// adding it otherwise; nothing is written automatically).
pub fn flow_runs_ignored(root: &Path) -> bool {
    let mut command = std::process::Command::new("git");
    command
        .args(["check-ignore", "-q", ".mdium/flow-runs/probe"])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.status() {
        Ok(status) => status.code() != Some(1),
        // No git: nothing to suggest.
        Err(_) => true,
    }
}
```

Add inside `impl FlowService`:

```rust
    pub fn command_review(&self, project_root_arg: &str, path: &str) -> Result<CommandReview, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.review_commands(&root, path)?)
    }

    pub fn confirm_commands(&self, project_root_arg: &str, path: &str, sha256: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.confirm_commands(&root, path, sha256)?)
    }

    pub fn run_start(
        &self,
        project_root_arg: &str,
        path: &str,
        params: &BTreeMap<String, Value>,
        sha256: &str,
    ) -> Result<RunSummary, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.start(&root, path, params, sha256)?)
    }

    pub fn run_list(&self, project_root_arg: &str) -> Result<Vec<RunSummary>, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.list(&root)?)
    }

    pub fn run_get(&self, project_root_arg: &str, run_id: &str) -> Result<RunSnapshot, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.get(&root, run_id)?)
    }

    pub fn run_stop(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.stop(&root, run_id)?)
    }

    pub fn run_resume(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.resume(&root, run_id)?)
    }

    pub fn run_cancel(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.cancel(&root, run_id)?)
    }

    /// Answers an approval; `node_key` `None` answers the budget approval.
    pub fn run_approve(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: Option<&str>,
        choice: &str,
        comment: Option<String>,
    ) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.approve(&root, run_id, node_key, choice, comment)?)
    }

    pub fn run_rerun_node(&self, project_root_arg: &str, run_id: &str, node_key: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.rerun_node(&root, run_id, node_key)?)
    }

    pub fn run_mark_succeeded(&self, project_root_arg: &str, run_id: &str, node_key: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.mark_succeeded(&root, run_id, node_key)?)
    }

    pub fn run_delete(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.delete(&root, run_id)?)
    }

    /// Tail of a node attempt's `stdout` / `stderr` log (at most 256 KiB).
    pub fn run_log(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: &str,
        attempt: u32,
        stream: &str,
        max_bytes: u64,
    ) -> Result<String, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.log(&root, run_id, node_key, attempt, stream, max_bytes)?)
    }

    pub fn gitignore_status(&self, project_root_arg: &str) -> Result<GitignoreStatus, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(GitignoreStatus { ignored: flow_runs_ignored(&root) })
    }

    /// Waits for active drivers to record `interrupted` (app exit).
    pub fn shutdown(&self, wait: Duration) {
        self.engine.shutdown(wait);
    }
```

`FlowEngine::approve` already takes `(root: &Path, run_id: &str, node_key: Option<&str>, choice: &str, comment: Option<String>)` (it is what the former Tauri command passed), so the call above compiles as written.

- [ ] **Step 4: Run the service tests**

Run: `cargo test -p flow-core service::` → Expected: 7 passed.

- [ ] **Step 5: Rewrite `commands/flow_run.rs` as wrappers**

Keep in `commands/flow_run.rs` everything Tauri-specific unchanged: the event name constants, the four payload structs, `TauriSink`, `InAppNotifier`, `SHUTDOWN_WAIT`, the `payloads_are_camel_case` test. Change the rest:

```rust
use super::flow::{with_service, FlowCommandError, FlowServiceState};
use flow_core::run::driver::{ApprovalNotifier, DriverEnv, EventSink};
use flow_core::run::engine::{CommandReview, FlowEngine, RunSnapshot, RunSummary};
use flow_core::run::model::{ApprovalRequest, NodeState, NodeStatus, Progress, Reason, RunState, RunStatus};
use flow_core::run::process::{AttachedLauncher, Launcher};
use flow_core::run::supervise::DetachedLauncher;
use flow_core::service::{FlowService, GitignoreStatus};
```

`create_state` now returns the service:

```rust
/// Creates the engine and its service (called once in `setup`).
pub fn create_state(app: &AppHandle) -> FlowServiceState {
    let base = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mdium");
    let env = DriverEnv {
        launcher: Arc::new(AttachedLauncher),
        // `detach: true` commands run under the supervisor mode of this executable.
        detached: match DetachedLauncher::for_current_exe() {
            Ok(launcher) => Some(Arc::new(launcher) as Arc<dyn Launcher>),
            Err(err) => {
                eprintln!("[flow] detached commands unavailable: {err}");
                None
            }
        },
        sink: Arc::new(TauriSink { app: app.clone() }),
        notifiers: Arc::new(vec![
            Arc::new(InAppNotifier { app: app.clone() }) as Arc<dyn ApprovalNotifier>
        ]),
        process_env: Arc::new(std::env::vars().collect()),
        poll: Duration::from_millis(200),
    };
    let engine = Arc::new(FlowEngine::new(env, base.join("flow-command-confirmations.json")));
    Arc::new(FlowService::new(engine))
}
```

Delete `FlowEngineState`, `with_engine`, `flow_runs_ignored` and `GitignoreStatus` (now in the service) and the tests `detects_whether_flow_runs_are_ignored` and `engine_errors_keep_code_and_details` (moved in Tasks 4–5). Each command becomes:

```rust
#[tauri::command]
pub async fn flow_command_review(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
) -> Result<CommandReview, FlowCommandError> {
    with_service(state, move |s| s.command_review(&project_root, &path)).await
}

#[tauri::command]
pub async fn flow_confirm_commands(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
    sha256: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.confirm_commands(&project_root, &path, &sha256)).await
}

#[tauri::command]
pub async fn flow_run_start(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
    params: BTreeMap<String, Value>,
    sha256: String,
) -> Result<RunSummary, FlowCommandError> {
    with_service(state, move |s| s.run_start(&project_root, &path, &params, &sha256)).await
}

#[tauri::command]
pub async fn flow_run_list(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<Vec<RunSummary>, FlowCommandError> {
    with_service(state, move |s| s.run_list(&project_root)).await
}

#[tauri::command]
pub async fn flow_run_get(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<RunSnapshot, FlowCommandError> {
    with_service(state, move |s| s.run_get(&project_root, &run_id)).await
}

#[tauri::command]
pub async fn flow_run_stop(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_stop(&project_root, &run_id)).await
}

#[tauri::command]
pub async fn flow_run_resume(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_resume(&project_root, &run_id)).await
}

#[tauri::command]
pub async fn flow_run_cancel(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_cancel(&project_root, &run_id)).await
}

/// Answers an approval; `nodeKey` null answers the budget approval.
#[tauri::command]
pub async fn flow_run_approve(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: Option<String>,
    choice: String,
    comment: Option<String>,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| {
        s.run_approve(&project_root, &run_id, node_key.as_deref(), &choice, comment)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_rerun_node(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_rerun_node(&project_root, &run_id, &node_key)).await
}

#[tauri::command]
pub async fn flow_run_mark_succeeded(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_mark_succeeded(&project_root, &run_id, &node_key)).await
}

#[tauri::command]
pub async fn flow_run_delete(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_delete(&project_root, &run_id)).await
}

/// Tail of a node attempt's `stdout` / `stderr` log (at most 256 KiB).
#[tauri::command]
pub async fn flow_run_log(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: String,
    attempt: u32,
    stream: String,
    max_bytes: u64,
) -> Result<String, FlowCommandError> {
    with_service(state, move |s| {
        s.run_log(&project_root, &run_id, &node_key, attempt, &stream, max_bytes)
    })
    .await
}

#[tauri::command]
pub async fn flow_gitignore_status(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<GitignoreStatus, FlowCommandError> {
    with_service(state, move |s| s.gitignore_status(&project_root)).await
}
```

Note `flow_gitignore_status` gains a `state` parameter; the frontend passes only `{ projectRoot }` and Tauri injects state, so the JS call is unchanged.

In `src-tauri/src/lib.rs` `setup`, replace the two flow lines (and the temporary `FlowServiceState` line from Task 4) with:

```rust
let flow_service = commands::flow_run::create_state(app.handle());
app.manage::<commands::flow::FlowServiceState>(flow_service);
```

and in the exit handler replace `app.try_state::<commands::flow_run::FlowEngineState>()` with `app.try_state::<commands::flow::FlowServiceState>()` (its `engine.shutdown(commands::flow_run::SHUTDOWN_WAIT)` call keeps working because `FlowService::shutdown` has the same shape). Remove the temporary `pub use flow_core::service::project_root;` from `commands/flow.rs` if nothing uses it.

- [ ] **Step 6: Build and run every test**

Run: `cargo test` (workspace) → Expected: pass.
Run: `cargo build` → Expected: no warnings.
Manual smoke (desktop): `npm run tauri dev`, enable `experimentalFlows`, open a folder with `.mdium/flows/manual-check.flow.yaml`, start it, approve, see it complete. Expected: identical to before.

- [ ] **Step 7: Commit**

```bash
git add -A src-tauri
git commit -m "refactor(flow): route the run commands through FlowService"
```

---

### Task 6: `FlowService::call(name, args)` JSON dispatch and command-name parity

**Files:**
- Modify: `src-tauri/crates/flow-core/src/service.rs`, `src-tauri/src/commands/flow_run.rs`

**Interfaces:**
- Produces: `flow_core::service::COMMAND_NAMES: [&str; 17]`, `FlowService::call(&self, name: &str, args: Value) -> Result<Value, FlowCommandError>`, codes `FLOW_UNKNOWN_COMMAND`, `FLOW_BAD_ARGS`, `FLOW_SERIALIZE_FAILED`.
- Consumes: Task 4–5 methods.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module of `service.rs`:

```rust
    #[test]
    fn call_dispatches_by_tauri_command_name_with_camel_case_args() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), OK).unwrap();

        let listed = svc.call("flow_list", serde_json::json!({ "projectRoot": root })).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        let loaded = svc
            .call("flow_load", serde_json::json!({ "projectRoot": root, "path": ".mdium/flows/a.flow.yaml" }))
            .unwrap();
        assert_eq!(loaded["flow"]["id"], "t");
        let runs = svc.call("flow_run_list", serde_json::json!({ "projectRoot": root })).unwrap();
        assert_eq!(runs, serde_json::json!([]));
        let ignored = svc.call("flow_gitignore_status", serde_json::json!({ "projectRoot": root })).unwrap();
        assert_eq!(ignored["ignored"], true);
    }

    #[test]
    fn call_rejects_unknown_names_and_bad_args() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert_eq!(
            svc.call("flow_nope", serde_json::json!({})).unwrap_err().code,
            FLOW_UNKNOWN_COMMAND
        );
        // Missing projectRoot.
        assert_eq!(svc.call("flow_list", serde_json::json!({})).unwrap_err().code, FLOW_BAD_ARGS);
        // attempt must be a number.
        let err = svc
            .call(
                "flow_run_log",
                serde_json::json!({ "projectRoot": root, "runId": "r", "nodeKey": "a", "attempt": "1", "stream": "stdout", "maxBytes": 10 }),
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_BAD_ARGS);
        // Engine errors pass through unchanged.
        let err = svc
            .call("flow_run_get", serde_json::json!({ "projectRoot": root, "runId": "nope" }))
            .unwrap_err();
        assert_eq!(err.code, crate::run::engine::FLOW_RUN_INVALID_ID);
    }

    #[test]
    fn every_command_name_is_dispatchable() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        for name in COMMAND_NAMES {
            // With empty args every command fails on arguments, never on the name.
            let code = svc.call(name, serde_json::json!({})).unwrap_err().code;
            assert_ne!(code, FLOW_UNKNOWN_COMMAND, "{name}");
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p flow-core service::call` → Expected: compile errors (`call`, `COMMAND_NAMES` not found).

- [ ] **Step 3: Implement `call`**

Add to `service.rs` (imports: `use serde::Deserialize;`):

```rust
/// The command is not one of [`COMMAND_NAMES`].
pub const FLOW_UNKNOWN_COMMAND: &str = "FLOW_UNKNOWN_COMMAND";
/// The JSON arguments do not match the command's parameters.
pub const FLOW_BAD_ARGS: &str = "FLOW_BAD_ARGS";
/// The result could not be serialized to JSON.
pub const FLOW_SERIALIZE_FAILED: &str = "FLOW_SERIALIZE_FAILED";

/// Every command the service dispatches by name (the Tauri command names;
/// the HTTP server uses the same names, spec 2026-10-10, 10.2).
pub const COMMAND_NAMES: [&str; 17] = [
    "flow_list",
    "flow_load",
    "flow_validate",
    "flow_command_review",
    "flow_confirm_commands",
    "flow_run_start",
    "flow_run_list",
    "flow_run_get",
    "flow_run_stop",
    "flow_run_resume",
    "flow_run_cancel",
    "flow_run_approve",
    "flow_run_rerun_node",
    "flow_run_mark_succeeded",
    "flow_run_delete",
    "flow_run_log",
    "flow_gitignore_status",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootArgs {
    project_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathArgs {
    project_root: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidateArgs {
    project_root: String,
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmArgs {
    project_root: String,
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartArgs {
    project_root: String,
    path: String,
    params: BTreeMap<String, Value>,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunArgs {
    project_root: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApproveArgs {
    project_root: String,
    run_id: String,
    #[serde(default)]
    node_key: Option<String>,
    choice: String,
    #[serde(default)]
    comment: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeArgs {
    project_root: String,
    run_id: String,
    node_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogArgs {
    project_root: String,
    run_id: String,
    node_key: String,
    attempt: u32,
    stream: String,
    max_bytes: u64,
}

fn args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, FlowCommandError> {
    serde_json::from_value(value).map_err(|err| FlowCommandError::new(FLOW_BAD_ARGS, err))
}

fn reply<T: Serialize>(value: T) -> Result<Value, FlowCommandError> {
    serde_json::to_value(value).map_err(|err| FlowCommandError::new(FLOW_SERIALIZE_FAILED, err))
}

impl FlowService {
    /// Dispatches a command by its Tauri name with its JSON argument object
    /// (camelCase keys, exactly what the frontend sends to `invoke`). Used
    /// by transports that carry commands as data (the HTTP server).
    pub fn call(&self, name: &str, value: Value) -> Result<Value, FlowCommandError> {
        match name {
            "flow_list" => {
                let a: RootArgs = args(value)?;
                reply(self.list_flows(&a.project_root)?)
            }
            "flow_load" => {
                let a: PathArgs = args(value)?;
                reply(self.load_flow(&a.project_root, &a.path)?)
            }
            "flow_validate" => {
                let a: ValidateArgs = args(value)?;
                reply(self.validate_flow(&a.project_root, &a.path, &a.content)?)
            }
            "flow_command_review" => {
                let a: PathArgs = args(value)?;
                reply(self.command_review(&a.project_root, &a.path)?)
            }
            "flow_confirm_commands" => {
                let a: ConfirmArgs = args(value)?;
                reply(self.confirm_commands(&a.project_root, &a.path, &a.sha256)?)
            }
            "flow_run_start" => {
                let a: StartArgs = args(value)?;
                reply(self.run_start(&a.project_root, &a.path, &a.params, &a.sha256)?)
            }
            "flow_run_list" => {
                let a: RootArgs = args(value)?;
                reply(self.run_list(&a.project_root)?)
            }
            "flow_run_get" => {
                let a: RunArgs = args(value)?;
                reply(self.run_get(&a.project_root, &a.run_id)?)
            }
            "flow_run_stop" => {
                let a: RunArgs = args(value)?;
                reply(self.run_stop(&a.project_root, &a.run_id)?)
            }
            "flow_run_resume" => {
                let a: RunArgs = args(value)?;
                reply(self.run_resume(&a.project_root, &a.run_id)?)
            }
            "flow_run_cancel" => {
                let a: RunArgs = args(value)?;
                reply(self.run_cancel(&a.project_root, &a.run_id)?)
            }
            "flow_run_approve" => {
                let a: ApproveArgs = args(value)?;
                reply(self.run_approve(&a.project_root, &a.run_id, a.node_key.as_deref(), &a.choice, a.comment)?)
            }
            "flow_run_rerun_node" => {
                let a: NodeArgs = args(value)?;
                reply(self.run_rerun_node(&a.project_root, &a.run_id, &a.node_key)?)
            }
            "flow_run_mark_succeeded" => {
                let a: NodeArgs = args(value)?;
                reply(self.run_mark_succeeded(&a.project_root, &a.run_id, &a.node_key)?)
            }
            "flow_run_delete" => {
                let a: RunArgs = args(value)?;
                reply(self.run_delete(&a.project_root, &a.run_id)?)
            }
            "flow_run_log" => {
                let a: LogArgs = args(value)?;
                reply(self.run_log(&a.project_root, &a.run_id, &a.node_key, a.attempt, &a.stream, a.max_bytes)?)
            }
            "flow_gitignore_status" => {
                let a: RootArgs = args(value)?;
                reply(self.gitignore_status(&a.project_root)?)
            }
            other => Err(FlowCommandError::new(FLOW_UNKNOWN_COMMAND, other)),
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core service::` → Expected: 10 passed.

- [ ] **Step 5: Add the parity test on the Tauri side**

In `src-tauri/src/commands/flow_run.rs` `tests` module add:

```rust
    /// The Tauri handlers registered in `lib.rs` for the flow engine, by
    /// name. Keep in sync with `generate_handler!`; the test below pins the
    /// list to the service's dispatch table so HTTP and Tauri never drift.
    const TAURI_FLOW_COMMANDS: [&str; 17] = [
        "flow_list",
        "flow_load",
        "flow_validate",
        "flow_command_review",
        "flow_confirm_commands",
        "flow_run_start",
        "flow_run_list",
        "flow_run_get",
        "flow_run_stop",
        "flow_run_resume",
        "flow_run_cancel",
        "flow_run_approve",
        "flow_run_rerun_node",
        "flow_run_mark_succeeded",
        "flow_run_delete",
        "flow_run_log",
        "flow_gitignore_status",
    ];

    #[test]
    fn tauri_commands_match_the_service_dispatch_table() {
        let mut tauri: Vec<&str> = TAURI_FLOW_COMMANDS.to_vec();
        let mut service: Vec<&str> = flow_core::service::COMMAND_NAMES.to_vec();
        tauri.sort();
        service.sort();
        assert_eq!(tauri, service);
    }
```

- [ ] **Step 6: Run all tests and commit**

Run: `cargo test` (workspace) → Expected: pass.

```bash
git add -A src-tauri
git commit -m "feat(flow): dispatch service commands by name for data-carrying transports"
```

---

### Task 7: Frontend `FlowTransport` and the Tauri implementation

**Files:**
- Create: `src/features/flow/lib/transport.ts`, `src/features/flow/lib/tauri-transport.ts`, `src/features/flow/lib/__tests__/transport.test.ts`
- Modify: `src/features/flow/lib/flow-api.ts`, `src/features/flow/lib/flow-run-api.ts`

**Interfaces:**
- Produces:
  - `FlowEventName = "flow://run-changed" | "flow://node-changed" | "flow://progress" | "flow://approval-requested"`.
  - `interface FlowTransport { call<T>(command: string, args: Record<string, unknown>): Promise<T>; subscribe<T>(event: FlowEventName, handler: (payload: T) => void): Promise<() => void>; }`
  - `setFlowTransport(transport: FlowTransport | null): void` (null restores the default), `getFlowTransport(): FlowTransport` (default: the Tauri transport, created lazily once).
  - `createTauriTransport(): FlowTransport` in `tauri-transport.ts`.
- Consumes: `@tauri-apps/api/core` `invoke`, `@tauri-apps/api/event` `listen` (only in `tauri-transport.ts`).
- Deferred on purpose: the spec's `artifactUrl(ref)` member (10.2) is added in V4 together with `ArtifactRef`; V1 has no artifacts to resolve (YAGNI).

- [ ] **Step 1: Write the failing tests**

`src/features/flow/lib/__tests__/transport.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { getFlowTransport, setFlowTransport, type FlowTransport } from "../transport";
import { createTauriTransport } from "../tauri-transport";
import { flowApi } from "../flow-api";
import { flowRunApi, subscribeFlowRunEvents } from "../flow-run-api";

describe("FlowTransport registry", () => {
  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
  });
  afterEach(() => setFlowTransport(null));

  it("defaults to the Tauri transport", async () => {
    invoke.mockResolvedValueOnce(["x"]);
    await expect(getFlowTransport().call("flow_list", { projectRoot: "C:\\p" })).resolves.toEqual(["x"]);
    expect(invoke).toHaveBeenCalledWith("flow_list", { projectRoot: "C:\\p" });
  });

  it("routes flowApi and flowRunApi through the registered transport", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const fake: FlowTransport = {
      call: async <T,>(command: string, args: Record<string, unknown>) => {
        calls.push([command, args]);
        return "ok" as T;
      },
      subscribe: async () => () => {},
    };
    setFlowTransport(fake);
    await expect(flowApi.list("C:\\p")).resolves.toBe("ok");
    await expect(flowRunApi.get("C:\\p", "r1")).resolves.toBe("ok");
    expect(calls).toEqual([
      ["flow_list", { projectRoot: "C:\\p" }],
      ["flow_run_get", { projectRoot: "C:\\p", runId: "r1" }],
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still normalizes command errors coming from a custom transport", async () => {
    setFlowTransport({
      call: async () => {
        throw JSON.stringify({ code: "FLOW_PROJECT_INVALID", message: "x" });
      },
      subscribe: async () => () => {},
    });
    await expect(flowApi.list("")).rejects.toEqual({ code: "FLOW_PROJECT_INVALID", message: "x" });
  });

  it("keeps an earlier unsubscribe bound to the transport that created it", async () => {
    // Review Focus 3: swapping the transport must not orphan live listeners.
    const detached: string[] = [];
    const first: FlowTransport = {
      call: async <T,>() => undefined as T,
      subscribe: async (event) => () => {
        detached.push(event);
      },
    };
    setFlowTransport(first);
    const unlisten = await subscribeFlowRunEvents({ onRunChanged: vi.fn() });
    setFlowTransport({ call: async <T,>() => undefined as T, subscribe: async () => () => {} });
    unlisten();
    expect(detached).toEqual(["flow://run-changed"]);
  });
});

describe("Tauri transport", () => {
  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
  });

  it("subscribe hands the handler the event payload only", async () => {
    // Review Focus 4: handlers get `event.payload`, not the envelope.
    const transport = createTauriTransport();
    const seen: unknown[] = [];
    const off = await transport.subscribe("flow://progress", (p) => seen.push(p));
    listeners.get("flow://progress")!({ payload: { runId: "r", text: "t" } });
    expect(seen).toEqual([{ runId: "r", text: "t" }]);
    off();
    expect(listeners.has("flow://progress")).toBe(false);
  });

  it("call forwards to invoke unchanged", async () => {
    invoke.mockResolvedValueOnce(7);
    await expect(createTauriTransport().call("flow_run_log", { maxBytes: 1 })).resolves.toBe(7);
    expect(invoke).toHaveBeenCalledWith("flow_run_log", { maxBytes: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/flow/lib/__tests__/transport.test.ts` → Expected: FAIL, cannot resolve `../transport` / `../tauri-transport`.

- [ ] **Step 3: Implement the transport modules**

`src/features/flow/lib/transport.ts`:

```ts
import {
  FLOW_APPROVAL_REQUESTED_EVENT,
  FLOW_NODE_CHANGED_EVENT,
  FLOW_PROGRESS_EVENT,
  FLOW_RUN_CHANGED_EVENT,
} from "@/shared/types/flow-run";

/** The backend events a transport can deliver (`flow://...`). */
export type FlowEventName =
  | typeof FLOW_RUN_CHANGED_EVENT
  | typeof FLOW_NODE_CHANGED_EVENT
  | typeof FLOW_PROGRESS_EVENT
  | typeof FLOW_APPROVAL_REQUESTED_EVENT;

/**
 * How the flow UI reaches the engine. The desktop app talks to Tauri
 * commands and events; the web front talks HTTP and WebSocket. Command
 * names and argument objects are identical across transports.
 */
export interface FlowTransport {
  /** Invokes one engine command with its camelCase argument object. */
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** Subscribes to one event; resolves to the unsubscribe function. */
  subscribe<T>(event: FlowEventName, handler: (payload: T) => void): Promise<() => void>;
}

let current: FlowTransport | null = null;
let fallback: FlowTransport | null = null;

/** Registers the transport the flow UI uses; `null` restores the default (Tauri). */
export function setFlowTransport(transport: FlowTransport | null): void {
  current = transport;
}

/** The registered transport, or the lazily created Tauri transport. */
export function getFlowTransport(): FlowTransport {
  if (current) return current;
  if (!fallback) fallback = createDefaultTransport();
  return fallback;
}

/* The default is injected by `tauri-transport.ts` at module load so this
 * module stays free of `@tauri-apps/*` imports (spec 2026-10-10, 10.2). */
let createDefaultTransport: () => FlowTransport = () => {
  throw new Error("no default FlowTransport registered");
};

/** Called once by the default transport module to register its factory. */
export function registerDefaultTransport(factory: () => FlowTransport): void {
  createDefaultTransport = factory;
}
```

`src/features/flow/lib/tauri-transport.ts` (the only file under `src/features/flow/` allowed to import `@tauri-apps/*`):

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerDefaultTransport, type FlowEventName, type FlowTransport } from "./transport";

/** The desktop transport: Tauri commands and events. */
export function createTauriTransport(): FlowTransport {
  return {
    call: <T,>(command: string, args: Record<string, unknown>) => invoke<T>(command, args),
    subscribe: async <T,>(event: FlowEventName, handler: (payload: T) => void) =>
      listen<T>(event, (e) => handler(e.payload)),
  };
}

registerDefaultTransport(createTauriTransport);
```

In `flow-api.ts` replace `import { invoke } from "@tauri-apps/api/core";` with:

```ts
import { getFlowTransport } from "./transport";
import "./tauri-transport";
```

and in its `call` helper replace `return await invoke<T>(command, args);` with `return await getFlowTransport().call<T>(command, args);`.

In `flow-run-api.ts` remove the two `@tauri-apps` imports, add the same two import lines as above, replace `return await invoke<T>(command, args);` with `return await getFlowTransport().call<T>(command, args);`, change the return type of `subscribeFlowRunEvents` from `Promise<UnlistenFn>` to `Promise<() => void>`, and rewrite its body:

```ts
export async function subscribeFlowRunEvents(handlers: FlowRunEventHandlers): Promise<() => void> {
  const transport = getFlowTransport();
  const unlisten: Array<() => void> = [];
  const add = async <T,>(name: FlowEventName, handler?: (payload: T) => void) => {
    if (handler) unlisten.push(await transport.subscribe<T>(name, handler));
  };
  await add(FLOW_RUN_CHANGED_EVENT, handlers.onRunChanged);
  await add(FLOW_NODE_CHANGED_EVENT, handlers.onNodeChanged);
  await add(FLOW_PROGRESS_EVENT, handlers.onProgress);
  await add(FLOW_APPROVAL_REQUESTED_EVENT, handlers.onApprovalRequested);
  return () => unlisten.forEach((fn) => fn());
}
```

(import `type FlowEventName` from `./transport`). The `import "./tauri-transport";` side-effect import in both API files guarantees the default factory is registered before the first `getFlowTransport()`.

- [ ] **Step 4: Run the new and the existing flow tests**

Run: `npx vitest run src/features/flow` → Expected: all pass, including `flow-api.test.ts`, `FlowViews.test.tsx` and `RunViews.test.tsx`, which still mock `@tauri-apps/api/*` (the mocks now reach the Tauri transport).
Run: `npx tsc --noEmit -p tsconfig.json` → Expected: no errors (the `UnlistenFn` type is no longer imported anywhere in the flow feature).

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/lib
git commit -m "refactor(flow): route the flow UI through a swappable FlowTransport"
```

---

### Task 8: Guard against Tauri imports in the flow feature

**Files:**
- Create: `src/features/flow/lib/__tests__/no-tauri-imports.test.ts`

**Interfaces:**
- Consumes: the file layout from Task 7.

- [ ] **Step 1: Write the test**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FLOW_ROOT = resolve(__dirname, "../..");
/** The only module that may talk to Tauri directly (spec 2026-10-10, 10.2). */
const ALLOWED = new Set(["lib/tauri-transport.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("flow feature isolation", () => {
  it("imports @tauri-apps only from the Tauri transport", () => {
    const offenders = sourceFiles(FLOW_ROOT)
      .filter((file) => /from\s+["']@tauri-apps\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(FLOW_ROOT, file).replace(/\\/g, "/"))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes against the Task 7 layout**

Run: `npx vitest run src/features/flow/lib/__tests__/no-tauri-imports.test.ts` → Expected: PASS.

Prove the guard bites: temporarily add `import { invoke } from "@tauri-apps/api/core";` to `src/features/flow/lib/flow-graph.ts`, rerun → Expected: FAIL listing `lib/flow-graph.ts`. Revert the temporary line.

- [ ] **Step 3: Run the whole frontend suite and the type check**

Run: `npm test` → Expected: all pass.
Run: `npx tsc --noEmit -p tsconfig.json` → Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/flow/lib/__tests__/no-tauri-imports.test.ts
git commit -m "test(flow): forbid direct Tauri imports outside the Tauri transport"
```

---

### Task 9: Final verification

**Files:** none new.

- [ ] **Step 1: Full backend and frontend verification**

From `src-tauri/`: `cargo test` → Expected: all pass. `cargo clippy --workspace --all-targets` → Expected: no new warnings compared with `main` (run the same command on `main` if unsure).
From the repo root: `npm test` and `npx tsc --noEmit -p tsconfig.json` → Expected: pass.

- [ ] **Step 2: Confirm the crate has no Tauri dependency**

Run (from `src-tauri/`): `cargo tree -p flow-core -e normal | grep -i tauri; echo "exit=$?"` → Expected: no lines printed, `exit=1`.

- [ ] **Step 3: Desktop smoke**

`npm run tauri dev`; with `experimentalFlows` on, open a project containing `.mdium/flows/manual-check.flow.yaml`; start it, answer the approval, stop and resume a run, open a node log, delete a finished run. Expected: identical behavior to `main`; the `flow://` events still update the run panel without reloading.

- [ ] **Step 4: Record the outcome**

Add one line to the "V1" row in `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` chapter 12 only if the implementation deviated from the plan (for example a method name); otherwise leave the spec untouched. Commit if changed:

```bash
git add .superpowers/specs
git commit -m "docs(spec): note V1 deviations"
```
