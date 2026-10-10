# V2: Project Manifest and Flow Signatures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MDium a project manifest (`.mdium/project.yaml` with runtimes, setup steps, secrets, flow roles and metrics), a setup runner, sub-flow signature validation (`FLOW_OUTPUT_UNKNOWN`, `FLOW_PARAM_TYPE`, whole-object output references) and the `lib/` parts library with a grouped flow list.

**Architecture:** Everything Tauri-free lives in `src-tauri/crates/flow-core`: a new `project` module (manifest model, parse, validate), a new `setup` module (runs the manifest's setup steps through the existing `AttachedLauncher`), extensions to `template` / `validate` / `load` (signatures), to `run/engine` (manifest bytes in the confirmation hash, runtimes and setup in the review, secrets check, parts cannot start) and to `service` (two new commands dispatched by name). The Tauri layer adds the two wrappers and one `flow://setup-progress` event; the frontend adds the grouped list, the project header with a setup dialog, and the runtime/setup sections of the run-start dialog, all through the existing `FlowTransport`.

**Tech Stack:** Rust 2021 (serde, serde_json, serde_yaml_ng, sha2), Tauri 2, TypeScript 5.9, React 19, Vitest 4, i18next.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` — chapter 2 (プロジェクト), 16.1 (署名), 16.2 (ライブラリと一覧), chapter 12 row V2. Base spec: `.superpowers/specs/2026-10-06-generic-flow-engine-design.md` (2.5 references, 7.2 confirmation).

## Global Constraints

- `flow-core` must not depend on `tauri` or any `tauri-plugin-*` crate; `src/features/flow/` imports `@tauri-apps/*` only in `lib/tauri-transport.ts` (guarded by `no-tauri-imports.test.ts`).
- Every new Tauri command lives in `src-tauri/src/commands/flow.rs` or `flow_run.rs` (the parity test extracts `commands::flow(?:_run)?::(flow_\w+)` from `lib.rs`), is listed in `flow_core::service::COMMAND_NAMES` and has a `call()` arm with the same camelCase JSON arguments.
- Every new constant in `src-tauri/crates/flow-core/src/issues.rs` must also appear in `FLOW_ERROR_CODES` / `FLOW_WARNING_CODES` of `src/shared/types/flow.ts` (mirror test in `flow-api.test.ts`) and have `issue.<CODE>` in both `src/shared/i18n/locales/{ja,en}/flow.json` (test in `FlowViews.test.tsx`); ja and en key sets and `{{placeholders}}` must match (`locale-parity.test.ts`).
- Manifest file: `.mdium/project.yaml`, `schemaVersion: 1`, `id` matches `[a-z0-9-]+`. Unknown top-level keys are warnings (`FLOW_UNKNOWN_KEY`); unknown attributes inside `runtimes.<name>`, `setup[]` and `metrics[]` are errors (`FLOW_UNKNOWN_FIELD`). `runtimes.<name>.kind` is only `python`; `python` is a string or an array of strings; `python` and `cwd` are project-relative and must not escape the root (`FLOW_PATH_OUTSIDE_PROJECT`); `setup[].run` is a non-empty argv array with no templates; `secrets` are environment-variable names; `flows.<role>` values are paths relative to `.mdium/`; `metrics[].ref` is `outputs.<ident>` or `costUsd`, `metrics[].better` is `higher` or `lower` (spec 2.1).
- Missing secrets block run start with `FLOW_SECRET_MISSING` whose details list each missing name (spec 2.1).
- The confirmation hash covers every flow file in the bundle plus the bytes of `.mdium/project.yaml` when it exists; the review shows runtimes (interpreter candidates, module, cwd) and setup steps; a flow needs confirmation when it has any command, or the project declares any runtime or setup step (spec 2.3).
- Setup runs only on the user's action, after a confirmation dialog listing the steps, never twice at once for the same project (`FLOW_SETUP_BUSY`), and reports progress as `flow://setup-progress` (spec 2.2, 2.4).
- `nodes.<sub>.outputs.<key>` must name a key declared in the callee's `outputs` (`FLOW_OUTPUT_UNKNOWN`); loop nodes have the fixed outputs `iterations`, `failedIterations`, `limitReached`, `results`; `nodes.<id>.outputs` (the whole object) is a valid reference (spec 16.1, 1.2).
- Constant (non-template) sub-flow / file-body arguments must match the callee's param type (`FLOW_PARAM_TYPE`); templated values are checked at run time as today (spec 16.1).
- `.mdium/flows/lib/**/*.flow.yaml` are parts: listed under their own group with their signature, never offered as run entry points (`FLOW_RUN_NOT_ENTRY` from the engine). Entries are the files directly in `.mdium/flows/`; other sub-directories stay ignored. The templates group (`mdium:`) is V7 (spec 16.2).
- Code comments in English; every user-visible string goes through i18n (ja and en). Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Behavior of existing flows without a manifest does not change: all current tests keep passing.

## Review Focus

1. **A manifest with a `runtimes` entry but a flow with no command nodes** — the run-start dialog must still ask for confirmation (today a flow without commands is auto-confirmed). Pinned in Task 7.
2. **`nodes.<sub>.outputs.<key>` where the callee file has validation errors** — the output check must not pile a second error on top of `FLOW_SUBFLOW_INVALID` or panic on a missing child. Pinned in Task 2.
3. **`python: [".venv/Scripts/python.exe", ".venv/bin/python"]` where neither file exists yet** — `flow_project_load` must report the manifest as valid (existence is setup's job), and the review must list all candidates. Pinned in Task 4 and Task 7.
4. **A setup step whose program is not installed** (`uv` missing) — the runner must report the step as failed with the OS error, leave later steps unrun, release the busy flag, and the UI must show it. Pinned in Task 8.
5. **A flow under `lib/` opened in the workspace** — the start button must be absent and the backend must refuse `flow_run_start` for it even if the UI is bypassed. Pinned in Task 5.

---

## File Structure

**Created**
- `src-tauri/crates/flow-core/src/project.rs` — manifest model (`ProjectDef`, `RuntimeDef`, `SetupStep`, `MetricDef`), `parse_project`, `validate_project`, `load_project`, `ProjectReport`, `flow_roles`.
- `src-tauri/crates/flow-core/src/setup.rs` — `run_setup` (sequential steps through a `Launcher`), `SetupProgress`, `SetupResult`.
- `src-tauri/tests/fixtures/projects/{valid,invalid}/*.project.yaml` — golden manifests.
- `src/features/flow/components/ProjectSetupDialog.tsx` — setup confirmation + progress.
- `src/features/flow/lib/__tests__/project.test.ts`, `components/__tests__/ProjectViews.test.tsx`.

**Modified**
- `flow-core/src/{template,validate,load,issues,service,lib}.rs`, `run/{engine,prepare}.rs`.
- `src-tauri/src/commands/flow.rs`, `flow_run.rs` (event), `src-tauri/src/lib.rs` (handler list).
- `src/shared/types/{flow,flow-run}.ts`, `src/features/flow/lib/{flow-api,flow-run-api,transport}.ts`, `components/{FlowPanel,FlowWorkspace,RunStartDialog}.tsx`, `components/Flow.css`, `src/shared/i18n/locales/{ja,en}/flow.json`, existing tests.

---

### Task 1: Whole-object output reference `nodes.<id>.outputs`

**Files:**
- Modify: `src-tauri/crates/flow-core/src/template.rs` (enum `Reference` ~L13, `Display` ~L36, `parse_reference` ~L135, test `rejects_unsupported_references` ~L248)
- Modify: `src-tauri/crates/flow-core/src/validate.rs` (`reference` ~L618)
- Modify: `src-tauri/crates/flow-core/src/run/prepare.rs` (`TemplateContext::resolve` ~L236)

**Interfaces:**
- Produces: `Reference::NodeOutputs { node: String }` (parsed from `nodes.<id>.outputs`, displayed the same way); resolves at run time to the node's whole outputs map as a JSON object; validated like `NodeOutput` (node must be visible).

- [ ] **Step 1: Write the failing tests**

In `template.rs` tests, add:

```rust
#[test]
fn parses_the_whole_outputs_object_reference() {
    assert_eq!(
        parse_reference("nodes.verify.outputs"),
        Ok(Reference::NodeOutputs { node: "verify".into() })
    );
    assert_eq!(
        Reference::NodeOutputs { node: "verify".into() }.to_string(),
        "nodes.verify.outputs"
    );
}
```

and remove `"nodes.x.outputs"` from the list in `rejects_unsupported_references` (it is now supported).

In `run/prepare.rs` tests (module `tests` at the end of the file, which already has `use super::*;`), add:

```rust
#[test]
fn whole_outputs_reference_resolves_to_the_object() {
    use std::collections::BTreeMap;
    let params = BTreeMap::new();
    let env = BTreeMap::new();
    let outputs = |node: &str| {
        (node == "a").then(|| BTreeMap::from([("k".to_string(), Value::from(1))]))
    };
    let ctx = TemplateContext {
        params: &params,
        outputs: &outputs,
        vars: &[],
        iteration: None,
        run_id: "r",
        run_dir: Path::new("/run"),
        node_dir: None,
        project_root: Path::new("/proj"),
        env: &env,
    };
    assert_eq!(
        ctx.render_value("${{ nodes.a.outputs }}").unwrap(),
        serde_json::json!({ "k": 1 })
    );
    assert!(ctx.render_value("${{ nodes.b.outputs }}").is_err());
}
```

In `validate.rs` tests (or `tests.rs` using `errors_of`), add to `src-tauri/crates/flow-core/src/tests.rs`:

```rust
#[test]
fn whole_outputs_reference_needs_a_visible_node() {
    let ok = flow("nodes:\n  - { id: a, kind: command, run: [x] }\n  - { id: b, kind: command, run: [y, '${{ nodes.a.outputs }}'] }\nedges:\n  - { from: a, to: b }\n");
    assert!(errors_of(&ok).is_empty(), "{:?}", errors_of(&ok));
    let bad = flow("nodes:\n  - { id: b, kind: command, run: [y, '${{ nodes.zzz.outputs }}'] }\n");
    assert_eq!(errors_of(&bad), vec![FLOW_UNKNOWN_NODE_REF]);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri/`): `cargo test -p flow-core whole_outputs` → Expected: compile error (`NodeOutputs` not found) or the parse test failing with `BadReference`.

- [ ] **Step 3: Implement**

`template.rs`: add the variant after `NodeOutput`:

```rust
    /// `nodes.<id>.outputs` (the whole outputs object of a node)
    NodeOutputs { node: String },
```

In `Display`: `Reference::NodeOutputs { node } => write!(f, "nodes.{node}.outputs"),`.

In `parse_reference`, add the arm right after the `NodeOutput` arm:

```rust
        ["nodes", node, "outputs"] => Reference::NodeOutputs {
            node: node.to_string(),
        },
```

`validate.rs` `reference()`: change the `NodeOutput` guard arm so both variants share it:

```rust
            Reference::NodeOutput { node, .. } | Reference::NodeOutputs { node }
                if !ctx.visible.iter().any(|ids| ids.contains(node)) =>
            {
```

`run/prepare.rs` `resolve()`: add

```rust
            Reference::NodeOutputs { node } => (self.outputs)(node).map(|map| {
                Value::Object(map.into_iter().collect())
            }),
```

If any other exhaustive `match` on `Reference` exists (grep `Reference::NodeOutput` across `flow-core/src`), add the new arm there with the same meaning (`condition.rs` only collects references and needs no change unless it matches exhaustively).

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` → Expected: all pass, including the updated `rejects_unsupported_references`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src
git commit -m "feat(flow): allow referencing a node's whole outputs object"
```

---

### Task 2: `FLOW_OUTPUT_UNKNOWN` — callee outputs must declare referenced keys

**Files:**
- Modify: `src-tauri/crates/flow-core/src/issues.rs` (after `FLOW_FILE_TOO_LARGE`)
- Modify: `src-tauri/crates/flow-core/src/validate.rs` (`validate` ~L15, `Validator` ~L52, `reference` ~L618)
- Modify: `src-tauri/crates/flow-core/src/load.rs` (`check_text` ~L51, `check_content_at` ~L178, `RefChecker` ~L200, `flow_ref` ~L248)
- Modify: `src-tauri/crates/flow-core/src/tests.rs`
- Modify: `src/shared/types/flow.ts` (`FLOW_ERROR_CODES`), `src/shared/i18n/locales/{ja,en}/flow.json` (`issue` group)

**Interfaces:**
- Produces: `pub const FLOW_OUTPUT_UNKNOWN: &str = "FLOW_OUTPUT_UNKNOWN";` (error; params `node`, `key`, `ref`); `validate::validate_with_outputs(flow: &FlowDef, declared: &BTreeMap<String, BTreeSet<String>>) -> Issues` (keys: node ids whose output keys are known — sub-flow nodes with a resolved callee, file-body and inline loops); `validate::validate(flow)` keeps its signature and means "no declared outputs known"; `validate::LOOP_OUTPUT_KEYS: [&str; 4] = ["iterations", "failedIterations", "limitReached", "results"]`.
- Consumes: `Reference::NodeOutputs` (Task 1).

- [ ] **Step 1: Write the failing tests**

In `tests.rs` (file-references section, after `subflow_reference_is_resolved_and_arguments_checked`):

```rust
const CHILD_WITH_OUTPUTS: &str = "schemaVersion: 1\nid: child\nname: Child\nparams: { dir: { type: path, required: true } }\nnodes:\n  - { id: a, kind: command, run: [x, '${{ params.dir }}'] }\noutputs:\n  summary: \"${{ nodes.a.outputs.text }}\"\n";

fn parent_using_output(key: &str) -> String {
    flow(&format!(
        "nodes:\n  - {{ id: s, kind: subflow, flow: './child.flow.yaml', params: {{ dir: '/tmp' }} }}\n  - {{ id: use, kind: command, run: [echo, '${{{{ nodes.s.outputs.{key} }}}}'] }}\nedges:\n  - {{ from: s, to: use }}\n"
    ))
}

#[test]
fn subflow_output_references_must_be_declared_by_the_callee() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), CHILD_WITH_OUTPUTS);
    let parent = flows.join("parent.flow.yaml");
    let ok = check_content(root, &parent, &parent_using_output("summary"));
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
    let bad = check_content(root, &parent, &parent_using_output("nope"));
    assert_eq!(codes(&bad.errors), vec![FLOW_OUTPUT_UNKNOWN]);
    let issue = &bad.errors[0];
    assert_eq!(issue.path, "nodes[1].run[1]");
    assert_eq!(issue.params["node"], "s");
    assert_eq!(issue.params["key"], "nope");
    // The whole object is always allowed.
    let whole = flow("nodes:\n  - { id: s, kind: subflow, flow: './child.flow.yaml', params: { dir: '/tmp' } }\n  - { id: use, kind: command, run: [echo, '${{ nodes.s.outputs }}'] }\nedges:\n  - { from: s, to: use }\n");
    assert!(check_content(root, &parent, &whole).errors.is_empty());
}

#[test]
fn loop_output_references_use_the_fixed_keys() {
    let ok = flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: '${{ params.xs }}', maxIterations: 3, body: { nodes: [ { id: a, kind: command, run: [x] } ] } }\n  - { id: use, kind: command, run: [echo, '${{ nodes.l.outputs.results }}'] }\nparams: { xs: { type: string } }\nedges:\n  - { from: l, to: use }\n");
    assert!(errors_of(&ok).is_empty(), "{:?}", errors_of(&ok));
    let bad = flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: '${{ params.xs }}', maxIterations: 3, body: { nodes: [ { id: a, kind: command, run: [x] } ] } }\n  - { id: use, kind: command, run: [echo, '${{ nodes.l.outputs.total }}'] }\nparams: { xs: { type: string } }\nedges:\n  - { from: l, to: use }\n");
    assert_eq!(errors_of(&bad), vec![FLOW_OUTPUT_UNKNOWN]);
}

#[test]
fn output_check_is_skipped_when_the_callee_is_invalid() {
    // Review Focus 2: only FLOW_SUBFLOW_INVALID, no second error, no panic.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), "schemaVersion: 1\nid: child\nname: Child\nnodes: []\n");
    let parent = flows.join("parent.flow.yaml");
    let report = check_content(root, &parent, &parent_using_output("summary"));
    assert_eq!(codes(&report.errors), vec![FLOW_SUBFLOW_INVALID]);
}
```

(`CHILD`'s existing `params` requires `dir`, so `parent_using_output` passes it; the invalid child above has no nodes, which is a validation error.)

Note `errors_of` uses `check_text`, which has no file system: loop keys are checked there because loop outputs are fixed; the sub-flow case needs `check_content`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p flow-core output` → Expected: compile error (`FLOW_OUTPUT_UNKNOWN` not found).

- [ ] **Step 3: Implement**

`issues.rs`, after `FLOW_FILE_TOO_LARGE`:

```rust
/// A template names `nodes.<id>.outputs.<key>` but the node's outputs
/// (a sub-flow's declared `outputs`, a loop's fixed keys) have no such key.
pub const FLOW_OUTPUT_UNKNOWN: &str = "FLOW_OUTPUT_UNKNOWN";
```

`validate.rs`:

```rust
/// Output keys every loop node has (spec 2.3, run/driver.rs).
pub const LOOP_OUTPUT_KEYS: [&str; 4] = ["iterations", "failedIterations", "limitReached", "results"];

/// Validates `flow` and returns the findings.
pub fn validate(flow: &FlowDef) -> Issues {
    validate_with_outputs(flow, &BTreeMap::new())
}

/// Like [`validate`], additionally checking `nodes.<id>.outputs.<key>`
/// references against `declared` (node id → known output keys). Loop nodes
/// are added automatically with [`LOOP_OUTPUT_KEYS`].
pub fn validate_with_outputs(flow: &FlowDef, declared: &BTreeMap<String, BTreeSet<String>>) -> Issues {
    let mut known = declared.clone();
    collect_loop_outputs(&flow.nodes, &mut known);
    let mut v = Validator {
        issues: Issues::default(),
        params: flow.params.keys().cloned().collect(),
        env_passthrough: flow.env_passthrough.iter().cloned().collect(),
        known_outputs: known,
    };
    // ... the former body of `validate` unchanged from `v.flow_level(flow);` on
}

fn collect_loop_outputs(nodes: &[FlowNode], known: &mut BTreeMap<String, BTreeSet<String>>) {
    for node in nodes {
        if let NodeKind::Loop(lp) = &node.kind {
            known.insert(
                node.id.clone(),
                LOOP_OUTPUT_KEYS.iter().map(|k| k.to_string()).collect(),
            );
            if let LoopBody::Inline(body) = &lp.body {
                collect_loop_outputs(&body.nodes, known);
            }
        }
    }
}
```

Add the field `known_outputs: BTreeMap<String, BTreeSet<String>>` to `struct Validator`. In `reference()`, add a new arm **before** the `_ => {}` arm (after the existing visibility arm so an unknown node reports `FLOW_UNKNOWN_NODE_REF`, not both):

```rust
            Reference::NodeOutput { node, key }
                if self
                    .known_outputs
                    .get(node)
                    .is_some_and(|keys| !keys.contains(key)) =>
            {
                self.issues.error(
                    FlowIssue::new(FLOW_OUTPUT_UNKNOWN, path)
                        .with("node", node.clone())
                        .with("key", key.clone())
                        .with("ref", reference.to_string()),
                );
            }
```

`load.rs`: make `RefChecker` collect the declared outputs of resolved sub-flows and file bodies, then validate with them. Change `check_text` to a two-phase helper and `check_content_at` as follows:

```rust
/// Parses and decodes `text` without the semantic validation.
fn decode_text(text: &str, format: FlowFormat) -> (Option<FlowDef>, Issues) {
    let value = match parse_text(text, format) {
        Ok(value) => value,
        Err(issue) => {
            let mut issues = Issues::default();
            issues.error(issue);
            return (None, issues);
        }
    };
    let decoded = decode(&value);
    (decoded.flow, decoded.issues)
}

/// Parses, decodes and validates `text` (no file system).
pub fn check_text(text: &str, format: FlowFormat) -> (Option<FlowDef>, Issues) {
    let (flow, mut issues) = decode_text(text, format);
    if let Some(flow) = &flow {
        issues.extend(validate(flow));
    }
    (flow, issues)
}

fn check_content_at(
    project_root: &Path,
    file: &Path,
    text: &str,
    format: FlowFormat,
    stack: &mut Vec<PathBuf>,
) -> FlowReport {
    let (flow, mut issues) = decode_text(text, format);
    if let Some(flow) = &flow {
        let base = file.parent().unwrap_or(project_root).to_path_buf();
        let mut refs = RefChecker {
            project_root,
            base: &base,
            stack,
            issues: Issues::default(),
            declared_outputs: BTreeMap::new(),
        };
        refs.nodes(&flow.nodes, "");
        issues.extend(validate_with_outputs(flow, &refs.declared_outputs));
        issues.extend(refs.issues);
    }
    FlowReport::from_issues(flow, issues)
}
```

(Keep `check_text`'s current behavior for callers that only have text; if the existing `check_text` body differs from the sketch above — e.g. it already splits parse/decode — keep its logic and only extract `decode_text`.) Import `validate_with_outputs` from `crate::validate` and `BTreeSet` from `std::collections`.

In `RefChecker`, add the field `declared_outputs: BTreeMap<String, BTreeSet<String>>`, and give `flow_ref` the node id: change its signature to `fn flow_ref(&mut self, reference: &str, path: &str, args: &BTreeMap<String, Value>, node_path: &str, node_id: &str)` and update both call sites in `nodes()` to pass `&node.id`. At the end of `flow_ref`, after the `FLOW_PARAM_MISMATCH` loops (where `child` is the decoded callee), add:

```rust
        self.declared_outputs.insert(
            node_id.to_string(),
            child.outputs.keys().cloned().collect(),
        );
```

For a `LoopBody::File` loop the node's outputs are the fixed loop keys (handled by `collect_loop_outputs`), so in `nodes()` only the `Subflow` branch's result is used: for the loop branch pass the id too but, after `flow_ref` returns, remove the entry: `self.declared_outputs.remove(&node.id);` (the callee's outputs become `results[]` items, not node outputs).

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test -p flow-core` → Expected: all pass (the three new tests and every existing one).

- [ ] **Step 5: Mirror the code on the frontend**

`src/shared/types/flow.ts`: append `"FLOW_OUTPUT_UNKNOWN",` at the end of `FLOW_ERROR_CODES` (after `"FLOW_FILE_TOO_LARGE"`).

`src/shared/i18n/locales/en/flow.json`, inside `"issue"` after `FLOW_FILE_TOO_LARGE`:

```json
    "FLOW_OUTPUT_UNKNOWN": "Node \"{{node}}\" has no output \"{{key}}\" ({{ref}})."
```

`src/shared/i18n/locales/ja/flow.json`:

```json
    "FLOW_OUTPUT_UNKNOWN": "ノード「{{node}}」に出力「{{key}}」はありません（{{ref}}）。"
```

Run: `npx vitest run src/features/flow src/shared/i18n` → Expected: pass (mirror test, issue-message test, parity test).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/flow-core/src src/shared/types/flow.ts src/shared/i18n/locales
git commit -m "feat(flow): validate sub-flow output references against the callee's outputs"
```

---

### Task 3: `FLOW_PARAM_TYPE` — constant arguments must match the callee's param types

**Files:**
- Modify: `src-tauri/crates/flow-core/src/issues.rs`, `load.rs` (`flow_ref`), `tests.rs`
- Modify: `src/shared/types/flow.ts`, `src/shared/i18n/locales/{ja,en}/flow.json`

**Interfaces:**
- Produces: `pub const FLOW_PARAM_TYPE: &str = "FLOW_PARAM_TYPE";` (error; params `param`, `expected` (`string|number|bool|path`), `found` (`string|number|bool|null|array|object`)).

- [ ] **Step 1: Write the failing test**

In `tests.rs`, using the existing `CHILD` (params `dir: path required`, `opt: string default x`):

```rust
#[test]
fn constant_subflow_arguments_must_match_the_param_type() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), CHILD);
    let parent = flows.join("parent.flow.yaml");
    let bad = check_content(root, &parent, &subflow_parent("./child.flow.yaml", ", params: { dir: 42 }"));
    assert_eq!(codes(&bad.errors), vec![FLOW_PARAM_TYPE]);
    let issue = &bad.errors[0];
    assert_eq!(issue.path, "nodes[0].params.dir");
    assert_eq!(issue.params["expected"], "path");
    assert_eq!(issue.params["found"], "number");
    // Templated values are not checked here (run time does that).
    let templated = check_content(
        root,
        &parent,
        &flow("params: { n: { type: number } }\nnodes:\n  - { id: s, kind: subflow, flow: './child.flow.yaml', params: { dir: '${{ params.n }}' } }\n"),
    );
    assert!(templated.errors.is_empty(), "{:#?}", templated.errors);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p flow-core constant_subflow_arguments` → Expected: compile error (`FLOW_PARAM_TYPE` not found).

- [ ] **Step 3: Implement**

`issues.rs`, after `FLOW_OUTPUT_UNKNOWN`:

```rust
/// A constant argument to a sub-flow / file body has the wrong JSON type
/// for the callee's `params.<name>.type`.
pub const FLOW_PARAM_TYPE: &str = "FLOW_PARAM_TYPE";
```

`load.rs` `flow_ref`, inside the existing `for key in args.keys()` loop, replace the loop with one over `(key, value)` and add the type check for known params:

```rust
        for (key, value) in args {
            let Some(def) = child.params.get(key) else {
                self.issues.error(
                    FlowIssue::new(FLOW_PARAM_MISMATCH, format!("{node_path}.params.{key}"))
                        .with("param", key.clone())
                        .with("reason", "unknown"),
                );
                continue;
            };
            if let Value::String(text) = value {
                if crate::template::has_template(text) {
                    continue; // checked at run time
                }
            }
            let ok = match def.ty {
                ParamType::String | ParamType::Path => value.is_string(),
                ParamType::Number => value.is_number(),
                ParamType::Bool => value.is_boolean(),
            };
            if !ok {
                self.issues.error(
                    FlowIssue::new(FLOW_PARAM_TYPE, format!("{node_path}.params.{key}"))
                        .with("param", key.clone())
                        .with("expected", param_type_name(def.ty))
                        .with("found", json_type_name(value)),
                );
            }
        }
```

with two small helpers at module level in `load.rs`:

```rust
fn param_type_name(ty: ParamType) -> &'static str {
    match ty {
        ParamType::String => "string",
        ParamType::Number => "number",
        ParamType::Bool => "bool",
        ParamType::Path => "path",
    }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` → Expected: all pass.

- [ ] **Step 5: Mirror on the frontend**

`flow.ts`: append `"FLOW_PARAM_TYPE",` after `"FLOW_OUTPUT_UNKNOWN"` in `FLOW_ERROR_CODES`. en: `"FLOW_PARAM_TYPE": "Sub-flow parameter \"{{param}}\" expects {{expected}} but got {{found}}."`; ja: `"FLOW_PARAM_TYPE": "サブフローの引数「{{param}}」は {{expected}} 型ですが、{{found}} が渡されています。"`.

Run: `npx vitest run src/features/flow src/shared/i18n` → Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/flow-core/src src/shared/types/flow.ts src/shared/i18n/locales
git commit -m "feat(flow): check constant sub-flow arguments against the callee's param types"
```

---

### Task 4: Project manifest model, parser and validator

**Files:**
- Create: `src-tauri/crates/flow-core/src/project.rs`
- Modify: `src-tauri/crates/flow-core/src/lib.rs` (add `pub mod project;`), `parse.rs` (make `check_keys` and `parse_text` reachable: `pub(crate) fn check_keys`)
- Create: `src-tauri/tests/fixtures/projects/valid/video-gen.project.yaml`, `minimal.project.yaml`; `invalid/schema.project.yaml`, `bad-id.project.yaml`, `runtime-outside.project.yaml`, `runtime-unknown-field.project.yaml`, `setup-empty.project.yaml`, `setup-templated.project.yaml`, `metric-bad-ref.project.yaml`, `flows-bad-name.project.yaml`, `secret-bad-name.project.yaml`; `warnings/unknown-key.project.yaml`

**Interfaces:**
- Produces (all `pub` in `flow_core::project`):
  - `pub const PROJECT_FILE: &str = ".mdium/project.yaml";`
  - `pub const PROJECT_SCHEMA_VERSION: u32 = 1;`
  - `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")] pub struct ProjectDef { pub schema_version: u32, pub id: String, pub name: String, pub description: Option<String>, pub runtimes: BTreeMap<String, RuntimeDef>, pub setup: Vec<SetupStep>, pub secrets: Vec<String>, pub flows: BTreeMap<String, String>, pub metrics: Vec<MetricDef> }` (optional/collection fields `#[serde(default, skip_serializing_if = ...)]`)
  - `pub struct RuntimeDef { pub kind: RuntimeKind, pub python: PythonPath, pub module: String, pub cwd: String /* default "." */, pub env: BTreeMap<String, String> }`, `pub enum RuntimeKind { Python }` (serde lowercase), `#[serde(untagged)] pub enum PythonPath { One(String), Candidates(Vec<String>) }` with `impl PythonPath { pub fn candidates(&self) -> Vec<String> }`
  - `pub struct SetupStep { pub run: Vec<String>, pub working_dir: Option<String> }` (serde `workingDir`)
  - `pub struct MetricDef { #[serde(rename = "ref")] pub reference: String, pub better: Better }`, `pub enum Better { Higher, Lower }` (serde lowercase)
  - `pub struct ProjectReport { pub project: Option<ProjectDef>, pub errors: Vec<FlowIssue>, pub warnings: Vec<FlowIssue> }` (Serialize, camelCase)
  - `pub fn check_project_text(text: &str) -> ProjectReport` (parse + decode + validate, no file system)
  - `pub fn load_project(project_root: &Path) -> Option<ProjectReport>` — `None` when `.mdium/project.yaml` does not exist (or `.mdium` / the file is a link); `Some(report)` otherwise (read errors become `FLOW_PARSE_FAILED` / `FLOW_FILE_TOO_LARGE` issues like flow files)
  - `pub fn flow_roles(project: &ProjectDef) -> BTreeMap<String, String>` — maps project-relative flow display paths (`.mdium/<value>` normalized with `/`) to role names
  - `pub fn inside_root(relative: &str) -> bool` — lexical containment check (no absolute, no prefix/root, `..` never climbs above the start)

