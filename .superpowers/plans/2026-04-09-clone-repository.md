# Clone Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Clone Repository" flow from the welcome screen so users can clone a git repo and open it in one action.

**Architecture:** New `git_clone` Tauri command in the Rust backend. New `CloneDialog` React component rendered from `App.tsx`. Welcome screen gets a second button to trigger the dialog.

**Tech Stack:** Rust/Tauri (backend command), React + TypeScript (dialog UI), i18next (translations)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/commands/git.rs` | Modify | Add `git_clone` command function |
| `src-tauri/src/lib.rs` | Modify | Register `git_clone` in handler list |
| `src/shared/i18n/locales/en/common.json` | Modify | Add English translation keys |
| `src/shared/i18n/locales/ja/common.json` | Modify | Add Japanese translation keys |
| `src/features/git/components/CloneDialog.tsx` | Create | Clone dialog component |
| `src/features/git/components/CloneDialog.css` | Create | Clone dialog styles |
| `src/app/App.tsx` | Modify | Import CloneDialog, add state, add welcome button |

---

### Task 1: Add `git_clone` backend command

**Files:**
- Modify: `src-tauri/src/commands/git.rs:194` (append after last function)
- Modify: `src-tauri/src/lib.rs:150` (add to handler list)

- [ ] **Step 1: Add `git_clone` function to git.rs**

Append after the `git_show_file` function (after line 194):

```rust
#[tauri::command]
pub fn git_clone(url: String, dest: String) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(&["clone", &url, &dest]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(err)
    }
}
```

- [ ] **Step 2: Register `git_clone` in lib.rs**

In `src-tauri/src/lib.rs`, add `commands::git::git_clone,` after line 150 (`commands::git::git_show_file,`):

```rust
            commands::git::git_show_file,
            commands::git::git_clone,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compilation succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): add git_clone backend command"
```

---

### Task 2: Add i18n translation keys

**Files:**
- Modify: `src/shared/i18n/locales/en/common.json:77` (before closing brace)
- Modify: `src/shared/i18n/locales/ja/common.json:77` (before closing brace)

- [ ] **Step 1: Add English keys**

In `src/shared/i18n/locales/en/common.json`, add before the closing `}` (after the `"folderNotFound"` line). Change the last existing entry to add a trailing comma:

```json
  "folderNotFound": "Folder not found: {{path}}",
  "cloneRepository": "Clone Repository",
  "cloneUrl": "Repository URL",
  "cloneUrlPlaceholder": "https://github.com/user/repo.git",
  "cloneDest": "Destination",
  "cloneDestSelect": "Select folder",
  "cloneDestNotSelected": "No folder selected",
  "cloning": "Cloning...",
  "cloneSuccess": "Repository cloned successfully",
  "cloneError": "Failed to clone repository"
}
```

- [ ] **Step 2: Add Japanese keys**

In `src/shared/i18n/locales/ja/common.json`, same position:

```json
  "folderNotFound": "フォルダが見つかりません: {{path}}",
  "cloneRepository": "リポジトリをクローン",
  "cloneUrl": "リポジトリURL",
  "cloneUrlPlaceholder": "https://github.com/user/repo.git",
  "cloneDest": "保存先",
  "cloneDestSelect": "フォルダを選択",
  "cloneDestNotSelected": "フォルダ未選択",
  "cloning": "クローン中...",
  "cloneSuccess": "リポジトリのクローンが完了しました",
  "cloneError": "リポジトリのクローンに失敗しました"
}
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/common.json src/shared/i18n/locales/ja/common.json
git commit -m "feat(i18n): add clone repository translation keys"
```

---

### Task 3: Create CloneDialog component and styles

**Files:**
- Create: `src/features/git/components/CloneDialog.css`
- Create: `src/features/git/components/CloneDialog.tsx`

- [ ] **Step 1: Create CloneDialog.css**

Create `src/features/git/components/CloneDialog.css`. Uses the same CSS variable tokens and class naming conventions as `AppDialog.css`:

```css
.clone-dialog__overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.clone-dialog {
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow-strong);
  width: 440px;
  padding: 20px;
}

