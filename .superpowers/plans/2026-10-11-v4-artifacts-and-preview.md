# V4 Artifacts and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every artifact a node reports (command, python) with a media type into `artifacts.json`, let flows reference artifacts by label, show them in the run panel (image / video / audio / text) and in approvals, add a comment (optionally required) to approvals, and turn the run panel's node list into a sub-flow / iteration tree.

**Architecture:** The driver validates each `artifact` event's path against the project root, guesses `mediaType` from the extension, assigns an index per attempt, emits an enriched `node_artifact` event and rewrites `<attempt>/artifacts.json`. Templates and approval `show` gain `nodes.<id>.artifacts[.<label>]`. A new `flow_artifact_path` command resolves an `{runId, nodeKey, attempt, index}` reference to an absolute path only if it is recorded in `artifacts.json`; the Tauri wrapper adds that one file to the asset-protocol scope so the UI can load it through `convertFileSrc` (the transport layer's new `artifactUrl`). The run panel is split into a tree, a node detail with an artifacts tab, and an approval dialog.

**Tech Stack:** Rust (flow-core, serde, tauri 2 `protocol-asset`), React 19 + TypeScript + vitest (happy-dom), react-i18next.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` — chapter 5 (5.1 recording, 5.2 retrieval, 5.3 run panel and approval), 3.5 (storage layout: `artifacts.json`), 3.7 (`FLOW_ARTIFACT_OUTSIDE_PROJECT`), 10.2 (`FlowTransport.artifactUrl`), 16.4 (run panel tree), 12 row V4. Base spec `.superpowers/specs/2026-10-06-generic-flow-engine-design.md` 4.4 (`node_artifact` event), 5.3 (`artifact` protocol line).

## Global Constraints

- `flow-core` must not depend on `tauri`; `src/features/flow/` imports `@tauri-apps/*` only in `lib/tauri-transport.ts` (guard test `no-tauri-imports.test.ts`). The asset URL therefore comes from the transport (`FlowTransport.artifactUrl`), never from `convertFileSrc` in a component.
- New Tauri commands live in `src-tauri/src/commands/flow_run.rs`, are listed in `flow_core::service::COMMAND_NAMES` (20 → 21) and have a `call()` arm with the same camelCase JSON arguments; a parity test matches `commands::flow(?:_run)?::(flow_\w+)` in `lib.rs`.
- Every new driver reason code gets `reason.<CODE>` and every new service/engine operation code gets `runError.<CODE>` in both `src/shared/i18n/locales/{ja,en}/flow.json` (identical key sets and placeholders; test `locale-parity.test.ts`). No hardcoded UI strings; code comments in English.
- Artifact recording (spec 5.1): `artifacts.json` per node attempt at `.mdium/flow-runs/<runId>/nodes/<nodeKey>/<n>/artifacts.json` holding `[{ index, path, label, mediaType, bytes, recordedAt }]`; `path` is absolute or relative to the node directory; a path outside the project root is rejected with the warning `FLOW_ARTIFACT_OUTSIDE_PROJECT` and the node is **not** failed; `mediaType` missing → guessed from the extension (`png` / `jpg` / `webp` / `mp4` / `webm` / `mp3` / `wav` / `json` / `md` / `txt`, else `application/octet-stream`).
- References (spec 5.1): `nodes.<id>.artifacts` (the list) and `nodes.<id>.artifacts.<label>` (path of the first artifact with that label); `${{ nodes.<id>.artifacts.<label> }}` expands to the path.
- Retrieval (spec 5.2): only paths recorded in `artifacts.json` can be fetched; Tauri uses the asset protocol (`convertFileSrc`) with the CSP allowing `asset:` / `http://asset.localhost` for `img-src` and `media-src`.
- Run panel (spec 5.3, 16.4): node detail gets an "artifacts" tab showing image / video (`<video controls>`) / audio / JSON and text (pretty, first 256 KiB); the node list is a tree by sub-flow and loop iteration with aggregates (running, failed, awaiting approval, cost, latest progress), parents collapsed by default except those containing running / failed / awaiting nodes; clicking an awaiting row opens its approval dialog.
- Approval (spec 5.3): `show` accepts `nodes.<id>.outputs.<key>`, `nodes.<id>.artifacts`, `nodes.<id>.artifacts.<label>`; outputs `choice` and `comment` (`""` when empty); the dialog always has a comment field; `options` entries may be `{ name, commentRequired: true }` or plain strings.
- Rust sources are mostly CRLF (`run/worker.rs`, `run/tests.rs` are LF): preserve each file's existing line endings. Never commit `src-tauri/gen/schemas/*.json`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Existing tests keep passing (baseline on b6ab42c: flow-core 214 / mdium 731, vitest 1839, pytest 29).

## Review Focus

1. An artifact whose file does not exist (yet): it is still recorded (with `bytes` absent) and the preview says it is unavailable instead of breaking the panel — Task 2 test `artifact_without_a_file_is_recorded_without_bytes`, Task 8 test "shows an unavailable notice when the artifact url fails".
2. The same label reported twice: `nodes.<id>.artifacts.<label>` resolves to the first, and the tab lists both — Task 3 test `artifact_label_reference_takes_the_first_match`.
3. A text artifact over 256 KiB: the preview shows the head with a truncation notice and never reads the whole file — Task 6 test `fetchTextHead marks a 206 response as truncated`, Task 8 test "shows a truncation notice for long text".
4. An option with `commentRequired` chosen with an empty comment: the button is disabled in the dialog and the engine refuses with `FLOW_APPROVAL_COMMENT_REQUIRED` — Task 4 test `comment_required_option_refuses_an_empty_comment`, Task 9 test "disables a commentRequired option until a comment is typed".
5. Runs recorded before V4 (`artifacts: [{path, label}]`, `options: ["approve", "reject"]`, `show: {name: value}`): they still load and render — Task 1 test `old_artifact_records_deserialize`, Task 4 tests `old_string_options_deserialize` and `old_show_values_deserialize`, Task 7 test "builds a flat tree when scopes are absent".

---

## File structure

Rust (`src-tauri/crates/flow-core/src/`):
- `run/artifacts.rs` (new): media type guessing, artifact path resolution, `artifacts.json` read/write. One responsibility: artifact records on disk.
- `run/model.rs`: `Artifact` gains `index`, `media_type`, `bytes`, `recorded_at`; `EventBody::NodeArtifact` carries the same; `ApprovalOption`, `ShowValue`; `apply` clears artifacts when a node starts running.
- `run/process.rs`: `ProtocolItem::Artifact` gains `media_type`.
- `run/driver.rs`: artifact recording, artifact lookup for templates, approval outputs, typed `show`.
- `template.rs`, `validate.rs`, `run/prepare.rs`: the two artifact references.
- `model.rs`, `parse.rs`: `ApprovalNode.options` as `Vec<ApprovalOption>`.
- `run/engine.rs`: `artifact_path`, comment-required check in `approve`.
- `service.rs`: `run_artifact_path`, `COMMAND_NAMES` → 21.
- `src-tauri/src/commands/flow_run.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`: Tauri wrapper with asset scope, feature, config, CSP.

Frontend:
- `src/shared/types/flow-run.ts`: `Artifact`, `ArtifactRef`, `ApprovalOption`, `ShowValue`, `ApprovalRequest` changes.
- `src/features/flow/lib/transport.ts`, `tauri-transport.ts`, `flow-run-api.ts`: `artifactUrl`.
- `src/features/flow/lib/artifact-kind.ts` (new): media type → preview kind, text head fetch.
- `src/features/flow/lib/run-tree.ts` (new): pure tree builder with aggregates.
- `src/features/flow/components/RunNodeTree.tsx` (new), `RunNodeDetail.tsx` (new), `ArtifactPreview.tsx` (new), `ApprovalDialog.tsx` (new); `RunPanel.tsx` shrinks to list + wiring; `Flow.css` additions.
- Tests: `lib/__tests__/artifact-kind.test.ts`, `lib/__tests__/run-tree.test.ts`, `components/__tests__/RunViews.test.tsx` (extended), `lib/__tests__/transport.test.ts` (extended).

---

### Task 1: Artifact records — model, protocol item, media type guessing, path resolution

**Files:**
- Create: `src-tauri/crates/flow-core/src/run/artifacts.rs`
- Modify: `src-tauri/crates/flow-core/src/run/mod.rs` (add `pub mod artifacts;`), `src-tauri/crates/flow-core/src/run/model.rs` (`Artifact`, `EventBody::NodeArtifact`, `apply`), `src-tauri/crates/flow-core/src/run/process.rs` (`ProtocolItem::Artifact`, parse)
- Test: unit tests inside `artifacts.rs`, `model.rs`, `process.rs`

**Interfaces:**
- Produces:
  - `model::Artifact { index: u32, path: String, label: Option<String>, media_type: String, bytes: Option<u64>, recorded_at: String }` (serde camelCase; `index`, `media_type`, `recorded_at` have `#[serde(default)]` so V3 records `{path, label}` still load; default `media_type` is `"application/octet-stream"`).
  - `EventBody::NodeArtifact { index, path, label, media_type, bytes, recorded_at }` (same defaults).
  - `ProtocolItem::Artifact { path: String, label: Option<String>, media_type: Option<String> }`.
  - `artifacts::guess_media_type(path: &str) -> &'static str`.
  - `artifacts::resolve_artifact_path(project_root: &Path, node_dir: &Path, raw: &str) -> Result<PathBuf, &'static str>` — absolute or node-dir-relative; the normalised path must start with the canonical project root; `Err("outside-root")` otherwise. Does not require the file to exist.
  - `artifacts::write_artifacts_json(dir: &Path, artifacts: &[Artifact]) -> std::io::Result<()>` (atomic write of the pretty JSON array) and `artifacts::read_artifacts_json(dir: &Path) -> Vec<Artifact>` (missing or unparsable → empty).
  - `artifacts::MEDIA_TYPES: [(&str, &str); 11]` (`jpg` and `jpeg` both map to `image/jpeg`), `artifacts::DEFAULT_MEDIA_TYPE`.
- Consumes: `fsutil::atomic_write`, `fsutil::now()`.

- [ ] **Step 1: Write the failing tests**

`run/artifacts.rs` (bottom):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_media_types_from_the_extension() {
        for (path, media) in [
            ("a.png", "image/png"), ("A.JPG", "image/jpeg"), ("x.jpeg", "image/jpeg"), ("w.webp", "image/webp"),
            ("v.mp4", "video/mp4"), ("v.webm", "video/webm"), ("s.mp3", "audio/mpeg"), ("s.wav", "audio/wav"),
            ("d.json", "application/json"), ("d.md", "text/markdown"), ("d.txt", "text/plain"),
            ("bin", "application/octet-stream"), ("x.exe", "application/octet-stream"),
        ] {
            assert_eq!(guess_media_type(path), media, "{path}");
        }
    }

    #[test]
    fn resolves_relative_paths_against_the_node_dir_and_rejects_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        let node_dir = root.join(".mdium/flow-runs/r/nodes/a/1");
        std::fs::create_dir_all(&node_dir).unwrap();
        let ok = resolve_artifact_path(&root, &node_dir, "out/a.png").unwrap();
        assert!(ok.ends_with("out/a.png") || ok.ends_with("out\\a.png"));
        assert!(ok.starts_with(root.canonicalize().unwrap()));
        let abs = root.join("x.txt");
        assert_eq!(resolve_artifact_path(&root, &node_dir, abs.to_str().unwrap()).unwrap(), root.canonicalize().unwrap().join("x.txt"));
        assert_eq!(resolve_artifact_path(&root, &node_dir, "../../../../../../../etc/passwd").unwrap_err(), "outside-root");
        let outside = tmp.path().join("elsewhere.txt");
        assert_eq!(resolve_artifact_path(&root, &node_dir, outside.to_str().unwrap()).unwrap_err(), "outside-root");
    }

    #[test]
    fn artifacts_json_round_trips_and_tolerates_absence() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_artifacts_json(tmp.path()).is_empty());
        let a = Artifact { index: 0, path: "C:/p/a.png".into(), label: Some("img".into()), media_type: "image/png".into(), bytes: Some(3), recorded_at: "2026-10-11T00:00:00.000Z".into() };
        write_artifacts_json(tmp.path(), &[a.clone()]).unwrap();
        assert_eq!(read_artifacts_json(tmp.path()), vec![a]);
        std::fs::write(tmp.path().join("artifacts.json"), "{not json").unwrap();
        assert!(read_artifacts_json(tmp.path()).is_empty());
    }
}
```

`run/model.rs` tests module (append):

```rust
    #[test]
    fn old_artifact_records_deserialize() {
        let a: Artifact = serde_json::from_str(r#"{"path":"out/a.md","label":"doc"}"#).unwrap();
        assert_eq!(a.index, 0);
        assert_eq!(a.media_type, "application/octet-stream");
        assert_eq!(a.bytes, None);
        assert_eq!(a.recorded_at, "");
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(json["mediaType"], "application/octet-stream");
        assert!(json.get("bytes").is_none());
    }

    #[test]
    fn running_clears_the_previous_attempts_artifacts() {
        let mut state = RunState::default();
        let artifact = |seq| FlowEvent { seq, ts: "t".into(), node_key: Some("a".into()), body: EventBody::NodeArtifact { index: 0, path: "p".into(), label: None, media_type: "text/plain".into(), bytes: None, recorded_at: "t".into() } };
        let status = |seq, to| FlowEvent { seq, ts: "t".into(), node_key: Some("a".into()), body: EventBody::NodeStatus { from: NodeStatus::Ready, to, attempt: 1, reason: None, port: None } };
        apply(&mut state, &status(1, NodeStatus::Running));
        apply(&mut state, &artifact(2));
        assert_eq!(state.nodes["a"].artifacts.len(), 1);
        apply(&mut state, &status(3, NodeStatus::Running));
        assert!(state.nodes["a"].artifacts.is_empty());
    }
```

(If `FlowEvent` / `EventBody::NodeStatus` field names differ, adapt the constructor to the real definitions at `run/model.rs` — the assertion is what matters.)

`run/process.rs` tests module (append):

```rust
    #[test]
    fn artifact_lines_keep_an_optional_media_type() {
        let item = parse_line(r#"{"v":1,"type":"artifact","path":"a.bin","mediaType":"image/png"}"#).unwrap();
        assert_eq!(item, ProtocolItem::Artifact { path: "a.bin".into(), label: None, media_type: Some("image/png".into()) });
        let item = parse_line(r#"{"v":1,"type":"artifact","path":"a.bin","label":"x"}"#).unwrap();
        assert_eq!(item, ProtocolItem::Artifact { path: "a.bin".into(), label: Some("x".into()), media_type: None });
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `src-tauri`): `cargo test -p flow-core artifacts` → compile errors (missing module / fields).

- [ ] **Step 3: Implement**

`run/artifacts.rs`:

```rust
//! Artifact records: media type guessing, path rules and `artifacts.json`.

use std::path::{Component, Path, PathBuf};

use crate::fsutil;
use crate::run::model::Artifact;

/// Extensions the spec maps to a media type (5.1); anything else is a blob.
pub const MEDIA_TYPES: [(&str, &str); 11] = [
    ("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp"),
    ("mp4", "video/mp4"), ("webm", "video/webm"), ("mp3", "audio/mpeg"), ("wav", "audio/wav"),
    ("json", "application/json"), ("md", "text/markdown"), ("txt", "text/plain"),
];

pub const DEFAULT_MEDIA_TYPE: &str = "application/octet-stream";

pub fn guess_media_type(path: &str) -> &'static str {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    ext.and_then(|e| MEDIA_TYPES.iter().find(|(x, _)| *x == e).map(|(_, m)| *m)).unwrap_or(DEFAULT_MEDIA_TYPE)
}

/// Normalises `raw` (absolute, or relative to `node_dir`) and requires it to
/// lie inside the project root. The file need not exist yet.
pub fn resolve_artifact_path(project_root: &Path, node_dir: &Path, raw: &str) -> Result<PathBuf, &'static str> {
    let candidate = Path::new(raw);
    let joined = if candidate.is_absolute() { candidate.to_path_buf() } else { node_dir.join(candidate) };
    let normalised = normalise(&joined);
    let root = project_root.canonicalize().map_err(|_| "outside-root")?;
    let root = normalise(&root);
    if normalised.starts_with(&root) { Ok(normalised) } else { Err("outside-root") }
}

/// Lexically resolves `.` and `..`; keeps the prefix and root components.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn write_artifacts_json(dir: &Path, artifacts: &[Artifact]) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(artifacts).map_err(std::io::Error::other)?;
    fsutil::atomic_write(&dir.join("artifacts.json"), text.as_bytes())
}

pub fn read_artifacts_json(dir: &Path) -> Vec<Artifact> {
    std::fs::read(dir.join("artifacts.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
```

(Check `fsutil::atomic_write`'s real signature and adapt; on Windows `canonicalize` yields a `\\?\` prefix — `normalise` keeps it, and `starts_with` compares component-wise, so both sides must be canonical: canonicalize the root only, and for the candidate canonicalize its longest existing ancestor if `starts_with` fails for prefix reasons. Simplest robust approach: strip a leading `\\?\` from both via `fsutil` helper if one exists, else add `fn strip_verbatim(p: &Path) -> PathBuf` here. Add a Windows-only test asserting `C:\proj\out\a.png` style input resolves.)

`run/model.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    /// Position within the attempt (0-based).
    #[serde(default)]
    pub index: u32,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default = "default_media_type")]
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub recorded_at: String,
}

fn default_media_type() -> String { crate::run::artifacts::DEFAULT_MEDIA_TYPE.to_string() }
```

`EventBody::NodeArtifact` gets the same six fields with the same serde attributes; `apply` pushes `Artifact { index, path, label, media_type, bytes, recorded_at }` and, in the `NodeStatus::Running` arm, adds `n.artifacts.clear();`. Fix every constructor of `NodeArtifact` / `Artifact` the compiler reports (driver, tests).

`run/process.rs`: `Artifact { path: String, label: Option<String>, media_type: Option<String> }`; parse arm `media_type: s("mediaType")`.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` → all pass (counts rise by 6).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/run/artifacts.rs src-tauri/crates/flow-core/src/run/mod.rs src-tauri/crates/flow-core/src/run/model.rs src-tauri/crates/flow-core/src/run/process.rs
git commit -m "feat(flow): artifact records with media types and artifacts.json helpers"
```

---

### Task 2: The driver records artifacts

**Files:**
- Modify: `src-tauri/crates/flow-core/src/run/driver.rs` (`apply_item` Artifact arm → `record_artifact`; new const `FLOW_ARTIFACT_OUTSIDE_PROJECT`), `src-tauri/crates/flow-core/src/run/test_helper.rs` (new command step `write_file`), `src-tauri/crates/flow-core/src/run/tests.rs`
- Test: `run/tests.rs`

**Interfaces:**
- Consumes: Task 1.
- Produces: `driver::FLOW_ARTIFACT_OUTSIDE_PROJECT: &str = "FLOW_ARTIFACT_OUTSIDE_PROJECT"`; `Driver::record_artifact(&mut self, key: &str, node_dir: &Path, path: String, label: Option<String>, media_type: Option<String>)`; `<attempt>/artifacts.json` rewritten after each accepted artifact; fake command step `{"write_file": {"path": "<node-dir-relative or absolute>", "content": "..."}}` (creates parent dirs; a relative path is relative to `MDIUM_FLOW_NODE_DIR`).

- [ ] **Step 1: Write the failing tests** (`run/tests.rs`)

```rust
#[test]
fn artifacts_are_recorded_with_media_types_and_written_to_artifacts_json() {
    let f = fixture();
    let rel = write_flow(&f.root, "art", json!({}), vec![cmd("a", json!([
        {"write_file": {"path": "out/pic.png", "content": "abc"}},
        ev(json!({"v":1,"type":"artifact","path":"out/pic.png","label":"pic"})),
        ev(json!({"v":1,"type":"artifact","path":"out/notes.md"})),
        ev(json!({"v":1,"type":"artifact","path":"out/blob","label":"blob","mediaType":"application/x-custom"})),
    ]))], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let a = node(&f.snapshot(&run_id), "a");
    assert_eq!(a.artifacts.len(), 3);
    assert_eq!(a.artifacts[0].index, 0);
    assert_eq!(a.artifacts[0].label.as_deref(), Some("pic"));
    assert_eq!(a.artifacts[0].media_type, "image/png");
    assert_eq!(a.artifacts[0].bytes, Some(3));
    assert!(Path::new(&a.artifacts[0].path).is_absolute());
    assert_eq!(a.artifacts[1].media_type, "text/markdown");
    assert_eq!(a.artifacts[1].bytes, None, "missing file keeps no size");
    assert_eq!(a.artifacts[2].media_type, "application/x-custom");
    assert!(!a.artifacts[0].recorded_at.is_empty());
    let dir = f.engine_store().node_attempt_dir(&run_id, "a", 1).unwrap();
    let on_disk = crate::run::artifacts::read_artifacts_json(&dir);
    assert_eq!(on_disk, a.artifacts);
}

#[test]
fn artifact_without_a_file_is_recorded_without_bytes() {
    let f = fixture();
    let rel = write_flow(&f.root, "art2", json!({}), vec![cmd("a", json!([
        ev(json!({"v":1,"type":"artifact","path":"later.txt","label":"later"})),
    ]))], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let a = node(&f.snapshot(&run_id), "a");
    assert_eq!(a.artifacts.len(), 1);
    assert_eq!(a.artifacts[0].bytes, None);
    assert_eq!(a.artifacts[0].media_type, "text/plain");
}

#[test]
fn artifacts_outside_the_project_are_rejected_with_a_warning() {
    let f = fixture();
    let outside = f._tmp.path().join("outside.txt");
    std::fs::write(&outside, "x").unwrap();
    let rel = write_flow(&f.root, "art3", json!({}), vec![cmd("a", json!([
        ev(json!({"v":1,"type":"artifact","path": outside.to_str().unwrap(), "label":"bad"})),
        ev(json!({"v":1,"type":"artifact","path":"../../../../../../x.txt"})),
        ev(json!({"v":1,"type":"artifact","path":"ok.txt"})),
    ]))], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let a = node(&f.snapshot(&run_id), "a");
    assert_eq!(a.artifacts.len(), 1, "only the inside path is kept");
    assert_eq!(a.artifacts[0].index, 0);
    let warnings: Vec<_> = f.events(&run_id).into_iter().filter(|e| matches!(&e.body, EventBody::Warning(r) if r.code == FLOW_ARTIFACT_OUTSIDE_PROJECT)).collect();
    assert_eq!(warnings.len(), 2);
    let log = f.engine.log(&f.root, &run_id, "a", 1, "stdout", 4096).unwrap();
    assert!(log.contains("FLOW_ARTIFACT_OUTSIDE_PROJECT"), "warning is visible in the node log: {log}");
}

#[test]
fn a_retry_starts_a_fresh_artifact_list() {
    let f = fixture();
    let rel = write_flow(&f.root, "art4", json!({}), vec![{
        let mut n = cmd("a", json!([
            ev(json!({"v":1,"type":"artifact","path":"a.txt"})),
            {"fail_before_attempt": 2},
        ]));
        n["retry"] = json!({"max": 1});
        n
    }], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let a = node(&f.snapshot(&run_id), "a");
    assert_eq!(a.attempt, 2);
    assert_eq!(a.artifacts.len(), 1);
    assert_eq!(a.artifacts[0].index, 0);
    let store = f.engine_store();
    assert_eq!(crate::run::artifacts::read_artifacts_json(&store.node_attempt_dir(&run_id, "a", 1).unwrap()).len(), 1);
    assert_eq!(crate::run::artifacts::read_artifacts_json(&store.node_attempt_dir(&run_id, "a", 2).unwrap()).len(), 1);
}
```

(Check how existing tests spell a node's `retry` attribute and the `fail_before_attempt` step — mirror the existing retry test in `tests.rs`. The python path is covered by the existing `python_node_runs_a_stage_and_records_events` test: extend its assertion with `s.artifacts[0].media_type == "text/plain"`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core artifacts_are_recorded` → fails (`index` 0 vs missing fields / `write_file` unknown step).

- [ ] **Step 3: Implement**

`run/test_helper.rs`, command steps: add

```rust
            "write_file" => {
                let spec = &step["write_file"];
                let raw = spec["path"].as_str().unwrap_or_default();
                let path = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { PathBuf::from(std::env::var("MDIUM_FLOW_NODE_DIR").unwrap_or_default()).join(raw) };
                if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
                std::fs::write(&path, spec["content"].as_str().unwrap_or_default()).unwrap();
            }
```

`run/driver.rs`:

```rust
pub const FLOW_ARTIFACT_OUTSIDE_PROJECT: &str = "FLOW_ARTIFACT_OUTSIDE_PROJECT";

    /// Records one reported artifact (spec 5.1): path inside the project,
    /// media type guessed when absent, index within the attempt, and the
    /// attempt's `artifacts.json` rewritten. An outside path is a warning.
    fn record_artifact(&mut self, key: &str, node_dir: &Path, raw: String, label: Option<String>, media_type: Option<String>) {
        let resolved = match artifacts::resolve_artifact_path(self.store.project_root(), node_dir, &raw) {
            Ok(p) => p,
            Err(reason) => {
                let warning = Reason::new(FLOW_ARTIFACT_OUTSIDE_PROJECT).with("path", raw.clone()).with("reason", reason);
                let _ = append_line(&node_dir.join("stdout.log"), &format!("[mdium] {FLOW_ARTIFACT_OUTSIDE_PROJECT}: {raw}"));
                self.emit(Some(key), EventBody::Warning(warning));
                return;
            }
        };
        let path = resolved.to_string_lossy().into_owned();
        let media_type = media_type.unwrap_or_else(|| artifacts::guess_media_type(&path).to_string());
        let bytes = std::fs::metadata(&resolved).ok().filter(|m| m.is_file()).map(|m| m.len());
        let index = self.node(key).artifacts.len() as u32;
        self.emit(Some(key), EventBody::NodeArtifact { index, path, label, media_type, bytes, recorded_at: fsutil::now() });
        let list = self.node(key).artifacts.clone();
        if let Err(err) = artifacts::write_artifacts_json(node_dir, &list) {
            self.protocol_warning(Some(key), "artifacts-json", vec![("message", Value::String(err.to_string()))]);
        }
    }
```

In `apply_item` replace the Artifact arm with `ProtocolItem::Artifact { path, label, media_type } => { let dir = <the attempt dir of this call/command>; self.record_artifact(key, &dir, path, label, media_type); }` — for commands the tracked process knows its attempt dir (see `prepare_launch` / `track`); for python calls use `call.dir`. If the dir is not at hand in `apply_item`, pass it in from both call sites (`poll_calls` has `self.calls[idx].dir`; the command path has the `ProtocolCursor`'s file path — its parent). `append_line` is the existing helper used for python `log` lines (keep using it). Imports: `use crate::run::artifacts;`.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/run/driver.rs src-tauri/crates/flow-core/src/run/test_helper.rs src-tauri/crates/flow-core/src/run/tests.rs
git commit -m "feat(flow): record artifacts with path checks, media types and artifacts.json"
```

---

### Task 3: Artifact references in templates, conditions and `show`

**Files:**
- Modify: `src-tauri/crates/flow-core/src/template.rs` (`Reference::NodeArtifacts`, `Reference::NodeArtifact`, parse, Display), `src-tauri/crates/flow-core/src/validate.rs` (unknown-node check), `src-tauri/crates/flow-core/src/run/prepare.rs` (`TemplateContext.artifacts`, resolve), `src-tauri/crates/flow-core/src/run/driver.rs` (`artifacts_seen`, `with_ctx`)
- Test: `template.rs`, `validate.rs` (or `tests.rs` validation fixtures), `run/tests.rs`

**Interfaces:**
- Produces:
  - `Reference::NodeArtifacts { node: String }` (`nodes.<id>.artifacts`), `Reference::NodeArtifact { node: String, label: String }` (`nodes.<id>.artifacts.<label>`).
  - `prepare::ArtifactsOf { node_key: String, attempt: u32, artifacts: Vec<Artifact> }`, `prepare::ArtifactsLookup<'a> = &'a dyn Fn(&str) -> Option<ArtifactsOf>`, `TemplateContext.artifacts: ArtifactsLookup<'a>`.
  - `TemplateContext::resolve`: `NodeArtifacts` → `Value::Array` of the artifact records (serde), `NodeArtifact` → `Value::String(path)` of the first artifact whose `label == label`, `None` when absent.
  - `Driver::artifacts_seen(&self, prefix: &str, id: &str) -> Option<ArtifactsOf>` (same scope walk as `outputs_seen`).
- Consumes: Task 1 `Artifact`.

- [ ] **Step 1: Write the failing tests**

`template.rs` tests:

```rust
    #[test]
    fn parses_artifact_references() {
        assert_eq!(parse_reference("nodes.a.artifacts").unwrap(), Reference::NodeArtifacts { node: "a".into() });
        assert_eq!(parse_reference("nodes.a.artifacts.pic").unwrap(), Reference::NodeArtifact { node: "a".into(), label: "pic".into() });
        assert!(parse_reference("nodes.a.artifacts.pic.extra").is_err());
        for r in [Reference::NodeArtifacts { node: "a".into() }, Reference::NodeArtifact { node: "a".into(), label: "pic".into() }] {
            assert_eq!(parse_reference(&r.to_string()).unwrap(), r);
        }
    }
```

`validate.rs` tests (next to the existing unknown-node-ref test):

```rust
    #[test]
    fn artifact_references_need_a_visible_node() {
        let flow = json!({"schemaVersion":1,"id":"f","name":"F","nodes":[
            {"id":"a","kind":"command","run":["x"]},
            {"id":"r","kind":"approval","show":["nodes.a.artifacts","nodes.a.artifacts.pic","nodes.zzz.artifacts"]}
        ],"edges":[{"from":"a","to":"r"}]});
        let issues = check_json(&flow);   // use the helper the surrounding tests use
        assert_eq!(issues.errors.len(), 1);
        assert_eq!(issues.errors[0].code, FLOW_UNKNOWN_NODE_REF);
        assert_eq!(issues.errors[0].path, "nodes[1].show[2]");
    }
```

`run/tests.rs`:

```rust
#[test]
fn artifact_label_reference_takes_the_first_match() {
    let f = fixture();
    let rel = write_flow(&f.root, "artref", json!({"outputs": {"first": "${{ nodes.a.artifacts.pic }}", "all": "${{ nodes.a.artifacts }}"}}), vec![
        cmd("a", json!([
            ev(json!({"v":1,"type":"artifact","path":"one.png","label":"pic"})),
            ev(json!({"v":1,"type":"artifact","path":"two.png","label":"pic"})),
        ])),
        {
            let mut n = cmd("b", json!([{"emit_arg_as": "got"}]));
            n["run"].as_array_mut().unwrap().push(json!("${{ nodes.a.artifacts.pic }}"));
            n
        },
    ], vec![json!({"from":"a","to":"b"})]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    let got = node(&snap, "b").outputs["got"].as_str().unwrap().to_string();
    assert!(got.ends_with("one.png"), "{got}");
    let outputs = &snap.state.outputs;   // or wherever flow outputs live in the snapshot — mirror the existing flow-outputs test
    assert!(outputs["first"].as_str().unwrap().ends_with("one.png"));
    assert_eq!(outputs["all"].as_array().unwrap().len(), 2);
    assert_eq!(outputs["all"][1]["label"], "pic");
}

#[test]
fn a_missing_artifact_label_is_unresolved() {
    let f = fixture();
    let rel = write_flow(&f.root, "artref2", json!({}), vec![
        cmd("a", json!([])),
        { let mut n = cmd("b", json!([])); n["run"].as_array_mut().unwrap().push(json!("${{ nodes.a.artifacts.nope }}")); n },
    ], vec![json!({"from":"a","to":"b"})]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(node(&snap, "b").reason.unwrap().code, "FLOW_TEMPLATE_UNRESOLVED");
}
```

(Check how the existing tests read flow-level `outputs` from a snapshot and how the `emit_arg_as` step is used; `cmd()` builds `run` as an argv array — confirm before pushing to it.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core artifact` → compile errors (variants missing).

- [ ] **Step 3: Implement**

`template.rs`: add the two variants with doc comments, `Display` arms (`nodes.{node}.artifacts`, `nodes.{node}.artifacts.{label}`), parse arms `["nodes", node, "artifacts"]` and `["nodes", node, "artifacts", label]` right after the outputs arms.

`validate.rs` `reference()`: extend the unknown-node arm to `Reference::NodeOutput { node, .. } | Reference::NodeOutputs { node } | Reference::NodeArtifacts { node } | Reference::NodeArtifact { node, .. } if !ctx.visible.contains(node)`. No output-key check applies to artifacts (labels are dynamic).

`run/prepare.rs`:

```rust
/// Artifacts of a node visible from a place in the run (with the instance they belong to).
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactsOf { pub node_key: String, pub attempt: u32, pub artifacts: Vec<Artifact> }
pub type ArtifactsLookup<'a> = &'a dyn Fn(&str) -> Option<ArtifactsOf>;
// TemplateContext: pub artifacts: ArtifactsLookup<'a>,
// resolve():
            Reference::NodeArtifacts { node } => (self.artifacts)(node).map(|a| serde_json::to_value(a.artifacts).unwrap_or(Value::Null)),
            Reference::NodeArtifact { node, label } => (self.artifacts)(node)?.artifacts.into_iter().find(|a| a.label.as_deref() == Some(label)).map(|a| Value::String(a.path)),
```

Update every `TemplateContext { ... }` construction (`grep -n "TemplateContext {" src-tauri/crates/flow-core/src -r`): tests pass `artifacts: &|_| None`.

`run/driver.rs`: `artifacts_seen` mirrors `outputs_seen` but returns `Some(ArtifactsOf { node_key: key.clone(), attempt: n.attempt, artifacts: n.artifacts.clone() })`; `with_ctx` builds `let artifacts = |id: &str| self.artifacts_seen(prefix, id);` and passes `artifacts: &artifacts`.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/template.rs src-tauri/crates/flow-core/src/validate.rs src-tauri/crates/flow-core/src/run/prepare.rs src-tauri/crates/flow-core/src/run/driver.rs src-tauri/crates/flow-core/src/run/tests.rs
git commit -m "feat(flow): reference node artifacts by list and by label"
```

---

### Task 4: Approval options with `commentRequired`, typed `show`, `choice` / `comment` outputs

**Files:**
- Modify: `src-tauri/crates/flow-core/src/model.rs` (`ApprovalOption`, `ApprovalNode.options`), `src-tauri/crates/flow-core/src/parse.rs` (allow-list for option objects), `src-tauri/crates/flow-core/src/validate.rs` (`port_names` over option names), `src-tauri/crates/flow-core/src/run/model.rs` (`ApprovalRequest.options`, `ShowValue`, `ApprovalRequest.show`), `src-tauri/crates/flow-core/src/run/driver.rs` (resolve `show`, outputs on approval, option checks), `src-tauri/crates/flow-core/src/run/engine.rs` (`FLOW_APPROVAL_COMMENT_REQUIRED` check in `approve`)
- Test: `model.rs`, `parse.rs`, `run/model.rs`, `run/tests.rs`, fixtures under `src-tauri/tests/fixtures/flows/valid/` (one new valid fixture `approval-options.flow.yaml`)

**Interfaces:**
- Produces:
  - `model::ApprovalOption { name: String, comment_required: bool }` — deserializes from a bare string or `{ name, commentRequired? }`; serializes as the bare string when `comment_required` is false, else the object (custom `Serialize` / `Deserialize`).
  - `ApprovalNode.options: Option<Vec<ApprovalOption>>`, `effective_options() -> Vec<ApprovalOption>`, `DEFAULT_APPROVAL_OPTIONS` unchanged.
  - `run::model::ShowValue` — `#[serde(untagged)] enum ShowValue { Artifacts(ShowArtifacts), Value(Value) }` with `ShowArtifacts { kind: ShowKind /* always "artifacts" */, node_key: String, attempt: u32, artifacts: Vec<Artifact> }` (camelCase); `ApprovalRequest.show: BTreeMap<String, ShowValue>`; `ApprovalRequest.options: Vec<ApprovalOption>`.
  - On approval of an approval node the driver emits `NodeOutput { key: "choice", value }` and `NodeOutput { key: "comment", value: "" | comment }` before settling.
  - `engine::FLOW_APPROVAL_COMMENT_REQUIRED: &str` — `approve` returns it when the chosen option requires a comment and `comment` is `None` or blank.
- Consumes: Task 3 (`Reference::NodeArtifacts` / `NodeArtifact`, `artifacts_seen`).

- [ ] **Step 1: Write the failing tests**

`model.rs` tests:

```rust
    #[test]
    fn approval_options_accept_strings_and_objects_and_round_trip() {
        let node: ApprovalNode = serde_json::from_value(json!({"options": ["accept", {"name": "revise", "commentRequired": true}, {"name": "later"}]})).unwrap();
        let opts = node.effective_options();
        assert_eq!(opts.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["accept", "revise", "later"]);
        assert_eq!(opts.iter().map(|o| o.comment_required).collect::<Vec<_>>(), [false, true, false]);
        let back = serde_json::to_value(&node).unwrap();
        assert_eq!(back["options"], json!(["accept", {"name": "revise", "commentRequired": true}, "later"]));
        let old: ApprovalNode = serde_json::from_value(json!({"options": ["a", "b"]})).unwrap();
        assert_eq!(old.effective_options().len(), 2);
    }
