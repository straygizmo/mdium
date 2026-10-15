# V5a Flow Editor Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only flow view into an editor: add / delete nodes from a palette (python stages from the manifest), drag nodes (positions saved in `ui.positions`), add / delete edges with a port chooser and `maxTraversals`, edit node and flow attributes in forms, edit the YAML side by side with the canvas, save normalized YAML (validated, with a comment-loss warning), create an empty flow, and detect external changes.

**Architecture:** The YAML text is the single source of truth in the editor store; the decoded `FlowDef` comes from Rust (`flow_validate`, debounced) so validation stays Rust-authoritative. Canvas and form edits are pure functions over `FlowDef` (`lib/editor-state.ts`) whose result is serialized back to text by a TypeScript YAML codec (`lib/flow-yaml.ts`, canonical key order, `yaml` package). A new Rust command `flow_save` writes atomically with an expected-hash check; `flow_load` / `flow_validate` now return the text and its sha256. External changes are detected through a transport-level folder watch.

**Tech Stack:** Rust (flow-core, serde_yaml_ng for reading, sha256), React 19 + TypeScript, `@xyflow/react` 12, `@monaco-editor/react` (YAML language), `yaml` ^2.8 (new dependency), zustand, vitest / happy-dom, react-i18next.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` chapter 6 (editor, minimal scope) and 16.6 (loop body from the palette is a file reference), 12 row V5; base spec `.superpowers/specs/2026-10-06-generic-flow-engine-design.md` 2.1 (normalized YAML, comment loss warning), 2.2–2.7 (definition model, `ui.positions`), 2.8 (validation), 6.2–6.3 (canvas, editor). The sub-flow function features of 16.3 (signature card, drill-down, extract, part signature form, caller re-validation) are the separate plan V5b.

## Global Constraints

- `flow-core` must not depend on `tauri`; `src/features/flow/` imports `@tauri-apps/*` only in `lib/tauri-transport.ts` (guard test `no-tauri-imports.test.ts`). File writes and file watching reach Tauri only through `FlowTransport` / `flowApi`.
- New Tauri commands live in `src-tauri/src/commands/flow.rs`, are listed in `flow_core::service::COMMAND_NAMES` (21 → 22) and have a `call()` arm with the same camelCase JSON arguments; the parity test matches `commands::flow(?:_run)?::(flow_\w+)` in `lib.rs`.
- Every new service error code gets `runError.<CODE>` in both `src/shared/i18n/locales/{ja,en}/flow.json` (identical key sets and placeholders; `locale-parity.test.ts`). No hardcoded UI strings (flow names / descriptions inside a flow file are data, not UI strings). Code comments in English.
- Saving writes **normalized YAML** (base spec 2.1): key order `schemaVersion, id, name, description, params, defaults, limits, env, envPassthrough, nodes, edges, outputs, ui`; node keys `id, kind, name, description, <kind attributes>, timeout, retry, cost, when, concurrencyKey`; edge keys `from, to, port, maxTraversals`; absent optionals are omitted; YAML comments are lost, so the editor warns before the first save of a file that contains comments.
- Save runs `flow_validate` first; validation errors do **not** block saving (they are shown as a warning the user confirms); running a flow with errors stays refused as today (spec 6).
- Positions are stored at `ui.positions[<nodeId>] = { x, y }` for top-level nodes (base spec 2.2; the existing `savedPositions` reader); the engine ignores `ui`.
- A `loop` added from the palette gets a **file** body (`body: <part path>`; spec 16.6); inline bodies are edited only in the YAML side (canvas shows them expanded, read-only in V5a).
- Node ids are `[a-z0-9_]+`, flow ids `[a-z0-9-]+`, ports `[A-Za-z0-9_-]+`, identifiers (params, outputs, loop vars) `[A-Za-z_][A-Za-z0-9_-]*` (Rust `validate.rs` / `template::is_ident`).
- Out of scope for V5a (spec 6 "対象外"): undo / redo, re-running auto layout, copy / paste, inline loop-body canvas editing, "new from template" (templates arrive in V7: `resources/flow-templates/`), the run-state overlay on the canvas.
- Rust sources are mostly CRLF: no line-ending churn. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Existing tests keep passing (baseline on 8740407: flow-core 238 / mdium 731, vitest 1874, pytest 31).

## Review Focus

1. A file whose YAML contains comments: the editor warns once before the first save (and not again for that file) and the saved file has no comments — Task 2 test `detects comments`, Task 9 test "warns about comment loss once before the first save".
2. The file changes on disk while the editor holds unsaved edits: the editor shows a notice with "reload" and "overwrite"; "reload" discards the edits, "overwrite" saves on top (re-reading the hash first) — Task 9 tests "offers reload or overwrite when the file changes outside" and "overwrite saves on top of the external change".
3. Typing YAML that does not parse: the canvas keeps the last good graph, the issue list shows `FLOW_PARSE_FAILED` with line / column, and saving is still allowed after the warning — Task 4 test "keeps the last decoded flow while the text is unparsable".
4. Connecting an edge that closes a cycle without `maxTraversals`: the edge is created, `FLOW_CYCLE_WITHOUT_LIMIT` appears on the issue list, and the edge form lets the user enter `maxTraversals`, which clears it — Task 5 test "a back edge gets maxTraversals from the edge form".
5. Deleting a node that other nodes reference (`${{ nodes.x.outputs.y }}`, edges): the edges to and from it are removed, the template references stay and surface as `FLOW_UNKNOWN_NODE_REF` after validation — Task 3 test `removeNode drops its edges and keeps references for validation to flag`.

---

## File structure

Rust (`src-tauri/crates/flow-core/src/`):
- `service.rs`: `FlowLoadResult` gains `content` and `sha256`; `save_flow`; `SaveArgs`; `COMMAND_NAMES` → 22; `FLOW_FILE_EXISTS`.
- `load.rs`: unchanged except reuse (`resolve_flow_path(root, rel, must_exist)`, `check_content`, `MAX_FLOW_FILE_BYTES`).
- `src-tauri/src/commands/flow.rs`, `src-tauri/src/lib.rs`: `flow_save` wrapper and registration.

Frontend (`src/features/flow/`):
- `lib/flow-yaml.ts` (new): `parseFlowText`, `stringifyFlow`, `hasComments`, `CANONICAL_*` key orders.
- `lib/flow-ports.ts` (new): `portsOf(node)`, `nextNodeId(def, kind)`.
- `lib/editor-state.ts` (new): pure edit operations on `FlowDef` (`addNode`, `removeNode`, `moveNode`, `addEdge`, `updateEdge`, `removeEdge`, `updateNode`, `updateFlowAttrs`) and `nodePathToIndex` helpers.
- `editor-store.ts` (new): zustand store per open file: `text`, `def`, `issues`, `sha256`, `dirty`, `selected` (node path | edge path | null), `pending` validation, `commentWarned`; actions `openFile`, `setText`, `applyEdit`, `select`, `markSaved`, `externalChange`.
- `lib/transport.ts`, `tauri-transport.ts`, `flow-api.ts`: `watchFolder`, `flowApi.save`.
- `components/FlowWorkspace.tsx`: becomes the editor shell (toolbar, canvas, YAML pane, aside with attributes).
- `components/FlowToolbar.tsx` (new): add-node palette button, save, YAML toggle, new flow.
- `components/NodePalette.tsx` (new): kinds, python stages (manifest), parts for subflow / loop body.
- `components/FlowCanvas.tsx`, `FlowNodes.tsx`: draggable nodes, connect, selection of edges, port popover.
- `components/PortPopover.tsx` (new): choose the exit of a new edge.
- `components/FlowYamlPane.tsx` (new): Monaco wrapper for the split view.
- `components/attrs/AttributePanel.tsx` (new, router by selection), `attrs/NodeCommonForm.tsx`, `attrs/EdgeForm.tsx`, `attrs/FlowAttrsForm.tsx`, `attrs/ConditionEditor.tsx`, `attrs/KeyValueEditor.tsx`, `attrs/StringListEditor.tsx`, `attrs/kinds/{CommandForm,ApprovalForm,BranchForm,LoopForm,SubflowForm,AgentForm,PythonForm,ActionForm}.tsx`.
- `components/NewFlowDialog.tsx` (new), `components/SaveWarningDialog.tsx` (new), `components/ExternalChangeNotice.tsx` (new).
- `components/Flow.css`: editor styles.
- Tests: `lib/__tests__/{flow-yaml,flow-ports,editor-state}.test.ts`, `__tests__/editor-store.test.ts`, `components/__tests__/{EditorViews,AttributeForms}.test.tsx`, extensions of `FlowViews.test.tsx`, `transport.test.ts`, `flow-api.test.ts`.

---

### Task 1: `flow_save` and text + hash on load / validate

**Files:**
- Modify: `src-tauri/crates/flow-core/src/service.rs` (`FlowLoadResult`, `load_flow`, `validate_flow`, `save_flow`, `SaveArgs`, `COMMAND_NAMES`, `call`), `src-tauri/src/commands/flow.rs`, `src-tauri/src/lib.rs`
- Test: `service.rs` tests

**Interfaces:**
- Produces:
  - `FlowLoadResult { path, format, kind, content: String, sha256: String, #[serde(flatten)] report }` — `content` is the text that was checked (file text for `load_flow`, the given text for `validate_flow`), `sha256` its hex digest (`sha256_hex`).
  - `FlowService::save_flow(&self, project_root: &str, path: &str, content: &str, expected_sha256: Option<&str>) -> Result<FlowLoadResult, FlowCommandError>`: `path` must be a flow file name inside `.mdium/flows/` (`resolve_flow_path(root, path, false)`, so `FLOW_FILE_PATH_INVALID` on escapes / bad names); `content` ≤ `MAX_FLOW_FILE_BYTES` else `FLOW_FILE_TOO_LARGE`; when `expected_sha256` is `None` the file must not exist (`FLOW_FILE_EXISTS`); when `Some(h)` the file must exist and its current bytes' hash must equal `h` (`FLOW_FILE_CHANGED`, `FLOW_FILE_NOT_FOUND`); writes with `fsutil::atomic_write` (creating `lib/` sub-directories as needed); returns the same result `load_flow` would return for the saved file.
  - `pub const FLOW_FILE_EXISTS: &str = "FLOW_FILE_EXISTS"`.
  - `COMMAND_NAMES` gains `"flow_save"`; `SaveArgs { project_root, path, content, expected_sha256: Option<String> }` (camelCase, deny_unknown_fields).
  - Tauri `flow_save(state, project_root, path, content, expected_sha256: Option<String>) -> Result<FlowLoadResult, FlowCommandError>`.
- Consumes: `load::resolve_flow_path`, `load::check_content`, `fsutil::atomic_write`, `sha256_hex`.

- [ ] **Step 1: Write the failing tests** (`service.rs` tests module)

```rust
    #[test]
    fn load_and_validate_return_the_text_and_its_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let text = "schemaVersion: 1\nid: a\nname: A\nnodes: []\n";
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), text).unwrap();
        let loaded = svc.load_flow(root, ".mdium/flows/a.flow.yaml").unwrap();
        assert_eq!(loaded.content, text);
        assert_eq!(loaded.sha256, sha256_hex(text.as_bytes()));
        let edited = "schemaVersion: 1\nid: a\nname: B\nnodes: []\n";
        let validated = svc.validate_flow(root, ".mdium/flows/a.flow.yaml", edited).unwrap();
        assert_eq!(validated.content, edited);
        assert_eq!(validated.sha256, sha256_hex(edited.as_bytes()));
        assert_eq!(validated.report.flow.unwrap().name, "B");
    }

    #[test]
    fn save_creates_overwrites_and_refuses_stale_or_outside_files() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let v1 = "schemaVersion: 1\nid: s\nname: S\nnodes: []\n";
        // Create: the file must not exist yet.
        let created = svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v1, None).unwrap();
        assert_eq!(created.kind, FlowKind::Part);
        assert_eq!(fs::read_to_string(tmp.path().join(".mdium/flows/lib/s.flow.yaml")).unwrap(), v1);
        assert_eq!(svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v1, None).unwrap_err().code, FLOW_FILE_EXISTS);
        // Overwrite with the right hash.
        let v2 = "schemaVersion: 1\nid: s\nname: S2\nnodes: []\n";
        let saved = svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v2, Some(&created.sha256)).unwrap();
        assert_eq!(saved.sha256, sha256_hex(v2.as_bytes()));
        assert_eq!(saved.report.flow.unwrap().name, "S2");
        // A stale hash is refused and leaves the file alone.
        let err = svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v1, Some(&created.sha256)).unwrap_err();
        assert_eq!(err.code, FLOW_FILE_CHANGED);
        assert_eq!(fs::read_to_string(tmp.path().join(".mdium/flows/lib/s.flow.yaml")).unwrap(), v2);
        // Overwriting a missing file, escaping the project, a bad name, and an oversized body.
        assert_eq!(svc.save_flow(root, ".mdium/flows/missing.flow.yaml", v1, Some("00")).unwrap_err().code, FLOW_FILE_NOT_FOUND);
        assert_eq!(svc.save_flow(root, "../x.flow.yaml", v1, None).unwrap_err().code, FLOW_FILE_PATH_INVALID);
        assert_eq!(svc.save_flow(root, ".mdium/flows/notes.txt", v1, None).unwrap_err().code, FLOW_FILE_PATH_INVALID);
        let big = "#".repeat(crate::load::MAX_FLOW_FILE_BYTES as usize + 1);
        assert_eq!(svc.save_flow(root, ".mdium/flows/big.flow.yaml", &big, None).unwrap_err().code, "FLOW_FILE_TOO_LARGE");
        // Invalid content is still saved; the report carries the errors.
        let bad = "schemaVersion: 1\nid: s\nname: S\nnodes:\n  - { id: x, kind: nope }\n";
        let saved = svc.save_flow(root, ".mdium/flows/bad.flow.yaml", bad, None).unwrap();
        assert!(!saved.report.errors.is_empty());
        // Dispatch through call().
        let via_call = svc.call("flow_save", json!({ "projectRoot": root, "path": ".mdium/flows/c.flow.yaml", "content": v1, "expectedSha256": null })).unwrap();
        assert_eq!(via_call["sha256"], sha256_hex(v1.as_bytes()));
    }
```

(Check how `FLOW_FILE_TOO_LARGE` is spelled / exported in `issues.rs` or `load.rs` and whether `resolve_flow_path` rejects `.mdium/flows/notes.txt` as a bad name — the brief expects `FLOW_FILE_PATH_INVALID`; adapt to the real code mapping in `flow_file()` if it uses another code, and say so.) Bump the `COMMAND_NAMES` length test to 22.

- [ ] **Step 2: Run them to verify they fail**

Run (from `src-tauri`): `cargo test -p flow-core save_` → compile error (`content` / `save_flow` missing).

- [ ] **Step 3: Implement**

`service.rs`:

```rust
pub const FLOW_FILE_EXISTS: &str = "FLOW_FILE_EXISTS";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLoadResult {
    pub path: String,
    pub format: FlowFormat,
    pub kind: FlowKind,
    /// The text that was checked (the file for `load`, the given text otherwise).
    pub content: String,
    /// Hex sha256 of `content`; `save` requires it to overwrite.
    pub sha256: String,
    #[serde(flatten)]
    pub report: FlowReport,
}

    /// Writes `content` to a flow file (spec 6: the editor's save). `None`
    /// creates (the file must not exist); `Some(hash)` overwrites only when
    /// the file still has that content hash.
    pub fn save_flow(&self, project_root_arg: &str, path: &str, content: &str, expected_sha256: Option<&str>) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, false)?;   // resolve_flow_path(.., must_exist = false)
        if content.len() as u64 > load::MAX_FLOW_FILE_BYTES {
            return Err(FlowCommandError::new(FLOW_FILE_TOO_LARGE, path));
        }
        match (expected_sha256, std::fs::read(&file)) {
            (None, Ok(_)) => return Err(FlowCommandError::new(FLOW_FILE_EXISTS, path)),
            (None, Err(_)) => {}
            (Some(_), Err(_)) => return Err(FlowCommandError::new(FLOW_FILE_NOT_FOUND, path)),
            (Some(expected), Ok(bytes)) if sha256_hex(&bytes) != expected => {
                return Err(FlowCommandError::new(FLOW_FILE_CHANGED, "the flow file changed since it was loaded"));
            }
            (Some(_), Ok(_)) => {}
        }
        if let Some(parent) = file.parent() { std::fs::create_dir_all(parent).map_err(|e| FlowCommandError::new(FLOW_COMMAND_FAILED, e))?; }
        fsutil::atomic_write(&file, content.as_bytes()).map_err(|e| FlowCommandError::new(FLOW_COMMAND_FAILED, e))?;
        self.load_flow(project_root_arg, path)
    }
```

`load_flow` reads the file text once (`std::fs::read_to_string` with the same size / UTF-8 checks `check_file` does — refactor `check_file` into `read_flow_text(file) -> Result<String, FlowIssue>` + `check_content`, so the text is read a single time) and fills `content` / `sha256`; `validate_flow` fills them from the argument. `SaveArgs`, the `call` arm, the Tauri wrapper (copy `flow_validate`'s shape with the extra `expected_sha256: Option<String>`) and the `lib.rs` registration follow the existing pattern.

- [ ] **Step 4: Run everything**

Run: `cargo test --workspace` (from `src-tauri`) → green; `cargo tree -p flow-core -e normal | grep -i ' tauri'` → empty.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/flow-core/src/service.rs src-tauri/crates/flow-core/src/load.rs src-tauri/src/commands/flow.rs src-tauri/src/lib.rs
git commit -m "feat(flow): flow_save with hash check; load and validate return the text and its sha256"
```

---

### Task 2: YAML codec and comment detection (TypeScript)

**Files:**
- Create: `src/features/flow/lib/flow-yaml.ts`, `src/features/flow/lib/__tests__/flow-yaml.test.ts`
- Modify: `package.json` (add `"yaml": "^2.8.0"` to dependencies), `package-lock.json`

**Interfaces:**
- Produces:
  - `parseFlowText(text: string): { value: unknown } | { error: { message: string; line: number; column: number } }` — a thin wrapper over `yaml.parse` (duplicate keys are errors, as in Rust); used only for comment detection and for client-side previews; Rust stays the validator.
  - `stringifyFlow(def: FlowDef): string` — canonical YAML: top-level key order `schemaVersion, id, name, description, params, defaults, limits, env, envPassthrough, nodes, edges, outputs, ui`; node key order `id, kind, name, description, <kind-specific keys in the order they appear in the TS type for that kind>, timeout, retry, cost, when, concurrencyKey`; edge key order `from, to, port, maxTraversals`; keys whose value is `undefined` are omitted; empty `edges`, `params`, `outputs`, `env`, `envPassthrough` maps / arrays are omitted; `ui` is kept verbatim; flow-style (`{ ... }`) is used for an edge object and for a node's `with` / `params` maps when they have at most 3 scalar entries, block style otherwise; strings that look like numbers / booleans / `${{` templates are quoted (the `yaml` library's default `stringify` handles quoting; pin `lineWidth: 0` so long templates are not folded).
  - `hasComments(text: string): boolean` — true when the YAML document carries any comment (via `yaml.parseDocument(text)` and `yaml.visit`: `commentBefore` / `comment` on the document or any node).
  - `CANONICAL_TOP_KEYS`, `CANONICAL_NODE_HEAD_KEYS = ["id","kind","name","description"]`, `CANONICAL_NODE_TAIL_KEYS = ["timeout","retry","cost","when","concurrencyKey"]`, `CANONICAL_EDGE_KEYS`.
- Consumes: `FlowDef` / `FlowNode` / `FlowEdge` types.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import { hasComments, parseFlowText, stringifyFlow } from "../flow-yaml";

const def: FlowDef = {
  schemaVersion: 1, id: "demo", name: "Demo",
  edges: [{ from: "a", to: "b" }, { from: "b", to: "a", port: "revise", maxTraversals: 2 }],
  nodes: [
    { id: "a", kind: "command", run: ["echo", "1"], shell: false, protocol: "mdium-v1", timeout: "30s", name: "Echo" },
    { id: "b", kind: "approval", options: ["accept", { name: "revise", commentRequired: true }], show: ["nodes.a.outputs.x"] },
    { id: "c", kind: "python", runtime: "demo", entry: "demo.add", with: { a: "${{ params.a }}", b: 1 } },
  ],
  params: { a: { type: "number", default: 2, required: false } },
  outputs: { sum: "${{ nodes.c.outputs.sum }}" },
  ui: { positions: { a: { x: 10, y: 20 } } },
};

describe("stringifyFlow", () => {
  it("writes keys in canonical order and omits absent optionals", () => {
    const text = stringifyFlow(def);
    const lines = text.split("\n");
    expect(lines[0]).toBe("schemaVersion: 1");
    expect(lines[1]).toBe("id: demo");
    expect(lines[2]).toBe("name: Demo");
    expect(text.indexOf("params:")).toBeLessThan(text.indexOf("nodes:"));
    expect(text.indexOf("nodes:")).toBeLessThan(text.indexOf("edges:"));
    expect(text.indexOf("edges:")).toBeLessThan(text.indexOf("outputs:"));
    expect(text.indexOf("outputs:")).toBeLessThan(text.indexOf("ui:"));
    expect(text).not.toContain("description");
    expect(text).not.toContain("null");
    // node a: id, kind, name, then command keys, then timeout
    const a = text.slice(text.indexOf("- id: a"), text.indexOf("- id: b"));
    expect(a.indexOf("kind: command")).toBeLessThan(a.indexOf("name: Echo"));
    expect(a.indexOf("run:")).toBeGreaterThan(a.indexOf("name: Echo"));
    expect(a.indexOf("timeout: 30s")).toBeGreaterThan(a.indexOf("protocol: mdium-v1"));
  });
  it("round-trips through parse", () => {
    const text = stringifyFlow(def);
    const parsed = parseFlowText(text);
    expect("value" in parsed && parsed.value).toEqual(def);
  });
  it("quotes templates and keeps long templates on one line", () => {
    const text = stringifyFlow({ ...def, outputs: { long: "${{ nodes.c.outputs.sum }} and a very long trailing text that would otherwise be folded by the default line width of eighty characters" } });
    expect(text).toMatch(/long: "\$\{\{ nodes\.c\.outputs\.sum \}\} and a very long[^\n]*"\n/);
  });
  it("uses flow style for small maps and edges", () => {
    const text = stringifyFlow(def);
    expect(text).toContain("- { from: a, to: b }");
    expect(text).toContain("with: { a: \"${{ params.a }}\", b: 1 }");
  });
});

describe("parseFlowText", () => {
  it("reports the position of a syntax error", () => {
    const r = parseFlowText("nodes:\n  - id: a\n   kind: [\n");
    expect("error" in r && r.error.line).toBeGreaterThan(0);
  });
  it("rejects duplicate keys like the Rust parser", () => {
    expect("error" in parseFlowText("id: a\nid: b\n")).toBe(true);
  });
});

describe("hasComments", () => {
  it("detects comments anywhere in the document", () => {
    expect(hasComments("# top\nid: a\n")).toBe(true);
    expect(hasComments("id: a\nnodes:\n  - id: x # trailing\n    kind: command\n")).toBe(true);
    expect(hasComments("id: a\nname: 'not # a comment'\n")).toBe(false);
    expect(hasComments("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm install yaml@^2.8.0` then `npx vitest run src/features/flow/lib/__tests__/flow-yaml.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { Document, isMap, isSeq, parse, parseDocument, visit, YAMLError } from "yaml";
import type { FlowDef, FlowEdge, FlowNode } from "@/shared/types/flow";

export const CANONICAL_TOP_KEYS = ["schemaVersion","id","name","description","params","defaults","limits","env","envPassthrough","nodes","edges","outputs","ui"] as const;
export const CANONICAL_NODE_HEAD_KEYS = ["id","kind","name","description"] as const;
export const CANONICAL_NODE_TAIL_KEYS = ["timeout","retry","cost","when","concurrencyKey"] as const;
export const CANONICAL_EDGE_KEYS = ["from","to","port","maxTraversals"] as const;
const EMPTY_OMITTED = new Set(["params","defaults","limits","env","envPassthrough","edges","outputs"]);

function ordered(obj: Record<string, unknown>, head: readonly string[], tail: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string) => { if (obj[k] !== undefined) out[k] = obj[k]; };
  head.forEach(put);
  Object.keys(obj).filter((k) => !head.includes(k) && !tail.includes(k)).forEach(put);
  tail.forEach(put);
  return out;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
}

function canonicalNode(node: FlowNode): Record<string, unknown> {
  const n = ordered(node as unknown as Record<string, unknown>, CANONICAL_NODE_HEAD_KEYS, CANONICAL_NODE_TAIL_KEYS);
  if (node.kind === "loop" && typeof node.body === "object") n.body = { ...node.body, nodes: node.body.nodes.map(canonicalNode) };
  return n;
}

export function stringifyFlow(def: FlowDef): string {
  const top = ordered(def as unknown as Record<string, unknown>, CANONICAL_TOP_KEYS);
  for (const k of EMPTY_OMITTED) if (isEmpty(top[k])) delete top[k];
  top.nodes = def.nodes.map(canonicalNode);
  if (top.edges) top.edges = (def.edges ?? []).map((e: FlowEdge) => ordered(e as unknown as Record<string, unknown>, CANONICAL_EDGE_KEYS));
  const doc = new Document(top);
  visit(doc, {
    Pair(_, pair) {
      const key = String((pair.key as { value?: unknown })?.value ?? "");
      const value = pair.value;
      if ((key === "with" || key === "params") && isMap(value) && value.items.length <= 3 && value.items.every((p) => !isMap(p.value) && !isSeq(p.value))) value.flow = true;
    },
    Seq(_, seq) {
      // edges: one flow-style object per line
      for (const item of seq.items) if (isMap(item) && item.items.every((p) => ["from","to","port","maxTraversals"].includes(String((p.key as { value?: unknown })?.value)))) item.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, indent: 2 });
}

export function parseFlowText(text: string): { value: unknown } | { error: { message: string; line: number; column: number } } {
  try {
    return { value: parse(text, { uniqueKeys: true }) };
  } catch (err) {
    const e = err as YAMLError;
    const pos = e.linePos?.[0];
    return { error: { message: e.message, line: pos?.line ?? 0, column: pos?.col ?? 0 } };
  }
}

export function hasComments(text: string): boolean {
  if (!text.trim()) return false;
  const doc = parseDocument(text);
  if (doc.commentBefore || doc.comment) return true;
  let found = false;
  visit(doc, (_, node) => {
    const n = node as { comment?: string | null; commentBefore?: string | null };
    if (n && (n.comment || n.commentBefore)) { found = true; return visit.BREAK; }
    return undefined;
  });
  return found;
}
```

(Adjust to the `yaml` 2.x API as needed — `Pair` / `Seq` visitor names, `linePos`, `uniqueKeys` — and keep the tests as the contract. The sequence-of-edges flow style must not apply to `nodes` items.)

- [ ] **Step 4: Run the tests** → pass; `npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/features/flow/lib/flow-yaml.ts src/features/flow/lib/__tests__/flow-yaml.test.ts
git commit -m "feat(flow): canonical YAML codec and comment detection for the editor"
```

---

### Task 3: Ports, ids and pure edit operations

**Files:**
- Create: `src/features/flow/lib/flow-ports.ts`, `src/features/flow/lib/editor-state.ts`, `src/features/flow/lib/__tests__/flow-ports.test.ts`, `src/features/flow/lib/__tests__/editor-state.test.ts`

**Interfaces:**
- Produces (`flow-ports.ts`):
  - `portsOf(node: FlowNode): string[]` — mirrors Rust `node_ports`: approval → option names; branch → case ports + `default`; agent with `outputContract: "outcome"` → `success`, `attention`; others → `success`; `failure` appended when absent.
  - `nextNodeId(def: FlowDef, kind: FlowNodeKind, base?: string): string` — `base ?? kind` lower-cased with non-`[a-z0-9_]` replaced by `_`, then `_2`, `_3`… until unused among all node ids (including inline bodies).
  - `isNodeId(s)`, `isIdent(s)`, `isPortName(s)` regexes as in the Global Constraints.
- Produces (`editor-state.ts`), all pure (return a new `FlowDef`, never mutate):
  - `type NodePath = string` (`nodes[i]` or `nodes[i].body.nodes[j]`, the graph's node id); `nodeAt(def, path)`, `parentList(def, path): { list: FlowNode[]; index: number; edges: FlowEdge[] }` (the scope that owns the node).
  - `addNode(def, node: FlowNode, position?: { x; y }): FlowDef` — appends to the top-level `nodes`; when `position` is given sets `ui.positions[node.id]`.
  - `removeNode(def, path): FlowDef` — removes the node and every edge of its scope that references its id; removes its `ui.positions` entry; leaves template references untouched.
  - `moveNode(def, nodeId, position): FlowDef` — top-level only; sets `ui.positions[nodeId]`.
  - `addEdge(def, scopePath: "" | NodePath, edge: FlowEdge): FlowDef` — appends to the scope's `edges` (top level when `scopePath === ""`), ignoring an exact duplicate (`from`, `to`, `port`).
  - `updateEdge(def, edgePath: string, patch: Partial<FlowEdge>): FlowDef` and `removeEdge(def, edgePath): FlowDef` — `edgePath` is the graph's edge id (`edges[i]` or `nodes[i].body.edges[j]`); `port: "success"` and `maxTraversals: undefined` are normalized away.
  - `updateNode(def, path, patch: Partial<FlowNode>): FlowDef` — shallow merge; `undefined` values delete keys; changing `kind` replaces the node with `{ id, kind, ...defaultsFor(kind) }` keeping `name` / `description`.
  - `renameNode(def, path, newId): FlowDef` — updates edges in the scope and `ui.positions`; template references are left to validation.
  - `updateFlowAttrs(def, patch: Pick<Partial<FlowDef>, "name" | "description" | "params" | "defaults" | "limits" | "env" | "envPassthrough" | "outputs">): FlowDef`.
  - `defaultsFor(kind): Omit<FlowNode, "id">` — the minimal valid node per kind: command `{ kind, run: [""], shell: false, protocol: "mdium-v1" }`, approval `{ kind }`, branch `{ kind, cases: [] }`, loop `{ kind, mode: "foreach", items: "${{ params.items }}", maxIterations: 10, body: "" }`, subflow `{ kind, flow: "" }`, agent `{ kind, provider: "claude", permission: "read-only", outputContract: "outcome", prompt: "" }`, python `{ kind, runtime: "", entry: "" }`, action `{ kind, uses: "mdium/flow-run-latest" }`.
  - `emptyFlow(id: string, name: string): FlowDef` → `{ schemaVersion: 1, id, name, nodes: [] }`.
- Consumes: `FlowDef` types; `buildFlowGraph` conventions for paths (`nodes[i]`, `nodes[i].body.nodes[j]`, edge ids `edges[i]` / `nodes[i].body.edges[j]`).

- [ ] **Step 1: Write the failing tests**

`flow-ports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import { isIdent, isNodeId, nextNodeId, portsOf } from "../flow-ports";

describe("portsOf", () => {
  it("mirrors the engine's node_ports", () => {
    expect(portsOf({ id: "c", kind: "command", run: ["x"], shell: false, protocol: "none" })).toEqual(["success", "failure"]);
    expect(portsOf({ id: "a", kind: "approval" })).toEqual(["approve", "reject", "failure"]);
    expect(portsOf({ id: "a", kind: "approval", options: ["ok", { name: "fix", commentRequired: true }] })).toEqual(["ok", "fix", "failure"]);
    expect(portsOf({ id: "b", kind: "branch", cases: [{ when: { ref: "params.x", op: "exists" }, port: "yes" }], default: "no" })).toEqual(["yes", "no", "failure"]);
    expect(portsOf({ id: "g", kind: "agent", provider: "claude", permission: "read-only", outputContract: "outcome" })).toEqual(["success", "attention", "failure"]);
    expect(portsOf({ id: "g", kind: "agent", provider: "claude", permission: "read-only", outputContract: "free" })).toEqual(["success", "failure"]);
  });
});

describe("nextNodeId", () => {
  const def = { schemaVersion: 1, id: "f", name: "F", nodes: [
    { id: "command", kind: "command", run: ["x"], shell: false, protocol: "none" },
    { id: "loop", kind: "loop", mode: "foreach", items: [], maxIterations: 1, body: { nodes: [{ id: "command_2", kind: "approval" }] } },
  ] } as unknown as FlowDef;
  it("skips ids used anywhere, including inline bodies", () => {
    expect(nextNodeId(def, "command")).toBe("command_3");
    expect(nextNodeId(def, "approval")).toBe("approval");
    expect(nextNodeId(def, "python", "demo.add")).toBe("demo_add");
  });
  it("validates ids and identifiers", () => {
    expect(isNodeId("a_1")).toBe(true); expect(isNodeId("A")).toBe(false); expect(isNodeId("a-b")).toBe(false);
    expect(isIdent("out-1")).toBe(true); expect(isIdent("1x")).toBe(false);
  });
});
```

`editor-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import { addEdge, addNode, defaultsFor, emptyFlow, moveNode, nodeAt, removeEdge, removeNode, renameNode, updateEdge, updateFlowAttrs, updateNode } from "../editor-state";

const base = (): FlowDef => ({
  schemaVersion: 1, id: "f", name: "F",
  nodes: [
    { id: "a", kind: "command", run: ["x"], shell: false, protocol: "none" },
    { id: "b", kind: "approval" },
    { id: "l", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 3, body: { nodes: [{ id: "i1", kind: "approval" }, { id: "i2", kind: "approval" }], edges: [{ from: "i1", to: "i2" }] } },
  ],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "a", port: "reject", maxTraversals: 2 }],
  outputs: { r: "${{ nodes.a.outputs.r }}" },
  ui: { positions: { a: { x: 1, y: 2 } } },
});

describe("editor-state", () => {
  it("addNode appends with a position and never mutates", () => {
    const d = base();
    const n = addNode(d, { id: "c", ...defaultsFor("approval") }, { x: 5, y: 6 });
    expect(d.nodes).toHaveLength(3);
    expect(n.nodes.map((x) => x.id)).toEqual(["a", "b", "l", "c"]);
    expect((n.ui as { positions: Record<string, unknown> }).positions.c).toEqual({ x: 5, y: 6 });
  });
  it("removeNode drops its edges and keeps references for validation to flag", () => {
    const n = removeNode(base(), "nodes[0]");
    expect(n.nodes.map((x) => x.id)).toEqual(["b", "l"]);
    expect(n.edges).toEqual([]);
    expect(n.outputs).toEqual({ r: "${{ nodes.a.outputs.r }}" });
    expect((n.ui as { positions: Record<string, unknown> }).positions.a).toBeUndefined();
  });
  it("removes a node inside an inline body together with its scope's edges", () => {
    const n = removeNode(base(), "nodes[2].body.nodes[0]");
    const loop = n.nodes[2] as { body: { nodes: { id: string }[]; edges?: unknown[] } };
    expect(loop.body.nodes.map((x) => x.id)).toEqual(["i2"]);
    expect(loop.body.edges ?? []).toEqual([]);
  });
  it("moveNode writes ui.positions for top-level nodes", () => {
    const n = moveNode(base(), "b", { x: 7, y: 8 });
    expect((n.ui as { positions: Record<string, unknown> }).positions).toEqual({ a: { x: 1, y: 2 }, b: { x: 7, y: 8 } });
  });
  it("addEdge appends to the right scope and ignores duplicates", () => {
    let n = addEdge(base(), "", { from: "a", to: "b", port: "failure" });
    expect(n.edges).toHaveLength(3);
    n = addEdge(n, "", { from: "a", to: "b", port: "failure" });
    expect(n.edges).toHaveLength(3);
    n = addEdge(n, "nodes[2]", { from: "i2", to: "i1", maxTraversals: 1 });
    expect((n.nodes[2] as { body: { edges: unknown[] } }).body.edges).toHaveLength(2);
  });
  it("updateEdge normalizes defaults and removeEdge removes by path", () => {
    let n = updateEdge(base(), "edges[1]", { port: "success", maxTraversals: undefined });
    expect(n.edges![1]).toEqual({ from: "b", to: "a" });
    n = updateEdge(n, "edges[0]", { maxTraversals: 4 });
    expect(n.edges![0]).toEqual({ from: "a", to: "b", maxTraversals: 4 });
    n = removeEdge(n, "nodes[2].body.edges[0]");
    expect((n.nodes[2] as { body: { edges?: unknown[] } }).body.edges ?? []).toEqual([]);
  });
  it("updateNode merges, deletes undefined keys and swaps kinds minimally", () => {
    let n = updateNode(base(), "nodes[0]", { name: "Run", timeout: "1m" });
    expect(nodeAt(n, "nodes[0]")).toMatchObject({ id: "a", name: "Run", timeout: "1m", run: ["x"] });
    n = updateNode(n, "nodes[0]", { timeout: undefined });
    expect("timeout" in nodeAt(n, "nodes[0]")!).toBe(false);
    n = updateNode(n, "nodes[0]", { kind: "approval" } as never);
    expect(nodeAt(n, "nodes[0]")).toEqual({ id: "a", kind: "approval", name: "Run" });
  });
  it("renameNode rewrites edges and positions", () => {
    const n = renameNode(base(), "nodes[0]", "start");
    expect(n.edges).toEqual([{ from: "start", to: "b" }, { from: "b", to: "start", port: "reject", maxTraversals: 2 }]);
    expect((n.ui as { positions: Record<string, unknown> }).positions).toEqual({ start: { x: 1, y: 2 } });
  });
  it("updateFlowAttrs and emptyFlow", () => {
    const n = updateFlowAttrs(base(), { params: { x: { type: "string", required: true } }, limits: { budgetUsd: 3 } });
    expect(n.params).toEqual({ x: { type: "string", required: true } });
    expect(n.limits).toEqual({ budgetUsd: 3 });
    expect(emptyFlow("new-flow", "New flow")).toEqual({ schemaVersion: 1, id: "new-flow", name: "New flow", nodes: [] });
  });
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL (modules missing).

- [ ] **Step 3: Implement** both modules per the interface list. Path handling: parse `nodes[i](.body.nodes[j])*` with a regex `/nodes\[(\d+)\]/g` walking into `body.nodes`; edge paths `(<nodePath>.body.)?edges[i]`. Use structural cloning at the touched level only (spread / `map`), never `JSON.parse(JSON.stringify())` on the whole def for every edit.

- [ ] **Step 4: Run the tests** → pass; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/lib/flow-ports.ts src/features/flow/lib/editor-state.ts src/features/flow/lib/__tests__/flow-ports.test.ts src/features/flow/lib/__tests__/editor-state.test.ts
git commit -m "feat(flow): node ports, id generation and pure flow edit operations"
```

---

### Task 4: Editor store, transport additions and the YAML pane

**Files:**
- Create: `src/features/flow/editor-store.ts`, `src/features/flow/__tests__/editor-store.test.ts`, `src/features/flow/components/FlowYamlPane.tsx`
- Modify: `src/features/flow/lib/transport.ts` (`watchFolder`), `src/features/flow/lib/tauri-transport.ts`, `src/features/flow/lib/flow-api.ts` (`save`, `watchFolder`), `src/shared/types/flow.ts` (`FlowLoadResult.content`, `.sha256`), `src/features/flow/lib/__tests__/transport.test.ts`, `src/features/flow/lib/__tests__/flow-api.test.ts`, `src/shared/i18n/locales/{en,ja}/flow.json`

**Interfaces:**
- Produces:
  - Types: `FlowLoadResult` gains `content: string; sha256: string`.
  - `FlowTransport.watchFolder(folder: string, handler: () => void): Promise<() => void>` — Tauri: `invoke("watch_folder", { folderPath: folder })`, `listen<string>("folder-changed", e => sameFolder(e.payload, folder) && handler())`, cleanup unlistens and `invoke("unwatch_folder", { folderPath: folder })` (verify the Rust command names in `src-tauri/src/file_watcher.rs` and adapt).
  - `flowApi.save(projectRoot, path, content, expectedSha256: string | null): Promise<FlowLoadResult>` → `call("flow_save", { projectRoot, path, content, expectedSha256 })`; `flowApi.watchFolder(folder, handler)` delegates to the transport.
  - `editor-store.ts` (zustand, one store keyed by `${projectRoot}\n${path}` in a `Map`, or a single store holding the active file — pick the single active-file store; the workspace opens one file at a time):

```ts
export type Selection = { kind: "node"; path: string } | { kind: "edge"; path: string } | { kind: "flow" } | null;
export interface EditorState {
  projectRoot: string | null; path: string | null; kind: FlowKind | null; format: FlowFormat | null;
  text: string;                 // source of truth
  savedSha256: string | null;   // hash of the text on disk when loaded / last saved
  def: FlowDef | null;          // last successfully decoded flow (Rust)
  errors: FlowIssue[]; warnings: FlowIssue[];
  dirty: boolean; validating: boolean; commentWarningPending: boolean;
  selection: Selection; externalChange: boolean; loadError: string | null;
  open(projectRoot: string, path: string): Promise<void>;        // flow_load → text/def/issues; commentWarningPending = hasComments(content)
  setText(text: string): void;                                   // user typed YAML: dirty, schedule validate (300 ms debounce)
  applyEdit(edit: (def: FlowDef) => FlowDef): void;              // canvas/form edit: def' → text = stringifyFlow(def'), dirty, schedule validate
  validateNow(): Promise<void>;                                  // flow_validate(path, text) → def (when decodable), issues; keeps the previous def otherwise
  select(selection: Selection): void;
  save(opts: { overwrite?: boolean }): Promise<"saved" | "changed-outside" | "error">; // flow_save with savedSha256 (or null for a new file); on FLOW_FILE_CHANGED → externalChange = true unless overwrite (then re-load the hash and save again)
  markExternalChange(): void; reload(): Promise<void>;           // reload = open() again, dropping edits
  close(): void;
}
export const useFlowEditorStore = create<EditorState>()(...)
```

  - `FlowYamlPane({ value, onChange, readOnly?, markers? })` — Monaco (`@monaco-editor/react` `Editor`, `language="yaml"`, theme from the settings store like `CodeEditorPanel`, `automaticLayout`, `minimap: false`); `onChange` debounced by the store, not here; `markers` (from `errors` with `FLOW_PARSE_FAILED` line / column params) set via `monaco.editor.setModelMarkers`.
  - i18n: `runError.FLOW_FILE_EXISTS` (en "A flow with that file name already exists." / ja "同じファイル名のフローが既にあります。"), `runError.FLOW_FILE_CHANGED` exists? (grep; add if missing: en "The file changed since it was loaded." / ja "読み込み後にファイルが変更されました。").
- Consumes: Tasks 2–3; `flowApi.validate`.

- [ ] **Step 1: Write the failing tests**

`editor-store.test.ts` (fake transport via `setFlowTransport`; `vi.useFakeTimers()` for the debounce):

```ts
it("open loads text, def, issues and the comment flag", async () => { /* route flow_load → { content: "# c\n...", sha256: "h1", flow, errors: [], warnings: [] }; expect text/def/savedSha256/commentWarningPending === true, dirty false */ });
it("setText debounces validation and keeps the last decoded flow while the text is unparsable", async () => {
  /* open valid; setText("nodes: [") → dirty true; advance 299 ms → no validate call; advance 1 ms → flow_validate called with the text; route returns flow: null + errors [FLOW_PARSE_FAILED] → def unchanged (previous), errors set */
});
it("applyEdit serializes the edit into the text and validates", async () => { /* applyEdit(d => addNode(d, ...)) → text contains "- id: new_node"; after debounce flow_validate called; def updated from the result */ });
it("save sends the saved hash, clears dirty, and reports external changes", async () => {
  /* save → flow_save args { expectedSha256: "h1" }; result sha256 "h2" → savedSha256 "h2", dirty false;
     then route flow_save to throw { code: "FLOW_FILE_CHANGED" } → save() === "changed-outside" and externalChange === true;
     save({ overwrite: true }) → first flow_load (to fetch the current hash "h3") then flow_save with expectedSha256 "h3" → "saved" */
});
it("a new file saves with a null hash", async () => { /* open() on FLOW_FILE_NOT_FOUND via openNew(path, def) helper or open with a text when the load fails → save sends expectedSha256: null */ });
```

(Write them fully in the test file with `route`-style fakes; the assertions above are the contract.) Add a transport test for `watchFolder` (Tauri: `invoke("watch_folder", { folderPath })`, handler fires on a matching `folder-changed` payload only, cleanup calls `unwatch_folder`) and a `flow-api.test.ts` row for `save`.

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement** the types, transport, api, store (`openNew(projectRoot, path, def)` sets `text = stringifyFlow(def)`, `savedSha256 = null`, `dirty = true`, `kind` by path prefix `.mdium/flows/lib/`), the YAML pane, and the i18n keys.

- [ ] **Step 4: Run the suites** → `npm test`, `tsc` green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow src/shared/types/flow.ts src/shared/i18n/locales/en/flow.json src/shared/i18n/locales/ja/flow.json
git commit -m "feat(flow): editor store with debounced validation, save and folder watch transport, YAML pane"
```

