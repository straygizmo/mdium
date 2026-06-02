# Release Notes — v0.2.3

## Highlights

This release adds automatic delimiter detection for the CSV family (CSV/TSV/SCSV/PSV/colon-separated), row-number gutters and dark-mode polish to the CSV preview, and per-tab view-state preservation so scroll position and editor state survive tab switches. It also introduces an LLM-driven VBA macro import path via a local MCP bridge, vector-SVG Mermaid embedding in DOCX export, and a batch of preview, Git graph, and RAG stability fixes.

---

## New Features

### CSV — Delimiter Auto-Detection
- Detects the delimiter when opening CSV-family files, supporting comma, tab, semicolon (`;`), pipe (`|`), and colon (`:`)
- New `CsvDelimiter` type and a per-tab `csvDelimiter` field on the tab model, so detection is read from the tab rather than inferred from the file extension
- `detectDelimiter` open-time detector with a PapaParse-based probe, plus a fallback path for colon detection that PapaParse cannot probe directly
- Registers `scsv`, `psv`, and `colsv` Monaco languages, and the code editor now picks the CSV language by the detected delimiter
- Rainbow tokenization works for any single-char delimiter (regression tests added for `;`, `|`, `:`)
- PapaParse adapters widened to accept the full `CsvDelimiter` set

### CSV Preview — Row Numbers & Dark Mode
- Sticky row-number gutter showing physical row numbers, with a reserved grid column and a corner cell labeled for row 1
- Parse-warning row numbers are 1-indexed to match the gutter
- Real theme variables used for surface/border/text, with a dedicated dark-mode override for the parse-warning banner

### Per-Tab View State Preservation
- Monaco editor view state (cursor, folding, selection) is preserved across tab switches via new per-tab view-state fields and actions on the tab store
- CSV preview scroll position and header-mode toggle are preserved per tab, restored after the virtualizer finishes measuring
- Per-tab scroll position persists across file-type switches

### VBA — LLM Autonomous Macro Import
- New `mdium-vba` MCP server (Node) exposing `list` / `extract` / `import` tools for LLM-driven macro editing
- Local HTTP bridge with token auth and `/vba/list`, `/vba/extract`, `/vba/inject` routes, each guarded by an active-tab check
- `allowLlmVbaImport` setting (default **off**) plus an LLM import toggle in the preview panel
- Active `.xlsm` path is tracked as shared state and synced into the OpenCode MCP config
- `list_vba_modules` read-only enumeration command and a strict module-set check on `inject_vba_modules`
- New `vba-mdium-flow` builtin skill guiding LLM macro editing; messages are wrapped with active-tab context
- Macro toolbar UI polished and MCP env defaults added

### DOCX Export
- Mermaid diagrams are embedded as vector SVG with a PNG fallback

---

## Bug Fixes

### Preview
- DOCX container stays mounted so `renderAsync` always has a target
- `blob:` allowed in CSP `frame-src`/`font-src` for preview panels
- Office preview now auto-retries with a manual retry button on load failure
- Guarded `sheet_to_html` against a missing `!ref` to fix an `.xlsm` preview crash
- CSV content is no longer fed into `marked`; preview uses a dedicated Vite worker

### OpenCode Chat
- Provider/API errors are surfaced instead of the chat hanging on "Thinking..."

### Git Graph
- Zombie lanes are closed and color skipping in the graph layout is fixed

### File Tree
- Office lock files (`~$` prefix) are hidden from the tree

### Code Editor
- View-state save is guarded against a disposed editor

### CSV
- `detectDelimiter` is guarded against PapaParse throws, and the colon threshold was raised
- Large CSV files keep the UI responsive

### RAG / Embeddings
- Legacy databases are kept, and `.mdium` files are attributed to their parent folder
- Embedding sequence length is capped, and WASM engine aborts are branded for clearer errors
- The failing path is included in `scan_folder_recursive` `read_dir` errors

---

## Refactoring

- CSV preview reserves a grid column for the row-number gutter and drops a dead rAF return with tightened echo-suppression comments
- CSV preview waits for virtualizer measurement before restoring scroll and suppresses echo scroll

---

## Chores & Docs

- Silenced an unreachable pattern and stale sourcemap warnings
- Added CSV delimiter auto-detect plan/spec and documented the cross-feature delimiter module and tab invariant
- Added CSV preview row-numbers & dark-mode plan/design and tab scroll/view-state preservation plan/design
- Added spec and plan for LLM autonomous VBA macro import
- Translated `vba-mdium-flow` skill to English with a Japanese reference
