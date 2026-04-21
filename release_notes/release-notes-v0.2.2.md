# Release Notes — v0.2.2

## Highlights

This release introduces a full CSV/TSV viewer with rainbow-tinted column coloring and virtualized rendering, a Git graph panel, in-app repository cloning, Azure auto-continue for the OpenCode chat, and many stability fixes across the VBA macro import pipeline, preview scrolling, and Slidev preview.

---

## New Features

### CSV / TSV Viewer
- Dedicated split layout for `.csv` and `.tsv` files: Monaco editor on the left, preview table on the right
- **Rainbow coloring**: Monaco stateful tokens provider tints each column with a distinct color, matched in both the editor and the preview table
- Papa Parse-based parser with RFC 4180 support and debounced parsing (`useCsvParse`)
- `CsvPreviewPanel` renders large files efficiently with `@tanstack/react-virtual` row virtualization
- Automatic encoding detection (UTF-8, UTF-16, Shift-JIS)
- CSV/TSV files are now shown in the file tree and wired into the tab store, language map, and Monaco theme system
- Synthetic column labels are fully i18n'd

### Git — Clone Repository
- New in-app `CloneDialog` with progress reporting
- Clone workflow integrated directly into the welcome screen
- Backend `git_clone` Tauri command
- Escape key support and clean state reset on dialog close

### Git — Graph Panel
- New Git graph panel with lane rendering, commit badges, and message display
- Splitter integration so the graph can be resized alongside the file list
- Backend commands and parsers for commit graph data
- Remote refs are fetched before refreshing the graph so upstream branches appear immediately

### Git — Staging & Commit
- Tracking of "commits ahead" of the remote
- Improvements to the staging and commit workflow

### OpenCode — Azure Auto-Continue
- Detects Azure OpenAI content-filter refusals (`isAzureRefusal`) and automatically sends a continuation message so the session resumes without manual intervention
- Auto-retry counter with per-session reset and guarded auto-send (aborts are respected)
- New `isAutoReply` message flag and visual "auto-reply" label on retry messages, with full i18n support
- `isAzureProviderActive` falls back from settings to `config.json` so detection works across configurations
- U+2019 apostrophe normalization so curly-quoted refusals are matched correctly

### OpenCode — Chat UX
- Reasoning parts are now displayed inline, and the stuck "thinking" state bug is fixed
- Animated bouncing-dots loader replaces the old loading bar
- Active AI provider and model are shown in the OPENCODE panel header
- MD context is scoped to the active folder's tab
- Completion popup is no longer clipped by the chat input
- ArrowUp no longer navigates chat history while the input has content
- Builtin question tool output renders as a `QuestionsCard`

### Batch Convert — Save to `.mdium`
- New **Save to .mdium** checkbox on the batch convert toolbar
- Output files can be routed into the project's `.mdium` folder instead of side-by-side with the source
- `check_mdium_md_exists` Tauri command and per-file existence flags (sibling vs. `.mdium`) shown in the dialog
- `.mdium` folder contents are visible in the file tree explorer

### MCP Image Generation
- Filename input is prefilled with a timestamp-based default for quick saves

### Theme
- Default theme changed from `opencode-dark` to `mdium-dark`

---

## Bug Fixes

### VBA Macro Import
- Fixed `.xlsm` corruption on macro import by zeroing `MODULEOFFSET`
- Reset `_VBA_PROJECT` to the spec header to prevent further `.xlsm` corruption
- Preserved `PerformanceCache` on import to stop `.xlsm` crashes
- Invalidate project caches so macro edits take effect immediately
- Fixed macro import not reflecting changes after VBE module rename
- Show the open-file dialog after import, and hide the import button when there is no macros directory

### Preview
- Preview now scrolls to the bottom when the editor reaches its end
- Line-aware scroll sync so editor and preview align correctly in the presence of images
- Prefix match for the `generate-video-scenario` command
- PDF/DOCX dependencies are statically imported to avoid proxy authentication hangs on lazy-load

### Slidev
- Uses the native junction API so a stale destination no longer breaks preview
- Rewrites bare relative image paths so Vite can resolve them

### Layout & App
- Sidebar panels no longer overflow behind the status bar
- Office and PDF files now show only the preview pane instead of opening an empty Markdown editor
- Export preserves the input path separator to avoid duplicate tabs

### File Tree
- The Delete key now works after clicking a tree node

### Git
- AI button position in the Git panel adjusted

### Settings
- The Azure env-var dialog is skipped when the value is unchanged

### RAG / Embeddings
- Unified embedding loader behind a single `embedFn` closure
- Embedding model file list is now per-model so each model pulls only the files it needs

### i18n
- Macros export/import labels clarified with explicit direction

---

## Refactoring

- CSV Monaco imports converted to type-only, with a `startIndex` invariant test added
- `hasExistingMd` split into sibling and `.mdium` flags for batch convert
- Unified RAG embedding loader behind `embedFn` closure
- Scoped and BEM-aligned CSS for the OpenCode auto-reply label

---

## Skills

- VBA skill updated to forbid `Row`, `Column`, and `Key` identifiers (reserved-word collisions)
