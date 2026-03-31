# External File Change Detection Dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a conflict dialog when a file is modified externally while the user has unsaved edits, with options to accept external changes, keep local edits, or view a unified diff.

**Architecture:** Modify the existing `useFileWatcher` callback in `App.tsx` to branch on the tab's `dirty` flag. When dirty, store the pending external content in React state and render a new `ExternalChangeDialog` component. The dialog uses the `diff` npm package to compute and display a unified diff inline.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri IPC, `diff` npm package, react-i18next

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/features/editor/components/ExternalChangeDialog.tsx` | Dialog component with diff toggle |
| Create | `src/features/editor/components/ExternalChangeDialog.css` | Dialog styling (BEM, CSS vars) |
| Modify | `src/app/App.tsx` (lines 78-89) | Add dirty-check branching + dialog state + render dialog |
| Modify | `src/shared/i18n/locales/en/editor.json` | Add 6 English translation keys |
| Modify | `src/shared/i18n/locales/ja/editor.json` | Add 6 Japanese translation keys |
| Modify | `package.json` | Add `diff` dependency |

---

### Task 1: Install `diff` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the diff package**

Run:
```bash
npm install diff
npm install -D @types/diff
```

- [ ] **Step 2: Verify installation**

Run:
```bash
node -e "const d = require('diff'); console.log(typeof d.structuredPatch)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add diff package for external change detection"
```

---

### Task 2: Add i18n translation keys

**Files:**
- Modify: `src/shared/i18n/locales/en/editor.json`
- Modify: `src/shared/i18n/locales/ja/editor.json`

- [ ] **Step 1: Add English keys**

Add the following keys to the end of `src/shared/i18n/locales/en/editor.json` (before the closing `}`):

```json
  "externalChangeTitle": "File Changed Externally",
  "externalChangeMessage": "\"{{fileName}}\" has been modified by another program. You have unsaved changes.",
  "externalChangeAccept": "Load External Changes",
  "externalChangeShowDiff": "Show Diff",
  "externalChangeHideDiff": "Hide Diff",
  "externalChangeKeep": "Keep My Changes"
```

- [ ] **Step 2: Add Japanese keys**

Add the following keys to the end of `src/shared/i18n/locales/ja/editor.json` (before the closing `}`):

```json
  "externalChangeTitle": "ファイルが外部で変更されました",
  "externalChangeMessage": "「{{fileName}}」が外部プログラムによって変更されました。未保存の変更があります。",
  "externalChangeAccept": "外部の変更を取り込む",
  "externalChangeShowDiff": "差分を確認",
  "externalChangeHideDiff": "差分を閉じる",
  "externalChangeKeep": "自分の編集を維持"
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/editor.json src/shared/i18n/locales/ja/editor.json
git commit -m "feat: add i18n keys for external change dialog"
```

---

### Task 3: Create ExternalChangeDialog CSS

**Files:**
- Create: `src/features/editor/components/ExternalChangeDialog.css`

- [ ] **Step 1: Create the CSS file**

Create `src/features/editor/components/ExternalChangeDialog.css` with the following content. This follows the same BEM pattern and CSS variable usage as `ImagePasteDialog.css`:

```css
.external-change-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
}

.external-change-dialog {
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  width: 560px;
  max-width: 90vw;
  box-shadow: 0 8px 32px var(--shadow-strong);
}

.external-change-dialog__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}

.external-change-dialog__message {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

.external-change-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.external-change-dialog__btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}

.external-change-dialog__btn--secondary {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text);
}

.external-change-dialog__btn--primary {
  background: var(--primary);
  border: none;
  color: #fff;
}

.external-change-dialog__btn:hover:not(:disabled) {
  opacity: 0.85;
}

.external-change-dialog__diff {
  margin-top: 12px;
  margin-bottom: 12px;
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  font-family: "Consolas", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
}