```

`parse.rs` tests: an approval node with `options: [{ name: revise, commentRequired: true, extra: 1 }]` reports `FLOW_UNKNOWN_FIELD` at `nodes[0].options[0].extra`; without `extra` it parses cleanly (mirror the branch `cases` test at `parse.rs:~402`).

`run/model.rs` tests:

```rust
    #[test]
    fn old_show_values_deserialize() {
        let r: ApprovalRequest = serde_json::from_value(json!({"options": ["approve"], "show": {"nodes.a.outputs.x": 42}, "reason": {"code": "FLOW_APPROVAL_NODE"}})).unwrap();
        assert_eq!(r.show["nodes.a.outputs.x"], ShowValue::Value(json!(42)));
        assert_eq!(r.options[0], ApprovalOption { name: "approve".into(), comment_required: false });
    }

    #[test]
    fn show_artifacts_serialize_with_a_kind_marker() {
        let v = ShowValue::Artifacts(ShowArtifacts { kind: ShowKind::Artifacts, node_key: "a".into(), attempt: 1, artifacts: vec![] });
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json, json!({"kind": "artifacts", "nodeKey": "a", "attempt": 1, "artifacts": []}));
        assert_eq!(serde_json::from_value::<ShowValue>(json).unwrap(), v);
    }
