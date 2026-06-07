# Release Notes — v0.2.5

## Highlights

This release focuses on the OpenCode integration. It adds a **built-in Plugins section** with On/Off toggles (aligned with the existing MCP/Skills UI), **On/Off toggles for skills**, and handling for **interactive `question.asked` prompts** so chat no longer hangs when an agent asks a question. It also confines the RAG agent's search to the **currently open folder** via new folder-scoped tools and bridge endpoints, keeps the active folder consistent across folderless tabs, and surfaces **per-file scan progress** in the RAG build badge.

---

## New Features

### OpenCode — Built-in Plugins Section
- New Plugins tab in the OpenCode config panel, aligned with the MCP/Skills UI (including a "+ Built-in" dropdown)
- Built-in plugin catalog with `addPlugin`/`removePlugin` store actions and a plugin config field
- On/Off toggle for plugins via an mdium-local disabled state, with enabled specs de-duplicated to avoid duplicate list keys
- Plugin badges show the built-in id (not the full spec) in the tooltip
- i18n strings (ja/en) for the plugins section

### OpenCode — Skills On/Off Toggle
- Skills can be enabled/disabled via `SKILL.md` rename, without removing them
- Stale disabled copies are cleared before rename for Windows-safe toggling

### OpenCode — Interactive Question Prompts
- Chat now handles interactive `question.asked` prompts instead of stalling when an agent asks a question

### OpenCode — Folder-Scoped Search
- The RAG agent's search is confined to the currently open folder
- New folder-scoped `folder_glob`/`folder_grep` tools (with built-in glob/grep/list disabled for the RAG agent), backed by `fs_glob`/`fs_grep` and `ActiveFolderState`
- Folder-scoped `/glob` and `/grep` endpoints added to the bridge
- Folder tools are auto-installed and the RAG agent is migrated (v2); the active folder is synced to Rust
- Symlinks/junctions are skipped to enforce the folder boundary

### RAG — Scan Progress Display
- Per-file scan progress events are emitted during indexing
- The build badge shows the scan phase label and file count

---

## Bug Fixes

### OpenCode
- The active folder is kept on folderless tabs, and messages are routed to the active folder's server
- Custom tools shown in both global and project scope are de-duplicated
- Agent frontmatter keeps `---` first so it parses (version stored as a YAML comment)

### RAG
- Progress is cleared on a no-change scan
- The empty filename span is hidden during the saving phase

---

## Chores & Docs

- `@opencode-ai/sdk` bumped to 1.16.2
- `regex` dependency added for folder-scoped grep
- Design specs and implementation plans added for the OpenCode built-in plugins section, OpenCode folder-scoped search, and the RAG scan progress display