- [ ] **Step 1: Write the fixtures**

`src-tauri/tests/fixtures/projects/valid/video-gen.project.yaml` (the spec 2.1 example):

```yaml
schemaVersion: 1
id: video-gen
name: CEFR video generator
description: Spec 2.1 example
runtimes:
  video_gen:
    kind: python
    python: [.venv/Scripts/python.exe, .venv/bin/python]
    module: video_gen_flow
    cwd: .
    env: { PYTHONUTF8: "1" }
setup:
  - { run: [uv, sync], workingDir: . }
secrets: [GOOGLE_API_KEY, ANTHROPIC_API_KEY]
flows:
  main: flows/production-cycle.flow.yaml
  improve: flows/improve.flow.yaml
metrics:
  - { ref: outputs.avgVideoCoherence, better: higher }
  - { ref: outputs.coverage, better: higher }
  - { ref: costUsd, better: lower }
```

`valid/minimal.project.yaml`:

```yaml
schemaVersion: 1
id: minimal
name: Minimal
```

Invalid fixtures (one error each):

- `schema.project.yaml`: `schemaVersion: 2\nid: x\nname: X\n` → `FLOW_SCHEMA_UNSUPPORTED`
- `bad-id.project.yaml`: `schemaVersion: 1\nid: Bad_Id\nname: X\n` → `FLOW_INVALID_ID`
- `runtime-outside.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nruntimes:\n  r: { kind: python, python: ../python.exe, module: m }\n` → `FLOW_PATH_OUTSIDE_PROJECT`
- `runtime-unknown-field.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nruntimes:\n  r: { kind: python, python: .venv/bin/python, module: m, venv: x }\n` → `FLOW_UNKNOWN_FIELD`
- `setup-empty.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nsetup:\n  - { run: [] }\n` → `FLOW_INVALID_VALUE`
- `setup-templated.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nsetup:\n  - { run: [uv, '${{ params.x }}'] }\n` → `FLOW_INVALID_VALUE`
- `metric-bad-ref.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nmetrics:\n  - { ref: nodes.a.outputs.b, better: higher }\n` → `FLOW_INVALID_VALUE`
- `flows-bad-name.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nflows:\n  main: flows/main.yaml\n` → `FLOW_INVALID_VALUE`
- `secret-bad-name.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nsecrets: [lower-case]\n` → `FLOW_INVALID_ID`

