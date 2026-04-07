# Git Diff Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style side-by-side diff viewer that opens as a tab when clicking changed files in the Git panel, plus a change count badge on the Git activity bar icon.

**Architecture:** Monaco DiffEditor renders side-by-side diffs in the editor area. A new Tauri command `git_show_file` retrieves file content at specific git revisions. The existing tab store is extended with diff-specific fields. GitFileList click handlers fetch both file versions and open a diff tab.

**Tech Stack:** Rust (Tauri commands), React + TypeScript, Monaco Editor (`@monaco-editor/react` DiffEditor), Zustand (state), i18next (i18n)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/commands/git.rs` | Modify | Add `git_show_file` command |
| `src-tauri/src/lib.rs` | Modify | Register `git_show_file` in command handler list |
| `src/shared/i18n/locales/en/git.json` | Modify | Add diff-related i18n keys (EN) |
| `src/shared/i18n/locales/ja/git.json` | Modify | Add diff-related i18n keys (JA) |
| `src/stores/tab-store.ts` | Modify | Add diff tab fields to Tab interface; add `openDiffTab` method |
| `src/features/git/components/GitDiffViewer.tsx` | Create | Monaco DiffEditor wrapper with labels |
| `src/features/git/components/GitDiffViewer.css` | Create | Diff viewer layout styling |
| `src/features/git/components/GitFileList.tsx` | Modify | Add click-to-diff handler on file rows |
| `src/app/App.tsx` | Modify | Add `isDiffTab` branch in editor rendering |
| `src/app/components/TabBar.tsx` | Modify | Show status badge + "(diff)" suffix for diff tabs |
| `src/features/file-tree/components/LeftPanel.tsx` | Modify | Add badge overlay on Git activity bar icon |
| `src/features/file-tree/components/LeftPanel.css` | Modify | Badge positioning and styling |

---

### Task 1: Add `git_show_file` Tauri Command

**Files:**
- Modify: `src-tauri/src/commands/git.rs:128-133`
- Modify: `src-tauri/src/lib.rs:144`

- [ ] **Step 1: Add `git_show_file` function to git.rs**

Add this function at the end of `src-tauri/src/commands/git.rs` (after `git_push_upstream`):

```rust
#[tauri::command]
pub fn git_show_file(path: String, revision: String, file: String) -> Result<String, String> {
    let spec = if revision.is_empty() {
        format!(":{}", file)
    } else {
        format!("{}:{}", revision, file)
    };
    run_git(&path, &["show", &spec])
}
```

- [ ] **Step 2: Register the command in lib.rs**

In `src-tauri/src/lib.rs`, add `commands::git::git_show_file,` after the line `commands::git::git_push_upstream,` (line 144):

```rust
            commands::git::git_push_upstream,
            commands::git::git_show_file,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): add git_show_file Tauri command for retrieving file content at revisions"
```

---

### Task 2: Add i18n Keys

**Files:**
- Modify: `src/shared/i18n/locales/en/git.json`
- Modify: `src/shared/i18n/locales/ja/git.json`

- [ ] **Step 1: Add English keys**

Add the following keys to `src/shared/i18n/locales/en/git.json` (before the closing `}`):

```json
  "diffTab": "{{fileName}} (diff)",
  "diffOriginalHead": "{{fileName}} (HEAD)",
  "diffOriginalIndex": "{{fileName}} (Index)",
  "diffModifiedWorking": "{{fileName}} (Working Tree)",
  "diffModifiedIndex": "{{fileName}} (Index)",
  "diffLoadError": "Failed to load diff",
  "diffBinaryFile": "Binary file - diff not available"
```

- [ ] **Step 2: Add Japanese keys**

Add the following keys to `src/shared/i18n/locales/ja/git.json` (before the closing `}`):

```json
  "diffTab": "{{fileName}} (diff)",
  "diffOriginalHead": "{{fileName}} (HEAD)",
  "diffOriginalIndex": "{{fileName}} (Index)",
  "diffModifiedWorking": "{{fileName}} (Working Tree)",
  "diffModifiedIndex": "{{fileName}} (Index)",
  "diffLoadError": "差分の読み込みに失敗しました",
  "diffBinaryFile": "バイナリファイル - 差分は表示できません"
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/git.json src/shared/i18n/locales/ja/git.json
git commit -m "feat(git): add i18n keys for diff viewer"
```

---

### Task 3: Extend Tab Store with Diff Tab Support

**Files:**
- Modify: `src/stores/tab-store.ts`

- [ ] **Step 1: Add diff fields to Tab interface**

In `src/stores/tab-store.ts`, add the following fields after the `editorVisible?: boolean;` line (line 31) inside the `Tab` interface:

```typescript
  /** Whether this tab displays a diff view */
  isDiffTab?: boolean;
  /** Original file content for diff (left side) */
  diffOriginal?: string;
  /** Modified file content for diff (right side) */
  diffModified?: string;
  /** Monaco language ID for diff syntax highlighting */
  diffLanguage?: string;
  /** Label for the original (left) pane */
  diffOriginalLabel?: string;
  /** Label for the modified (right) pane */
  diffModifiedLabel?: string;
  /** Git status code for display in tab (e.g. "M", "A", "D") */
  diffStatus?: string;
