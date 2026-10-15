# V5b Sub-flow Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat sub-flows as functions in the editor: `subflow` nodes and file-bodied `loop` nodes show their signature on a single card, double-click drills into the referenced file with breadcrumbs to come back, a selected group of nodes can be extracted into a new part with an inferred signature, a part file opens with its signature form first, and saving a part re-validates its callers.

**Architecture:** Builds on V5a's editor store and pure edit operations. Signatures come from the existing `flow_list` summaries (params / outputs per file). Drill-down is a navigation stack in the flow view store. Extraction is a pure function (`lib/extract-subflow.ts`) over `FlowDef` that infers params / outputs from template references crossing the selection boundary, refuses ambiguous boundaries with a reason, and produces the new part plus the updated caller; the UI validates both through Rust before saving.

**Tech Stack:** React 19 + TypeScript, `@xyflow/react` 12 (multi-selection), zustand, vitest / happy-dom, react-i18next. No Rust changes.

**Spec:** `.superpowers/specs/2026-10-10-portable-projects-and-improvement-loop-design.md` 16.1 (signature), 16.2 (parts list with signatures, drag to canvas), 16.3 (collapsed display, drill-down, extract, part signature form), 16.5 (granularity), 16.6 (loop bodies), 6 (editor), 12 row V5. Requires V5a merged (editor store, `flow-yaml.ts`, `editor-state.ts`, `flow_save`).

## Global Constraints

- Same as V5a (transport-only backend access, i18n parity, no hardcoded strings, English comments, CRLF in Rust, commit trailer). Baseline: V5a's final test counts.
- Signature (16.1): a part's `params` are its arguments, `outputs` its return values, `description` its description; `outputs` must be declared (callers referencing an undeclared key get `FLOW_OUTPUT_UNKNOWN`).
- Collapsed display (16.3): `subflow` nodes and file-bodied `loop` nodes show name, the argument mapping and the output keys on one card; the body is never drawn.
- Drill-down (16.3): double-click opens the referenced flow; a breadcrumb (`flow › node › …`) navigates back. The run-state overlay on the drilled view is out of scope (the canvas overlay is a later PR).
- Extract (16.3): the inferred signature takes outside references (`params.*`, `nodes.<outside>.outputs.*`, `nodes.<outside>.artifacts…`, loop variables, `index`, `iteration.outputs.*`) as params named after the referenced key (with a numeric suffix on collision) and selection outputs referenced from outside as outputs; refused with a reason when edges enter the selection at more than one node, or leave it from more than one exit (node, port), or the selection mixes scopes, or is empty; back edges closed inside the selection move with it; the new file goes to `lib/<name>.flow.yaml`, the selection is replaced by one `subflow` node; both files are validated and the operation is cancelled on errors.
- A part file opens with the signature form (`params` / `outputs`) at the top of the attribute panel (16.3).
- Saving a part re-validates the callers in the project and lists those with errors (16.1).
- Out of scope: inline expansion (the reverse of extract), copy / paste, undo.

## Review Focus

1. Extracting a selection that references a loop variable (`item`) from an enclosing inline loop: the variable becomes a param (`item`) and the caller passes `${{ item }}` — Task 3 test `loop variables become params`.
2. Extracting when two different outside nodes feed two different selected nodes: refused with `multiple-entries`, nothing changes — Task 3 test `refuses multiple entry points`.
3. A selected node's output referenced by an outside node under two keys (`nodes.sel.outputs.a` and `.b`): both become outputs and the outside references are rewritten to `nodes.<new>.outputs.a` / `.b` — Task 3 test `rewrites outside references to the new node`.
4. Drilling into a part that does not exist (`flow: lib/missing.flow.yaml`): the editor shows the load error and the breadcrumb still returns to the caller — Task 2 test "a missing part shows an error and keeps the breadcrumb".
5. Saving a part whose caller now references a removed output: the caller appears in the callers notice with `FLOW_OUTPUT_UNKNOWN` — Task 5 test "lists callers with errors after saving a part".

---

