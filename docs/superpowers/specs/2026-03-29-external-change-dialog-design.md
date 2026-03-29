# External File Change Detection Dialog

## Summary

When an MD file is open in the editor with unsaved changes (dirty state), and the file is modified externally (e.g., by another editor), display a dialog that lets the user choose how to handle the conflict. When the file is not dirty, continue the current behavior of silently reloading the content.

## Context

MDium already has file watching via `useFileWatcher` hook and Tauri's `file_watcher.rs` backend. Currently, external changes are auto-applied regardless of the editor's dirty state (`App.tsx:78-89`). This can silently overwrite the user's unsaved edits.

The opencode integration frequently modifies files, so the dialog should only appear when there is a genuine conflict (dirty state), not on every external change.

## Design

### Approach

Modify the `useFileWatcher` callback in `App.tsx` to check the active tab's `dirty` flag. If dirty, show a new `ExternalChangeDialog` component. If clean, silently reload as before (Approach 1 from brainstorming).

### New Files

- `src/features/editor/components/ExternalChangeDialog.tsx` — Dialog component
- `src/features/editor/components/ExternalChangeDialog.css` — Styles

### Modified Files

- `src/app/App.tsx` — Add dirty-check branching in `useFileWatcher` callback, add dialog state and rendering
- `src/shared/i18n/locales/en/editor.json` — English strings
- `src/shared/i18n/locales/ja/editor.json` — Japanese strings
- `package.json` — Add `diff` dependency

### New Dependency

- `diff` (npm) — Lightweight text diff library for computing unified diffs between the user's content and the external content.

### App.tsx Changes

New state to track pending external changes:

```typescript
const [externalChange, setExternalChange] = useState<{
  tabId: string;
  filePath: string;
  currentContent: string;   // User's unsaved edits
  externalContent: string;  // Content read from disk
} | null>(null);
```

Modified `useFileWatcher` callback:

```typescript
useFileWatcher(activeTab?.filePath ?? null, useCallback(async (changedPath: string) => {
  if (!activeTab || activeTab.filePath !== changedPath) return;
  const newContent = await invoke<string>("read_text_file", { path: changedPath });
  if (newContent === activeTab.content) return;

  if (activeTab.dirty) {
    setExternalChange({
      tabId: activeTab.id,
      filePath: changedPath,
      currentContent: activeTab.content,
      externalContent: newContent,
    });
  } else {
    useTabStore.getState().updateTabContent(activeTab.id, newContent);
  }
}, [activeTab]));
```

Dialog handlers:

- **Accept external**: Call `updateTabContent(tabId, externalContent)`, then `setExternalChange(null)`
- **Keep current**: `setExternalChange(null)` (dismiss dialog, keep user's edits)
- **Close (Escape / overlay click)**: Same as keep current

### ExternalChangeDialog Component

**Props:**

```typescript
interface ExternalChangeDialogProps {
  filePath: string;
  currentContent: string;
  externalContent: string;
  onAcceptExternal: () => void;
  onKeepCurrent: () => void;
  onClose: () => void;
}
```

**Behavior:**

- Displays file name extracted from `filePath`
- Message explaining the conflict
- Three buttons: "Load External Changes", "Show Diff", "Keep My Changes"
- "Show Diff" toggles a unified diff view inline within the dialog
- Diff view: added lines in green background, removed lines in red background, context lines (3 lines before/after each change) in default style
- Follows the same overlay/dialog pattern as `ImagePasteDialog` (fixed overlay, centered dialog, click-outside-to-close, Escape key support)
- Keyboard: Escape closes (same as "Keep My Changes")

**Diff Computation:**

Uses the `diff` npm package (`structuredPatch` or `createPatch` function) to compute a unified diff. The diff output is rendered as a scrollable `<pre>` block with line-by-line coloring:

- Lines starting with `+`: green background (`--diff-added`)
- Lines starting with `-`: red background (`--diff-removed`)
- Lines starting with `@@`: blue/muted header (`--diff-header`)
- Other lines: default background

### CSS Styling

Follow existing BEM pattern with `.external-change-dialog__*` classes. Use CSS variables for theming consistency:

- `--bg-base`, `--border`, `--text` for dialog
- `--accent-green` / `--accent-red` for diff coloring (or define new variables)
- `z-index: 900` for overlay (same as ImagePasteDialog)
- Diff area: `max-height: 400px`, `overflow-y: auto`, monospace font

### i18n

Namespace: `editor`

| Key | EN | JA |
|-----|----|----|
| `externalChangeTitle` | File Changed Externally | ファイルが外部で変更されました |
| `externalChangeMessage` | "{{fileName}}" has been modified by another program. You have unsaved changes. | 「{{fileName}}」が外部プログラムによって変更されました。未保存の変更があります。 |
| `externalChangeAccept` | Load External Changes | 外部の変更を取り込む |
| `externalChangeShowDiff` | Show Diff | 差分を確認 |
| `externalChangeHideDiff` | Hide Diff | 差分を閉じる |
| `externalChangeKeep` | Keep My Changes | 自分の編集を維持 |

### Edge Cases

- **Tab closed while dialog is open**: If the user closes the tab, dismiss the dialog (`externalChange` state references a `tabId` that no longer exists).
- **Multiple rapid external changes**: Each new external change updates the `externalContent` in state, so the dialog always shows the latest version.
- **Same content after diff**: If external content happens to match current content (e.g., change then revert), the dialog is not shown (content equality check runs first).
- **Non-active tab changed externally**: The current `useFileWatcher` only watches the active tab's file. Non-active dirty tabs are not affected (this is existing behavior and unchanged).