```

`run/tests.rs`:

```rust
#[test]
fn approval_shows_artifacts_and_exposes_choice_and_comment() {
    let f = fixture();
    let rel = write_flow(&f.root, "appr", json!({"outputs": {"c": "${{ nodes.review.outputs.comment }}", "ch": "${{ nodes.review.outputs.choice }}"}}), vec![
        cmd("a", json!([
            {"write_file": {"path": "shot.png", "content": "png"}},
            ev(json!({"v":1,"type":"artifact","path":"shot.png","label":"shot"})),
            ev(json!({"v":1,"type":"output","key":"n","value":7})),
        ])),
        json!({"id":"review","kind":"approval","show":["nodes.a.outputs.n","nodes.a.artifacts","nodes.a.artifacts.shot"],
               "options":["accept",{"name":"revise","commentRequired":true}]}),
    ], vec![json!({"from":"a","to":"review"})]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_status(&run_id, RunStatus::AwaitingApproval);
    let req = f.notifier.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(req.options.iter().map(|o| (o.name.as_str(), o.comment_required)).collect::<Vec<_>>(), [("accept", false), ("revise", true)]);
    assert_eq!(req.show["nodes.a.outputs.n"], ShowValue::Value(json!(7)));
    match &req.show["nodes.a.artifacts"] { ShowValue::Artifacts(s) => { assert_eq!(s.node_key, "a"); assert_eq!(s.attempt, 1); assert_eq!(s.artifacts.len(), 1); } other => panic!("{other:?}") }
    match &req.show["nodes.a.artifacts.shot"] { ShowValue::Artifacts(s) => assert_eq!(s.artifacts[0].label.as_deref(), Some("shot")), other => panic!("{other:?}") }
    let err = f.engine.approve(&f.root, &run_id, Some("review"), "revise", None).unwrap_err();
    assert_eq!(err.code, crate::run::engine::FLOW_APPROVAL_COMMENT_REQUIRED);
    let err = f.engine.approve(&f.root, &run_id, Some("review"), "revise", Some("   ".into())).unwrap_err();
    assert_eq!(err.code, crate::run::engine::FLOW_APPROVAL_COMMENT_REQUIRED);
    f.engine.approve(&f.root, &run_id, Some("review"), "accept", None).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    let review = node(&snap, "review");
    assert_eq!(review.outputs["choice"], "accept");
    assert_eq!(review.outputs["comment"], "");
    assert_eq!(review.port.as_deref(), Some("accept"));
    assert_eq!(snap.state.outputs["ch"], "accept");   // adapt to where flow outputs live
}

#[test]
fn comment_required_option_refuses_an_empty_comment() {
    let f = fixture();
    let rel = write_flow(&f.root, "appr2", json!({}), vec![
        json!({"id":"review","kind":"approval","options":[{"name":"revise","commentRequired":true},"accept"]}),
    ], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_status(&run_id, RunStatus::AwaitingApproval);
    assert_eq!(f.engine.approve(&f.root, &run_id, Some("review"), "revise", Some("".into())).unwrap_err().code, crate::run::engine::FLOW_APPROVAL_COMMENT_REQUIRED);
    f.engine.approve(&f.root, &run_id, Some("review"), "revise", Some("fix the title".into())).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "review").outputs["comment"], "fix the title");
}
```

(Check the exact `Err` type of `engine.approve` — it is the engine's `Result` with an `EngineError { code, .. }`; adapt `.code` access accordingly. A missing-label `show` entry (`nodes.a.artifacts.nope`) resolves to `ShowValue::Value(Value::Null)` — add one assertion for it.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core approval` → compile errors.