---

### Task 5: Canvas editing — drag, connect with a port chooser, select and delete edges and nodes

**Files:**
- Create: `src/features/flow/components/PortPopover.tsx`
- Modify: `src/features/flow/components/FlowCanvas.tsx`, `FlowNodes.tsx`, `Flow.css`, `src/features/flow/components/__tests__/FlowViews.test.tsx` (or a new `EditorViews.test.tsx`)
- Test: component tests

**Interfaces:**
- Produces:
  - `FlowCanvas` props become `{ graph, layout, selection: Selection, editable: boolean, onSelect(selection: Selection), onToggle(id), onMoveNode(nodeId, position), onConnect(req: { sourcePath: string; targetPath: string }), onDeleteSelection() }`; with `editable`, `nodesDraggable` and `nodesConnectable` are on, top-level nodes are draggable (children of a group are not), `onNodeDragStop` calls `onMoveNode` with the node's new position, edges are selectable (`onEdgeClick` → `onSelect({ kind: "edge", path })`), the Delete / Backspace key with a selected node or edge calls `onDeleteSelection` (ReactFlow `deleteKeyCode={null}`; handle the key in the canvas wrapper so the store owns the edit).
  - Handles: keep the four handles; `out` and `back-out` become `type="source"` connectable when `editable`; `in` / `back-in` `type="target"`. `onConnect` is called with the two graph paths (source / target). ReactFlow `isValidConnection` rejects a target inside another scope than the source (compare the `parentId` of both nodes).
  - `PortPopover({ ports: string[], anchor: { x, y }, onChoose(port: string), onCancel() })` — a small listbox positioned at the drop point (`success` preselected, Enter confirms, Escape cancels); rendered by the workspace (Task 8 wires it: the workspace keeps `pendingConnection` and calls `addEdge` on choose).
  - `FlowNodes`: when a node is the current selection its card gets `flow-node--selected`; an edge in selection gets `flow-edge--selected`.
