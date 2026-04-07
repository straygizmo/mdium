# Git Diff Viewer Design Spec

## Overview

Add a VS Code-style side-by-side diff viewer to the Git panel. When users click a changed file in the Git file list, a diff tab opens in the editor area showing the original and modified versions using Monaco DiffEditor. Additionally, display a change count badge on the Git icon in the activity bar.

## Requirements

- Side-by-side diff display (Monaco DiffEditor)
- Opens as a tab in the editor area (alongside existing file tabs)
- Single-click on a file in GitFileList triggers diff view
- Diff target varies by stage status:
  - Unstaged files: Working tree vs Index (git diff -- file)
  - Staged files: Index vs HEAD (git diff --staged -- file)
- Read-only (view only, no editing in diff view)
- Change count badge on Git activity bar icon

## Architecture

### Data Flow

1. **GitFileList** — User clicks a file entry
2. **Git Store** — Calls Tauri commands to fetch original and modified file contents
3. **Tab Store** — Creates a diff tab with `isDiffTab: true` and diff data
4. **App.tsx** — Detects `isDiffTab` and renders `GitDiffViewer` instead of normal editor
5. **GitDiffViewer** — Renders Monaco DiffEditor in side-by-side mode

### New Tauri Commands (git.rs)

Monaco DiffEditor requires the full file content for both sides (not a patch/diff output). Two commands are needed to retrieve file contents at specific git revisions.

#### `git_show_file(path: String, revision: String, file: String) -> Result<String, String>`
Returns the content of a file at a specific revision. Used to populate the "original" side of the diff editor.
```
git show <revision>:<file>
```
- For HEAD content: `revision = "HEAD"`
- For index (staged) content: `revision = ""`  (empty string, producing `git show :<file>`)

The "modified" side content is obtained differently depending on context:
- **Unstaged files**: Read the working tree file directly via Tauri fs plugin (`@tauri-apps/plugin-fs`)
- **Staged files**: Use `git_show_file` with empty revision to get index content

### Tab Store Changes (tab-store.ts)

Add to the `Tab` interface:
```typescript
isDiffTab?: boolean;
diffOriginal?: string;    // Original file content (left side)
diffModified?: string;    // Modified file content (right side)
diffLanguage?: string;    // Monaco language ID for syntax highlighting
diffOriginalLabel?: string; // Label for left pane (e.g., "App.tsx (HEAD)")
diffModifiedLabel?: string; // Label for right pane (e.g., "App.tsx (Working Tree)")
```

Add a new method:
```typescript
openDiffTab(params: {
  folderPath: string;
  filePath: string;
  fileName: string;
  original: string;
  modified: string;
  language: string;
  originalLabel: string;
  modifiedLabel: string;
  staged: boolean;
}) => void;
```

Diff tab ID scheme: `diff:<staged|unstaged>:<filePath>` — ensures clicking the same file reuses the existing diff tab rather than opening duplicates.

### GitFileList Changes (GitFileList.tsx)

Add an `onClick` handler to each file row:
1. Determine if file is staged or unstaged
2. For unstaged files:
   - Original (left): Fetch index content via `git_show_file(folderPath, "", filePath)`
   - Modified (right): Read working tree file via Tauri fs plugin
   - Labels: "{filename} (Index)" / "{filename} (Working Tree)"
3. For staged files:
   - Original (left): Fetch HEAD content via `git_show_file(folderPath, "HEAD", filePath)`
   - Modified (right): Fetch index content via `git_show_file(folderPath, "", filePath)`
   - Labels: "{filename} (HEAD)" / "{filename} (Index)"
4. For new files (Added/Untracked):
   - Original is empty string
   - Modified is the file content
5. For deleted files:
   - Original is the HEAD/index content
   - Modified is empty string
6. Call `openDiffTab()` with the fetched data

### New Component: GitDiffViewer.tsx

Location: `src/features/git/components/GitDiffViewer.tsx`

```typescript
// Uses @monaco-editor/react DiffEditor component
import { DiffEditor } from "@monaco-editor/react";
```

