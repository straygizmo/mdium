# Release Notes — v0.2.1

## Highlights

This release brings a built-in Git diff viewer, HTML table paste-to-Markdown conversion, a tree-based batch convert UI, and numerous quality-of-life improvements to the OpenCode chat and editor experience.

---

## New Features

### Git Diff Viewer
- Integrated inline diff viewer powered by Monaco DiffEditor
- Click any changed file in the Git panel to open a side-by-side diff tab
- Change count badge on the Git activity bar icon
- Diff status badge and `(diff)` suffix shown in the tab bar
- Tauri command `git_show_file` for retrieving file content at any revision

### Table Paste (HTML to Markdown)
- Paste HTML tables from Excel, Google Sheets, or web pages directly into the editor — they are automatically converted to Markdown tables
- Supports rich formatting, alignment, and nested content
- `useTablePaste` hook integrated into `EditorPanel`

### Batch Convert — Tree View
- Replaced the flat file list in BatchConvertModal with a hierarchical tree view
- Tree builder with filter pruning and path collection utilities
- New `BatchConvertTreeNode` component for intuitive file selection

### Excel Batch Convert
- Added `.xlsx`, `.xlsm`, and `.xls` support to batch convert

### OpenCode Chat — Questions UI
- Interactive `QuestionsCard` rendered inline in the chat when the AI asks clarifying questions
- JSON questions are auto-detected; raw JSON is hidden once the card is displayed

### OpenCode Chat — Abort Button
- Added an abort button to cancel the AI's thinking/processing state
- Suppressed "Done" toast when the user aborts a session

### OpenCode Input Enhancements
- **Image paste**: paste images directly into the chat input
- **Input history**: navigate previous messages with arrow keys
- **Undo / Redo**: full undo/redo support in the chat textarea (`useInputUndoRedo` hook)
- **Vertical splitter**: resizable divider between the messages panel and the input area
- **End key**: press End to scroll the messages panel to the bottom
- **New chat on command execution**: executing commands from the preview panel now opens a fresh chat session

### Slidev — Dynamic Install
- Slidev dependencies are now installed on demand via `npm install` instead of bundling `node_modules`
- Install progress and proxy error hints are shown in the preview panel
- Cross-platform junction/symlink helper for linking the Slidev workspace

### Video Export Optimization
- Static frame skipping: scenes without animation are analyzed and redundant frames are skipped during export, significantly reducing render time
- `analyzeScenes` utility computes static frame ranges automatically

### Video Editing Improvements
- Prompt edit dialog for refining scene prompts
- Scene element CRUD (create, read, update, delete)
- Font color controls for text elements
- Image assets are now copied to the render directory for correct export

### File Tree
- **Copy Path**: new context menu item to copy a file's path to the clipboard
- **Persist expansion state**: directory expansion state is saved and restored across app restarts

### Tab & Toolbar Persistence
- Left toolbar selection (e.g., Explorer, Git, Search) is now persisted per folder tab

### MCP Server Configuration
- Tool count badge displayed when an MCP server is enabled
- Copy/move choice dialog when moving an MCP server from global to project scope
- VBA coding conventions added as a builtin skill
- Edit button now works on disabled MCP server items
- Restyled config badges with badge counts
- Builtin dropdown closes on outside click

### In-App Dialogs
- Replaced native OS dialogs with a unified in-app `AppDialog` for a consistent cross-platform experience

---

## Bug Fixes

### Windows
- Added `CREATE_NO_WINDOW` flag to all `Command` spawns to prevent console window flashes
- Resolved `code.cmd` via `cmd /C` on Windows for the VS Code launcher

### Editor & Preview
- Hidden drawing toolbar for SVG files to prevent corruption
- Fixed `savedImagePath` / `absolutePath` handling for external MCP servers
- Re-attach table context menu listeners when DOM element changes
- Use edited command template instead of hardcoded builtin for video scenarios
- Default "Save As" directory now points to the working folder

### Explorer
- Empty folders are now always shown regardless of filter settings

### Git
- Japanese folder and file names are now displayed correctly in source control

### OpenCode
- Form state is preserved across settings tab switches
- Undo/redo is correctly scoped: global shortcuts are skipped when the chat input or config textareas are focused
- Undo stack is reset on programmatic content changes to prevent undoing template loads
- Raw JSON is hidden when the questions card is displayed
- Connection badge reorganized inline with chat toolbars

### Settings
- Verified badge is shown immediately after a successful connection test
- Verified model state is synced to local state so the Save action preserves it

### Slidev
- Junction is removed before temp directory cleanup to protect AppData
- Junction cleanup, `spawn_blocking`, and install lock issues addressed

### VBA
- Multi-strategy module matching for macro import

### i18n
- Renamed "Outline" label to "Markdown Outline"
- Unified toolbar icon colors to `--text-secondary`

---

## Refactoring

- Shared `useEditorKeyDown` hook extracted for undo/redo/paste across all editor textareas
- Removed `opencode tui.json` theme sync on theme change
- Switched table paste parser from `parse5` to `DOMParser` with `happy-dom` test environment
- Stabilized undo/redo callbacks with `inputRef` pattern