- [ ] **Step 3: Implement**

`model.rs`:

```rust
/// One approval option (= output port), optionally requiring a comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalOption { pub name: String, pub comment_required: bool }

impl Serialize for ApprovalOption {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.comment_required {
            use serde::ser::SerializeStruct;
            let mut st = s.serialize_struct("ApprovalOption", 2)?;
            st.serialize_field("name", &self.name)?;
            st.serialize_field("commentRequired", &true)?;
            st.end()
        } else { s.serialize_str(&self.name) }
    }
}

impl<'de> Deserialize<'de> for ApprovalOption {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw { Name(String), Full { name: String, #[serde(default, rename = "commentRequired")] comment_required: bool } }
        Ok(match Raw::deserialize(d)? {
            Raw::Name(name) => ApprovalOption { name, comment_required: false },
            Raw::Full { name, comment_required } => ApprovalOption { name, comment_required },
        })
    }
}
```

`ApprovalNode.options: Option<Vec<ApprovalOption>>`; `effective_options()` maps defaults to `ApprovalOption { name, comment_required: false }`.

`parse.rs`: in the nested-key walk, treat `options` of an approval like branch `cases`: for each array element that is an object, allow exactly `["name", "commentRequired"]` and report others at `nodes[i].options[j].<key>`.

`validate.rs` `approval()`: `self.port_names(&options.iter().map(|o| o.name.clone()).collect::<Vec<_>>(), ...)`.