Props sourced from the active diff tab:
- `original`: Original file content
- `modified`: Modified file content
- `language`: Monaco language for syntax highlighting
- `originalLabel`: Label for left pane header
- `modifiedLabel`: Label for right pane header

Monaco DiffEditor options:
- `renderSideBySide: true`
- `readOnly: true`
- `originalEditable: false`
- `automaticLayout: true`
- `theme`: Match app theme (vs-dark / vs)
- `minimap: { enabled: false }` (diff view doesn't need minimap)
- `scrollBeyondLastLine: false`

### App.tsx Changes

Add a condition in the editor area rendering:
```
activeTab.isDiffTab ? <GitDiffViewer />
: activeTab.mindmapFileType ? <MindmapEditor />
: activeTab.imageFileType ? <ImageCanvas />
: activeTab.isCodeFile ? <CodeEditorPanel />
: <EditorPanel + PreviewPanel />
```

### TabBar Changes (TabBar.tsx)

For diff tabs, display with a status indicator:
- Tab name format: `{status} {fileName} (diff)` — e.g., "M App.tsx (diff)"
- Status badge color matches git status colors (modified=yellow, added=green, deleted=red)
- No dirty indicator (diff tabs are read-only)

## Change Count Badge

### Display
- Position: Activity bar Git icon, top-right corner
- Shape: Circular badge (min-width: 14px, border-radius: 50%)
- Color: Primary color background (`--color-primary`) with contrasting text

### Count Rules
- Count = total changed files (staged + unstaged)
- 0 files: Badge hidden
- 1-99 files: Show number
- 100+ files: Show "99+"

### Implementation
- Modify `LeftPanel.tsx`: Add badge overlay to Git icon button
- Modify `LeftPanel.css`: Badge positioning and styling
- Data source: `useGitStore(s => s.files.length)`

## i18n Keys

Add to `en/git.json` and `ja/git.json`:

| Key | EN | JA |
|-----|----|----|
| `diffTab` | `{{status}} {{fileName}} (diff)` | `{{status}} {{fileName}} (diff)` |
| `diffOriginalHead` | `{{fileName}} (HEAD)` | `{{fileName}} (HEAD)` |
| `diffOriginalIndex` | `{{fileName}} (Index)` | `{{fileName}} (Index)` |
| `diffModifiedWorking` | `{{fileName}} (Working Tree)` | `{{fileName}} (Working Tree)` |
| `diffModifiedIndex` | `{{fileName}} (Index)` | `{{fileName}} (Index)` |
| `diffLoadError` | `Failed to load diff` | `差分の読み込みに失敗しました` |
| `diffEmptyNew` | `New file` | `新規ファイル` |
| `diffEmptyDeleted` | `Deleted file` | `削除済みファイル` |

## Error Handling

- If Tauri command fails (e.g., file not in git): Show error toast via existing toast system
- If file is binary: Show a message instead of diff ("Binary file - diff not available")
- If git repo is not initialized: Diff click is a no-op (files won't be listed anyway)

## Files Changed Summary

| File | Change | Description |
|------|--------|-------------|
| `src-tauri/src/commands/git.rs` | Modify | Add `git_show_file` command |
| `src/stores/tab-store.ts` | Modify | Add diff tab fields and openDiffTab method |
| `src/features/git/components/GitDiffViewer.tsx` | **New** | Monaco DiffEditor wrapper component |
| `src/features/git/components/GitDiffViewer.css` | **New** | Diff viewer styling (labels, layout) |
| `src/features/git/components/GitFileList.tsx` | Modify | Add click handler to open diff |
| `src/app/App.tsx` | Modify | Add isDiffTab condition in editor rendering |
| `src/app/components/TabBar.tsx` | Modify | Diff tab display with status badge |
| `src/features/file-tree/components/LeftPanel.tsx` | Modify | Add badge overlay to Git icon |
| `src/features/file-tree/components/LeftPanel.css` | Modify | Badge styles |
| `src/shared/i18n/locales/en/git.json` | Modify | Add diff-related keys |
| `src/shared/i18n/locales/ja/git.json` | Modify | Add diff-related keys |
