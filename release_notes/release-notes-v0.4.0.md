# Release Notes — v0.4.0

## Highlights

This release turns MDium into a workbench for agent-driven development. A new **Workflows panel** runs multi-stage tasks on a kanban board, from requirement intake through implementation, review and merge. A new **Flow engine and editor** describes those processes as portable YAML projects with agent, action, Python and sub-flow nodes. The **AGENT CHAT panel** gathers Claude, Codex, Copilot and opencode into one place, replaces the former RAG panel, and exposes the RAG index to every provider through an `mdium-rag` MCP server. Excel workbooks gain a **VBA macro chat** that pulls, edits and pushes modules without leaving the editor.

---

## New Features

### Workflows Panel

- Kanban and matrix workspace for tasks, with a task detail modal, status columns and themed status colors
- Requirement intake sessions in a dedicated window: converse, review proposals, then finalize the intake into a task
- Stage orchestration with outcome handling, recovery of interrupted runs, and a merge/discard flow for finished work
- Issue tracking that detects the forge, talks to its CLI, syncs stage results and protects against duplicate entries
- Task attachments, including Markdown versions of Office and PDF files for the agents
- Safety guard that explains what the workflow may touch and suggests ignore rules

### Flow Engine and Editor

- Portable flow projects: `project.yaml`, setup and test steps, signature verification and reusable library parts
- Node kinds: agent nodes running one guarded turn through an agent runner, action nodes (screening, git worktree, design doc, issue entry/close, project setup, metrics compare), Python nodes backed by a resident `mdium-worker`, loops, branches and sub-flows
- Visual editor with an editable canvas, node palette, attribute forms for every node kind, a YAML split view that preserves comments and key order, drill-down into sub-flows and extraction of selected nodes into a sub-flow
- Templates (`dev-workflow`, `improve-app`) with new-flow-from-template, project metrics and baseline comparison
- Artifacts and previews for flow outputs; actual Claude turn cost is recorded per node

### AGENT CHAT Panel

- One panel hosting Claude, Codex, Copilot and opencode tabs, with per-folder chat state and a provider availability probe
- Agent runner sidecar with Codex, Copilot, Claude Agent SDK and opencode adapters, permission routing and runtime safety guard rules
- Settings panels for Codex and Copilot matching the Claude and opencode layouts
- Index strip above the provider tabs with a settings drawer; the standalone RAG panel and its chat are removed
- `mdium-rag` MCP server bridging the in-app RAG index to Claude, Codex, Copilot and opencode, with per-provider toggles, Office document conversion on request and in-app approval of index updates
- `mdium-docs` MCP server sharing the Office/PDF converters with Node agents

### VBA Macro Chat

- `.xlsm` tabs split into a sheet preview and a workbook-bound macro chat with a module list
- `vba_list` / `vba_pull` / `vba_push` tools that round-trip standard, class and document modules, including module add/remove, name validation and source normalization
- Excel lock detection with a warning banner, re-checked before each send
- Macro chat shows only what matters: no config badges, themed header buttons

### Editor and Panels

- Multiple terminal sessions per folder with CLI launchers
- Pull in the Git panel, with fetch errors surfaced
- Batch converter can convert legacy `.doc` files through Word
- Sanitized Markdown rendering and a unified diff view shared across panels
- Session cost shown above the opencode chat input

### Theme

- Theme-aware switch stylesheet applied to all checkbox and span toggles
- Task status background tokens in every theme preset

---

## Bug Fixes

- VBA: pushed class modules now compile in Excel; path-like and stream-colliding module names are refused; no-op pushes are skipped and stale files are cleaned on pull
- Macro chat: waits for the opencode connection, avoids binding one workbook's session to another, keeps sending allowed while the workbook is locked
- Worker: fixed a permanent hang on Windows when a stage imported heavy Python modules while stdin had a pending read
- Agent chat: concurrent permission requests are queued, stale session starts are guarded, runner shutdown is awaited on close
- Terminal: views stay mounted, exited or orphaned PTYs are cleaned up, add-terminal menu opens below its button
- UI: external links open only for web URLs and folders, and without going through a shell
- opencode: the RAG agent calls `rag_status` before `rag_search`; bridge errors are shown in the tool result
- Dev: `tauri dev` no longer restarts on test-fixture project writes

---

## Chores & Docs

- Flow engine moved into the `flow-core` crate with a swappable transport layer and `FlowService`
- Driver split into kind modules; workflow helpers for frontmatter, dialogs and error codes unified
- Design documents and plans for the workflows panel, flow editor, AGENT CHAT index strip and VBA macro chat