`warnings/unknown-key.project.yaml`: `schemaVersion: 1\nid: x\nname: X\nowner: me\n` → warning `FLOW_UNKNOWN_KEY`.

- [ ] **Step 2: Write the failing tests**

In `project.rs` (test module at the bottom):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::issues::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/projects")
    }

    fn codes(issues: &[FlowIssue]) -> Vec<String> {
        let mut c: Vec<String> = issues.iter().map(|i| i.code.clone()).collect();
        c.sort();
        c
    }

    #[test]
    fn valid_fixtures_decode_without_issues() {
        for name in ["video-gen.project.yaml", "minimal.project.yaml"] {
            let text = fs::read_to_string(fixtures().join("valid").join(name)).unwrap();
            let report = check_project_text(&text);
            assert!(report.errors.is_empty(), "{name}: {:#?}", report.errors);
            assert!(report.warnings.is_empty(), "{name}: {:#?}", report.warnings);
            assert!(report.project.is_some(), "{name}");
        }
        let text = fs::read_to_string(fixtures().join("valid/video-gen.project.yaml")).unwrap();
        let project = check_project_text(&text).project.unwrap();
        assert_eq!(project.id, "video-gen");
        let rt = &project.runtimes["video_gen"];
        assert_eq!(rt.kind, RuntimeKind::Python);
        assert_eq!(rt.python.candidates(), vec![".venv/Scripts/python.exe", ".venv/bin/python"]);
        assert_eq!(rt.module, "video_gen_flow");
        assert_eq!(rt.cwd, ".");
        assert_eq!(project.setup[0].run, vec!["uv", "sync"]);
        assert_eq!(project.secrets, vec!["GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]);
        assert_eq!(project.metrics[2].reference, "costUsd");
        assert_eq!(project.metrics[2].better, Better::Lower);
        assert_eq!(
            flow_roles(&project),
            std::collections::BTreeMap::from([
                (".mdium/flows/production-cycle.flow.yaml".to_string(), "main".to_string()),
                (".mdium/flows/improve.flow.yaml".to_string(), "improve".to_string()),
            ])
        );
    }

    #[test]
    fn minimal_manifest_has_defaults() {
        let text = fs::read_to_string(fixtures().join("valid/minimal.project.yaml")).unwrap();
        let project = check_project_text(&text).project.unwrap();
        assert!(project.runtimes.is_empty() && project.setup.is_empty() && project.secrets.is_empty());
        assert!(project.flows.is_empty() && project.metrics.is_empty());
    }

    #[test]
    fn invalid_fixtures_report_exactly_their_error() {
        let cases = [
            ("schema", FLOW_SCHEMA_UNSUPPORTED),
            ("bad-id", FLOW_INVALID_ID),
            ("runtime-outside", FLOW_PATH_OUTSIDE_PROJECT),
            ("runtime-unknown-field", FLOW_UNKNOWN_FIELD),
            ("setup-empty", FLOW_INVALID_VALUE),
            ("setup-templated", FLOW_INVALID_VALUE),
            ("metric-bad-ref", FLOW_INVALID_VALUE),
            ("flows-bad-name", FLOW_INVALID_VALUE),
            ("secret-bad-name", FLOW_INVALID_ID),
        ];
        let dir = fixtures().join("invalid");
        let mut seen = 0;
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let stem = path.file_name().unwrap().to_str().unwrap().trim_end_matches(".project.yaml").to_string();
            let (_, expected) = cases.iter().find(|(n, _)| *n == stem).unwrap_or_else(|| panic!("{stem} has no expectation"));
            let report = check_project_text(&fs::read_to_string(&path).unwrap());
            assert_eq!(codes(&report.errors), vec![expected.to_string()], "{stem}: {:#?}", report.errors);
            assert!(report.project.is_none(), "{stem}");
            seen += 1;
        }
        assert_eq!(seen, cases.len());
    }

    #[test]
    fn unknown_top_level_key_is_a_warning() {
        let text = fs::read_to_string(fixtures().join("warnings/unknown-key.project.yaml")).unwrap();
        let report = check_project_text(&text);
        assert!(report.errors.is_empty());
        assert_eq!(codes(&report.warnings), vec![FLOW_UNKNOWN_KEY]);
        assert!(report.project.is_some());
    }

    #[test]
    fn python_candidates_need_not_exist_yet() {
        // Review Focus 3: existence is setup's job, not validation's.
        let report = check_project_text(
            "schemaVersion: 1\nid: x\nname: X\nruntimes:\n  r: { kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: m }\n",
        );
        assert!(report.errors.is_empty(), "{:#?}", report.errors);
    }

    #[test]
    fn load_project_distinguishes_missing_from_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load_project(tmp.path()).is_none());
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(tmp.path().join(PROJECT_FILE), "schemaVersion: 1\nid: x\nname: X\n").unwrap();
        let report = load_project(tmp.path()).unwrap();
        assert!(report.errors.is_empty() && report.project.is_some());
        fs::write(tmp.path().join(PROJECT_FILE), "{ not yaml").unwrap();
        let report = load_project(tmp.path()).unwrap();
        assert_eq!(codes(&report.errors), vec![FLOW_PARSE_FAILED]);
    }

    #[test]
    fn inside_root_rejects_escapes_and_absolute_paths() {
        assert!(inside_root(".venv/bin/python"));
        assert!(inside_root("./a/../b"));
        assert!(inside_root("."));
        assert!(!inside_root("../x"));
        assert!(!inside_root("a/../../x"));
        assert!(!inside_root("/abs"));
        assert!(!inside_root("C:\\abs"));
        assert!(!inside_root(""));
    }
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test -p flow-core project::` → Expected: compile error (module missing).

- [ ] **Step 4: Implement `project.rs`**

```rust
//! The project manifest `.mdium/project.yaml` (spec 2026-10-10, chapter 2):
//! runtimes, setup steps, secret names, flow roles and metrics. Parsed and
//! validated like flow files: unknown top-level keys warn, unknown nested
//! attributes are errors, paths stay inside the project.

use crate::issues::*;
use crate::load::MAX_FLOW_FILE_BYTES;
use crate::parse::{check_keys, parse_text, FlowFormat};
use crate::template::{has_template, is_ident};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path};

pub const PROJECT_FILE: &str = ".mdium/project.yaml";
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

const TOP_LEVEL_KEYS: &[&str] = &[
    "schemaVersion", "id", "name", "description", "runtimes", "setup", "secrets", "flows", "metrics",
];
const RUNTIME_KEYS: &[&str] = &["kind", "python", "module", "cwd", "env"];
const SETUP_KEYS: &[&str] = &["run", "workingDir"];
const METRIC_KEYS: &[&str] = &["ref", "better"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDef {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub runtimes: BTreeMap<String, RuntimeDef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup: Vec<SetupStep>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub flows: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub metrics: Vec<MetricDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Python,
}

/// One interpreter path or OS-specific candidates (the first that exists wins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PythonPath {
    One(String),
    Candidates(Vec<String>),
}

impl PythonPath {
    pub fn candidates(&self) -> Vec<String> {
        match self {
            PythonPath::One(p) => vec![p.clone()],
            PythonPath::Candidates(ps) => ps.clone(),
        }
    }
}

