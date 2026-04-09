# Clone Repository Feature Design

## Overview

Add a "Clone Repository" flow starting from the welcome screen. Users enter a repository URL and select a local destination folder, then the app clones the repo and opens it automatically.

## Requirements

- Welcome screen (no folder open) shows a "Clone Repository" button alongside the existing "Open Folder" button
- Clicking the button opens a modal dialog with URL input and destination folder selection
- Clone executes via a new `git_clone` Tauri backend command
- Simple spinner during clone (no progress bar)
- On success, the cloned folder opens automatically via `openFolder()`
- On failure, an error message is shown in the dialog with retry possible
- Public repositories only (no authentication UI)

## Backend

New Tauri command in `src-tauri/src/commands/git.rs`:

```rust
#[tauri::command]
pub fn git_clone(url: String, dest: String) -> Result<String, String>
```

- Does not use the existing `run_git` helper (which requires `current_dir` on an existing directory)
- Constructs `Command::new("git").args(&["clone", &url, &dest])` directly
- Windows: `CREATE_NO_WINDOW` flag (consistent with other git commands)
- Must be registered in Tauri's command handler list

## Frontend

### CloneDialog Component

New file: `src/features/git/components/CloneDialog.tsx`

Props:
- `open: boolean` — visibility
- `onClose: () => void` — close callback
- `onCloned: (path: string) => void` — success callback with cloned path

Local state (useState):
- `url: string` — repository URL input
- `dest: string` — selected destination path
- `loading: boolean` — clone in progress
- `error: string | null` — error message

UI elements:
- Title: `t("cloneRepository")`
- URL text input with placeholder `t("cloneUrlPlaceholder")`
- Destination display + "Select folder" button (Tauri `open()` dialog)
- "Clone" button (disabled when URL empty, dest empty, or loading)
- "Cancel" button (disabled when loading)
- Spinner overlay when loading
- Error message area

### CloneDialog Styles

New file: `src/features/git/components/CloneDialog.css`

Follows existing `.app-dialog__overlay` / `.app-dialog` CSS patterns for visual consistency.

### Welcome Screen Changes

In `src/app/App.tsx`, the no-folder welcome screen section adds a second button:

```jsx
<div className="app__welcome-actions">
  <button className="app__welcome-btn" onClick={handleOpenFolder}>
    {t("openFolder")}
  </button>
  <button className="app__welcome-btn" onClick={() => setShowCloneDialog(true)}>
    {t("cloneRepository")}
  </button>
</div>
```

`CloneDialog` is rendered in App.tsx. On success (`onCloned`), calls `openFolder(path)` to open the cloned folder.

## i18n

Added to `common` namespace:

| Key | English | Japanese |
|-----|---------|----------|
| cloneRepository | Clone Repository | リポジトリをクローン |
| cloneUrl | Repository URL | リポジトリURL |
| cloneUrlPlaceholder | `https://github.com/user/repo.git` | `https://github.com/user/repo.git` |
| cloneDest | Destination | 保存先 |
| cloneDestSelect | Select folder | フォルダを選択 |
| cloneDestNotSelected | No folder selected | フォルダ未選択 |
| cloning | Cloning... | クローン中... |
| cloneSuccess | Repository cloned successfully | リポジトリのクローンが完了しました |
| cloneError | Failed to clone repository | リポジトリのクローンに失敗しました |

## Changed Files

| File | Change |
|------|--------|
| `src-tauri/src/commands/git.rs` | Add `git_clone` command |
| `src-tauri/src/lib.rs` (or command registration) | Register `git_clone` handler |
| `src/features/git/components/CloneDialog.tsx` | New: clone dialog component |
| `src/features/git/components/CloneDialog.css` | New: dialog styles |
| `src/app/App.tsx` | Add button to welcome screen + render CloneDialog |
| `src/shared/i18n/locales/en/common.json` | Add English keys |
| `src/shared/i18n/locales/ja/common.json` | Add Japanese keys |

## Out of Scope

- Private repository authentication UI
- Progress bar (spinner only)
- Command palette integration
- Branch selection, shallow clone, or other clone options
- URL drag-and-drop / paste detection