.external-change-dialog__diff-line {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.external-change-dialog__diff-line--added {
  background: rgba(46, 160, 67, 0.15);
  color: var(--text);
}

.external-change-dialog__diff-line--removed {
  background: rgba(248, 81, 73, 0.15);
  color: var(--text);
}

.external-change-dialog__diff-line--header {
  color: var(--text-muted);
  font-style: italic;
  background: var(--bg-base);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/editor/components/ExternalChangeDialog.css
git commit -m "feat: add ExternalChangeDialog CSS"
```

---

### Task 4: Create ExternalChangeDialog component

**Files:**
- Create: `src/features/editor/components/ExternalChangeDialog.tsx`

- [ ] **Step 1: Create the component**

Create `src/features/editor/components/ExternalChangeDialog.tsx`:

```tsx
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { structuredPatch } from "diff";
import "./ExternalChangeDialog.css";

interface ExternalChangeDialogProps {
  filePath: string;
  currentContent: string;
  externalContent: string;
  onAcceptExternal: () => void;
  onKeepCurrent: () => void;
  onClose: () => void;
}

export function ExternalChangeDialog({
  filePath,
  currentContent,
  externalContent,
  onAcceptExternal,
  onKeepCurrent,
  onClose,
}: ExternalChangeDialogProps) {
  const { t } = useTranslation("editor");
  const [showDiff, setShowDiff] = useState(false);

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  const diffLines = showDiff
    ? computeDiffLines(currentContent, externalContent)
    : [];

  return (
    <div className="external-change-overlay" onClick={onClose}>
      <div
        className="external-change-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="external-change-dialog__title">
          {t("externalChangeTitle")}
        </h3>
        <p className="external-change-dialog__message">
          {t("externalChangeMessage", { fileName })}
        </p>

        {showDiff && (
          <div className="external-change-dialog__diff">
            {diffLines.map((line, i) => (
              <div
                key={i}
                className={`external-change-dialog__diff-line ${getDiffLineClass(line)}`}
              >
                {line}
              </div>
            ))}
          </div>
        )}

        <div className="external-change-dialog__actions">
          <button
            className="external-change-dialog__btn external-change-dialog__btn--secondary"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? t("externalChangeHideDiff") : t("externalChangeShowDiff")}
          </button>
          <button
            className="external-change-dialog__btn external-change-dialog__btn--secondary"
            onClick={onKeepCurrent}
          >
            {t("externalChangeKeep")}
          </button>
          <button
            className="external-change-dialog__btn external-change-dialog__btn--primary"
            onClick={onAcceptExternal}
          >
            {t("externalChangeAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}

function computeDiffLines(oldText: string, newText: string): string[] {
  const patch = structuredPatch("file", "file", oldText, newText, "", "", {
    context: 3,
  });
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }
  return lines;
}

function getDiffLineClass(line: string): string {
  if (line.startsWith("+")) return "external-change-dialog__diff-line--added";
  if (line.startsWith("-")) return "external-change-dialog__diff-line--removed";
  if (line.startsWith("@@")) return "external-change-dialog__diff-line--header";
  return "";
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors related to `ExternalChangeDialog`.

- [ ] **Step 3: Commit**

```bash
git add src/features/editor/components/ExternalChangeDialog.tsx
git commit -m "feat: add ExternalChangeDialog component with diff view"
```

---

### Task 5: Integrate dialog into App.tsx

**Files:**
- Modify: `src/app/App.tsx` (lines 1-89 and render section)

- [ ] **Step 1: Add import**

Add the following import to `src/app/App.tsx` after the existing component imports (around line 31, after the `ImageCanvas` import):

```typescript
import { ExternalChangeDialog } from "@/features/editor/components/ExternalChangeDialog";
```

- [ ] **Step 2: Add state for external change tracking**

In the `App` function body, add the following state declaration after the existing ref declarations (after line 73, `const editorAreaRef = ...`):

```typescript
  const [externalChange, setExternalChange] = useState<{
    tabId: string;
    filePath: string;
    currentContent: string;
    externalContent: string;
  } | null>(null);
```

- [ ] **Step 3: Replace the useFileWatcher callback**

Replace the existing `useFileWatcher` block (lines 78-89):

```typescript
  // Watch active tab file for external changes (e.g., opencode edits)
  useFileWatcher(activeTab?.filePath ?? null, useCallback(async (changedPath: string) => {
    if (!activeTab || activeTab.filePath !== changedPath) return;
    try {
      const newContent = await invoke<string>("read_text_file", { path: changedPath });
      if (newContent !== activeTab.content) {
        useTabStore.getState().updateTabContent(activeTab.id, newContent);
      }
    } catch (e) {
      console.error("Failed to reload file after external change:", e);
    }
  }, [activeTab]));
```

with:

```typescript
  // Watch active tab file for external changes (e.g., opencode edits)
  useFileWatcher(activeTab?.filePath ?? null, useCallback(async (changedPath: string) => {
    if (!activeTab || activeTab.filePath !== changedPath) return;
    try {
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
    } catch (e) {
      console.error("Failed to reload file after external change:", e);
    }
  }, [activeTab]));
```

- [ ] **Step 4: Add dialog rendering**

In the JSX return of `App`, add the `ExternalChangeDialog` rendering. Find the location where `ImagePasteDialog` or other dialogs are rendered (typically near the end of the JSX, before the closing fragment or root div). Add the following:

```tsx
        {externalChange && (
          <ExternalChangeDialog
            filePath={externalChange.filePath}
            currentContent={externalChange.currentContent}
            externalContent={externalChange.externalContent}
            onAcceptExternal={() => {
              useTabStore.getState().updateTabContent(
                externalChange.tabId,
                externalChange.externalContent,
              );
              setExternalChange(null);
            }}
            onKeepCurrent={() => setExternalChange(null)}
            onClose={() => setExternalChange(null)}
          />
        )}
```

- [ ] **Step 5: Verify it compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat: integrate ExternalChangeDialog into App with dirty-check branching"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Build and launch the app**

Run:
```bash
npm run tauri dev
```

- [ ] **Step 2: Test clean file (no dialog)**

1. Open a markdown file in MDium
2. Do NOT edit it (not dirty)
3. In an external editor, modify and save the same file
4. Verify: content updates silently in MDium, no dialog appears

- [ ] **Step 3: Test dirty file (dialog appears)**

1. Open a markdown file in MDium
2. Type some text (tab becomes dirty — dot on tab title)
3. In an external editor, modify and save the same file
4. Verify: dialog appears with title, message, and 3 buttons

- [ ] **Step 4: Test "Keep My Changes" button**

1. Trigger the dialog as above
2. Click "Keep My Changes"
3. Verify: dialog closes, editor retains your unsaved edits

- [ ] **Step 5: Test "Load External Changes" button**

1. Trigger the dialog again (edit in MDium, then modify externally)
2. Click "Load External Changes"
3. Verify: dialog closes, editor shows the externally modified content

- [ ] **Step 6: Test "Show Diff" toggle**

1. Trigger the dialog again
2. Click "Show Diff"
3. Verify: unified diff appears inline with green (added) and red (removed) line highlighting
4. Click "Hide Diff"
5. Verify: diff view collapses

- [ ] **Step 7: Test Escape key and overlay click**

1. Trigger the dialog
2. Press Escape
3. Verify: dialog closes, edits are preserved (same as "Keep My Changes")
4. Trigger again, click on the dark overlay outside the dialog
5. Verify: same behavior

- [ ] **Step 8: Test repeated external changes**

1. Keep edits in MDium (dirty)
2. Modify file externally, dismiss dialog with "Keep My Changes"
3. Modify file externally again
4. Verify: dialog appears again with the latest external content