fn default_cwd() -> String {
    ".".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDef {
    pub kind: RuntimeKind,
    pub python: PythonPath,
    pub module: String,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub run: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Better {
    Higher,
    Lower,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricDef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub better: Better,
}

/// A checked manifest, as returned to the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReport {
    pub project: Option<ProjectDef>,
    pub errors: Vec<FlowIssue>,
    pub warnings: Vec<FlowIssue>,
}

impl ProjectReport {
    fn from_issues(project: Option<ProjectDef>, issues: Issues) -> Self {
        Self {
            project,
            errors: issues.errors,
            warnings: issues.warnings,
        }
    }
}

/// Parses, decodes and validates manifest text (no file system).
pub fn check_project_text(text: &str) -> ProjectReport {
    let mut issues = Issues::default();
    let value = match parse_text(text, FlowFormat::Yaml) {
        Ok(value) => value,
        Err(issue) => {
            issues.error(issue);
            return ProjectReport::from_issues(None, issues);
        }
    };
    let Some(root) = value.as_object() else {
        issues.error(FlowIssue::new(FLOW_INVALID_VALUE, "").with("reason", "not-an-object"));
        return ProjectReport::from_issues(None, issues);
    };
    match root.get("schemaVersion").and_then(Value::as_u64) {
        Some(v) if v == u64::from(PROJECT_SCHEMA_VERSION) => {}
        _ => {
            issues.error(
                FlowIssue::new(FLOW_SCHEMA_UNSUPPORTED, "schemaVersion")
                    .with("found", root.get("schemaVersion").cloned().unwrap_or(Value::Null))
                    .with("supported", PROJECT_SCHEMA_VERSION),
            );
            return ProjectReport::from_issues(None, issues);
        }
    }
    for key in root.keys() {
        if !TOP_LEVEL_KEYS.contains(&key.as_str()) {
            issues.warn(FlowIssue::new(FLOW_UNKNOWN_KEY, key.clone()).with("key", key.clone()));
        }
    }
    if let Some(runtimes) = root.get("runtimes").and_then(Value::as_object) {
        for (name, def) in runtimes {
            check_keys(def, &format!("runtimes.{name}"), RUNTIME_KEYS, &mut issues);
        }
    }
    if let Some(steps) = root.get("setup").and_then(Value::as_array) {
        for (i, step) in steps.iter().enumerate() {
            check_keys(step, &format!("setup[{i}]"), SETUP_KEYS, &mut issues);
        }
    }
    if let Some(metrics) = root.get("metrics").and_then(Value::as_array) {
        for (i, metric) in metrics.iter().enumerate() {
            check_keys(metric, &format!("metrics[{i}]"), METRIC_KEYS, &mut issues);
        }
    }
    if issues.has_errors() {
        return ProjectReport::from_issues(None, issues);
    }
    let known: serde_json::Map<String, Value> = root
        .iter()
        .filter(|(k, _)| TOP_LEVEL_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let project: ProjectDef = match serde_json::from_value(Value::Object(known)) {
        Ok(p) => p,
        Err(err) => {
            issues.error(
                FlowIssue::new(FLOW_INVALID_VALUE, "")
                    .with("reason", "decode")
                    .with("message", err.to_string()),
            );
            return ProjectReport::from_issues(None, issues);
        }
    };
    issues.extend(validate_project(&project));
    if issues.has_errors() {
        return ProjectReport::from_issues(None, issues);
    }
    ProjectReport::from_issues(Some(project), issues)
}

fn is_project_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn is_module_name(name: &str) -> bool {
    !name.is_empty() && name.split('.').all(|part| {
        let mut chars = part.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// True when `relative` is a relative path that never climbs above its start.
pub fn inside_root(relative: &str) -> bool {
    if relative.is_empty() {
        return false;
    }
    let mut depth: i64 = 0;
    for component in Path::new(relative).components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return false,
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
        }
    }
    true
}

fn invalid(path: impl Into<String>, reason: &str) -> FlowIssue {
    FlowIssue::new(FLOW_INVALID_VALUE, path).with("reason", reason)
}

fn outside(path: impl Into<String>, value: &str) -> FlowIssue {
    FlowIssue::new(FLOW_PATH_OUTSIDE_PROJECT, path).with("path", value)
}

/// Semantic checks of a decoded manifest.
pub fn validate_project(project: &ProjectDef) -> Issues {
    let mut issues = Issues::default();
    if !is_project_id(&project.id) {
        issues.error(FlowIssue::new(FLOW_INVALID_ID, "id").with("name", project.id.clone()));
    }
    if project.name.trim().is_empty() {
        issues.error(invalid("name", "empty"));
    }
    for (name, rt) in &project.runtimes {
        let path = format!("runtimes.{name}");
        if !is_ident(name) {
            issues.error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", name.clone()));
        }
        let candidates = rt.python.candidates();
        if candidates.is_empty() {
            issues.error(invalid(format!("{path}.python"), "empty"));
        }
        for (i, candidate) in candidates.iter().enumerate() {
            let p = format!("{path}.python[{i}]");
            if has_template(candidate) {
                issues.error(invalid(&p, "template-not-allowed"));
            } else if !inside_root(candidate) {
                issues.error(outside(&p, candidate));
            }
        }
        if !is_module_name(&rt.module) {
            issues.error(invalid(format!("{path}.module"), "bad-module-name"));
        }
        if has_template(&rt.module) {
            issues.error(invalid(format!("{path}.module"), "template-not-allowed"));
        }
        if !inside_root(&rt.cwd) {
            issues.error(outside(format!("{path}.cwd"), &rt.cwd));
        }
        for key in rt.env.keys() {
            if !is_env_name(key) {
                issues.error(FlowIssue::new(FLOW_INVALID_ID, format!("{path}.env.{key}")).with("name", key.clone()));
            }
        }
    }
    for (i, step) in project.setup.iter().enumerate() {
        let path = format!("setup[{i}]");
        if step.run.is_empty() {
            issues.error(invalid(format!("{path}.run"), "empty"));
        }
        for (j, arg) in step.run.iter().enumerate() {
            if has_template(arg) {
                issues.error(invalid(format!("{path}.run[{j}]"), "template-not-allowed"));
            }
        }
        if let Some(dir) = &step.working_dir {
            if !inside_root(dir) {
                issues.error(outside(format!("{path}.workingDir"), dir));
            }
        }
    }
    for (i, name) in project.secrets.iter().enumerate() {
        if !is_env_name(name) {
            issues.error(FlowIssue::new(FLOW_INVALID_ID, format!("secrets[{i}]")).with("name", name.clone()));
        }
    }
    for (role, file) in &project.flows {
        let path = format!("flows.{role}");
        if !is_ident(role) {
            issues.error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", role.clone()));
        }
        let is_flow_name = file
            .rsplit('/')
            .next()
            .and_then(FlowFormat::from_file_name)
            .is_some();
        if !is_flow_name {
            issues.error(invalid(&path, "bad-file-name"));
        } else if !inside_root(file) {
            issues.error(outside(&path, file));
        }
    }
    for (i, metric) in project.metrics.iter().enumerate() {
        let path = format!("metrics[{i}].ref");
        let ok = metric.reference == "costUsd"
            || metric
                .reference
                .strip_prefix("outputs.")
                .is_some_and(is_ident);
        if !ok {
            issues.error(invalid(&path, "bad-metric-ref"));
        }
    }
    issues
}

/// Project-relative flow display paths (`.mdium/<value>`, `/` separators) → role.
pub fn flow_roles(project: &ProjectDef) -> BTreeMap<String, String> {
    project
        .flows
        .iter()
        .map(|(role, file)| {
            let display = format!(".mdium/{}", file.trim_start_matches("./").replace('\\', "/"));
            (display, role.clone())
        })
        .collect()
}

/// Reads `<root>/.mdium/project.yaml`; `None` when it does not exist.
pub fn load_project(project_root: &Path) -> Option<ProjectReport> {
    let file = project_root.join(PROJECT_FILE);
    for probe in [project_root.join(".mdium"), file.clone()] {
        match std::fs::symlink_metadata(&probe) {
            Ok(meta) if meta.file_type().is_symlink() => return None,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    let mut issues = Issues::default();
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(err) => {
            issues.error(FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", err.to_string()));
            return Some(ProjectReport::from_issues(None, issues));
        }
    };
    if bytes.len() as u64 > MAX_FLOW_FILE_BYTES {
        issues.error(
            FlowIssue::new(FLOW_FILE_TOO_LARGE, "")
                .with("size", bytes.len())
                .with("limit", MAX_FLOW_FILE_BYTES),
        );
        return Some(ProjectReport::from_issues(None, issues));
    }
    let Ok(text) = String::from_utf8(bytes) else {
        issues.error(FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", "file is not valid UTF-8"));
        return Some(ProjectReport::from_issues(None, issues));
    };
    Some(check_project_text(&text))
}
```

`parse.rs`: change `fn check_keys(` to `pub(crate) fn check_keys(` (and `parse_text` is already `pub`). `lib.rs`: add `pub mod project;` (alphabetical, after `parse`). If `FLOW_PATH_OUTSIDE_PROJECT` has `#[allow(dead_code)]` or is unused elsewhere, leave the attribute; it is now used.

- [ ] **Step 5: Run the tests**

Run: `cargo test -p flow-core project::` → Expected: 7 passed. Then `cargo test -p flow-core` → all pass; `cargo build` → no warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/flow-core/src src-tauri/tests/fixtures/projects
git commit -m "feat(flow): parse and validate the project manifest"
```

---

### Task 5: `lib/` parts — grouped listing with signatures, parts cannot start

**Files:**
- Modify: `src-tauri/crates/flow-core/src/load.rs` (`FlowSummary` ~L356, `list_flows` ~L378)
- Modify: `src-tauri/crates/flow-core/src/service.rs` (`FlowLoadResult`, `load_flow`, `validate_flow`)
- Modify: `src-tauri/crates/flow-core/src/run/engine.rs` (`start`, error code)
- Modify: `src-tauri/crates/flow-core/src/tests.rs` (`list_flows_summarizes_flow_files_only`), `service.rs` tests
- Modify: `src/shared/types/flow.ts` (`FlowSummary`, `FlowLoadResult`), `src/features/flow/components/__tests__/FlowViews.test.tsx` (mock data)

**Interfaces:**
- Produces:
  - `pub enum FlowKind { Entry, Part }` (serde lowercase) in `load.rs`; `pub fn flow_kind_of(display_path: &str) -> FlowKind` (`.mdium/flows/lib/` prefix → `Part`).
  - `FlowSummary` gains `kind: FlowKind`, `role: Option<String>` (skip if none), `description: Option<String>`, `params: BTreeMap<String, ParamDef>`, `outputs: Vec<String>` (declared output keys, sorted).
  - `list_flows` lists entries (files directly in `.mdium/flows/`) and parts (`.mdium/flows/lib/**`, recursive, links skipped), sorted by path; roles come from `project::load_project` when the manifest decodes.
  - `FlowLoadResult` gains `kind: FlowKind`.
  - Engine: `pub const FLOW_RUN_NOT_ENTRY: &str = "FLOW_RUN_NOT_ENTRY";` returned by `start` for a part path.
  - TS: `export type FlowKind = "entry" | "part";` on `FlowSummary` and `FlowLoadResult`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `list_flows_summarizes_flow_files_only` in `tests.rs` with:

```rust
#[test]
fn list_flows_groups_entries_and_lib_parts() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    assert!(list_flows(root).unwrap().is_empty(), "missing dir yields empty list");
    let flows = root.join(".mdium/flows");
    write(
        &flows.join("b.flow.yaml"),
        &flow("description: Entry B\nparams: { n: { type: number, default: 1 } }\nnodes:\n  - { id: a, kind: command, run: [x] }\noutputs: { total: \"${{ nodes.a.outputs.n }}\" }\n"),
    );
    write(&flows.join("a.flow.json"), "{ not json");
    write(&flows.join("notes.md"), "ignored");
    write(&flows.join("nested/c.flow.yaml"), "ignored: true");
    write(&flows.join("lib/part.flow.yaml"), &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n"));
    write(&flows.join("lib/deep/inner.flow.yaml"), &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n"));
    write(&root.join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nflows: { main: flows/b.flow.yaml }\n");
    let list = list_flows(root).unwrap();
    let paths: Vec<&str> = list.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            ".mdium/flows/a.flow.json",
            ".mdium/flows/b.flow.yaml",
            ".mdium/flows/lib/deep/inner.flow.yaml",
            ".mdium/flows/lib/part.flow.yaml",
        ]
    );
    assert_eq!((list[0].kind, list[0].id.clone(), list[0].error_count), (FlowKind::Entry, None, 1));
    let b = &list[1];
    assert_eq!((b.kind, b.id.as_deref(), b.role.as_deref()), (FlowKind::Entry, Some("t"), Some("main")));
    assert_eq!(b.description.as_deref(), Some("Entry B"));
    assert_eq!(b.params.keys().cloned().collect::<Vec<_>>(), vec!["n"]);
    assert_eq!(b.outputs, vec!["total"]);
    assert_eq!(list[2].kind, FlowKind::Part);
    assert_eq!(list[3].kind, FlowKind::Part);
    assert!(list[3].role.is_none());
}
```

In `service.rs` tests, add:

```rust
    #[test]
    fn parts_cannot_be_started() {
        use crate::run::engine::FLOW_RUN_NOT_ENTRY;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows/lib")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/lib/p.flow.yaml"), OK).unwrap();
        let review = svc.command_review(root, ".mdium/flows/lib/p.flow.yaml").unwrap();
        svc.confirm_commands(root, ".mdium/flows/lib/p.flow.yaml", &review.sha256).unwrap();
        let err = svc
            .run_start(root, ".mdium/flows/lib/p.flow.yaml", &BTreeMap::new(), &review.sha256)
            .unwrap_err();
        assert_eq!(err.code, FLOW_RUN_NOT_ENTRY);
        let loaded = svc.load_flow(root, ".mdium/flows/lib/p.flow.yaml").unwrap();
        assert_eq!(loaded.kind, crate::load::FlowKind::Part);
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core list_flows_groups parts_cannot` → Expected: compile errors (`FlowKind`, `role`, `FLOW_RUN_NOT_ENTRY` missing).

- [ ] **Step 3: Implement**

`load.rs`:

```rust
/// Entry flows run directly; parts (`.mdium/flows/lib/**`) are called by others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowKind {
    Entry,
    Part,
}

pub const LIB_DIR_PREFIX: &str = ".mdium/flows/lib/";

/// Kind of a flow by its project-relative display path.
pub fn flow_kind_of(display_path: &str) -> FlowKind {
    if display_path.starts_with(LIB_DIR_PREFIX) {
        FlowKind::Part
    } else {
        FlowKind::Entry
    }
}

/// One entry of [`list_flows`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    /// Project-relative path with `/` separators.
    pub path: String,
    pub kind: FlowKind,
    /// Role from the manifest's `flows` (e.g. `main`), when listed there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub id: Option<String>,
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The signature: declared params and output keys (empty when not decoded).
    pub params: BTreeMap<String, ParamDef>,
    pub outputs: Vec<String>,
    pub error_count: usize,
    pub warning_count: usize,
}
```

Rewrite `list_flows`:

```rust
/// Lists and checks the flow files in `<root>/.mdium/flows/` (entries) and
/// `<root>/.mdium/flows/lib/**` (parts); links are skipped; other
/// sub-directories are ignored. A missing directory yields an empty list.
pub fn list_flows(project_root: &Path) -> std::io::Result<Vec<FlowSummary>> {
    let dir = project_root.join(FLOWS_DIR);
    for sub in [project_root.join(".mdium"), dir.clone()] {
        match std::fs::symlink_metadata(&sub) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Ok(vec![]),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(err) => return Err(err),
        }
    }
    let mut files = Vec::new();
    collect_flow_files(&dir, false, &mut files)?;
    let lib = dir.join("lib");
    if matches!(std::fs::symlink_metadata(&lib), Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink()) {
        collect_flow_files(&lib, true, &mut files)?;
    }
    files.sort();
    let roles = crate::project::load_project(project_root)
        .and_then(|report| report.project)
        .map(|project| crate::project::flow_roles(&project))
        .unwrap_or_default();
    Ok(files
        .iter()
        .map(|file| {
            let report = check_file(project_root, file);
            let path = relative_display(project_root, file);
            let flow = report.flow.as_ref();
            FlowSummary {
                kind: flow_kind_of(&path),
                role: roles.get(&path).cloned(),
                id: flow.map(|f| f.id.clone()),
                name: flow.map(|f| f.name.clone()),
                description: flow.and_then(|f| f.description.clone()),
                params: flow.map(|f| f.params.clone()).unwrap_or_default(),
                outputs: flow.map(|f| f.outputs.keys().cloned().collect()).unwrap_or_default(),
                error_count: report.errors.len(),
                warning_count: report.warnings.len(),
                path,
            }
        })
        .collect())
}

/// Flow files directly in `dir`, descending into sub-directories when `recursive`.
fn collect_flow_files(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_file() && FlowFormat::from_file_name(&name).is_some() {
            out.push(entry.path());
        } else if recursive && file_type.is_dir() {
            collect_flow_files(&entry.path(), true, out)?;
        }
    }
    Ok(())
}
```

(`file_type().is_dir()` is false for symlinked directories, so links are skipped as before.)

`service.rs`: add `pub kind: FlowKind` to `FlowLoadResult` (after `format`), and set `kind: flow_kind_of(&path_display)` in both `load_flow` and `validate_flow` (compute the display path first, then build the struct). Import `crate::load::{flow_kind_of, FlowKind}`.

`run/engine.rs`: add `pub const FLOW_RUN_NOT_ENTRY: &str = "FLOW_RUN_NOT_ENTRY";` beside the other operation codes, and in `start`, right after `let bundle = load_bundle(root, rel)?;`:

```rust
        if crate::load::flow_kind_of(&bundle.display) == crate::load::FlowKind::Part {
            return Err(EngineError::new(
                FLOW_RUN_NOT_ENTRY,
                "flows under .mdium/flows/lib/ are parts and cannot be started directly",
            ));
        }
```

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test -p flow-core` → Expected: all pass. Fix any test that constructs `FlowSummary` or `FlowLoadResult` literally (grep for `FlowSummary {` / `FlowLoadResult {` in tests).

- [ ] **Step 5: Mirror on the frontend**

`src/shared/types/flow.ts`:

```ts
export type FlowKind = "entry" | "part";

/** One entry of `flow_list`. */
export interface FlowSummary {
  path: string;
  kind: FlowKind;
  /** Role from the manifest's `flows` (e.g. `main`). */
  role?: string;
  id: string | null;
  name: string | null;
  description?: string;
  params: Record<string, FlowParamDef>;
  outputs: string[];
  errorCount: number;
  warningCount: number;
}
```

and add `kind: FlowKind;` to `FlowLoadResult` after `format`. Update every test object literal typed as `FlowSummary` / `FlowLoadResult` (`FlowViews.test.tsx`, `RunViews.test.tsx` if any) to include `kind: "entry"`, `params: {}`, `outputs: []`.

Add the i18n key for the engine error in both locales under `runError`: en `"FLOW_RUN_NOT_ENTRY": "This flow is a part (under lib/) and cannot be started directly."`, ja `"FLOW_RUN_NOT_ENTRY": "このフローは部品（lib/ 配下）のため、直接は実行できません。"`.

Run: `npm test` and `npx tsc --noEmit -p tsconfig.json` → Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/flow-core/src src/shared src/features/flow
git commit -m "feat(flow): list lib/ parts with their signature and refuse to start them"
```

---

### Task 6: `flow_project_load` command

**Files:**
- Modify: `src-tauri/crates/flow-core/src/service.rs` (`FlowService::project_load`, `call`, `COMMAND_NAMES`), `src-tauri/src/commands/flow.rs`, `src-tauri/src/lib.rs` (handler list)
- Modify: `src/shared/types/flow.ts` (project types), `src/features/flow/lib/flow-api.ts`, `src/features/flow/lib/__tests__/flow-api.test.ts`

**Interfaces:**
- Produces:
  - `pub struct ProjectLoadResult { pub exists: bool, pub path: String /* ".mdium/project.yaml" */, #[serde(flatten)] pub report: ProjectReport }` in `service.rs`; `FlowService::project_load(&self, project_root: &str) -> Result<ProjectLoadResult, FlowCommandError>` (when the file does not exist: `exists: false`, empty report with `project: None`).
  - `COMMAND_NAMES: [&str; 18]` with `"flow_project_load"`; `call` arm with `RootArgs`.
  - Tauri `flow_project_load(state, project_root)` in `commands/flow.rs`, registered in `lib.rs`.
  - TS: `ProjectDef`, `RuntimeDef`, `SetupStep`, `MetricDef`, `ProjectLoadResult` in `flow.ts`; `flowApi.projectLoad(projectRoot) => Promise<ProjectLoadResult>`.
- Consumes: Task 4.

- [ ] **Step 1: Write the failing tests**

`service.rs` tests:

```rust
    #[test]
    fn project_load_reports_missing_and_present_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let missing = svc.project_load(root).unwrap();
        assert!(!missing.exists && missing.report.project.is_none() && missing.report.errors.is_empty());
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nsecrets: [A_KEY]\n").unwrap();
        let present = svc.project_load(root).unwrap();
        assert!(present.exists);
        assert_eq!(present.report.project.as_ref().unwrap().secrets, vec!["A_KEY"]);
        let json = serde_json::to_value(&present).unwrap();
        assert_eq!(json["path"], ".mdium/project.yaml");
        assert_eq!(json["project"]["id"], "p");
        let via_call = svc.call("flow_project_load", serde_json::json!({ "projectRoot": root })).unwrap();
        assert_eq!(via_call["exists"], true);
    }
```

`flow-api.test.ts`: add to the `it.each` table: `["projectLoad", () => flowApi.projectLoad(ROOT), "flow_project_load", { projectRoot: ROOT }],`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core project_load` → compile error; `npx vitest run src/features/flow/lib/__tests__/flow-api.test.ts` → FAIL (`projectLoad` is not a function).

- [ ] **Step 3: Implement**

`service.rs`:

```rust
use crate::project::{load_project, ProjectReport, PROJECT_FILE};

/// `flow_project_load` result: the manifest, or `exists: false`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLoadResult {
    pub exists: bool,
    pub path: String,
    #[serde(flatten)]
    pub report: ProjectReport,
}

impl FlowService {
    /// Reads and validates `.mdium/project.yaml` (spec 2.4).
    pub fn project_load(&self, project_root_arg: &str) -> Result<ProjectLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let (exists, report) = match load_project(&root) {
            Some(report) => (true, report),
            None => (false, ProjectReport { project: None, errors: vec![], warnings: vec![] }),
        };
        Ok(ProjectLoadResult { exists, path: PROJECT_FILE.to_string(), report })
    }
}
```

(`ProjectReport`'s fields are `pub`, so the literal above compiles; put the `impl` block next to the other service methods.) In `COMMAND_NAMES` change the length to 18 and append `"flow_project_load"`; in `call` add:

```rust
            "flow_project_load" => {
                let a: RootArgs = args(value)?;
                reply(self.project_load(&a.project_root)?)
            }
```

`commands/flow.rs`:

```rust
#[tauri::command]
pub async fn flow_project_load(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<ProjectLoadResult, FlowCommandError> {
    with_service(state, move |s| s.project_load(&project_root)).await
}
```

(import `flow_core::service::ProjectLoadResult`). `lib.rs`: add `commands::flow::flow_project_load,` after `commands::flow::flow_validate,`.

`src/shared/types/flow.ts`:

```ts
/** `.mdium/project.yaml` (spec 2026-10-10, 2.1). */
export interface RuntimeDef {
  kind: "python";
  python: string | string[];
  module: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface SetupStep {
  run: string[];
  workingDir?: string;
}

export interface MetricDef {
  ref: string;
  better: "higher" | "lower";
}

export interface ProjectDef {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  runtimes?: Record<string, RuntimeDef>;
  setup?: SetupStep[];
  secrets?: string[];
  flows?: Record<string, string>;
  metrics?: MetricDef[];
}

/** `flow_project_load` result. */
export interface ProjectLoadResult {
  exists: boolean;
  path: string;
  project: ProjectDef | null;
  errors: FlowIssue[];
  warnings: FlowIssue[];
}

/** Interpreter candidates of a runtime (one path or OS-specific candidates). */
export function pythonCandidates(runtime: RuntimeDef): string[] {
  return Array.isArray(runtime.python) ? runtime.python : [runtime.python];
}
```

`flow-api.ts`: add `projectLoad: (projectRoot: string) => call<ProjectLoadResult>("flow_project_load", { projectRoot }),` to `flowApi` and import the type.

- [ ] **Step 4: Run the tests**

Run: `cargo test --workspace` → pass (the parity test sees the new handler in `lib.rs`); `npm test` and `npx tsc --noEmit -p tsconfig.json` → pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri src/shared src/features/flow
git commit -m "feat(flow): expose the project manifest through flow_project_load"
```

---

### Task 7: Confirmation covers the manifest; secrets are checked at run start

**Files:**
- Modify: `src-tauri/crates/flow-core/src/run/engine.rs` (`Bundle`, `hash`, `load_bundle`, `CommandReview`, `review_commands`, `require_confirmed`, `start`), `run/tests.rs` (or `service.rs` tests)
- Modify: `src/shared/types/flow-run.ts` (`CommandReview`), `src/features/flow/components/RunStartDialog.tsx`, `src/features/flow/components/__tests__/RunViews.test.tsx`, `src/shared/i18n/locales/{ja,en}/flow.json`

**Interfaces:**
- Produces:
  - `pub struct RuntimeSummary { pub name: String, pub python: Vec<String>, pub module: String, pub cwd: String }`, `pub struct SetupSummary { pub run: Vec<String>, pub working_dir: Option<String> }` (camelCase) in `engine.rs`; `CommandReview` gains `pub runtimes: Vec<RuntimeSummary>`, `pub setup: Vec<SetupSummary>`, `pub project_path: Option<String>` (`.mdium/project.yaml` when hashed in).
  - `Bundle` gains `project: Option<(String, String)>` (display path, sha256 of the manifest bytes); `hash()` includes it as one more `path\tsha` line (the single-file shortcut applies only when there are no others **and** no manifest).
  - `confirmed` / `require_confirmed` / `start` treat the flow as needing confirmation when `commands`, `runtimes` or `setup` is non-empty.
  - `pub const FLOW_SECRET_MISSING: &str = "FLOW_SECRET_MISSING";` — `start` fails with it (details: one `Reason` per missing name with param `name`) when the manifest decodes and any `secrets` name is absent or empty in `DriverEnv.process_env`. A manifest with errors is ignored by `start` (its issues surface in the UI through `flow_project_load`), but its bytes are still hashed.
  - TS `CommandReview { path; sha256; confirmed; commands; runtimes: RuntimeSummary[]; setup: SetupSummary[]; projectPath?: string }`.
- Consumes: Task 4 (`load_project`, `flow_roles` unused here), Task 6 for the TS manifest types (`pythonCandidates` not needed; `RuntimeSummary.python` is already an array).

- [ ] **Step 1: Write the failing tests**

In `service.rs` tests (they can build a service and write files):

```rust
    const MANIFEST: &str = "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: { kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: m }\nsetup:\n  - { run: [uv, sync] }\nsecrets: [MDIUM_TEST_SECRET]\n";
    const NO_COMMANDS: &str = "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: approval, message: hi }\n";

    #[test]
    fn manifest_runtimes_and_setup_require_confirmation_and_change_the_hash() {
        // Review Focus 1 and 3.
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        let before = svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap();
        assert!(before.confirmed && before.runtimes.is_empty() && before.project_path.is_none());
        fs::write(tmp.path().join(".mdium/project.yaml"), MANIFEST).unwrap();
        let review = svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap();
        assert_ne!(review.sha256, before.sha256);
        assert!(!review.confirmed);
        assert_eq!(review.project_path.as_deref(), Some(".mdium/project.yaml"));
        assert_eq!(review.runtimes[0].name, "r");
        assert_eq!(review.runtimes[0].python, vec![".venv/Scripts/python.exe", ".venv/bin/python"]);
        assert_eq!(review.runtimes[0].module, "m");
        assert_eq!(review.setup[0].run, vec!["uv", "sync"]);
        // Starting before confirming is refused; after confirming, the secret check runs.
        let err = svc.run_start(root, ".mdium/flows/a.flow.yaml", &BTreeMap::new(), &review.sha256).unwrap_err();
        assert_eq!(err.code, crate::run::engine::FLOW_COMMANDS_UNCONFIRMED);
        svc.confirm_commands(root, ".mdium/flows/a.flow.yaml", &review.sha256).unwrap();
        let err = svc.run_start(root, ".mdium/flows/a.flow.yaml", &BTreeMap::new(), &review.sha256).unwrap_err();
        assert_eq!(err.code, crate::run::engine::FLOW_SECRET_MISSING);
        assert_eq!(err.details[0].params["name"], "MDIUM_TEST_SECRET");
        // Editing the manifest invalidates the confirmation.
        fs::write(tmp.path().join(".mdium/project.yaml"), MANIFEST.replace("uv, sync", "uv, sync, --frozen")).unwrap();
        assert!(!svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap().confirmed);
    }
```

(`fs`, `BTreeMap`, `OK`, `service` are already in scope in that test module.) The secret check needs a service whose `process_env` lacks the name; the test helper passes an empty map, so this holds. Add a second test that **passes** when the env has it:

```rust
    #[test]
    fn present_secrets_do_not_block_start() {
        let tmp = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("MDIUM_TEST_SECRET".to_string(), "x".to_string())]);
        let svc = service_with_env(tmp.path(), env);
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nsecrets: [MDIUM_TEST_SECRET]\n").unwrap();
        let review = svc.command_review(root, ".mdium/flows/a.flow.yaml").unwrap();
        assert!(review.confirmed, "no commands, runtimes or setup: nothing to confirm");
        let started = svc.run_start(root, ".mdium/flows/a.flow.yaml", &BTreeMap::new(), &review.sha256).unwrap();
        assert!(!started.run_id.is_empty());
        svc.run_cancel(root, &started.run_id).unwrap();
    }
```

Refactor the test helper so `service(dir)` calls `service_with_env(dir, BTreeMap::new())` and `service_with_env` sets `process_env: Arc::new(env)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core manifest_runtimes present_secrets` → compile errors (`runtimes`, `project_path`, `FLOW_SECRET_MISSING` missing).

- [ ] **Step 3: Implement**

`engine.rs`:

```rust
pub const FLOW_SECRET_MISSING: &str = "FLOW_SECRET_MISSING";

/// A runtime of the manifest, as shown for confirmation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    pub name: String,
    pub python: Vec<String>,
    pub module: String,
    pub cwd: String,
}

/// A setup step of the manifest, as shown for confirmation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSummary {
    pub run: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}
```

`CommandReview` gains, after `commands`: `pub runtimes: Vec<RuntimeSummary>`, `pub setup: Vec<SetupSummary>`, `#[serde(skip_serializing_if = "Option::is_none")] pub project_path: Option<String>`.

`Bundle` gains `project: Option<ProjectInBundle>` with

```rust
/// The manifest as read when the bundle was loaded.
struct ProjectInBundle {
    display: String,
    sha: String,
    project: Option<crate::project::ProjectDef>,
}
```

In `load_bundle`, after reading the root flow, read the manifest bytes directly (so the hash is over the exact bytes):

```rust
    let project = {
        let file = root.join(crate::project::PROJECT_FILE);
        match crate::project::load_project(root) {
            None => None,
            Some(report) => {
                let bytes = std::fs::read(&file)
                    .map_err(|e| EngineError::new(FLOW_FILE_INVALID, format!("project.yaml: {e}")))?;
                Some(ProjectInBundle {
                    display: crate::project::PROJECT_FILE.to_string(),
                    sha: sha256_hex(&bytes),
                    project: report.project,
                })
            }
        }
    };
```

and put it in the returned `Bundle`. Change `hash()`:

```rust
    fn hash(&self) -> String {
        if self.others.is_empty() && self.project.is_none() {
            return self.root_sha.clone();
        }
        let mut text = String::from("mdium-flow-bundle-v1\n");
        let mut files: Vec<(&str, &str)> = vec![(self.display.as_str(), self.root_sha.as_str())];
        files.extend(self.others.iter().map(|(p, (sha, _))| (p.as_str(), sha.as_str())));
        if let Some(project) = &self.project {
            files.push((project.display.as_str(), project.sha.as_str()));
        }
        files.sort();
        for (path, sha) in files {
            text.push_str(&format!("{path}\t{sha}\n"));
        }
        sha256_hex(text.as_bytes())
    }

    fn runtime_summaries(&self) -> Vec<RuntimeSummary> {
        self.project
            .as_ref()
            .and_then(|p| p.project.as_ref())
            .map(|p| {
                p.runtimes
                    .iter()
                    .map(|(name, rt)| RuntimeSummary {
                        name: name.clone(),
                        python: rt.python.candidates(),
                        module: rt.module.clone(),
                        cwd: rt.cwd.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn setup_summaries(&self) -> Vec<SetupSummary> {
        self.project
            .as_ref()
            .and_then(|p| p.project.as_ref())
            .map(|p| {
                p.setup
                    .iter()
                    .map(|s| SetupSummary { run: s.run.clone(), working_dir: s.working_dir.clone() })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Anything the user must confirm before this content runs.
    fn needs_confirmation(&self) -> bool {
        !command_summaries(&self.files()).is_empty()
            || !self.runtime_summaries().is_empty()
            || !self.setup_summaries().is_empty()
    }
```

`review_commands`:

```rust
        let confirmed = !bundle.needs_confirmation() || self.is_confirmed(root, &bundle.display, &sha256);
        Ok(CommandReview {
            path: bundle.display.clone(),
            sha256,
            confirmed,
            commands,
            runtimes: bundle.runtime_summaries(),
            setup: bundle.setup_summaries(),
            project_path: bundle.project.as_ref().map(|p| p.display.clone()),
        })
```

`start`: replace the `has_commands` check with `if bundle.needs_confirmation() && !self.is_confirmed(root, &display, &actual)`; then, before `prepare_params`, add the secret check:

```rust
        if let Some(project) = bundle.project.as_ref().and_then(|p| p.project.as_ref()) {
            let missing: Vec<Reason> = project
                .secrets
                .iter()
                .filter(|name| self.env.process_env.get(*name).is_none_or(|v| v.is_empty()))
                .map(|name| Reason::new(FLOW_SECRET_MISSING).with("name", name.clone()))
                .collect();
            if !missing.is_empty() {
                return Err(EngineError::new(
                    FLOW_SECRET_MISSING,
                    "environment variables named in project.yaml `secrets` are not set",
                )
                .with_details(missing));
            }
        }
```

(`is_none_or` needs Rust 1.82+; use `.map_or(true, |v| v.is_empty())` if the toolchain is older.) Leave `require_confirmed` (used on reattach after a restart) unchanged: it checks the stored `meta.flow_sha256`, which a run started after this task already computed over the manifest bytes, and `RunMeta` does not store the manifest itself.

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test --workspace` → all pass. Existing engine tests that assert a flow without commands is `confirmed` still hold (no manifest in their temp dirs).

- [ ] **Step 5: Frontend review sections**

`src/shared/types/flow-run.ts`:

```ts
export interface RuntimeSummary {
  name: string;
  python: string[];
  module: string;
  cwd: string;
}

export interface SetupSummary {
  run: string[];
  workingDir?: string;
}

export interface CommandReview {
  path: string;
  sha256: string;
  confirmed: boolean;
  commands: CommandSummary[];
  runtimes: RuntimeSummary[];
  setup: SetupSummary[];
  projectPath?: string;
}
```

`RunStartDialog.tsx`: compute `const reviewItems = review ? review.commands.length + review.runtimes.length + review.setup.length : 0;` and `const needsConfirmation = !!review && !review.confirmed && reviewItems > 0;`. After the commands `<section>`, add two sections rendered only when non-empty:

```tsx
      {review && review.runtimes.length > 0 && (
        <section className="flow-dialog__section">
          <h3 className="flow-dialog__heading">{t("run.runtimesTitle")}</h3>
          <div className="flow-dialog__muted">{t("run.runtimesHint", { path: review.projectPath ?? ".mdium/project.yaml" })}</div>
          <ul className="flow-dialog__commands">
            {review.runtimes.map((rt) => (
              <li key={rt.name} className="flow-dialog__command">
                <div className="flow-dialog__command-head">
                  <strong>{rt.name}</strong>
                  <span className="flow-dialog__badge">{t("run.runtimePython")}</span>
                </div>
                {rt.python.map((p) => (
                  <code key={p} className="flow-dialog__code">{p}</code>
                ))}
                <div className="flow-dialog__muted">{t("run.runtimeModule", { module: rt.module })}</div>
                <div className="flow-dialog__muted">{t("run.workingDir", { dir: rt.cwd })}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {review && review.setup.length > 0 && (
        <section className="flow-dialog__section">
          <h3 className="flow-dialog__heading">{t("run.setupTitle")}</h3>
          <ul className="flow-dialog__commands">
            {review.setup.map((step, i) => (
              <li key={i} className="flow-dialog__command">
                <code className="flow-dialog__code">{step.run.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}</code>
                {step.workingDir && <div className="flow-dialog__muted">{t("run.workingDir", { dir: step.workingDir })}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}
```

Move the confirmation checkbox / `alreadyConfirmed` block out of the commands section into its own block after the setup section, shown when `reviewItems > 0`:

```tsx
      {review && reviewItems > 0 && (
        needsConfirmation ? (
          <label className="flow-dialog__confirm">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>{t("run.confirmLabel")}</span>
          </label>
        ) : (
          <div className="flow-dialog__muted">{t("run.alreadyConfirmed")}</div>
        )
      )}
```

i18n `run` group additions — en:

```json
    "runtimesTitle": "Runtimes this project declares",
    "runtimesHint": "Declared in {{path}}. The interpreter and module run with your user account.",
    "runtimePython": "python",
    "runtimeModule": "Module: {{module}}",
    "setupTitle": "Setup steps of this project",
```

ja:

```json
    "runtimesTitle": "このプロジェクトのランタイム",
    "runtimesHint": "{{path}} で宣言されています。インタプリタとモジュールは利用者の権限で実行されます。",
    "runtimePython": "python",
    "runtimeModule": "モジュール: {{module}}",
    "setupTitle": "このプロジェクトのセットアップ手順",
```

and `runError` additions — en: `"FLOW_SECRET_MISSING": "Environment variables named in project.yaml are not set."`; ja: `"FLOW_SECRET_MISSING": "project.yaml の secrets に書かれた環境変数が設定されていません。"`; plus `reason` group — en: `"FLOW_SECRET_MISSING": "{{name}} is not set."`, ja: `"FLOW_SECRET_MISSING": "{{name}} が設定されていません。"`.

`RunViews.test.tsx`: every mocked `CommandReview` object gains `runtimes: []`, `setup: []`. Add one test: a review with `commands: []`, `runtimes: [{ name: "r", python: [".venv/bin/python"], module: "m", cwd: "." }]`, `setup: []`, `confirmed: false` renders the runtimes heading and the confirmation checkbox, and the start button stays disabled until it is checked (Review Focus 1).

Run: `npm test` and `npx tsc --noEmit -p tsconfig.json` → pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri src/shared src/features/flow
git commit -m "feat(flow): confirm manifest runtimes and setup, check secrets at run start"
```

---

### Task 8: Setup runner and `flow_project_setup`

**Files:**
- Create: `src-tauri/crates/flow-core/src/setup.rs`
- Modify: `src-tauri/crates/flow-core/src/lib.rs`, `service.rs` (`FlowService` field, `project_setup`, `call`, `COMMAND_NAMES`), `src-tauri/src/commands/flow.rs`, `src-tauri/src/commands/flow_run.rs` (event constant), `src-tauri/src/lib.rs`
- Modify: `src/shared/types/flow-run.ts` (event + payload types), `src/features/flow/lib/transport.ts` (`FlowEventName`), `src/features/flow/lib/flow-api.ts` (`projectSetup`, `subscribeSetupProgress`), `src/shared/i18n/locales/{ja,en}/flow.json` (`runError`)

**Interfaces:**
- Produces (`flow_core::setup`):
  - `pub struct SetupProgress { pub setup_id: String, pub step: usize /* 1-based */, pub total: usize, pub status: SetupStatus, pub run: Vec<String>, pub exit_code: Option<i32> }`, `pub enum SetupStatus { Started, Succeeded, Failed, Finished }` (serde lowercase), camelCase.
  - `pub struct SetupStepResult { pub index: usize, pub run: Vec<String>, pub working_dir: String, pub exit_code: Option<i32>, pub error: Option<String>, pub stdout_tail: String, pub stderr_tail: String }`, `pub struct SetupResult { pub setup_id: String, pub ok: bool, pub log_dir: String, pub steps: Vec<SetupStepResult> }` (camelCase).
  - `pub fn run_setup(project_root: &Path, project: &ProjectDef, launcher: &dyn Launcher, poll: Duration, progress: &dyn Fn(&SetupProgress)) -> SetupResult` — runs steps in order; stops at the first failure (non-zero exit or spawn error); logs under `<root>/.mdium/setup-runs/<setupId>/step-<n>.stdout.log` / `.stderr.log`; tails are the last 4 KiB.
  - `FlowService::project_setup(&self, project_root: &str, progress: &(dyn Fn(&SetupProgress) + Sync)) -> Result<SetupResult, FlowCommandError>`; codes `FLOW_PROJECT_REQUIRED` (no manifest or manifest has errors), `FLOW_SETUP_BUSY` (already running for this project), `FLOW_SETUP_FAILED` reserved for I/O failures creating the log directory. A step failure is data (`ok: false`), not an error.
  - `COMMAND_NAMES: [&str; 19]` with `"flow_project_setup"`; `call` runs it with a no-op progress closure.
  - Tauri `flow_project_setup(app, state, project_root)` in `commands/flow.rs` emitting `SETUP_PROGRESS_EVENT = "flow://setup-progress"` (constant in `flow_run.rs` beside the others) with payload `{ projectRoot, ...SetupProgress }`.
  - TS: `FLOW_SETUP_PROGRESS_EVENT`, `SetupProgressEvent`, `SetupResult`, `SetupStepResult`; `flowApi.projectSetup(projectRoot)`, `subscribeSetupProgress(handler): Promise<() => void>`; `FlowEventName` includes the new event.
- Consumes: `flow_core::run::process::{AttachedLauncher, Launcher, LaunchSpec, tail_file}`, Task 4 `ProjectDef`.

- [ ] **Step 1: Write the failing tests**

`setup.rs` tests use the test binary trick already used by the engine tests: `crate::run::test_helper::helper_argv()` returns argv that runs a scripted fake command; its script is passed through the env var from `helper_env(&[...])`. But setup steps carry no env, so instead use plain OS commands that exist on every platform: on Windows `["cmd", "/C", "exit 0"]`, on Unix `["sh", "-c", "exit 0"]`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{check_project_text, ProjectDef};
    use crate::run::process::AttachedLauncher;
    use std::sync::Mutex;

    fn exit_step(code: i32) -> String {
        if cfg!(windows) {
            format!("{{ run: [cmd, /C, 'exit {code}'] }}")
        } else {
            format!("{{ run: [sh, -c, 'exit {code}'] }}")
        }
    }

    fn project(steps: &[String]) -> ProjectDef {
        let text = format!(
            "schemaVersion: 1\nid: p\nname: P\nsetup:\n{}",
            steps.iter().map(|s| format!("  - {s}\n")).collect::<String>()
        );
        check_project_text(&text).project.expect("valid manifest")
    }

    #[test]
    fn runs_steps_in_order_and_stops_at_the_first_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let project = project(&[exit_step(0), exit_step(3), exit_step(0)]);
        let seen = Mutex::new(Vec::new());
        let result = run_setup(tmp.path(), &project, &AttachedLauncher, Duration::from_millis(20), &|p| {
            seen.lock().unwrap().push((p.step, p.status, p.exit_code));
        });
        assert!(!result.ok);
        assert_eq!(result.steps.len(), 2, "third step never ran");
        assert_eq!(result.steps[0].exit_code, Some(0));
        assert_eq!(result.steps[1].exit_code, Some(3));
        let seen = seen.lock().unwrap();
        assert_eq!(
            *seen,
            vec![
                (1, SetupStatus::Started, None),
                (1, SetupStatus::Succeeded, Some(0)),
                (2, SetupStatus::Started, None),
                (2, SetupStatus::Failed, Some(3)),
                (2, SetupStatus::Finished, None),
            ]
        );
        assert!(tmp.path().join(".mdium/setup-runs").join(&result.setup_id).join("step-1.stdout.log").exists());
    }

    #[test]
    fn a_missing_program_is_a_failed_step_with_the_os_error() {
        // Review Focus 4.
        let tmp = tempfile::tempdir().unwrap();
        let project = project(&["{ run: [mdium-no-such-program-xyz, sync] }".to_string(), exit_step(0)]);
        let result = run_setup(tmp.path(), &project, &AttachedLauncher, Duration::from_millis(20), &|_| {});
        assert!(!result.ok);
        assert_eq!(result.steps.len(), 1);
        assert!(result.steps[0].exit_code.is_none());
        assert!(result.steps[0].error.as_deref().is_some_and(|e| !e.is_empty()));
    }

    #[test]
    fn all_steps_succeeding_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let project = project(&[exit_step(0), exit_step(0)]);
        let result = run_setup(tmp.path(), &project, &AttachedLauncher, Duration::from_millis(20), &|_| {});
        assert!(result.ok);
        assert_eq!(result.steps.len(), 2);
    }
}
```

`service.rs` tests:

```rust
    #[test]
    fn project_setup_requires_a_valid_manifest_and_rejects_concurrent_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert_eq!(svc.project_setup(root, &|_| {}).unwrap_err().code, FLOW_PROJECT_REQUIRED);
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\n").unwrap();
        let result = svc.project_setup(root, &|_| {}).unwrap();
        assert!(result.ok && result.steps.is_empty());
        let via_call = svc.call("flow_project_setup", serde_json::json!({ "projectRoot": root })).unwrap();
        assert_eq!(via_call["ok"], true);
        // Busy: mark the root as running, then try again.
        svc.setups.lock().unwrap().insert(project_root(root).unwrap());
        assert_eq!(svc.project_setup(root, &|_| {}).unwrap_err().code, FLOW_SETUP_BUSY);
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core setup` → compile errors.

- [ ] **Step 3: Implement `setup.rs`**

```rust
//! Runs a manifest's `setup` steps (spec 2026-10-10, 2.2): sequentially,
//! stopping at the first failure, logging each step to
//! `.mdium/setup-runs/<id>/`, reporting progress through a callback.

use crate::fsutil;
use crate::project::ProjectDef;
use crate::run::process::{tail_file, Launcher, LaunchSpec};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TAIL_BYTES: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupStatus {
    Started,
    Succeeded,
    Failed,
    /// Sent once after the last step (or the first failure).
    Finished,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub setup_id: String,
    /// 1-based step number (`total` on `Finished`).
    pub step: usize,
    pub total: usize,
    pub status: SetupStatus,
    pub run: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStepResult {
    pub index: usize,
    pub run: Vec<String>,
    pub working_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Spawn / wait failure (the step never produced an exit code).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub setup_id: String,
    pub ok: bool,
    /// Project-relative log directory.
    pub log_dir: String,
    pub steps: Vec<SetupStepResult>,
}

/// Runs every setup step of `project` in order.
pub fn run_setup(
    project_root: &Path,
    project: &ProjectDef,
    launcher: &dyn Launcher,
    poll: Duration,
    progress: &dyn Fn(&SetupProgress),
) -> SetupResult {
    let setup_id = fsutil::new_id();
    let log_rel = format!(".mdium/setup-runs/{setup_id}");
    let log_dir: PathBuf = project_root.join(&log_rel);
    let total = project.setup.len();
    let mut steps = Vec::new();
    let mut ok = true;
    for (i, step) in project.setup.iter().enumerate() {
        let index = i + 1;
        let report = |status: SetupStatus, exit_code: Option<i32>| {
            progress(&SetupProgress {
                setup_id: setup_id.clone(),
                step: index,
                total,
                status,
                run: step.run.clone(),
                exit_code,
            })
        };
        report(SetupStatus::Started, None);
        let working_dir = step.working_dir.clone().unwrap_or_else(|| ".".to_string());
        let stdout = log_dir.join(format!("step-{index}.stdout.log"));
        let stderr = log_dir.join(format!("step-{index}.stderr.log"));
        let mut result = SetupStepResult {
            index,
            run: step.run.clone(),
            working_dir: working_dir.clone(),
            exit_code: None,
            error: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
        };
        let outcome = std::fs::create_dir_all(&log_dir).and_then(|_| {
            let spec = LaunchSpec {
                argv: step.run.clone(),
                shell: false,
                working_dir: project_root.join(&working_dir),
                env: Vec::new(),
                stdout: stdout.clone(),
                stderr: stderr.clone(),
                node_dir: log_dir.clone(),
                new_group: true,
            };
            let mut handle = launcher.launch(&spec)?;
            loop {
                if let Some(code) = handle.try_wait()? {
                    return Ok(code);
                }
                std::thread::sleep(poll);
            }
        });
        result.stdout_tail = tail_file(&stdout, TAIL_BYTES).unwrap_or_default();
        result.stderr_tail = tail_file(&stderr, TAIL_BYTES).unwrap_or_default();
        let failed = match outcome {
            Ok(code) => {
                result.exit_code = Some(code);
                code != 0
            }
            Err(err) => {
                result.error = Some(err.to_string());
                true
            }
        };
        report(
            if failed { SetupStatus::Failed } else { SetupStatus::Succeeded },
            result.exit_code,
        );
        steps.push(result);
        if failed {
            ok = false;
            break;
        }
    }
    progress(&SetupProgress {
        setup_id: setup_id.clone(),
        step: total,
        total,
        status: SetupStatus::Finished,
        run: Vec::new(),
        exit_code: None,
    });
    SetupResult { setup_id, ok, log_dir: log_rel, steps }
}
```

(Check `LaunchSpec`'s exact field list in `run/process.rs` L13-26 and `ProcessHandle::try_wait`'s return type `io::Result<Option<i32>>`; adapt field names if they differ, keeping the behavior.) `lib.rs`: add `pub mod setup;`.

`service.rs`: add the field and the method.

```rust
use crate::setup::{run_setup, SetupProgress, SetupResult};
use std::collections::HashSet;
use std::sync::Mutex;

pub const FLOW_PROJECT_REQUIRED: &str = "FLOW_PROJECT_REQUIRED";
pub const FLOW_SETUP_BUSY: &str = "FLOW_SETUP_BUSY";
pub const FLOW_SETUP_FAILED: &str = "FLOW_SETUP_FAILED";

pub struct FlowService {
    engine: Arc<FlowEngine>,
    /// Project roots whose setup is running (one at a time per project).
    pub(crate) setups: Mutex<HashSet<PathBuf>>,
}
```

(`new` initializes `setups: Mutex::new(HashSet::new())`.)

```rust
    /// Runs the manifest's `setup` steps (spec 2.2); progress goes to `progress`.
    pub fn project_setup(
        &self,
        project_root_arg: &str,
        progress: &(dyn Fn(&SetupProgress) + Sync),
    ) -> Result<SetupResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let project = match load_project(&root) {
            Some(report) if report.errors.is_empty() => report.project,
            _ => None,
        }
        .ok_or_else(|| FlowCommandError::new(FLOW_PROJECT_REQUIRED, "no valid .mdium/project.yaml"))?;
        {
            let mut running = self.setups.lock().unwrap_or_else(|p| p.into_inner());
            if !running.insert(root.clone()) {
                return Err(FlowCommandError::new(FLOW_SETUP_BUSY, project_root_arg));
            }
        }
        let result = run_setup(
            &root,
            &project,
            &crate::run::process::AttachedLauncher,
            Duration::from_millis(200),
            progress,
        );
        self.setups.lock().unwrap_or_else(|p| p.into_inner()).remove(&root);
        Ok(result)
    }
```

`COMMAND_NAMES` → 19 with `"flow_project_setup"`; `call` arm: `"flow_project_setup" => { let a: RootArgs = args(value)?; reply(self.project_setup(&a.project_root, &|_| {})?) }`. `FLOW_SETUP_FAILED` is defined for the frontend's error table; `run_setup` never returns it (log-dir failures are step errors), so mark it `#[allow(dead_code)]` with a comment if the compiler warns.

`commands/flow_run.rs`: add `pub const SETUP_PROGRESS_EVENT: &str = "flow://setup-progress";` beside the other constants. `commands/flow.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgressPayload {
    project_root: String,
    #[serde(flatten)]
    progress: SetupProgress,
}

#[tauri::command]
pub async fn flow_project_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<SetupResult, FlowCommandError> {
    with_service(state, move |s| {
        let root = project_root.clone();
        s.project_setup(&project_root, &move |p| {
            let payload = SetupProgressPayload { project_root: root.clone(), progress: p.clone() };
            if let Err(err) = app.emit(super::flow_run::SETUP_PROGRESS_EVENT, payload) {
                eprintln!("[flow] emitting setup progress failed: {err}");
            }
        })
    })
    .await
}
```

(imports: `flow_core::setup::{SetupProgress, SetupResult}`, `serde::Serialize`, `tauri::Emitter`). `lib.rs`: register `commands::flow::flow_project_setup,`.

Frontend — `flow-run.ts`:

```ts
export const FLOW_SETUP_PROGRESS_EVENT = "flow://setup-progress";

export type SetupStatus = "started" | "succeeded" | "failed" | "finished";

export interface SetupProgressEvent {
  projectRoot: string;
  setupId: string;
  step: number;
  total: number;
  status: SetupStatus;
  run: string[];
  exitCode?: number;
}

export interface SetupStepResult {
  index: number;
  run: string[];
  workingDir: string;
  exitCode?: number;
  error?: string;
  stdoutTail: string;
  stderrTail: string;
}

export interface SetupResult {
  setupId: string;
  ok: boolean;
  logDir: string;
  steps: SetupStepResult[];
}
```

`transport.ts`: add `| typeof FLOW_SETUP_PROGRESS_EVENT` to `FlowEventName` (import the constant). `flow-api.ts`: add `projectSetup: (projectRoot: string) => call<SetupResult>("flow_project_setup", { projectRoot }),` and

```ts
/** Subscribes to setup progress; resolves to the unsubscribe function. */
export function subscribeSetupProgress(handler: (event: SetupProgressEvent) => void): Promise<() => void> {
  return getFlowTransport().subscribe<SetupProgressEvent>(FLOW_SETUP_PROGRESS_EVENT, handler);
}
```

i18n `runError` additions — en: `"FLOW_PROJECT_REQUIRED": "This folder has no valid .mdium/project.yaml."`, `"FLOW_SETUP_BUSY": "Setup is already running for this project."`, `"FLOW_SETUP_FAILED": "Setup could not be started."`; ja: `"FLOW_PROJECT_REQUIRED": "このフォルダに有効な .mdium/project.yaml がありません。"`, `"FLOW_SETUP_BUSY": "このプロジェクトのセットアップは実行中です。"`, `"FLOW_SETUP_FAILED": "セットアップを開始できませんでした。"`.

`flow-api.test.ts`: add `["projectSetup", () => flowApi.projectSetup(ROOT), "flow_project_setup", { projectRoot: ROOT }],` to the table and a test that `subscribeSetupProgress` subscribes to `"flow://setup-progress"` through a fake transport and hands the handler the payload.

- [ ] **Step 4: Run everything**

Run: `cargo test --workspace`, `npm test`, `npx tsc --noEmit -p tsconfig.json` → all pass; `cargo build` → no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri src/shared src/features/flow
git commit -m "feat(flow): run project setup steps with progress events"
```

---

### Task 9: Flow panel groups, project header and setup dialog

**Files:**
- Modify: `src/features/flow/components/FlowPanel.tsx`, `FlowWorkspace.tsx`, `Flow.css`
- Create: `src/features/flow/components/ProjectSetupDialog.tsx`, `src/features/flow/components/__tests__/ProjectViews.test.tsx`
- Modify: `src/features/flow/components/__tests__/FlowViews.test.tsx`, `src/shared/i18n/locales/{ja,en}/flow.json` (`list`, `project` groups)

**Interfaces:**
- Produces: `FlowPanel` renders a project header (name, error count, setup button) above two groups (entries, parts); `ProjectSetupDialog({ projectRoot, project, onClose })`; `FlowWorkspace` passes `flow={null}` to `RunPanel` for parts and shows `run.partHint`.
- Consumes: `flowApi.projectLoad`, `flowApi.projectSetup`, `subscribeSetupProgress` (Tasks 6, 8), `FlowSummary.kind/role/params/outputs`, `FlowLoadResult.kind` (Task 5), `pythonCandidates` (Task 6).

- [ ] **Step 1: Write the failing tests**

`src/features/flow/components/__tests__/ProjectViews.test.tsx` (same harness as `FlowViews.test.tsx`: happy-dom, `vi.mock("@tauri-apps/api/core")`, `vi.mock("@tauri-apps/api/event")` with a `listeners` map as in `RunViews.test.tsx`, i18n import, `useTabStore.setState({ activeFolderPath: FOLDER })` in `beforeEach`):

```tsx
describe("FlowPanel with a project", () => {
  it("groups entries and parts and shows the project header", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "flow_list") {
        return [
          { path: ".mdium/flows/main.flow.yaml", kind: "entry", role: "main", id: "m", name: "Main", params: {}, outputs: ["coverage"], errorCount: 0, warningCount: 0 },
          { path: ".mdium/flows/lib/video.flow.yaml", kind: "part", id: "v", name: "Video", params: { storyDir: { type: "path", required: true } }, outputs: ["videoPath"], errorCount: 0, warningCount: 0 },
        ];
      }
      if (cmd === "flow_project_load") {
        return { exists: true, path: ".mdium/project.yaml", project: { schemaVersion: 1, id: "p", name: "Proj", setup: [{ run: ["uv", "sync"] }] }, errors: [], warnings: [] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => root.render(<FlowPanel />));
    await waitFor(() => expect(container.textContent).toContain("Proj"));
    expect(container.textContent).toContain(i18n.t("list.groupEntries", { ns: "flow" }));
    expect(container.textContent).toContain(i18n.t("list.groupParts", { ns: "flow" }));
    expect(container.textContent).toContain("main"); // role badge
    expect(container.textContent).toContain("storyDir → videoPath"); // signature line
    expect(container.querySelector(".flow-panel__setup")).not.toBeNull();
  });

  it("hides the setup button without setup steps and reports manifest errors", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "flow_list") return [];
      if (cmd === "flow_project_load") {
        return { exists: true, path: ".mdium/project.yaml", project: null, errors: [{ code: "FLOW_INVALID_ID", path: "id", params: { name: "Bad" } }], warnings: [] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await act(async () => root.render(<FlowPanel />));
    await waitFor(() => expect(container.textContent).toContain(i18n.t("project.invalid", { ns: "flow", count: 1 })));
    expect(container.querySelector(".flow-panel__setup")).toBeNull();
  });
});

describe("ProjectSetupDialog", () => {
  it("lists the steps, requires confirmation, runs and shows progress", async () => {
    const project = { schemaVersion: 1 as const, id: "p", name: "Proj", setup: [{ run: ["uv", "sync"], workingDir: "." }] };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "flow_project_setup") {
        listeners.get("flow://setup-progress")?.({ payload: { projectRoot: FOLDER, setupId: "s1", step: 1, total: 1, status: "started", run: ["uv", "sync"] } });
        listeners.get("flow://setup-progress")?.({ payload: { projectRoot: FOLDER, setupId: "s1", step: 1, total: 1, status: "failed", run: ["uv", "sync"], exitCode: 2 } });
        return { setupId: "s1", ok: false, logDir: ".mdium/setup-runs/s1", steps: [{ index: 1, run: ["uv", "sync"], workingDir: ".", exitCode: 2, stdoutTail: "", stderrTail: "boom" }] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const onClose = vi.fn();
    await act(async () => root.render(<ProjectSetupDialog projectRoot={FOLDER} project={project} onClose={onClose} />));
    expect(container.textContent).toContain("uv sync");
    const run = container.querySelector<HTMLButtonElement>(".flow-dialog__button--primary")!;
    expect(run.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>(".flow-dialog__confirm input")!.click());
    expect(run.disabled).toBe(false);
    await act(async () => run.click());
    await waitFor(() => expect(container.textContent).toContain(i18n.t("project.setupFailed", { ns: "flow" })));
    expect(container.textContent).toContain("boom");
    expect(invoke).toHaveBeenCalledWith("flow_project_setup", { projectRoot: FOLDER });
  });
});
```

Also update the existing `FlowViews.test.tsx` `FlowPanel` tests: the `flow_list` mocks need `kind: "entry"`, `params: {}`, `outputs: []`, and the component now also calls `flow_project_load` — make the mock answer `{ exists: false, path: ".mdium/project.yaml", project: null, errors: [], warnings: [] }` for it (switch those tests from `mockResolvedValueOnce` to a `mockImplementation` keyed by command).

Add to `ProjectViews.test.tsx` a workspace test (Review Focus 5): render `<FlowWorkspace />` with the store selecting `.mdium/flows/lib/part.flow.yaml`, `flow_load` answering `{ path: ".mdium/flows/lib/part.flow.yaml", format: "yaml", kind: "part", flow: docDigest(), errors: [], warnings: [] }` (and `flow_run_list` answering `[]`, `flow_gitignore_status` answering `{ ignored: true }`); assert the text contains `i18n.t("run.partHint", { ns: "flow" })` and `container.querySelector(".flow-run__start")` (or whatever selector `RunPanel` uses for its start button — read `RunPanel.tsx` once to pick the right one) is `null`.

Note on types: `signatureText`'s `t` parameter is simplest typed as `TFunction<"flow">` from `i18next` / `react-i18next`; if the simplified `(key, opts) => string` signature does not accept `useTranslation("flow").t`, use `TFunction`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/flow/components` → FAIL (component / keys missing).

- [ ] **Step 3: Implement**

i18n additions (both locales; ja values given after en):

```json
  "list": {
    "groupEntries": "Flows",
    "groupParts": "Parts (lib/)",
    "signature": "{{params}} → {{outputs}}",
    "noParams": "()",
    "noOutputs": "()"
  },
  "project": {
    "title": "Project",
    "noManifest": "No .mdium/project.yaml in this folder.",
    "invalid": "project.yaml has {{count}} errors.",
    "setup": "Set up",
    "setupTitle": "Set up project: {{name}}",
    "setupHint": "These commands run now, with your user account, in this folder. They are listed in .mdium/project.yaml.",
    "setupConfirm": "I reviewed these steps and allow them to run.",
    "setupRun": "Run setup",
    "setupRunning": "Running…",
    "setupStep": "Step {{step}} of {{total}}",
    "setupDone": "Setup finished.",
    "setupFailed": "Setup failed.",
    "stepStatus": { "started": "running", "succeeded": "done", "failed": "failed" },
    "logDir": "Logs: {{dir}}"
  }
```

ja: `groupEntries: "フロー"`, `groupParts: "部品（lib/）"`, `signature: "{{params}} → {{outputs}}"`, `noParams: "()"`, `noOutputs: "()"`; `project.title: "プロジェクト"`, `noManifest: "このフォルダに .mdium/project.yaml はありません。"`, `invalid: "project.yaml に {{count}} 件のエラーがあります。"`, `setup: "セットアップ"`, `setupTitle: "プロジェクトのセットアップ: {{name}}"`, `setupHint: "次のコマンドを、このフォルダで利用者の権限で今すぐ実行します。.mdium/project.yaml に書かれた手順です。"`, `setupConfirm: "この手順を確認し、実行を許可します。"`, `setupRun: "セットアップを実行"`, `setupRunning: "実行中…"`, `setupStep: "手順 {{step}} / {{total}}"`, `setupDone: "セットアップが完了しました。"`, `setupFailed: "セットアップに失敗しました。"`, `stepStatus: { started: "実行中", succeeded: "完了", failed: "失敗" }`, `logDir: "ログ: {{dir}}"`. Add to `run`: en `"partHint": "This flow is a part (under lib/). Call it from another flow; it cannot be started directly."`, ja `"partHint": "このフローは部品（lib/ 配下）です。他のフローから呼び出してください。直接は実行できません。"`.

`FlowPanel.tsx` — add project state and grouping:

```tsx
import type { FlowSummary, ProjectLoadResult } from "@/shared/types/flow";
import { ProjectSetupDialog } from "./ProjectSetupDialog";

/** `params → outputs` of a part, for the list. */
export function signatureText(flow: FlowSummary, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const params = Object.keys(flow.params);
  const outputs = flow.outputs;
  return t("list.signature", {
    params: params.length ? params.join(", ") : t("list.noParams"),
    outputs: outputs.length ? outputs.join(", ") : t("list.noOutputs"),
  });
}
```

Inside the component: `const [project, setProject] = useState<ProjectLoadResult | null>(null);` and `const [setupOpen, setSetupOpen] = useState(false);`. In `refresh`, after `flowApi.list(folder)` resolves, also `const loaded = await flowApi.projectLoad(folder); if (id === requestId.current) setProject(loaded);` (wrap in the same try; a failure sets the list error as today). Render, after the toolbar:

```tsx
      {project && (
        <div className="flow-panel__project">
          <div className="flow-panel__project-name">
            {project.project?.name ?? (project.exists ? t("project.title") : t("project.noManifest"))}
          </div>
          {project.errors.length > 0 && (
            <div className="flow-panel__message flow-panel__message--error">{t("project.invalid", { count: project.errors.length })}</div>
          )}
          {project.project && (project.project.setup?.length ?? 0) > 0 && (
            <button type="button" className="flow-panel__setup" onClick={() => setSetupOpen(true)}>
              {t("project.setup")}
            </button>
          )}
        </div>
      )}
      {setupOpen && project?.project && (
        <ProjectSetupDialog projectRoot={folder} project={project.project} onClose={() => setSetupOpen(false)} />
      )}
```

Replace the single `<ul>` with two groups built from `state.flows.filter((f) => f.kind === "entry")` and `.filter((f) => f.kind === "part")`, each as:

```tsx
      <div className="flow-panel__group-title">{t("list.groupEntries")}</div>
      <ul className="flow-panel__list">{entries.map(renderItem)}</ul>
```

where `renderItem` is the existing `<li>` markup plus, inside the button after the name: `{flow.role && <span className="flow-panel__role">{flow.role}</span>}` and, for parts, `<span className="flow-panel__item-signature">{signatureText(flow, t)}</span>`. Render the parts group only when it has items; the entries group always (so the empty state still reads `list.empty` when both are empty — keep the existing empty-state branch keyed on `state.flows.length === 0`).

`ProjectSetupDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { ProjectDef } from "@/shared/types/flow";
import type { FlowRunError, SetupProgressEvent, SetupResult } from "@/shared/types/flow-run";
import { flowApi, isFlowCommandError, subscribeSetupProgress } from "../lib/flow-api";
import { describeError } from "../lib/run-format";

interface ProjectSetupDialogProps {
  projectRoot: string;
  project: ProjectDef;
  onClose(): void;
}

/** Confirms and runs the manifest's setup steps, showing progress (spec 2.2). */
export function ProjectSetupDialog({ projectRoot, project, onClose }: ProjectSetupDialogProps) {
  const { t } = useTranslation("flow");
  const steps = project.setup ?? [];
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<number, SetupProgressEvent>>({});
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<FlowRunError | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void subscribeSetupProgress((event) => {
      if (event.projectRoot !== projectRoot || event.status === "finished") return;
      setProgress((p) => ({ ...p, [event.step]: event }));
    }).then((off) => {
      if (cancelled) off();
      else unsubscribe.current = off;
    });
    return () => {
      cancelled = true;
      unsubscribe.current?.();
    };
  }, [projectRoot]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({});
    try {
      setResult(await flowApi.projectSetup(projectRoot));
    } catch (err) {
      setError(isFlowCommandError(err) ? { code: err.code, message: err.message } : { code: "FLOW_COMMAND_FAILED", message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const described = error ? describeError(t, error) : null;
  const argv = (run: string[]) => run.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-project-setup-title" onClose={onClose}>
      <h2 id="flow-project-setup-title" className="flow-dialog__title">{t("project.setupTitle", { name: project.name })}</h2>
      <div className="flow-dialog__muted">{t("project.setupHint")}</div>
      <ul className="flow-dialog__commands">
        {steps.map((step, i) => {
          const index = i + 1;
          const live = progress[index];
          const done = result?.steps.find((s) => s.index === index);
          const status = done ? (done.exitCode === 0 ? "succeeded" : "failed") : live?.status;
          return (
            <li key={index} className="flow-dialog__command">
              <div className="flow-dialog__command-head">
                <strong>{t("project.setupStep", { step: index, total: steps.length })}</strong>
                {status && status !== "finished" && <span className="flow-dialog__badge">{t(`project.stepStatus.${status}`)}</span>}
              </div>
              <code className="flow-dialog__code">{argv(step.run)}</code>
              {step.workingDir && <div className="flow-dialog__muted">{t("run.workingDir", { dir: step.workingDir })}</div>}
              {done?.error && <pre className="flow-dialog__code">{done.error}</pre>}
              {done && done.exitCode !== 0 && done.stderrTail && <pre className="flow-dialog__code">{done.stderrTail}</pre>}
            </li>
          );
        })}
      </ul>
      {!result && (
        <label className="flow-dialog__confirm">
          <input type="checkbox" checked={accepted} disabled={busy} onChange={(e) => setAccepted(e.target.checked)} />
          <span>{t("project.setupConfirm")}</span>
        </label>
      )}
      {result && (
        <div className={`flow-dialog__muted${result.ok ? "" : " flow-dialog__error"}`} role="status">
          <div>{result.ok ? t("project.setupDone") : t("project.setupFailed")}</div>
          <div>{t("project.logDir", { dir: result.logDir })}</div>
        </div>
      )}
      {described && (
        <div className="flow-dialog__error" role="alert">
          <div>{described.message}</div>
        </div>
      )}
      <div className="flow-dialog__footer">
        <button type="button" className="flow-dialog__button" onClick={onClose} disabled={busy}>{t("run.close")}</button>
        {!result && (
          <button type="button" className="flow-dialog__button flow-dialog__button--primary" disabled={!accepted || busy} onClick={() => void run()}>
            {busy ? t("project.setupRunning") : t("project.setupRun")}
          </button>
        )}
      </div>
    </DialogShell>
  );
}
```

`FlowWorkspace.tsx`: where `RunPanel` is rendered, pass `flow={result.kind === "entry" && result.flow && result.errors.length === 0 ? result.flow : null}` and, when `result.kind === "part"`, render `<div className="flow-workspace__message">{t("run.partHint")}</div>` above the `RunPanel`.

`Flow.css`: add minimal rules for `.flow-panel__project`, `.flow-panel__project-name` (bold), `.flow-panel__setup` (same look as `.flow-panel__refresh`), `.flow-panel__group-title` (small uppercase muted heading with top margin), `.flow-panel__role` (small badge like `.flow-panel__badge`), `.flow-panel__item-signature` (muted monospace, small).

- [ ] **Step 4: Run the tests**

Run: `npm test` and `npx tsc --noEmit -p tsconfig.json` → pass (including `no-tauri-imports`, locale parity, issue-message existence).

- [ ] **Step 5: Commit**

```bash
git add src/features/flow src/shared/i18n/locales
git commit -m "feat(flow): project header with setup dialog and grouped flow list"
```

---

### Task 10: Final verification

- [ ] **Step 1: Suites**

From `src-tauri/`: `cargo test --workspace` and `cargo build` (no warnings). From the root: `npm test`, `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 2: Crate boundary**

`cargo tree -p flow-core -e normal | grep -i ' tauri'` → no output (the root line contains `src-tauri` in its path; a match on ` tauri` with a leading space excludes it).

- [ ] **Step 3: Desktop smoke (human)**

With `experimentalFlows` on, open a folder with `.mdium/project.yaml` containing one runtime, one setup step (`["cmd", "/C", "echo hi"]`) and `secrets: [MDIUM_DEMO_KEY]`, plus `.mdium/flows/main.flow.yaml` (an approval node) and `.mdium/flows/lib/part.flow.yaml`. Expect: the panel shows the project name and a setup button; the list has two groups; the part shows its signature; opening the part shows the part hint and no start button; the setup dialog lists the step, requires the checkbox, runs and shows "done"; starting `main` asks for confirmation (runtime + setup listed), then fails with the missing-secret message naming `MDIUM_DEMO_KEY`; after setting the variable and restarting the app, the run starts.

- [ ] **Step 4: Spec note**

Record in the spec's chapter 12 row V2 only if the implementation deviated from the plan's interfaces; otherwise no change.