- Consumes: Task 3 (`portsOf`, `addEdge`, `removeEdge`, `removeNode`, `moveNode`), Task 4 store.

- [ ] **Step 1: Write the failing tests** (`EditorViews.test.tsx`, mounting `FlowCanvas` directly with a small graph, ReactFlow real under happy-dom as `FlowViews.test.tsx` does)

```ts
it("renders draggable, connectable nodes when editable", async () => {
  /* mount FlowCanvas editable with docDigest graph → every `.react-flow__node` has class `draggable`; handles `.react-flow__handle` are present with data-handleid "out"/"in" and not `.connectablestart`-disabled */
});
it("selects an edge on click and reports Delete", async () => {
  /* click `.react-flow__edge` path → onSelect called with { kind: "edge", path: "edges[0]" }; dispatch keydown Delete on the canvas wrapper → onDeleteSelection called */
});
it("reports node moves with the dropped position", async () => {
  /* ReactFlow drag under happy-dom is impractical: call the exported `toReactFlow` handler path instead — export `handleNodeDragStop(onMoveNode)` and invoke it with a fake node { id: "nodes[0]", data: { node: { nodeId: "collect" } }, position: { x: 3, y: 4 } } → onMoveNode("collect", { x: 3, y: 4 }) */
});
it("PortPopover lists ports with success first and confirms with Enter", async () => {
  /* render PortPopover ports ["success","failure","attention"]; expect three options; press Enter → onChoose("success"); click "attention" → onChoose("attention"); Escape → onCancel */
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement** (keep the read-only path identical when `editable` is false so `FlowViews.test.tsx` stays green).

- [ ] **Step 4: Run the suites** → `npm test`, `tsc` green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/components
git commit -m "feat(flow): editable canvas with drag, connect, selection, delete and a port chooser"
```