`run/model.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShowKind { Artifacts }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowArtifacts { pub kind: ShowKind, pub node_key: String, pub attempt: u32, pub artifacts: Vec<Artifact> }

/// A value an approval shows: artifacts (previewed) or any other value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShowValue { Artifacts(ShowArtifacts), Value(Value) }
```

`ApprovalRequest { options: Vec<ApprovalOption>, show: BTreeMap<String, ShowValue>, .. }`. Fix the compile errors in `driver.rs` (`request.options.iter().any(|o| o.name == choice)`, command-initiated and budget approvals build `vec![ApprovalOption { name: "approve".into(), comment_required: false }, ...]`) and in `engine.rs`.

`run/driver.rs` `start_node` Approval arm: resolve each `show` entry with `template::parse_reference`; for `Reference::NodeArtifacts { node }` and `NodeArtifact { node, label }` call `self.artifacts_seen(prefix, node)` and build `ShowValue::Artifacts(ShowArtifacts { kind: ShowKind::Artifacts, node_key, attempt, artifacts })` (filtered to the label for `NodeArtifact`; a label with no match → `ShowValue::Value(Value::Null)`); any other reference → `ShowValue::Value(ctx.resolve(&r).unwrap_or(Value::Null))`. `apply_approval`, approval-node branch: before `settle`, emit `NodeOutput { key: "choice".into(), value: Value::String(choice.into()) }` and `NodeOutput { key: "comment".into(), value: Value::String(comment.clone().unwrap_or_default()) }` (capture `comment` before it is moved into the `Approval` event).

`run/engine.rs` `approve`: after finding the request and checking the choice is an option, `if option.comment_required && comment.as_deref().map(str::trim).unwrap_or("").is_empty() { return Err(EngineError::new(FLOW_APPROVAL_COMMENT_REQUIRED, "a comment is required for this option")); }` with `pub const FLOW_APPROVAL_COMMENT_REQUIRED: &str = "FLOW_APPROVAL_COMMENT_REQUIRED";`.

Fixture: `src-tauri/tests/fixtures/flows/valid/approval-options.flow.yaml` with an approval whose `options` mix strings and objects and whose `show` uses the three reference forms (the fixture-sweep test `valid_fixtures_have_no_errors_or_warnings` covers it).

- [ ] **Step 4: Run the tests**

Run: `cargo test -p flow-core` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/model.rs src-tauri/crates/flow-core/src/parse.rs src-tauri/crates/flow-core/src/validate.rs src-tauri/crates/flow-core/src/run/model.rs src-tauri/crates/flow-core/src/run/driver.rs src-tauri/crates/flow-core/src/run/engine.rs src-tauri/crates/flow-core/src/run/tests.rs src-tauri/tests/fixtures/flows/valid/approval-options.flow.yaml
git commit -m "feat(flow): approval options with required comments, artifact previews in show, choice and comment outputs"
```

---

### Task 5: `flow_artifact_path` — service command, Tauri wrapper with asset scope, protocol and CSP

**Files:**
- Modify: `src-tauri/crates/flow-core/src/run/engine.rs` (`artifact_path`), `src-tauri/crates/flow-core/src/service.rs` (`run_artifact_path`, `ArtifactArgs`, `COMMAND_NAMES` → 21), `src-tauri/src/commands/flow_run.rs` (`flow_artifact_path`), `src-tauri/src/lib.rs` (registration), `src-tauri/Cargo.toml` (`protocol-asset`), `src-tauri/tauri.conf.json` (`assetProtocol`, CSP `media-src`)
- Test: `service.rs`, the `COMMAND_NAMES` count test, the Tauri parity test

**Interfaces:**
- Produces:
  - `engine::ArtifactLocation { path: String, media_type: String, bytes: Option<u64> }` (serde camelCase).
  - `FlowEngine::artifact_path(&self, root: &Path, run_id: &str, node_key: &str, attempt: u32, index: u32) -> Result<ArtifactLocation>` — reads `<attempt>/artifacts.json`, finds `index`, re-checks the path lies inside the project root (`artifacts::resolve_artifact_path`), else `FLOW_ARTIFACT_NOT_FOUND`; `FLOW_NODE_NOT_FOUND` when the node key is unknown (as `log` does).
  - `FlowService::run_artifact_path(&self, project_root: &str, run_id: &str, node_key: &str, attempt: u32, index: u32) -> Result<ArtifactLocation, FlowCommandError>`; `COMMAND_NAMES` gains `"flow_artifact_path"`; `call` arm with `ArtifactArgs { project_root, run_id, node_key, attempt, index }`.
  - Tauri `flow_artifact_path(app: tauri::AppHandle, state, project_root, run_id, node_key, attempt, index) -> Result<ArtifactLocation, FlowCommandError>`: delegates, then `app.asset_protocol_scope().allow_file(&location.path)` (error → `FLOW_ARTIFACT_NOT_FOUND` with the message), returns the location.
  - Config: `tauri = { version = "2", features = ["image-png", "protocol-asset"] }`; `app.security.assetProtocol: { "enable": true, "scope": [] }`; CSP gains `media-src 'self' blob: asset: http://asset.localhost https://asset.localhost`.
- Consumes: Task 1, Task 2.

- [ ] **Step 1: Write the failing tests** (`service.rs` tests)

```rust
    #[test]
    fn artifact_path_returns_recorded_paths_only() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        // Fabricate a finished run with one artifact (reuse the helper the run_get/log tests use to run a flow through the service).
        let run_id = run_flow_with_artifact(&svc, root);   // write the helper: a command node emitting {"type":"artifact","path":"a.txt","label":"t"} after writing the file
        let loc = svc.run_artifact_path(root, &run_id, "a", 1, 0).unwrap();
        assert!(Path::new(&loc.path).is_absolute());
        assert_eq!(loc.media_type, "text/plain");
        assert_eq!(loc.bytes, Some(1));
        assert_eq!(svc.run_artifact_path(root, &run_id, "a", 1, 9).unwrap_err().code, crate::run::engine::FLOW_ARTIFACT_NOT_FOUND);
        assert_eq!(svc.run_artifact_path(root, &run_id, "zzz", 1, 0).unwrap_err().code, "FLOW_NODE_NOT_FOUND");
        let via_call = svc.call("flow_artifact_path", json!({"projectRoot": root, "runId": run_id, "nodeKey": "a", "attempt": 1, "index": 0})).unwrap();
        assert_eq!(via_call["mediaType"], "text/plain");
        // A tampered artifacts.json pointing outside the project is refused.
        let dir = svc.engine_store_for_tests(root).node_attempt_dir(&run_id, "a", 1).unwrap();   // or compute the dir with RunStore::new(root)
        std::fs::write(dir.join("artifacts.json"), r#"[{"index":0,"path":"C:/Windows/notepad.exe","mediaType":"application/octet-stream","recordedAt":""}]"#).unwrap();
        assert_eq!(svc.run_artifact_path(root, &run_id, "a", 1, 0).unwrap_err().code, crate::run::engine::FLOW_ARTIFACT_NOT_FOUND);
    }
```

