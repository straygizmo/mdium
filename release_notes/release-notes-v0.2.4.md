# Release Notes — v0.2.4

## Highlights

This release migrates the mindmap save format from KityMinder `.km` to binary XMind `.xmind` (with image/layout/theme round-tripping and a one-way `.km` import bridge), adds BM25/vector **hybrid search** to RAG, and brings RAG and speech up to working in **offline / blocked-network** environments. It also reworks the OpenCode RAG integration around an HTTP bridge with built-in custom tools, hardens OpenCode connectivity behind proxies and against rate-limit stalls, and adds a **batch delete** mode for generated `.md` files.

---

## New Features

### Mindmap — XMind (`.xmind`) Format
- Mindmaps are now saved as binary XMind (`.xmind`) at every save site; `.xmind` is the only editable mindmap extension, and is always parsed as XMind
- KityMinder graphs are serialized to XMind `content.json` and an XMind 8 `content.xml` is also built for interoperability with the desktop XMind app
- Node images are embedded into and restored from `resources/` inside the `.xmind` package, with SVG image-extension normalization
- Layout, theme, and image sizing are preserved on save and restored on parse, including a layout ⇆ `structureClass` mapping
- `.km` files become import-only: opening a `.km` converts it to `.xmind` via an import bridge, and the intermediate `.km` is removed after conversion
- XMind icon, panel label, and i18n messages for save/import added

### OpenCode — `convert-specmd-to-xmind` Command
- The mindmap builtin command is renamed to `convert-specmd-to-xmind` and repurposed to turn a **specification** Markdown file into a testcase mindmap
- It analyzes the spec and emits one test item per specification point as KityMinder `.km` JSON, which mdium then auto-converts to `.xmind`
- Node labels follow a concise expected-result style (e.g. "{check item} should be {expected value}")

### RAG — BM25 / Vector Hybrid Search
- `rag_search` now performs hybrid vector + BM25 retrieval, fused with Reciprocal Rank Fusion (RRF)
- New FTS5 index with sync triggers and a legacy backfill, plus a trigram (`build_fts_query`) query builder for CJK-friendly matching
- Search mode and BM25-weight controls added to the RAG panel, with settings persistence and legacy migration (`searchMode` / `bm25Weight`)
- `query_text` is optional, and RRF score computation is de-duplicated

### RAG — Offline / Blocked-Network Support
- ONNX/ORT WASM is served locally (via a dev middleware in development) instead of from a CDN, fixing the "Building…" hang and no-backend errors in closed networks
- Embedding models are stored under `app_local_data_dir`, fixing OS error 5
- Manual model-placement UX for blocked networks, including an Open-folder button that works even when the model directory already exists
- `model_subpath` is hardened against path traversal

### RAG — OpenCode Bridge & Custom Tools
- OpenCode's `rag_search` is delegated to the mdium app over a local HTTP bridge (sidecar written at startup), so search runs against mdium's active folder rather than OpenCode's worktree
- Built-in custom tools can be added via "+ Built-in" (replacing connect-time auto-copy); adding the RAG agent prompts to install the required tool
- Default embedding model is `ruri-v3-30m` for the Japanese UI, and the model is pre-warmed on OpenCode connect
- The RAG agent prompt is strengthened to mandate `rag_search` first

### Export — Batch Delete Generated `.md`
- New delete mode in the batch convert modal to move generated `.md` files to the recycle bin
- `delete_generated_md` command moves files to the recycle bin rather than hard-deleting
- `.md` filenames are shown in the batch delete tree, with a `pruneTreeByHasMd` helper and a confirm dialog
- Type-safe delete-status enum and a shared md-path helper

### OpenCode — Stall Watchdog
- A stall watchdog is wired into the chat SSE loop, surfacing a soft "still waiting" notice instead of an indefinite "Thinking…" hang on rate-limit (429) stalls
- Pure `evaluateStall` timing logic with test coverage across the full notice window

---

## Bug Fixes

### OpenCode
- Connects via a reqwest-backed fetch to bypass the WinINET proxy hang ("Connecting…" freeze) in proxy environments
- Stall give-up is guarded against stomping a new turn

### RAG
- The RAG bridge always responds and is guarded against a model-load hang; `node:` import specifiers and a fetch timeout are used in the `rag_search` tool
- Settings dialog height is capped with `max-height`

### Editor & UI
- Editor scroll position is preserved on programmatic content edits
- The file-tree context menu is clamped within the viewport
- The source-control badge is cleared when all folder tabs are closed

### Dependencies
- The `tauri` crate is bumped to 2.11.2 to match `@tauri-apps/api`

---

## Chores & Docs

- Vitest no longer double-counts `.claude` worktree copies (excluded from discovery)
- Temporary SSE event diagnostics added for the rate-limit hang investigation
- Specs and implementation plans added for XMind export, RAG BM25/vector hybrid search, RAG offline/blocked-env support, the OpenCode stall watchdog, and batch delete of generated `.md`