.clone-dialog__title {
  margin: 0 0 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.clone-dialog__field {
  margin-bottom: 12px;
}

.clone-dialog__label {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
  color: var(--text-muted);
}

.clone-dialog__input {
  width: 100%;
  padding: 6px 8px;
  font-size: 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-input, var(--bg-base));
  color: var(--text);
  outline: none;
  box-sizing: border-box;
}

.clone-dialog__input:focus {
  border-color: var(--accent, #4a9eff);
}

.clone-dialog__dest-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.clone-dialog__dest-path {
  flex: 1;
  font-size: 13px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clone-dialog__dest-btn {
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-base);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.clone-dialog__dest-btn:hover {
  background: var(--bg-hover, var(--bg-surface));
}

.clone-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.clone-dialog__btn {
  padding: 6px 16px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-base);
  color: var(--text);
  cursor: pointer;
}

.clone-dialog__btn:hover {
  background: var(--bg-hover, var(--bg-surface));
}

.clone-dialog__btn--primary {
  background: var(--accent, #4a9eff);
  color: #fff;
  border-color: var(--accent, #4a9eff);
}

.clone-dialog__btn--primary:hover {
  opacity: 0.9;
}

.clone-dialog__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.clone-dialog__error {
  margin-top: 8px;
  font-size: 13px;
  color: var(--danger, #e55);
}

.clone-dialog__spinner {
  margin-top: 12px;
  font-size: 13px;
  color: var(--text-muted);
}
```

- [ ] **Step 2: Create CloneDialog.tsx**

Create `src/features/git/components/CloneDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./CloneDialog.css";

interface CloneDialogProps {
  open: boolean;
  onClose: () => void;
  onCloned: (path: string) => void;
}

export function CloneDialog({ open: isOpen, onClose, onCloned }: CloneDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSelectDest = async () => {
    const selected = await open({ directory: true });
    if (selected && typeof selected === "string") {
      setDest(selected);
      setError(null);
    }
  };

  const handleClone = async () => {
    setLoading(true);
    setError(null);
    try {
      // Extract repo name from URL for the clone subdirectory
      const repoName = url.replace(/\.git$/, "").split("/").pop() || "repo";
      const clonePath = `${dest}/${repoName}`;
      await invoke("git_clone", { url, dest: clonePath });
      setUrl("");
      setDest("");
      onCloned(clonePath);
      onClose();
    } catch (e) {
      setError(`${t("cloneError")}: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = () => {
    if (!loading) {
      onClose();
    }
  };

  const canClone = url.trim() !== "" && dest !== "" && !loading;

  return (
    <div className="clone-dialog__overlay" onMouseDown={handleOverlayClick}>
      <div className="clone-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="clone-dialog__title">{t("cloneRepository")}</h2>

        <div className="clone-dialog__field">
          <label className="clone-dialog__label">{t("cloneUrl")}</label>
          <input
            className="clone-dialog__input"
            type="text"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            placeholder={t("cloneUrlPlaceholder")}
            disabled={loading}
            autoFocus
          />
        </div>

        <div className="clone-dialog__field">
          <label className="clone-dialog__label">{t("cloneDest")}</label>
          <div className="clone-dialog__dest-row">
            <span className="clone-dialog__dest-path">
              {dest || t("cloneDestNotSelected")}
            </span>
            <button
              className="clone-dialog__dest-btn"
              onClick={handleSelectDest}
              disabled={loading}
            >
              {t("cloneDestSelect")}
            </button>
          </div>
        </div>

        {loading && (
          <div className="clone-dialog__spinner">{t("cloning")}</div>
        )}

        {error && (
          <div className="clone-dialog__error">{error}</div>
        )}

        <div className="clone-dialog__actions">
          <button
            className="clone-dialog__btn"
            onClick={onClose}
            disabled={loading}
          >
            {t("cancel")}
          </button>
          <button
            className="clone-dialog__btn clone-dialog__btn--primary"
            onClick={handleClone}
            disabled={!canClone}
          >
            {t("cloneRepository")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/git/components/CloneDialog.tsx src/features/git/components/CloneDialog.css
git commit -m "feat(git): add CloneDialog component"
```

---

### Task 4: Integrate CloneDialog into App.tsx welcome screen

**Files:**
- Modify: `src/app/App.tsx:34` (imports area)
- Modify: `src/app/App.tsx:1074-1083` (no-folder welcome screen)

- [ ] **Step 1: Add import for CloneDialog**

In `src/app/App.tsx`, add the CloneDialog import after the GitDiffViewer import (after line 34):

```typescript
import { GitDiffViewer } from "@/features/git/components/GitDiffViewer";
import { CloneDialog } from "@/features/git/components/CloneDialog";
```

- [ ] **Step 2: Add CloneDialog state**

Inside the `App` component function, find the existing `useState` declarations and add (the exact insertion point is alongside other state variables in the component):

```typescript
const [showCloneDialog, setShowCloneDialog] = useState(false);
```

- [ ] **Step 3: Add handleCloned callback**

Add near `handleOpenFolder` (around line 323):

```typescript
const handleCloned = useCallback(
  (clonedPath: string) => {
    addRecentFolder(clonedPath);
    openFolder(clonedPath);
  },
  [addRecentFolder, openFolder],
);
```

- [ ] **Step 4: Add Clone Repository button to welcome screen**

In `src/app/App.tsx`, modify the no-folder welcome screen (lines 1074-1084). Replace:

```tsx
            ) : (
              <div className="app__welcome">
                <img src={appIconUrl} alt="MDium" className="app__welcome-icon" />
                <h1 className="app__welcome-title">MDium</h1>
                <p className="app__welcome-sub">{t("noFolderOpen")}</p>
                <div className="app__welcome-actions">
                  <button className="app__welcome-btn" onClick={handleOpenFolder}>
                    {t("openFolder")}
                  </button>
                </div>
              </div>
```

With:

```tsx
            ) : (
              <div className="app__welcome">
                <img src={appIconUrl} alt="MDium" className="app__welcome-icon" />
                <h1 className="app__welcome-title">MDium</h1>
                <p className="app__welcome-sub">{t("noFolderOpen")}</p>
                <div className="app__welcome-actions">
                  <button className="app__welcome-btn" onClick={handleOpenFolder}>
                    {t("openFolder")}
                  </button>
                  <button className="app__welcome-btn" onClick={() => setShowCloneDialog(true)}>
                    {t("cloneRepository")}
                  </button>
                </div>
              </div>
```

- [ ] **Step 5: Render CloneDialog**

In `src/app/App.tsx`, find where `<AppDialog />` is rendered (near the end of the JSX return) and add `CloneDialog` right before it:

```tsx
        <CloneDialog
          open={showCloneDialog}
          onClose={() => setShowCloneDialog(false)}
          onCloned={handleCloned}
        />
        <AppDialog />
```

- [ ] **Step 6: Verify the app builds**

Run: `npm run build`
Expected: Build succeeds with no TypeScript or build errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat: integrate clone repository into welcome screen"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Start the dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: Verify welcome screen**

With no folder open, confirm:
- MDium logo and title are displayed
- "Open Folder" button is present
- "Clone Repository" button is present next to it

- [ ] **Step 3: Test the clone dialog**

1. Click "Clone Repository" → dialog opens
2. Verify URL input field with placeholder text
3. Verify "Select folder" button opens native folder picker
4. Verify "Cancel" closes the dialog
5. Verify "Clone" button is disabled until both URL and destination are filled

- [ ] **Step 4: Test a real clone**

1. Enter `https://github.com/slidevjs/slidev-theme-default.git` (small public repo)
2. Select a destination folder
3. Click "Clone" → spinner appears
4. On success → dialog closes, folder opens automatically in MDium

- [ ] **Step 5: Test error handling**

1. Enter an invalid URL like `https://github.com/nonexistent/repo.git`
2. Click "Clone" → error message appears in the dialog
3. Verify the dialog remains open and user can fix the URL and retry