```

- [ ] **Step 2: Add openDiffTab method signature to TabState interface**

In the `TabState` interface, add after the `toggleTabEditor` method (around line 57):

```typescript
  /** Open a diff tab (or reuse existing one for the same file+staged combination) */
  openDiffTab: (params: {
    folderPath: string;
    filePath: string;
    fileName: string;
    original: string;
    modified: string;
    language: string;
    originalLabel: string;
    modifiedLabel: string;
    staged: boolean;
    status: string;
  }) => void;
```

- [ ] **Step 3: Implement openDiffTab in the store**

Add the `openDiffTab` implementation inside the store creation, after the `toggleTabEditor` method (after line 244, before `openFolder`):

```typescript
  openDiffTab: ({ folderPath, filePath, fileName, original, modified, language, originalLabel, modifiedLabel, staged, status }) => {
    const diffId = `diff:${staged ? "staged" : "unstaged"}:${filePath}`;
    const { tabs, folderLastActiveTab } = get();
    const existing = tabs.find((t) => t.id === diffId && t.folderPath === folderPath);
    if (existing) {
      // Update content and reactivate
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === diffId && t.folderPath === folderPath
            ? { ...t, diffOriginal: original, diffModified: modified, diffOriginalLabel: originalLabel, diffModifiedLabel: modifiedLabel }
            : t
        ),
        activeTabId: diffId,
        activeFolderPath: folderPath,
        folderLastActiveTab: { ...folderLastActiveTab, [folderPath]: diffId },
      }));
      useUiStore.getState().setEditorVisible(false);
      return;
    }
    const newTab: Tab = {
      id: diffId,
      filePath,
      folderPath,
      fileName,
      content: "",
      dirty: false,
      undoStack: [],
      redoStack: [],
      isDiffTab: true,
      diffOriginal: original,
      diffModified: modified,
      diffLanguage: language,
      diffOriginalLabel: originalLabel,
      diffModifiedLabel: modifiedLabel,
      diffStatus: status,
      editorVisible: false,
    };
    useUiStore.getState().setEditorVisible(false);
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: diffId,
      activeFolderPath: folderPath,
      folderLastActiveTab: { ...s.folderLastActiveTab, [folderPath]: diffId },
    }));
  },
```

- [ ] **Step 4: Exclude diff fields from persistence**

The `persist` middleware's `partialize` (line 348) only stores `openFolderPaths` and `activeFolderPath`, so diff tab data is already excluded from localStorage. No changes needed here — just verify this is correct.

- [ ] **Step 5: Commit**

```bash
git add src/stores/tab-store.ts
git commit -m "feat(git): extend tab store with diff tab support and openDiffTab method"
```

---

### Task 4: Create GitDiffViewer Component

**Files:**
- Create: `src/features/git/components/GitDiffViewer.tsx`
- Create: `src/features/git/components/GitDiffViewer.css`

- [ ] **Step 1: Create GitDiffViewer.css**

Create `src/features/git/components/GitDiffViewer.css`:

```css
.git-diff-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.git-diff-viewer__header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 4px 12px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
  min-height: 28px;
  flex-shrink: 0;
}