(Use the same flow-running approach the existing `run_log` service test uses — look for `flow_run_log` in `service.rs` tests. Use `/etc/passwd` on unix for the tampered path: `if cfg!(windows) {..} else {..}`.) Bump the expected `COMMAND_NAMES` length to 21 in its test.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p flow-core artifact_path` → compile error.

- [ ] **Step 3: Implement**

`engine.rs`:

```rust
pub const FLOW_ARTIFACT_NOT_FOUND: &str = "FLOW_ARTIFACT_NOT_FOUND";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLocation { pub path: String, pub media_type: String, #[serde(skip_serializing_if = "Option::is_none")] pub bytes: Option<u64> }

    /// The absolute path of a recorded artifact (spec 5.2): only what
    /// `artifacts.json` lists, and only inside the project.
    pub fn artifact_path(&self, root: &Path, run_id: &str, node_key: &str, attempt: u32, index: u32) -> Result<ArtifactLocation> {
        let (store, meta, state) = /* same attach + load as `log` */;
        if !state.nodes.contains_key(node_key) { return Err(EngineError::new(FLOW_NODE_NOT_FOUND, node_key)); }
        let dir = store.node_attempt_dir(run_id, node_key, attempt)?;
        let artifact = artifacts::read_artifacts_json(&dir).into_iter().find(|a| a.index == index)
            .ok_or_else(|| EngineError::new(FLOW_ARTIFACT_NOT_FOUND, format!("{node_key}#{attempt}[{index}]")))?;
        let path = artifacts::resolve_artifact_path(store.project_root(), &dir, &artifact.path)
            .map_err(|_| EngineError::new(FLOW_ARTIFACT_NOT_FOUND, "outside the project"))?;
        let bytes = std::fs::metadata(&path).ok().filter(|m| m.is_file()).map(|m| m.len());
        Ok(ArtifactLocation { path: path.to_string_lossy().into_owned(), media_type: artifact.media_type, bytes })
    }
```

`service.rs`: `run_artifact_path` (delegates like `run_log`), `ArtifactArgs` (camelCase, deny_unknown_fields), `COMMAND_NAMES` entry, `call` arm.

`src-tauri/src/commands/flow_run.rs`:

```rust
#[tauri::command]
pub async fn flow_artifact_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, FlowServiceState>,
    project_root: String, run_id: String, node_key: String, attempt: u32, index: u32,
) -> Result<ArtifactLocation, FlowCommandError> {
    let location = with_service(state, move |s| s.run_artifact_path(&project_root, &run_id, &node_key, attempt, index)).await?;
    // Only recorded artifacts become loadable through the asset protocol (spec 5.2).
    app.asset_protocol_scope().allow_file(&location.path)
        .map_err(|e| FlowCommandError::new(flow_core::run::engine::FLOW_ARTIFACT_NOT_FOUND, e.to_string()))?;
    Ok(location)
}
```

Register in `lib.rs` next to `flow_run_log`. `Cargo.toml` feature; `tauri.conf.json`:

```json
"security": {
  "assetProtocol": { "enable": true, "scope": [] },
  "csp": "<existing>; media-src 'self' blob: asset: http://asset.localhost https://asset.localhost"
}
```

(Append `media-src` as a new directive; keep every existing directive unchanged.)

- [ ] **Step 4: Run everything**

Run: `cargo test --workspace` (from `src-tauri`), `cargo build` (confirms the `protocol-asset` feature compiles), `cargo tree -p flow-core -e normal | grep -i ' tauri'` → empty. Do not stage `src-tauri/gen/schemas/*.json` even though the build regenerates them.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/run/engine.rs src-tauri/crates/flow-core/src/service.rs src-tauri/src/commands/flow_run.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "feat(flow): flow_artifact_path command, asset protocol scope and media CSP"
```

---

### Task 6: Frontend types, transport `artifactUrl`, artifact kinds, i18n

**Files:**
- Modify: `src/shared/types/flow-run.ts`, `src/features/flow/lib/transport.ts`, `src/features/flow/lib/tauri-transport.ts`, `src/features/flow/lib/flow-run-api.ts`, `src/features/flow/lib/__tests__/transport.test.ts`, `src/features/flow/components/__tests__/RunViews.test.tsx` ("flow run api" block), `src/shared/i18n/locales/{en,ja}/flow.json`
- Create: `src/features/flow/lib/artifact-kind.ts`, `src/features/flow/lib/__tests__/artifact-kind.test.ts`

**Interfaces:**
- Produces:
  - Types: `Artifact { index: number; path: string; label?: string; mediaType: string; bytes?: number; recordedAt: string }`; `ArtifactRef { runId: string; nodeKey: string; attempt: number; index: number }`; `ArtifactLocation { path: string; mediaType: string; bytes?: number }`; `ApprovalOption { name: string; commentRequired?: boolean }`; `ShowValue = { kind: "artifacts"; nodeKey: string; attempt: number; artifacts: Artifact[] } | unknown`; `ApprovalRequest.options: ApprovalOption[]`, `show?: Record<string, ShowValue>`; `NodeState.artifacts?: Artifact[]`; helper `isShowArtifacts(v: unknown): v is ShowArtifacts`.
  - `FlowTransport.artifactUrl(projectRoot: string, ref: ArtifactRef): Promise<string>`; Tauri: `invoke<ArtifactLocation>("flow_artifact_path", { projectRoot, ...ref })` then `convertFileSrc(location.path, "asset")`.
  - `flowRunApi.artifactUrl(projectRoot, ref)`.
  - `artifact-kind.ts`: `type ArtifactKind = "image" | "video" | "audio" | "text" | "json" | "other"`; `artifactKind(mediaType: string): ArtifactKind` (`image/*` → image, `video/*` → video, `audio/*` → audio, `application/json` → json, `text/*` → text, else other); `TEXT_PREVIEW_BYTES = 256 * 1024`; `fetchTextHead(url: string, maxBytes?: number): Promise<{ text: string; truncated: boolean }>` (`fetch(url, { headers: { Range: "bytes=0-<max-1>" } })`; `truncated` when the status is 206 and `Content-Range` total exceeds `maxBytes`, or the body is longer than `maxBytes` (then cut)); `prettyJson(text: string): string | null` (parses, returns 2-space JSON, `null` on failure).
  - i18n keys (en / ja): `run.tab.overview` "Overview" / "概要", `run.tab.artifacts` "Artifacts" / "成果物", `run.outputs` "Outputs" / "出力", `run.noOutputs` "No outputs." / "出力はありません。", `run.noArtifacts` "No artifacts." / "成果物はありません。", `run.previewUnavailable` "Preview unavailable." / "プレビューを表示できません。", `run.previewTruncated` "Showing the first {{kib}} KiB." / "先頭 {{kib}} KiB を表示しています。", `run.previewNone` "No preview for this type." / "この種類はプレビューできません。", `run.openArtifact` "Open" / "開く", `run.commentRequired` "This option needs a comment." / "この選択肢にはコメントが必要です。", `run.review` "Review" / "確認", `run.iteration` "Iteration {{n}}" / "反復 {{n}}", `run.agg.running` "{{n}} running" / "実行中 {{n}}", `run.agg.failed` "{{n}} failed" / "失敗 {{n}}", `run.agg.awaiting` "{{n}} awaiting approval" / "承認待ち {{n}}", `run.expand` "Expand" / "展開", `run.collapse` "Collapse" / "折りたたむ", `runError.FLOW_ARTIFACT_NOT_FOUND` "The artifact is not recorded for this run." / "この実行に記録されていない成果物です。", `runError.FLOW_APPROVAL_COMMENT_REQUIRED` "A comment is required for this option." / "この選択肢にはコメントが必要です。", `reason.FLOW_ARTIFACT_OUTSIDE_PROJECT` "Artifact \"{{path}}\" is outside the project and was ignored." / "成果物「{{path}}」はプロジェクトの外にあるため無視しました。".

- [ ] **Step 1: Write the failing tests**

`artifact-kind.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { artifactKind, fetchTextHead, prettyJson, TEXT_PREVIEW_BYTES } from "../artifact-kind";

describe("artifactKind", () => {
  it.each([
    ["image/png", "image"], ["image/webp", "image"], ["video/mp4", "video"], ["audio/wav", "audio"],
    ["application/json", "json"], ["text/plain", "text"], ["text/markdown", "text"], ["application/octet-stream", "other"], ["", "other"],
  ] as const)("%s → %s", (media, kind) => expect(artifactKind(media)).toBe(kind));
});

describe("fetchTextHead", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("requests a byte range and returns the text", async () => {
    const fetchMock = vi.fn(async () => new Response("hello", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTextHead("asset://x")).resolves.toEqual({ text: "hello", truncated: false });
    expect(fetchMock).toHaveBeenCalledWith("asset://x", { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
  });
  it("marks a 206 response as truncated when the total exceeds the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("head", { status: 206, headers: { "Content-Range": `bytes 0-3/${TEXT_PREVIEW_BYTES * 2}` } })));
    await expect(fetchTextHead("asset://x")).resolves.toEqual({ text: "head", truncated: true });
  });
  it("cuts a full body longer than the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a".repeat(10), { status: 200 })));
    await expect(fetchTextHead("asset://x", 4)).resolves.toEqual({ text: "aaaa", truncated: true });
  });
  it("rejects on a failed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchTextHead("asset://x")).rejects.toThrow();
  });
});

describe("prettyJson", () => {
  it("formats valid json and rejects the rest", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("{nope")).toBeNull();
  });
});
```

`transport.test.ts`: a fake transport with `artifactUrl` → `flowRunApi.artifactUrl(ROOT, ref)` returns it; the Tauri transport test (in the same file or `RunViews.test.tsx` "flow run api"): with `invoke` resolving `{ path: "C:/p/a.png", mediaType: "image/png" }` and `convertFileSrc` mocked (`vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`) }))`), `flowRunApi.artifactUrl(ROOT, { runId: "r", nodeKey: "a", attempt: 1, index: 0 })` resolves to `"asset://C:/p/a.png"` and `invoke` was called with `("flow_artifact_path", { projectRoot: ROOT, runId: "r", nodeKey: "a", attempt: 1, index: 0 })`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/flow/lib` → FAIL (module / method missing).

- [ ] **Step 3: Implement** the types, transport method (`tauri-transport.ts` imports `convertFileSrc` from `@tauri-apps/api/core`), api method, `artifact-kind.ts`, and the i18n keys in both locales. Every other `vi.mock("@tauri-apps/api/core", ...)` in `src/features/flow` tests must now also provide `convertFileSrc` (grep and add).

- [ ] **Step 4: Run the suites**

Run: `npm test`, `npx tsc --noEmit -p tsconfig.json` → green (the locale-parity test proves the key sets match).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/flow-run.ts src/features/flow/lib src/shared/i18n/locales/en/flow.json src/shared/i18n/locales/ja/flow.json src/features/flow/components/__tests__/RunViews.test.tsx
git commit -m "feat(flow): artifact types, transport artifactUrl, preview kinds and strings"
```

---

### Task 7: The run tree model

**Files:**
- Create: `src/features/flow/lib/run-tree.ts`, `src/features/flow/lib/__tests__/run-tree.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RunAggregate { running: number; failed: number; awaiting: number; costUsd: number; progress?: string }
export interface RunTreeRow {
  /** Node instance key, or the scope prefix for an iteration row. */
  key: string;
  kind: "node" | "iteration";
  /** Display name: the definition name for a root node on pass 1, else the id (with `@pass`), or the iteration index. */
  label: string;
  depth: number;
  node?: NodeState;
  iterationIndex?: number;
  children: RunTreeRow[];
  agg: RunAggregate;
}
export function buildRunTree(state: RunState, flow: FlowDef): RunTreeRow[]
/** Keys of the rows that should start expanded: every ancestor of a running / failed / awaiting node. */
export function defaultExpandedKeys(rows: RunTreeRow[]): Set<string>
export function flattenVisible(rows: RunTreeRow[], expanded: Set<string>): RunTreeRow[]
```

  Rules: a node key's parent is its prefix's owner (`state.scopes[prefix].owner`); when the scope has an `index`, an `iteration` row keyed by the prefix sits between the owner and its nodes; nodes without a resolvable owner go to the root; root rows follow `flow.nodes` order (unknown ids after, by key), iteration rows by index, children by key; `agg` sums children plus the row's own node (`running` counts `running` and `retry_wait`, `failed` counts `failed`, `awaiting` counts `awaiting_approval`, `costUsd` = `cost.actual + cost.estimated`, `progress` = the first running node's `progress.text` depth-first, else the row's own).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import type { NodeState, RunState } from "@/shared/types/flow-run";
import { buildRunTree, defaultExpandedKeys, flattenVisible } from "../run-tree";

const n = (status: NodeState["status"], extra: Partial<NodeState> = {}): NodeState =>
  ({ status, attempt: 1, cost: { actual: 0, estimated: 0 }, costReported: false, ...extra }) as NodeState;
const flow = { schemaVersion: 1, id: "f", name: "F", nodes: [{ id: "docs", kind: "loop", name: "Docs" }, { id: "sub", kind: "subflow", name: "Sub" }, { id: "fin", kind: "command", name: "Finish" }], edges: [] } as unknown as FlowDef;

function state(extra: Partial<RunState> = {}): RunState {
  return {
    seq: 1, status: "running", cost: { actual: 0, estimated: 0 },
    nodes: {
      docs: n("running"),
      "docs[0]/summarize": n("succeeded", { cost: { actual: 0.5, estimated: 0 } }),
      "docs[1]/summarize": n("running", { progress: { text: "half" } }),
      sub: n("succeeded"),
      "sub/inner": n("failed"),
      fin: n("pending"),
    },
    scopes: { "": { status: "running" }, "docs[0]/": { status: "completed", owner: "docs", index: 0 }, "docs[1]/": { status: "running", owner: "docs", index: 1 }, "sub/": { status: "failed", owner: "sub" } },
    ...extra,
  } as RunState;
}

describe("buildRunTree", () => {
  it("nests iterations under their loop and sub-flow nodes under their caller", () => {
    const rows = buildRunTree(state(), flow);
    expect(rows.map((r) => r.label)).toEqual(["Docs", "Sub", "Finish"]);
    const docs = rows[0];
    expect(docs.children.map((c) => [c.kind, c.iterationIndex])).toEqual([["iteration", 0], ["iteration", 1]]);
    expect(docs.children[1].children[0].key).toBe("docs[1]/summarize");
    expect(docs.children[1].children[0].label).toBe("summarize");
    expect(docs.children[1].children[0].depth).toBe(2);
    expect(rows[1].children[0].key).toBe("sub/inner");
  });
  it("aggregates counts, cost and the latest progress bottom-up", () => {
    const [docs, sub] = buildRunTree(state(), flow);
    expect(docs.agg).toEqual({ running: 2, failed: 0, awaiting: 0, costUsd: 0.5, progress: "half" });
    expect(sub.agg.failed).toBe(1);
  });
  it("labels later passes and keeps unknown owners at the root", () => {
    const rows = buildRunTree(state({ nodes: { "fin@2": n("ready"), "ghost/x": n("ready") }, scopes: { "": { status: "running" } }, passes: { fin: 2 } }), flow);
    expect(rows.map((r) => r.label)).toEqual(["fin@2", "x"]);
  });
  it("builds a flat tree when scopes are absent", () => {
    const rows = buildRunTree({ seq: 1, status: "completed", cost: { actual: 0, estimated: 0 }, nodes: { fin: n("succeeded") } } as RunState, flow);
    expect(rows).toHaveLength(1);
    expect(rows[0].children).toEqual([]);
  });
});

describe("defaultExpandedKeys / flattenVisible", () => {
  it("expands only ancestors of running, failed or awaiting nodes", () => {
    const rows = buildRunTree(state(), flow);
    const expanded = defaultExpandedKeys(rows);
    expect([...expanded].sort()).toEqual(["docs", "docs[1]/", "sub"]);
    const visible = flattenVisible(rows, expanded).map((r) => r.key);
    expect(visible).toEqual(["docs", "docs[0]/", "docs[1]/", "docs[1]/summarize", "sub", "sub/inner", "fin"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/flow/lib/__tests__/run-tree.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import type { FlowDef } from "@/shared/types/flow";
import { splitNodeKey, type NodeState, type RunState } from "@/shared/types/flow-run";

const EMPTY: RunAggregate = { running: 0, failed: 0, awaiting: 0, costUsd: 0 };

export function buildRunTree(state: RunState, flow: FlowDef): RunTreeRow[] {
  const rows = new Map<string, RunTreeRow>();
  const roots: RunTreeRow[] = [];
  const order = new Map(flow.nodes.map((d, i) => [d.id, i] as const));
  const rowFor = (key: string): RunTreeRow => {
    let row = rows.get(key);
    if (!row) {
      const { prefix, id, pass } = splitNodeKey(key);
      const def = prefix === "" ? flow.nodes.find((d) => d.id === id) : undefined;
      const base = def?.name && pass === 1 ? def.name : pass > 1 ? `${id}@${pass}` : id;
      row = { key, kind: "node", label: base, depth: 0, node: state.nodes[key], children: [], agg: { ...EMPTY } };
      rows.set(key, row);
      attach(row, prefix);
    }
    return row;
  };
  const iterationFor = (prefix: string, owner: string, index: number): RunTreeRow => {
    let row = rows.get(prefix);
    if (!row) {
      row = { key: prefix, kind: "iteration", label: String(index), depth: 0, iterationIndex: index, children: [], agg: { ...EMPTY } };
      rows.set(prefix, row);
      rowFor(owner).children.push(row);
    }
    return row;
  };
  const attach = (row: RunTreeRow, prefix: string) => {
    const scope = prefix === "" ? undefined : state.scopes?.[prefix];
    if (prefix === "" || !scope?.owner) { roots.push(row); return; }
    const parent = scope.index === undefined ? rowFor(scope.owner) : iterationFor(prefix, scope.owner, scope.index);
    parent.children.push(row);
  };
  for (const key of Object.keys(state.nodes)) rowFor(key);
  const sortRows = (list: RunTreeRow[], root: boolean) =>
    list.sort((a, b) => {
      if (a.kind === "iteration" && b.kind === "iteration") return (a.iterationIndex ?? 0) - (b.iterationIndex ?? 0);
      if (root) {
        const oa = order.get(splitNodeKey(a.key).id) ?? Number.MAX_SAFE_INTEGER;
        const ob = order.get(splitNodeKey(b.key).id) ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
      }
      return a.key.localeCompare(b.key);
    });
  const finish = (row: RunTreeRow, depth: number): RunAggregate => {
    row.depth = depth;
    sortRows(row.children, false);
    const own = aggregateOf(row.node);
    const agg = row.children.reduce((acc, c) => merge(acc, finish(c, depth + 1)), own);
    row.agg = agg;
    return agg;
  };
  sortRows(roots, true);
  for (const r of roots) finish(r, 0);
  return roots;
}

function aggregateOf(node?: NodeState): RunAggregate {
  if (!node) return { ...EMPTY };
  const s = node.status;
  return {
    running: s === "running" || s === "retry_wait" ? 1 : 0,
    failed: s === "failed" ? 1 : 0,
    awaiting: s === "awaiting_approval" ? 1 : 0,
    costUsd: node.cost.actual + node.cost.estimated,
    progress: s === "running" ? node.progress?.text : undefined,
  };
}

function merge(a: RunAggregate, b: RunAggregate): RunAggregate {
  return { running: a.running + b.running, failed: a.failed + b.failed, awaiting: a.awaiting + b.awaiting, costUsd: a.costUsd + b.costUsd, progress: a.progress ?? b.progress };
}

export function defaultExpandedKeys(rows: RunTreeRow[]): Set<string> {
  const out = new Set<string>();
  const visit = (row: RunTreeRow) => {
    if (row.children.length === 0) return;
    const hot = row.agg.running + row.agg.failed + row.agg.awaiting - (row.node ? aggregateOf(row.node).running + aggregateOf(row.node).failed + aggregateOf(row.node).awaiting : 0);
    if (hot > 0) out.add(row.key);
    row.children.forEach(visit);
  };
  rows.forEach(visit);
  return out;
}

export function flattenVisible(rows: RunTreeRow[], expanded: Set<string>): RunTreeRow[] {
  const out: RunTreeRow[] = [];
  const visit = (row: RunTreeRow) => { out.push(row); if (expanded.has(row.key)) row.children.forEach(visit); };
  rows.forEach(visit);
  return out;
}
```