---

### Task 6: Node palette

**Files:**
- Create: `src/features/flow/components/NodePalette.tsx`, `src/features/flow/components/__tests__/NodePalette.test.tsx`
- Modify: `src/shared/i18n/locales/{en,ja}/flow.json`

**Interfaces:**
- Produces: `NodePalette({ projectRoot, def, parts: FlowSummary[], project: ProjectLoadResult | null, onAdd(node: FlowNode), onClose() })` — a popover with: one entry per kind (`command`, `approval`, `branch`, `loop`, `subflow`, `agent`, `action`; label `kind.<kind>`), the `python` group listing stages per runtime (loaded lazily on open via `flowApi.runtimeDescribe(projectRoot, runtime, project.sha256)`; while loading show `palette.loading`; a describe failure shows `describeError` inline and keeps the other entries usable), and for `loop` / `subflow` a part picker (`parts` with their signature text) because a palette loop gets a file body (spec 16.6) and a subflow needs a `flow`. `onAdd` receives a complete node: `{ id: nextNodeId(def, kind, stageName?), ...defaultsFor(kind) }` with `runtime` / `entry` / `with` (one key per declared stage input, value `""` or the default) for python, `flow` / `body` set to the chosen part path (relative to the file's directory: parts live in `.mdium/flows/lib/`, so from `.mdium/flows/x.flow.yaml` the reference is `lib/<name>.flow.yaml`; from a part it is `<name>.flow.yaml`) and `params` with one key per callee param.
- i18n keys (both locales): `palette.title`, `palette.loading`, `palette.pickPart`, `palette.noParts`, `palette.pythonStages`, `palette.noRuntime` ("No python runtime in project.yaml." / "project.yaml に python ランタイムがありません。"), `editor.addNode`.
- Consumes: Task 3 (`nextNodeId`, `defaultsFor`), `flowApi.runtimeDescribe`, `flowApi.list` results (parts), `ProjectLoadResult`.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds a command node with a unique id", async () => { /* click "command" → onAdd({ id: "command", kind: "command", run: [""], shell: false, protocol: "mdium-v1" }); with an existing "command" node → id "command_2" */ });
it("lists python stages from the manifest and adds one with its inputs", async () => {
  /* route flow_runtime_describe → manifest with stage demo.add inputs a (required), b (default 1); open the palette → "demo.add" appears; click → onAdd({ id: "demo_add", kind: "python", runtime: "demo", entry: "demo.add", with: { a: "", b: 1 } }) */
});
it("adds a loop with a file body chosen from the parts", async () => { /* parts [{ path: ".mdium/flows/lib/per-doc.flow.yaml", params: { doc: {...} }, outputs: [...] }]; click "loop" → part list → choose → onAdd({ id: "loop", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 10, body: "lib/per-doc.flow.yaml", params: { doc: "" } }) for an entry file at ".mdium/flows/main.flow.yaml" */ });
it("shows a notice when the project has no python runtime", async () => { /* project null or runtimes {} → "No python runtime in project.yaml." */ });
```

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement**; CSS `flow-palette`, `flow-palette__group`, `flow-palette__item`.

- [ ] **Step 4: Run the suites** → green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/components/NodePalette.tsx src/features/flow/components/__tests__/NodePalette.test.tsx src/features/flow/components/Flow.css src/shared/i18n/locales/en/flow.json src/shared/i18n/locales/ja/flow.json
git commit -m "feat(flow): node palette with python stages and part pickers"
```

---

### Task 7: Attribute panel — shared editors, common node form, edge form, flow attributes, conditions

**Files:**
- Create: `src/features/flow/components/attrs/{AttributePanel,NodeCommonForm,EdgeForm,FlowAttrsForm,ConditionEditor,KeyValueEditor,StringListEditor}.tsx`, `src/features/flow/components/__tests__/AttributeForms.test.tsx`
- Modify: `src/shared/i18n/locales/{en,ja}/flow.json`

**Interfaces:**
- Produces:
  - `AttributePanel({ def, selection, issues, parts, project, onEditNode(path, patch), onRenameNode(path, id), onEditEdge(path, patch), onDeleteEdge(path), onEditFlow(patch) })` — routes: `selection.kind === "node"` → `NodeCommonForm` + the kind form (Task 8; until then a `<pre>` JSON fallback for kinds without a form); `"edge"` → `EdgeForm`; `"flow"` / null → `FlowAttrsForm`.
  - `NodeCommonForm({ node, path, issues, onChange, onRename })`: id (text; validated with `isNodeId`, applied on blur / Enter, shows `attrs.invalidId` on a bad value and does nothing), name, description (textarea), timeout (text, placeholder `30s`), retry (max number + backoff text + `on` checkboxes), cost (estimateUsd / budgetUsd numbers), when (`ConditionEditor` with an "enable" toggle), concurrencyKey. Each field writes through `onChange(path, { key: value | undefined })` on blur / change; empty strings become `undefined`.
  - `EdgeForm({ edge, path, ports: string[], onChange, onDelete })`: from / to (read-only text), port (`<select>` of the source node's `portsOf`), maxTraversals (number, empty = undefined), delete button.
  - `FlowAttrsForm({ def, onChange })`: name, description, params (`KeyValueEditor` rows: name, type select, required checkbox, default, description), defaults (timeout, retry, workingDir), limits (maxConcurrentNodes, budgetUsd, stopGrace), env (`KeyValueEditor` string → string), envPassthrough (`StringListEditor`), outputs (`KeyValueEditor` key → template).
  - `ConditionEditor({ value: FlowCondition, onChange })`: recursive form for the minimal syntax — a node is either a comparison (`ref` text, `op` select of the eight operators, `value` text parsed as number / boolean / JSON array when it looks like one, hidden for `exists`) or a group (`all` / `any` / `not`) with "add comparison" / "add group" / "remove" buttons.
  - `KeyValueEditor<T>({ entries: Record<string, T>, columns: ColumnSpec<T>[], onChange, addLabel })` and `StringListEditor({ items, onChange, addLabel })` — generic row editors (new key must satisfy `isIdent`, duplicates refused with `attrs.duplicateKey`).
- i18n (both locales): `attrs.*` labels for every field above (e.g. `attrs.id`, `attrs.name`, `attrs.description`, `attrs.timeout`, `attrs.retryMax`, `attrs.retryBackoff`, `attrs.retryOn`, `attrs.costEstimate`, `attrs.costBudget`, `attrs.when`, `attrs.concurrencyKey`, `attrs.invalidId`, `attrs.duplicateKey`, `attrs.port`, `attrs.maxTraversals`, `attrs.deleteEdge`, `attrs.flowTitle`, `attrs.params`, `attrs.defaults`, `attrs.limits`, `attrs.env`, `attrs.envPassthrough`, `attrs.outputs`, `attrs.addRow`, `attrs.remove`, `attrs.condition.ref`, `attrs.condition.op`, `attrs.condition.value`, `attrs.condition.all`, `attrs.condition.any`, `attrs.condition.not`, `attrs.condition.addComparison`, `attrs.condition.addGroup`, `attrs.condition.enable`).
- Consumes: Task 3 (`portsOf`, `isNodeId`, `isIdent`), `describeReason` for issue display.

- [ ] **Step 1: Write the failing tests** (`AttributeForms.test.tsx`, mounting each form directly with `createRoot`; `setNativeValue` + `input` / `change` events; one `it` per bullet)

- the common form writes `{ name: "Run" }` on blur and `{ timeout: undefined }` when cleared; an invalid id ("Bad-Id") shows the invalid-id text and does not call `onRename`; a valid id calls `onRename(path, "run_1")`.
- the edge form offers the source node's ports (`approve`, `reject`, `failure` for an approval source), writes `{ port: "reject" }`, writes `{ maxTraversals: 3 }` and `{ maxTraversals: undefined }` when cleared, and the delete button calls `onDelete(path)`.
- the flow form adds a param row (`{ params: { x: { type: "string", required: false } } }`), refuses a duplicate key with the duplicate-key text, and writes `limits.budgetUsd`.
- the condition editor builds `{ all: [{ ref: "params.x", op: ">=", value: 7 }, { not: { ref: "nodes.a.outputs.ok", op: "exists" } }] }` through the UI and hides the value field for `exists`.

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement**; CSS `flow-attrs`, `flow-attrs__field`, `flow-attrs__row`, `flow-attrs__error`.

- [ ] **Step 4: Run the suites** → green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/components/attrs src/features/flow/components/__tests__/AttributeForms.test.tsx src/features/flow/components/Flow.css src/shared/i18n/locales/en/flow.json src/shared/i18n/locales/ja/flow.json
git commit -m "feat(flow): attribute panel with common, edge, flow and condition forms"
```

---

### Task 8: Attribute panel — kind forms

**Files:**
- Create: `src/features/flow/components/attrs/kinds/{CommandForm,ApprovalForm,BranchForm,LoopForm,SubflowForm,AgentForm,PythonForm,ActionForm}.tsx`
- Modify: `src/features/flow/components/attrs/AttributePanel.tsx`, `src/features/flow/components/__tests__/AttributeForms.test.tsx`, `src/shared/i18n/locales/{en,ja}/flow.json`

**Interfaces:**
- Produces, each `({ node, path, parts, project, onChange })` writing partial patches through `onChange(path, patch)`:
  - `CommandForm`: `run` (one argv entry per line in a textarea; `shell` checkbox switches to a single string), `workingDir`, `env` (`KeyValueEditor`), `successCodes` (comma-separated numbers), `protocol` select, `detach` checkbox.
  - `ApprovalForm`: `message`, `show` (`StringListEditor` of references), `options` rows (name + commentRequired checkbox; a row with `commentRequired` false serializes to a plain string).
  - `BranchForm`: `cases` rows (`ConditionEditor` + port text), `default` port.
  - `LoopForm`: `mode` select, `items` (text, template or JSON array), `until` (`ConditionEditor`, `while` only), `maxIterations`, `parallelism`, `as`, `onItemFailure`, body: a part picker (file body; shows the callee signature and `params` rows from it) — an inline body shows `attrs.inlineBodyHint` ("Inline bodies are edited in the YAML view.") and no body controls.
  - `SubflowForm`: `flow` part picker (signature shown; `params` rows generated from the callee's `params` with the current values).
  - `AgentForm`: `provider` select, `model`, `prompt` textarea or `promptRef` text (radio), `permission` select, `outputContract` select, `workingDir`.
  - `PythonForm`: `runtime` select (from `project.runtimes`), `entry` select (stages of the runtime via `flowApi.runtimeDescribe`, cached per runtime in the panel), `with` rows generated from the stage's input schema (name, type, required marker, description) with the current template value; unknown extra keys shown as removable rows.
  - `ActionForm`: `uses` select (`mdium/flow-run-latest`, `mdium/metrics-compare`, `mdium/project-setup`, and the other `KNOWN_ACTIONS` names copied from `model.rs`), `with` (`KeyValueEditor`).
- i18n: `attrs.<field>` keys for every field (both locales), `attrs.inlineBodyHint`.
- Consumes: Task 7 shared editors, Task 6's part-reference convention (`lib/<name>.flow.yaml` from an entry, `<name>.flow.yaml` from a part).

- [ ] **Step 1: Write the failing tests** — one `it` per form asserting a representative patch: command (`run` from two lines → `{ run: ["python", "x.py"] }`), approval (`options` → `["ok", { name: "fix", commentRequired: true }]`), branch (add a case → `{ cases: [{ when: { ref: "params.p", op: "exists" }, port: "yes" }] }`), loop (choose a part → `{ body: "lib/p.flow.yaml", params: { doc: "" } }`, inline body shows the hint), subflow (`{ flow: "lib/p.flow.yaml", params: { doc: "" } }`), agent (`{ promptRef: "prompts/a.md", prompt: undefined }`), python (manifest route → `entry` options; choosing `demo.add` → `{ entry: "demo.add", with: { a: "", b: 1 } }`), action (`{ uses: "mdium/metrics-compare" }`).

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement**, replacing the JSON fallback in `AttributePanel`.

- [ ] **Step 4: Run the suites** → green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow/components/attrs src/features/flow/components/__tests__/AttributeForms.test.tsx src/shared/i18n/locales/en/flow.json src/shared/i18n/locales/ja/flow.json
git commit -m "feat(flow): attribute forms for every node kind"
```

---

### Task 9: Workspace shell — toolbar, split view, save flow, new flow, external changes

**Files:**
- Create: `src/features/flow/components/FlowToolbar.tsx`, `NewFlowDialog.tsx`, `SaveWarningDialog.tsx`, `ExternalChangeNotice.tsx`, `src/features/flow/components/__tests__/EditorViews.test.tsx` (extend)
- Modify: `src/features/flow/components/FlowWorkspace.tsx`, `FlowPanel.tsx` (new-flow button), `Flow.css`, `src/shared/i18n/locales/{en,ja}/flow.json`, `src/features/flow/components/__tests__/FlowViews.test.tsx` (adapt to the store)

**Interfaces:**
- Produces:
  - `FlowWorkspace` uses `useFlowEditorStore`: opens the selected file, renders `FlowToolbar` (add node → `NodePalette`; save (Ctrl+S) → the save flow below; YAML toggle → shows `FlowYamlPane` beside the canvas, bound to `text` / `setText`; validate → `validateNow`), the canvas (`editable` = true; selection → store; `onConnect` → `PortPopover` → `addEdge`; `onMoveNode` → `moveNode`; `onDeleteSelection` → `removeNode` / `removeEdge`), the aside (`RunPanel` as today, `FlowIssueList`, `AttributePanel`), a `dirty` marker in the header (`editor.unsaved`), and the "read-only" badge is removed.
  - Save flow: `validateNow()`; if `errors.length > 0` → `SaveWarningDialog` (`editor.saveWithErrors`, continue / cancel); if `commentWarningPending` → the same dialog with `editor.commentLoss` (continue clears the flag for this file; cancel aborts); then `store.save()`; `"changed-outside"` → `ExternalChangeNotice` with reload / overwrite buttons (reload → `store.reload()`; overwrite → `store.save({ overwrite: true })`).
  - External changes: on open, `flowApi.watchFolder(dirname(path))`; the handler re-loads the file's hash (`flowApi.load`) and, when it differs from `savedSha256`, either reloads silently when `!dirty` or shows `ExternalChangeNotice` (`editor.changedOutside`) when `dirty`. Unwatch on close / path change.
  - `NewFlowDialog({ projectRoot, existing: FlowSummary[], onCreate(path, def), onClose })` — fields: file name (`[a-z0-9-]+`, suffix `.flow.yaml`), location (entry `.mdium/flows/` or part `.mdium/flows/lib/`), flow id (defaults to the file name), display name; refuses an existing path (`editor.fileExists`); `onCreate` → `store.openNew(projectRoot, path, emptyFlow(id, name))` then an immediate `save()` (null hash) and `setSelected(folder, path)` + list refresh. `FlowPanel` gets a "new flow" button (`list.newFlow`).
  - i18n (both locales): `editor.addNode`, `editor.save`, `editor.saved`, `editor.unsaved`, `editor.yaml`, `editor.validate`, `editor.saveWithErrors` ("The flow has validation errors. Save anyway?" / "検証エラーがあります。保存しますか？"), `editor.commentLoss` ("Comments in this file will be lost when saving (the editor writes normalized YAML). Continue?" / "保存すると、このファイルのコメントは失われます（正規化した YAML を書き出します）。続けますか？"), `editor.continue`, `editor.cancel`, `editor.changedOutside` ("The file changed outside the editor." / "ファイルがエディタの外で変更されました。"), `editor.reload`, `editor.overwrite`, `editor.fileExists`, `editor.newFlow`, `editor.fileName`, `editor.location`, `editor.locationEntry`, `editor.locationPart`, `editor.flowId`, `editor.flowName`, `editor.create`, `list.newFlow`.
- Consumes: Tasks 4–8.

- [ ] **Step 1: Write the failing tests** (`EditorViews.test.tsx`, mounting `<FlowWorkspace />` as `FlowViews.test.tsx` does, with `route` fakes for `flow_load`, `flow_validate`, `flow_save`, `flow_list`, `flow_project_load`, `watch_folder`, `unwatch_folder`)

- "edits from the attribute panel reach the YAML text and are saved": select a node → change its name → the YAML pane's value contains `name: Run` → press Ctrl+S → `flow_save` called with `{ expectedSha256: <loaded hash>, content: <text containing "name: Run"> }` → header no longer shows the unsaved marker.
- "warns about comment loss once before the first save": `flow_load` content has `# note` → Ctrl+S → dialog text contains "Comments in this file will be lost" → continue → saved; second Ctrl+S after another edit → no dialog.
- "warns but allows saving with validation errors": `flow_validate` returns an error → Ctrl+S → "validation errors" dialog → continue → `flow_save` called.
- "offers reload or overwrite when the file changes outside": `flow_save` throws `FLOW_FILE_CHANGED` → notice with "Reload" and "Overwrite"; click Overwrite → `flow_load` then `flow_save` with the new hash.
- "reloads silently on an external change when there are no edits": fire the `folder-changed` listener with the flows folder; `flow_load` now returns sha `h2` and a new name → header shows the new name, no notice.
- "creates a new entry flow": click the panel's new-flow button → fill name `my-flow` → create → `flow_save` with `{ path: ".mdium/flows/my-flow.flow.yaml", expectedSha256: null }` and content containing `id: my-flow`; refuses `my-flow` when `flow_list` already has it.
- Adapt `FlowViews.test.tsx` expectations (`invoke` calls now include `flow_validate` after edits, the read-only badge is gone).

- [ ] **Step 2: Run to verify they fail** → FAIL.

- [ ] **Step 3: Implement**; CSS: `flow-toolbar`, `flow-workspace--split` (canvas and YAML pane side by side, resizable by a simple 50/50 split), `flow-notice`.

- [ ] **Step 4: Run the suites** → `npm test`, `tsc` green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flow src/shared/i18n/locales/en/flow.json src/shared/i18n/locales/ja/flow.json
git commit -m "feat(flow): editor workspace with toolbar, YAML split view, save, new flow and external change handling"
```

---

### Task 10: Final verification

- [ ] From `src-tauri/`: `cargo test --workspace` (no failures, no new warnings), `cargo clippy --workspace --all-targets` (no new warnings in `service.rs` / `load.rs` / `commands/flow.rs`), `cargo tree -p flow-core -e normal | grep -i ' tauri'` → empty.
- [ ] From the root: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `uv run --project python/mdium-worker pytest -q`.
- [ ] Desktop smoke (human, under `tauri dev` with the `.taurignore` in place): open python-demo's `artifacts` flow; drag a node and save → `ui.positions` appears in the file; add a `command` node from the palette, connect `render → command` choosing `failure` in the popover, set `maxTraversals` on a back edge via the edge form and see `FLOW_CYCLE_WITHOUT_LIMIT` disappear; edit the approval's options in the form and watch the YAML pane update; type in the YAML pane and watch the canvas update; introduce a YAML syntax error and see the parse issue with line / column while the canvas keeps the last graph; edit the file in another editor while dirty and see the reload / overwrite notice; create a new empty flow and run it (it has no nodes: the run completes immediately); open a file with comments and see the comment-loss warning once.
- [ ] Record deviations in the spec's chapter 12 row V5 (V5a part): serialization lives in the TypeScript codec (Rust reads, TS writes normalized YAML); the port is chosen in a popover on connect and edited in the edge form; "new from template" deferred to V7; drill-down / extract / signature features are V5b.