.git-diff-viewer__label {
  flex: 1;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-diff-viewer__editor {
  flex: 1;
  min-height: 0;
}
```

- [ ] **Step 2: Create GitDiffViewer.tsx**

Create `src/features/git/components/GitDiffViewer.tsx`:

```tsx
import { DiffEditor } from "@monaco-editor/react";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import "./GitDiffViewer.css";

export function GitDiffViewer() {
  const activeTab = useTabStore((s) => s.getActiveTab());
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;

  if (!activeTab?.isDiffTab) return null;

  return (
    <div className="git-diff-viewer">
      <div className="git-diff-viewer__header">
        <span className="git-diff-viewer__label">
          {activeTab.diffOriginalLabel}
        </span>
        <span className="git-diff-viewer__label">
          {activeTab.diffModifiedLabel}
        </span>
      </div>
      <div className="git-diff-viewer__editor">
        <DiffEditor
          key={activeTab.id}
          original={activeTab.diffOriginal ?? ""}
          modified={activeTab.diffModified ?? ""}
          language={activeTab.diffLanguage ?? "plaintext"}
          theme={themeType === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 14,
            lineNumbers: "on",
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/git/components/GitDiffViewer.tsx src/features/git/components/GitDiffViewer.css
git commit -m "feat(git): create GitDiffViewer component with Monaco DiffEditor"
```

---

### Task 5: Wire GitDiffViewer into App.tsx

**Files:**
- Modify: `src/app/App.tsx:1001-1023`

- [ ] **Step 1: Add import**

Add the following import near the other feature imports (after the `CodeEditorPanel` import, around line 31):

```typescript
import { GitDiffViewer } from "@/features/git/components/GitDiffViewer";
```

- [ ] **Step 2: Add isDiffTab condition in editor rendering**

In `src/app/App.tsx`, find the rendering block starting at line 1001:

```typescript
            {activeTab ? (
              activeTab.mindmapFileType && activeTab.binaryData ? (
```

Change it to add the `isDiffTab` branch as the first condition:

```typescript
            {activeTab ? (
              activeTab.isDiffTab ? (
                <GitDiffViewer />
              ) : activeTab.mindmapFileType && activeTab.binaryData ? (
```

This inserts `isDiffTab` check before `mindmapFileType`. Everything else remains unchanged.

- [ ] **Step 3: Prevent isDiffTab from hiding editor for subsequent tabs**

In `src/app/App.tsx`, find the `useEffect` that force-hides editor for special file types (around line 265-273):

```typescript
  useEffect(() => {
    if (activeTab) {
      const isSpecialFile = activeTab.mindmapFileType || activeTab.imageFileType || activeTab.officeFileType;
      const isVideoJson = activeTab.filePath?.toLowerCase().endsWith(".video.json");
      const isCode = activeTab.isCodeFile;
      if (isSpecialFile || isVideoJson || isCode) {
```

Add `activeTab.isDiffTab` to the special file check:

```typescript
      const isSpecialFile = activeTab.mindmapFileType || activeTab.imageFileType || activeTab.officeFileType || activeTab.isDiffTab;
```

- [ ] **Step 4: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(git): wire GitDiffViewer into App.tsx editor rendering"
```

---

### Task 6: Add Click-to-Diff in GitFileList

**Files:**
- Modify: `src/features/git/components/GitFileList.tsx`

- [ ] **Step 1: Add onDiffOpen prop and imports**

Update the imports and props interface in `src/features/git/components/GitFileList.tsx`:

```typescript
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import { getMonacoLanguage } from "@/features/code-editor/lib/language-map";
import type { GitFileEntry } from "@/features/git/lib/parse-status";
```

Add `folderPath` to the props interface:

```typescript
interface GitFileListProps {
  title: string;
  files: GitFileEntry[];
  staged: boolean;
  folderPath: string;
  onStage?: (files: string[]) => void;
  onUnstage?: (files: string[]) => void;
  onDiscard?: (files: string[]) => void;
}
```

Update the destructured props:

```typescript
export function GitFileList({
  title,
  files,
  staged,
  folderPath,
  onStage,
  onUnstage,
  onDiscard,
}: GitFileListProps) {
```

- [ ] **Step 2: Add handleFileClick function**

Add this function inside the `GitFileList` component, after the `allPaths` declaration:

```typescript
  const openDiffTab = useTabStore((s) => s.openDiffTab);

  const handleFileClick = async (file: GitFileEntry) => {
    if (!folderPath) return;
    const fileName = file.path.split("/").pop() ?? file.path;
    const language = getMonacoLanguage(file.path);

    try {
      let original = "";
      let modified = "";
      let originalLabel = "";
      let modifiedLabel = "";

      if (staged) {
        // Staged: HEAD (left) vs Index (right)
        if (file.status !== "A") {
          original = await invoke<string>("git_show_file", {
            path: folderPath,
            revision: "HEAD",
            file: file.path,
          });
        }
        if (file.status !== "D") {
          modified = await invoke<string>("git_show_file", {
            path: folderPath,
            revision: "",
            file: file.path,
          });
        }
        originalLabel = t("diffOriginalHead", { fileName });
        modifiedLabel = t("diffModifiedIndex", { fileName });
      } else {
        // Unstaged: Index (left) vs Working Tree (right)
        if (file.status !== "??" && file.status !== "A") {
          original = await invoke<string>("git_show_file", {
            path: folderPath,
            revision: "",
            file: file.path,
          }).catch(() => "");
        }
        if (file.status !== "D") {
          // Read working tree file
          const fullPath = folderPath.replace(/\\/g, "/") + "/" + file.path;
          modified = await invoke<string>("read_text_file", { path: fullPath });
        }
        originalLabel = t("diffOriginalIndex", { fileName });
        modifiedLabel = t("diffModifiedWorking", { fileName });
      }

      openDiffTab({
        folderPath,
        filePath: file.path,
        fileName,
        original,
        modified,
        language,
        originalLabel,
        modifiedLabel,
        staged,
        status: file.status,
      });
    } catch (e) {
      console.error("Failed to load diff:", e);
    }
  };
```

- [ ] **Step 3: Add onClick to file row**

Find the file row div (the `<div className="git-file-list__row"` element) and add the click handler and cursor style:

Change:
```tsx
          <div className="git-file-list__row" key={`${f.path}-${f.staged}`}>
```

To:
```tsx
          <div
            className="git-file-list__row"
            key={`${f.path}-${f.staged}`}
            onClick={() => handleFileClick(f)}
            style={{ cursor: "pointer" }}
          >
```

- [ ] **Step 4: Commit**

```bash
git add src/features/git/components/GitFileList.tsx
git commit -m "feat(git): add click-to-diff handler in GitFileList"
```

---

### Task 7: Pass folderPath to GitFileList from GitPanel

**Files:**
- Modify: `src/features/git/components/GitPanel.tsx`

- [ ] **Step 1: Add folderPath prop to GitFileList usages**

In `src/features/git/components/GitPanel.tsx`, find the two `<GitFileList>` usages (around lines 260-272) and add the `folderPath` prop to both:

Change:
```tsx
        <GitFileList
          title={t("stagedChanges")}
          files={stagedFiles}
          staged={true}
          onUnstage={handleUnstage}
        />
        <GitFileList
          title={t("changes")}
          files={unstagedFiles}
          staged={false}
          onStage={handleStage}
          onDiscard={handleDiscard}
        />
```

To:
```tsx
        <GitFileList
          title={t("stagedChanges")}
          files={stagedFiles}
          staged={true}
          folderPath={activeFolderPath ?? ""}
          onUnstage={handleUnstage}
        />
        <GitFileList
          title={t("changes")}
          files={unstagedFiles}
          staged={false}
          folderPath={activeFolderPath ?? ""}
          onStage={handleStage}
          onDiscard={handleDiscard}
        />
```

- [ ] **Step 2: Commit**

```bash
git add src/features/git/components/GitPanel.tsx
git commit -m "feat(git): pass folderPath to GitFileList for diff support"
```

---

### Task 8: Update TabBar for Diff Tabs

**Files:**
- Modify: `src/app/components/TabBar.tsx`

- [ ] **Step 1: Add diff tab display logic**

In `src/app/components/TabBar.tsx`, find the tab name rendering inside the `fileTabs.map()` block (around line 109-112):

```tsx
              <span className="tab-bar__name">
                <span className="tab-bar__file-icon">{getFileIcon(tab.fileName)}</span>
                {tab.fileName}
                {tab.dirty && <span className="tab-bar__dirty">*</span>}
              </span>
```

Replace with:

```tsx
              <span className="tab-bar__name">
                {tab.isDiffTab && tab.diffStatus && (
                  <span className="tab-bar__diff-status" data-status={tab.diffStatus}>
                    {tab.diffStatus}
                  </span>
                )}
                <span className="tab-bar__file-icon">{getFileIcon(tab.fileName)}</span>
                {tab.isDiffTab ? `${tab.fileName} (diff)` : tab.fileName}
                {!tab.isDiffTab && tab.dirty && <span className="tab-bar__dirty">*</span>}
              </span>
```

- [ ] **Step 2: Skip unsaved-changes dialog for diff tabs**

In the close button onClick handler (around line 116-119), diff tabs are read-only so there's no need for an unsaved changes check. Find:

```tsx
                onClick={async (e) => {
                  e.stopPropagation();
                  if (tab.dirty && !(await ask(t("unsavedChanges"), { kind: "warning" }))) return;
                  closeTab(tab.id);
                }}
```

Change to:

```tsx
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!tab.isDiffTab && tab.dirty && !(await ask(t("unsavedChanges"), { kind: "warning" }))) return;
                  closeTab(tab.id);
                }}
```

- [ ] **Step 3: Add diff status badge CSS**

Add the following to `src/app/components/TabBar.css` at the end of the file:

```css
.tab-bar__diff-status {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  margin-right: 4px;
  min-width: 14px;
  text-align: center;
}

.tab-bar__diff-status[data-status="M"] {
  color: var(--git-modified, #e2a438);
}

.tab-bar__diff-status[data-status="A"],
.tab-bar__diff-status[data-status="??"] {
  color: var(--git-added, #73c991);
}

.tab-bar__diff-status[data-status="D"] {
  color: var(--git-deleted, #f44747);
}

.tab-bar__diff-status[data-status="R"],
.tab-bar__diff-status[data-status="C"] {
  color: var(--git-renamed, #6eb5ff);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/components/TabBar.tsx src/app/components/TabBar.css
git commit -m "feat(git): show diff status badge and (diff) suffix in tab bar"
```

---

### Task 9: Add Change Count Badge to Git Activity Bar Icon

**Files:**
- Modify: `src/features/file-tree/components/LeftPanel.tsx:98-108`
- Modify: `src/features/file-tree/components/LeftPanel.css`

- [ ] **Step 1: Add badge to Git icon button**

In `src/features/file-tree/components/LeftPanel.tsx`, find the git activity bar button (around line 98-108):

```tsx
          <button
            className={`left-panel__activity-btn ${leftPanel === "git" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => setLeftPanel("git")}
            title={t("sourceControl", { ns: "git" })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 21V9a9 9 0 0 0 9 9" />
            </svg>
          </button>
```

Replace with:

```tsx
          <button
            className={`left-panel__activity-btn ${leftPanel === "git" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => setLeftPanel("git")}
            title={t("sourceControl", { ns: "git" })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 21V9a9 9 0 0 0 9 9" />
            </svg>
            {gitFileCount > 0 && (
              <span className="left-panel__badge">
                {gitFileCount > 99 ? "99+" : gitFileCount}
              </span>
            )}
          </button>
```

- [ ] **Step 2: Add gitFileCount derived value**

At the top of the `LeftPanel` component function body (after the existing store selectors around line 63), add:

```typescript
  const gitFileCount = useGitStore((s) => s.files.length);
```

Note: `useGitStore` is already imported at line 13.

- [ ] **Step 3: Add badge CSS**

Add the following to the end of `src/features/file-tree/components/LeftPanel.css`:

In the existing `.left-panel__activity-btn` rule block (around line 34), add `position: relative;` to the existing properties.

Then add the new `.left-panel__badge` rule:

```css
.left-panel__badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--color-primary, #89b4fa);
  color: var(--bg-base, #1e1e2e);
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  pointer-events: none;
}
```

The `position: relative` is required so the absolutely-positioned badge renders relative to the button.

- [ ] **Step 4: Commit**

```bash
git add src/features/file-tree/components/LeftPanel.tsx src/features/file-tree/components/LeftPanel.css
git commit -m "feat(git): add change count badge to Git activity bar icon"
```

---

### Task 10: Manual Integration Test

- [ ] **Step 1: Start the dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: Test unstaged file diff**

1. Open a folder with a git repo in MDium
2. Modify a tracked file (e.g., edit and save a `.ts` file)
3. In the Git panel, see the modified file listed under "Changes"
4. Click the file name
5. Verify: A new tab opens with "(diff)" suffix and the file's git status badge
6. Verify: Monaco DiffEditor shows side-by-side view with original (Index) on left and modified (Working Tree) on right
7. Verify: Syntax highlighting works based on file type
8. Verify: The diff is read-only (cannot type in either pane)

- [ ] **Step 3: Test staged file diff**

1. Stage the modified file (click + button)
2. Click the file under "Staged Changes"
3. Verify: A new diff tab opens showing HEAD (left) vs Index (right)
4. Verify: Labels in the header show correct source names

- [ ] **Step 4: Test new file diff**

1. Create a new untracked file in the repo
2. Click the file under "Changes" (status "??")
3. Verify: Original side is empty, modified side shows the file content

- [ ] **Step 5: Test badge**

1. Verify the Git icon in the activity bar shows a numbered badge
2. Stage all files and commit
3. Verify the badge disappears when there are no changes

- [ ] **Step 6: Test tab behavior**

1. Click the same file again — verify it reuses the existing diff tab (no duplicate)
2. Close the diff tab with × button — verify no unsaved-changes dialog appears
3. Open a diff tab, then click a regular file tab — verify editor switches correctly
4. Open a diff tab, then switch back to a regular tab — verify editor/preview panes work normally