(The `hot` computation expands a parent only when a descendant is running / failed / awaiting; the parent's own state does not count. In the test, `docs` itself is running but its child `docs[1]/summarize` is too, so it expands; `sub` expands because `sub/inner` failed.)

- [ ] **Step 4: Run the tests** → pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/lib/run-tree.ts src/features/flow/lib/__tests__/run-tree.test.ts
git commit -m "feat(flow): run tree model with per-scope aggregates"
```

---

### Task 8: Run panel tree, node detail with the artifacts tab, artifact preview

**Files:**
- Create: `src/features/flow/components/RunNodeTree.tsx`, `src/features/flow/components/RunNodeDetail.tsx`, `src/features/flow/components/ArtifactPreview.tsx`
- Modify: `src/features/flow/components/RunPanel.tsx` (replace the flat `<ul>` and the per-row actions with the tree + detail; keep `ApprovalCard` until Task 9), `src/features/flow/components/Flow.css`, `src/features/flow/components/__tests__/RunViews.test.tsx`

**Interfaces:**
- Produces:
  - `RunNodeTree({ rows: RunTreeRow[]; selectedKey: string | null; onSelect(key: string): void; onOpenApproval(nodeKey: string): void })` — renders `flattenVisible` rows as `<ul role="tree">` / `<li role="treeitem" aria-level aria-expanded aria-selected>` with a toggle button (`aria-label` `run.expand` / `run.collapse`), the label, the status (nodes) or `run.iteration`, and the aggregates for rows with children (`run.agg.running` etc. only when > 0, cost via `formatUsd`, progress text); expansion state lives in the component (`useState(() => defaultExpandedKeys(rows))`, re-seeded when the set of hot keys grows); clicking a row calls `onSelect(key)`; clicking a row whose node is `awaiting_approval` also calls `onOpenApproval(key)`.
  - `RunNodeDetail({ projectRoot; runId; nodeKey; node: NodeState; name: string; canRerun: boolean; canMarkSucceeded: boolean; isApproval: boolean; onAct; onLog })` — head (name, status, attempt), progress, reason, tabs `run.tab.overview` (outputs as a `<dl>`; `run.noOutputs`) and `run.tab.artifacts` (list of `Artifact`s: label or file name, media type, bytes; `run.noArtifacts`; each with `<ArtifactPreview>`), then the action buttons moved from the old rows (Log / Re-run / Mark succeeded).
  - `ArtifactPreview({ projectRoot; runId; nodeKey; attempt; artifact: Artifact })` — resolves the URL with `flowRunApi.artifactUrl` in an effect (cancelled on unmount); by `artifactKind(artifact.mediaType)`: image `<img src alt={label ?? path}>`, video `<video controls src>`, audio `<audio controls src>`, text / json `<pre>` with `fetchTextHead` (json pretty-printed when not truncated and parseable) and `run.previewTruncated` ({{kib}} = 256) when truncated, other → `run.previewNone` plus the path; a rejected URL or fetch → `run.previewUnavailable`. Also exported for Task 9.
- Consumes: Tasks 6, 7.

- [ ] **Step 1: Write the failing tests** (`RunViews.test.tsx`, new `describe("run panel tree and artifacts")`)

Use the file's helpers (`route`, `snapshot`, `summary`, `waitFor`, `button`, hoisted `invoke`). Add `convertFileSrc` to the `@tauri-apps/api/core` mock and `vi.stubGlobal("fetch", ...)` where a text preview is exercised.

```ts
it("renders the node tree with iteration rows and aggregates", async () => {
  const snap = snapshot("r1", {
    state: {
      nodes: { docs: node("running"), "docs[0]/sum": node("succeeded"), "docs[1]/sum": node("running", { progress: { text: "half" } }) },
      scopes: { "": { status: "running" }, "docs[0]/": { status: "completed", owner: "docs", index: 0 }, "docs[1]/": { status: "running", owner: "docs", index: 1 } },
    },
  });
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }) });
  const { container } = await renderPanel();   // the helper the existing tests use to mount <RunPanel> and select the run
  await waitFor(() => container.querySelectorAll('[role="treeitem"]').length >= 4);
  const items = [...container.querySelectorAll('[role="treeitem"]')];
  expect(items.map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "2", "3"]);
  expect(items[0].textContent).toContain("2 running");
  expect(items[0].textContent).toContain("half");
  expect(items[1].textContent).toContain("Iteration 0");
  expect(items[1].getAttribute("aria-expanded")).toBe("false");
  expect(items[2].getAttribute("aria-expanded")).toBe("true");
});