### Task 1: Signature cards for sub-flow and file-loop nodes

**Files:**
- Modify: `src/features/flow/lib/flow-graph.ts` (`buildFlowGraph(def, collapsed, issues, signatures?)`, `GraphNode.signature`), `src/features/flow/components/FlowNodes.tsx`, `FlowWorkspace.tsx` (pass the parts' summaries), `Flow.css`, `src/features/flow/lib/__tests__/flow-graph.test.ts`, `components/__tests__/FlowViews.test.tsx`, locales

**Interfaces:**
- Produces: `export interface NodeSignature { file: string; params: Array<{ name: string; value: string | undefined; declared: boolean }>; outputs: string[]; missing: boolean }`; `GraphNode.signature?: NodeSignature` filled for `subflow` nodes (`node.flow`) and `loop` nodes whose `body` is a string, by resolving the reference relative to the current file's directory against `signatures: Record<string /* project-relative path */, { params: Record<string, FlowParamDef>; outputs: string[] }>` (built from `flowApi.list`); `missing: true` when the path is not in the map. `resolvePartPath(currentFile: string, ref: string): string` exported (normalizes `./`, `../`). The card lists `params` as `name = value` rows (undeclared keys marked with `signature.undeclared`, declared-but-unset marked `signature.unset`) and the outputs as chips; a missing part shows `signature.missing`.
- i18n: `signature.params`, `signature.outputs`, `signature.undeclared`, `signature.unset`, `signature.missing`.

- [ ] **Step 1: Write the failing tests** — `flow-graph.test.ts`: a subflow node `{ flow: "lib/p.flow.yaml", params: { doc: "${{ item }}", extra: 1 } }` in `.mdium/flows/main.flow.yaml` with `signatures["​.mdium/flows/lib/p.flow.yaml"] = { params: { doc, lang }, outputs: ["summary"] }` → `signature.params` is `[doc = "${{ item }}" declared, lang undefined declared, extra "1" undeclared]`, `outputs ["summary"]`, `missing false`; a reference to an unknown file → `missing true`; a file-bodied loop gets a signature too; `resolvePartPath(".mdium/flows/lib/a.flow.yaml", "../b.flow.yaml") === ".mdium/flows/b.flow.yaml"`. `FlowViews.test.tsx`: the rendered subflow card shows "doc = ${{ item }}" and the chip "summary".

- [ ] **Step 2: Run to verify they fail** → FAIL. **Step 3: Implement.** **Step 4: Run the suites** → green. **Step 5: Commit** `feat(flow): signature cards for sub-flow and file-loop nodes`.

---

### Task 2: Drill-down with breadcrumbs

**Files:**
- Modify: `src/features/flow/flow-store.ts` (navigation stack), `FlowWorkspace.tsx` (breadcrumb, double-click), `FlowCanvas.tsx` (`onNodeDoubleClick` → `onDrill(path)`), `Flow.css`, locales, `components/__tests__/EditorViews.test.tsx`

**Interfaces:**
- Produces: `useFlowViewStore` gains `stack: Record<folder, Array<{ path: string; label: string }>>`, `push(folder, entry)`, `popTo(folder, index)`, `reset(folder)`; `setSelected` resets the stack. Double-clicking a node with a signature pushes `{ path: resolvePartPath(current, ref), label: node.name ?? node.id }` and selects that file (the editor store opens it; dirty edits in the caller prompt `editor.discardEdits` confirm first — reuse `showConfirm`). The header shows `root-flow › label › …` as buttons; clicking one pops to it. A load error for the drilled file keeps the breadcrumb so the user can return.
- i18n: `editor.drillDown` (tooltip), `editor.discardEdits`.

- [ ] **Step 1: Write the failing tests** — "double-clicking a subflow node opens the part and shows a breadcrumb" (route `flow_load` for both paths; after the double click the header shows `Digest › per-doc` and `flow_load` was called with the part path; clicking the first crumb returns to the entry); "a missing part shows an error and keeps the breadcrumb" (`flow_load` throws `FLOW_FILE_NOT_FOUND` → the error text is shown, the crumb `Digest` is still clickable).

- [ ] **Steps 2–5** as above; commit `feat(flow): drill into sub-flows with breadcrumbs`.

---

### Task 3: Extraction as a pure function

**Files:**
- Create: `src/features/flow/lib/extract-subflow.ts`, `src/features/flow/lib/__tests__/extract-subflow.test.ts`

**Interfaces:**
- Produces:

```ts
export type ExtractFailure = "empty" | "mixed-scopes" | "multiple-entries" | "multiple-exits" | "invalid-name";
export interface ExtractResult {
  part: FlowDef;                 // the new file: id = name, params/outputs inferred, nodes = selection (ids kept), edges = inner edges (incl. back edges inside)
  updated: FlowDef;              // caller: selection replaced by one subflow node { id: name (normalized to a node id), kind: "subflow", flow: <ref>, params }, edges re-pointed, outside references rewritten
  signature: { params: string[]; outputs: string[] };
}
export function extractSubflow(def: FlowDef, selectedPaths: string[], name: string, currentFile: string): { ok: true } & ExtractResult | { ok: false; reason: ExtractFailure; detail?: string };
export function collectReferences(value: unknown): string[];   // every `${{ ref }}` reference text inside strings of a JSON value (node attributes, conditions)
```

  Rules: all selected paths must share one scope (top level, or the same inline body) else `mixed-scopes`; `name` must satisfy the flow-id rule `[a-z0-9-]+` else `invalid-name`; entries = edges from outside into the selection: their targets must be one node else `multiple-entries` (edges with `maxTraversals` are ignored for this count); exits = edges from the selection to outside: the set of `(from, port)` must have one element else `multiple-exits`; params: for every reference inside the selection to `params.<p>` → param `<p>` (type copied from the caller's `params`), to `nodes.<outside>.outputs.<k>` → param `<k>` (type `string`), to `nodes.<outside>.artifacts…` → param named `<outside>_artifacts` / `<label>`, to a loop variable `item` / `<as>` / `index` → param of that name, to `iteration.outputs.<k>` → param `<k>`; collisions get `_2`, `_3`; the caller node's `params` map each param to the original expression (`${{ params.p }}`, `${{ nodes.x.outputs.k }}`, `${{ item }}`); inside the part the references are rewritten to `${{ params.<param> }}`; outputs: every reference from outside (other nodes, flow `outputs`, edge-less) to `nodes.<selected>.outputs.<k>` → part output `<k>: "${{ nodes.<selected>.outputs.<k> }}"` and the outside reference becomes `nodes.<new>.outputs.<k>`; the replacement node sits at the entry node's position; the exit port maps to the new node's `success` (a `failure` exit port is preserved as `failure`); positions of moved nodes go to the part's `ui.positions` with the minimum shifted to the origin.

- [ ] **Step 1: Write the failing tests** — `basic extraction builds the signature and rewrites references` (two selected nodes reading `params.src` and `nodes.prep.outputs.list`, one outside node reading `nodes.b.outputs.result` → part params `src`, `list`; part outputs `result`; caller node `params: { src: "${{ params.src }}", list: "${{ nodes.prep.outputs.list }}" }`; the outside node's `run` contains `${{ nodes.<name>.outputs.result }}`; caller edges `prep → <name>`, `<name> → after`); `loop variables become params` (selection inside an inline loop body referencing `${{ item }}` → param `item`, caller passes `${{ item }}`, the new subflow node lives in the body); `refuses multiple entry points`; `refuses multiple exits`; `refuses mixed scopes and empty selections`; `keeps back edges inside the selection`; `rewrites outside references to the new node` (two keys); `name collision gets a suffix` (`params.k` and `nodes.x.outputs.k` → `k`, `k_2`).

- [ ] **Step 2: Run to verify they fail** → FAIL. **Step 3: Implement** (reuse `collectReferences` over `JSON.stringify`-free recursive walks; reference parsing with the same regex as `template.rs`: `\$\{\{\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*\}\}`). **Step 4: Run** → green. **Step 5: Commit** `feat(flow): pure sub-flow extraction with inferred signatures`.

---

### Task 4: Extraction UI

**Files:**
- Create: `src/features/flow/components/ExtractDialog.tsx`
- Modify: `FlowCanvas.tsx` (multi-selection: `multiSelectionKeyCode="Shift"`, `selectionOnDrag`, `onSelectionChange` → `onSelectMany(paths)`), `FlowToolbar.tsx` (extract button enabled with ≥ 1 selected node), `FlowWorkspace.tsx`, `editor-store.ts` (`selectedMany: string[]`), locales, `EditorViews.test.tsx`

**Interfaces:**
- Produces: `ExtractDialog({ def, selectedPaths, currentFile, existingParts: string[], onConfirm(name), onClose })` shows the inferred signature preview (`extractSubflow` dry run) or the refusal reason (`extract.reason.<ExtractFailure>`), a name field (default `part-<n>`, refuses an existing `lib/<name>.flow.yaml`). On confirm the workspace: runs `extractSubflow`, validates the part text (`flowApi.validate(projectRoot, partPath, stringifyFlow(part))`) and the updated caller text; if either has errors → `extract.failedValidation` with the issues, nothing saved; else saves the part (`flowApi.save(partPath, text, null)`), applies `updated` through `store.applyEdit`, refreshes the parts list, and selects the new node.
- i18n: `extract.title`, `extract.name`, `extract.preview`, `extract.reason.empty` / `mixed-scopes` / `multiple-entries` / `multiple-exits` / `invalid-name`, `extract.failedValidation`, `extract.exists`, `editor.extract`.

- [ ] **Step 1: Write the failing tests** — "extracts a selection into a new part" (select two nodes with shift-click → extract → dialog shows params/outputs → confirm → `flow_validate` twice, `flow_save` for `.mdium/flows/lib/part-1.flow.yaml` with `expectedSha256: null`, the YAML pane now contains `kind: subflow`); "refuses an ambiguous selection with the reason"; "cancels when validation fails" (`flow_validate` of the part returns an error → no `flow_save`, text unchanged).

- [ ] **Steps 2–5**; commit `feat(flow): extract selected nodes into a sub-flow`.

---

### Task 5: Part signature form, caller re-validation, final verification

**Files:**
- Modify: `components/attrs/AttributePanel.tsx` (parts: `FlowAttrsForm` params / outputs section rendered first, titled `signature.title`), `FlowWorkspace.tsx` / `editor-store.ts` (after a successful save of a part: `flowApi.list` → callers = entries/parts whose `errorCount > 0` and whose text references this part — simplest faithful approximation: every flow with errors other than the saved one; show `editor.callersWithErrors` listing their paths with a button to open each), locales, tests

- [ ] **Step 1: Write the failing tests** — "a part opens with the signature form first" (open `.mdium/flows/lib/p.flow.yaml` → the first form heading is the signature title and lists params / outputs); "lists callers with errors after saving a part" (`flow_list` after save returns `main.flow.yaml` with `errorCount: 1` → notice contains `main.flow.yaml`; clicking opens it).
- [ ] **Steps 2–4** as above; commit `feat(flow): part signature form and caller re-validation`.
- [ ] **Final verification**: `cargo test --workspace` (unchanged Rust), `npm test`, `npx tsc --noEmit -p tsconfig.json`, `uv run --project python/mdium-worker pytest -q`. Desktop smoke (human): on python-demo's `artifacts` flow, select `review` + `echo` with shift-click (one entry from `render`, no exit; `render` + `review` is refused because the selection exits through the two approval ports `accept` and `revise`), extract as `review-step`, confirm the part appears under Parts with its signature, the caller shows one `subflow` card with `params` rows and `outputs` chips, double-click drills in and the breadcrumb returns, run the entry flow end to end. Record V5b deviations in the spec's chapter 12 row V5 (no run overlay on drill-down; caller detection by error count).