it("shows outputs and artifacts of the selected node with an image preview", async () => {
  const snap = snapshot("r1", { state: { nodes: { a: node("succeeded", { outputs: { n: 7 }, artifacts: [{ index: 0, path: "C:/p/a.png", label: "pic", mediaType: "image/png", bytes: 3, recordedAt: "t" }] }) } } });
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }),
          flow_artifact_path: (args) => { expect(args).toEqual({ projectRoot: ROOT, runId: "r1", nodeKey: "a", attempt: 1, index: 0 }); return { path: "C:/p/a.png", mediaType: "image/png" }; } });
  const { container } = await renderPanel();
  await act(async () => { (container.querySelector('[role="treeitem"]') as HTMLElement).click(); });
  await waitFor(() => container.textContent!.includes("n"));
  expect(container.querySelector(".flow-node-detail dl")!.textContent).toContain("7");
  await act(async () => { button(container, "Artifacts").click(); });
  await waitFor(() => container.querySelector("img") !== null);
  expect(container.querySelector("img")!.getAttribute("src")).toBe("asset://C:/p/a.png");
  expect(container.textContent).toContain("pic");
});

it("previews text artifacts with a truncation notice", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("head", { status: 206, headers: { "Content-Range": "bytes 0-3/999999" } })));
  const snap = snapshot("r1", { state: { nodes: { a: node("succeeded", { artifacts: [{ index: 0, path: "C:/p/log.txt", mediaType: "text/plain", recordedAt: "t" }] }) } } });
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }), flow_artifact_path: () => ({ path: "C:/p/log.txt", mediaType: "text/plain" }) });
  const { container } = await renderPanel();
  await act(async () => { (container.querySelector('[role="treeitem"]') as HTMLElement).click(); });
  await act(async () => { button(container, "Artifacts").click(); });
  await waitFor(() => container.querySelector("pre") !== null);
  expect(container.querySelector("pre")!.textContent).toBe("head");
  expect(container.textContent).toContain("Showing the first 256 KiB.");
  vi.unstubAllGlobals();
});

it("shows an unavailable notice when the artifact url fails", async () => {
  const snap = snapshot("r1", { state: { nodes: { a: node("succeeded", { artifacts: [{ index: 0, path: "C:/p/gone.png", mediaType: "image/png", recordedAt: "t" }] }) } } });
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }), flow_artifact_path: () => { throw { code: "FLOW_ARTIFACT_NOT_FOUND", message: "x" }; } });
  const { container } = await renderPanel();
  await act(async () => { (container.querySelector('[role="treeitem"]') as HTMLElement).click(); });
  await act(async () => { button(container, "Artifacts").click(); });
  await waitFor(() => container.textContent!.includes("Preview unavailable."));
});
```

(`node(status, extra)` and `renderPanel()` are small local helpers to add if the file lacks them; `route`'s unknown-command error must not be hit by `flow_artifact_path`. The existing tests that query `.flow-run__node` rows must be updated to the tree markup (`[role="treeitem"]`), and the log / rerun / mark-succeeded button tests now first click the row to open the detail.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/flow/components/__tests__/RunViews.test.tsx` → FAIL.

- [ ] **Step 3: Implement** the three components, wire them into `RunPanel` (`selectedNode` state reset when the run changes; detail rendered under the tree; `rootDef` / `needsAction` logic moves into the detail's props), add CSS classes `flow-tree`, `flow-tree__row`, `flow-tree__toggle`, `flow-tree__agg`, `flow-node-detail`, `flow-node-detail__tabs`, `flow-artifact`, `flow-artifact__media` (max-width 100%, max-height 320px), `flow-artifact__text` (pre, max-height 320px, overflow auto). Reuse the `flow-dialog__tabs` / `flow-dialog__tab` classes for the tab strip. Keep `ApprovalCard` and the approvals block as they are (Task 9 replaces them).

- [ ] **Step 4: Run the suites**

Run: `npm test`, `npx tsc --noEmit -p tsconfig.json` → green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/components
git commit -m "feat(flow): run panel node tree, node detail with outputs and artifact previews"
```

---

### Task 9: The approval dialog — comment, `commentRequired`, previews, opened from the tree

**Files:**
- Create: `src/features/flow/components/ApprovalDialog.tsx`
- Modify: `src/features/flow/components/RunPanel.tsx` (remove `ApprovalCard`; approvals block becomes a list of `run.review` buttons; `openApproval` state), `src/features/flow/components/Flow.css`, `src/features/flow/components/__tests__/RunViews.test.tsx`

**Interfaces:**
- Produces: `ApprovalDialog({ projectRoot; runId; request: ApprovalRequest; onClose(); onChoose(choice: string, comment: string): Promise<void> })` — a `DialogShell` (`flow-dialog-overlay`, `flow-dialog`, `labelledBy="flow-approval-title"`) with the title (`run.approvals: <nodeKey>` or `run.budget`), the message or `describeReason`, the `show` entries (artifacts via `ArtifactPreview` with `nodeKey` / `attempt` from the `ShowValue`; other values as `<code>` JSON), a `<textarea>` comment (`aria-label` `run.comment`), and one button per option (`run.option.<name>` with `defaultValue`); an option with `commentRequired` is `disabled` while the trimmed comment is empty and shows `run.commentRequired` as its `title`; choosing calls `onChoose` then `onClose` on success.
- RunPanel: `openApproval: string | null` (node key or `"__budget__"`); the approvals block lists each request as a `run.review` button; `RunNodeTree.onOpenApproval` sets it; a `FLOW_APPROVAL_COMMENT_REQUIRED` error surfaces through the existing error box (`runError.*`).
- Consumes: Task 6 types, Task 8 `ArtifactPreview` and tree.

- [ ] **Step 1: Write the failing tests** (replace the existing "localizes built-in approval options and budget approvals" test and add)

```ts
it("opens the approval dialog from the awaiting row, previews artifacts and sends the comment", async () => {
  const request = { nodeKey: "review", options: [{ name: "accept" }, { name: "revise", commentRequired: true }], message: "Check it",
    show: { "nodes.a.outputs.n": 7, "nodes.a.artifacts.shot": { kind: "artifacts", nodeKey: "a", attempt: 1, artifacts: [{ index: 0, path: "C:/p/shot.png", label: "shot", mediaType: "image/png", recordedAt: "t" }] } },
    reason: { code: "FLOW_APPROVAL_NODE" } };
  const snap = snapshot("r1", { state: { status: "awaiting_approval", approvals: [request], nodes: { a: node("succeeded"), review: node("awaiting_approval") } } });
  const approve = vi.fn(async () => undefined);
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }),
          flow_artifact_path: () => ({ path: "C:/p/shot.png", mediaType: "image/png" }), flow_run_approve: approve });
  const { container } = await renderPanel();
  const rows = [...container.querySelectorAll('[role="treeitem"]')];
  await act(async () => { (rows.find((r) => r.textContent!.includes("review")) as HTMLElement).click(); });
  await waitFor(() => document.querySelector(".flow-dialog") !== null);
  const dialog = document.querySelector(".flow-dialog") as HTMLElement;
  expect(dialog.textContent).toContain("Check it");
  expect(dialog.textContent).toContain("7");
  await waitFor(() => dialog.querySelector("img") !== null);
  const revise = button(dialog, "revise") as HTMLButtonElement;
  expect(revise.disabled).toBe(true);
  expect(revise.title).toBe("This option needs a comment.");
  const comment = dialog.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => { setNativeValue(comment, "fix the title"); comment.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(revise.disabled).toBe(false);
  await act(async () => { revise.click(); });
  expect(approve).toHaveBeenCalledWith({ projectRoot: ROOT, runId: "r1", nodeKey: "review", choice: "revise", comment: "fix the title" });
  await waitFor(() => document.querySelector(".flow-dialog") === null);
});

it("disables a commentRequired option until a comment is typed and localizes built-in options", async () => {
  const request = { nodeKey: "review", options: [{ name: "approve" }, { name: "reject", commentRequired: true }], reason: { code: "FLOW_APPROVAL_NODE" } };
  const snap = snapshot("r1", { state: { status: "awaiting_approval", approvals: [request], nodes: { review: node("awaiting_approval") } } });
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }) });
  const { container } = await renderPanel();
  await act(async () => { button(container, "Review").click(); });
  await waitFor(() => document.querySelector(".flow-dialog") !== null);
  const dialog = document.querySelector(".flow-dialog") as HTMLElement;
  expect(button(dialog, "Approve")).toBeTruthy();
  expect((button(dialog, "Reject") as HTMLButtonElement).disabled).toBe(true);
});

it("opens the budget approval from its review button", async () => {
  const request = { options: [{ name: "approve" }, { name: "stop" }], reason: { code: "FLOW_BUDGET_EXCEEDED" } };
  const snap = snapshot("r1", { state: { status: "awaiting_approval", approvals: [request], nodes: {} } });
  route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }) });
  const { container } = await renderPanel();
  await act(async () => { button(container, "Review").click(); });
  await waitFor(() => document.querySelector(".flow-dialog") !== null);
  expect(document.querySelector(".flow-dialog")!.textContent).toContain("Budget");
});
```

(`setNativeValue` sets the value through the prototype setter so React's `onChange` fires — add it as a local helper if the file lacks one. Use the existing text of `run.budget` in en for the last assertion.)

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement** `ApprovalDialog.tsx` and the `RunPanel` changes; CSS `flow-approval__show`, `flow-approval__comment` (textarea, width 100%, min-height 4em).

- [ ] **Step 4: Run the suites** → `npm test`, `npx tsc --noEmit -p tsconfig.json` green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/components
git commit -m "feat(flow): approval dialog with comments, required comments and artifact previews"
```

---

### Task 10: Final verification

- [ ] From `src-tauri/`: `cargo test --workspace` (no failures, no new warnings), `cargo build`, `cargo clippy --workspace --all-targets` (no new warnings in files this plan touched), `cargo tree -p flow-core -e normal | grep -i ' tauri'` → empty.
- [ ] From the root: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `uv run --project python/mdium-worker pytest -q` (unchanged, still green).
- [ ] Desktop smoke (human): open `src-tauri/tests/fixtures/projects/python-demo` (after Setup) or a project with a command node that writes an image and reports it as an artifact; run the flow; the run panel shows the tree (iterations nested under a loop if the flow has one), the node detail's Artifacts tab shows the image inline and a text artifact's head; an approval node with `show: [nodes.<id>.artifacts]` previews the image in the dialog; an option with `commentRequired` stays disabled until a comment is typed; after approving, `${{ nodes.<id>.outputs.comment }}` is visible in a later node's inputs. If the image is blank, check the CSP (`img-src` / `media-src` must include `asset:` and `http://asset.localhost`) and that `assetProtocol.enable` is true.
- [ ] Record deviations in the spec's chapter 12 row V4: the asset scope is extended per fetched artifact (`allow_file` from `flow_artifact_path`) rather than per run directory at start (stricter: only recorded artifacts become readable); `show` values are typed (`ShowValue`); the approval `timeout` attribute stays unimplemented (not in the parser today; carried to a later PR).
