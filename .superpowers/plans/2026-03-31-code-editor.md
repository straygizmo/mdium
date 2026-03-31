# Code Editor (Monaco Editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the textarea+preview layout with a full-width Monaco Editor for all non-Markdown text files.

**Architecture:** Add a `CodeEditorPanel` component wrapping `@monaco-editor/react`. File type routing in `App.tsx` detects code files (anything not Markdown, Office, image, mindmap, PDF, or video) and renders `CodeEditorPanel` full-width instead of the editor+preview split. State integrates into the existing `tab-store`.

**Tech Stack:** `@monaco-editor/react`, `monaco-editor`, React, Zustand (tab-store), Tauri IPC

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Modify | Add `@monaco-editor/react` and `monaco-editor` dependencies |
| `src/shared/lib/constants.ts` | Modify | Add `isCodeFile()` helper function |
| `src/features/code-editor/components/CodeEditorPanel.tsx` | Create | Monaco Editor wrapper component |
| `src/features/code-editor/components/CodeEditorPanel.css` | Create | Styling for the code editor |
| `src/features/code-editor/lib/language-map.ts` | Create | File extension → Monaco language ID mapping |
| `src/app/App.tsx` | Modify | Route code files to `CodeEditorPanel`, hide editor+preview |

---

### Task 1: Install Monaco Editor Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

Run:
```bash
npm install @monaco-editor/react monaco-editor
```

- [ ] **Step 2: Verify installation**

Run:
```bash
npm ls @monaco-editor/react monaco-editor
```

Expected: Both packages listed without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(code-editor): install @monaco-editor/react and monaco-editor"
```

---

### Task 2: Add Language Mapping Utility

**Files:**
- Create: `src/features/code-editor/lib/language-map.ts`

- [ ] **Step 1: Create the language map file**

```typescript
// src/features/code-editor/lib/language-map.ts

const EXT_TO_LANGUAGE: Record<string, string> = {
  // VBA
  ".bas": "vb",
  ".cls": "vb",
  ".frm": "vb",
  // Web
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  // Data
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".csv": "plaintext",
  // Systems
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".dart": "dart",
  // Scripting
  ".py": "python",
  ".rb": "ruby",
  ".php": "php",
  ".lua": "lua",
  ".r": "r",
  ".pl": "perl",
  // Shell
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".bat": "bat",
  ".cmd": "bat",
  // Database
  ".sql": "sql",
  // Config
  ".ini": "ini",
  ".conf": "ini",
  ".cfg": "ini",
  ".env": "plaintext",
  ".properties": "ini",
  // Markup
  ".tex": "latex",
  ".rst": "restructuredtext",
  // Other
  ".dockerfile": "dockerfile",
  ".graphql": "graphql",
  ".gql": "graphql",
};

/**
 * Get Monaco Editor language ID from a file path.
 * Falls back to "plaintext" for unknown extensions.
 */
export function getMonacoLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();

  // Handle special filenames (no extension)
  const fileName = lower.split(/[\\/]/).pop() ?? "";
  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "makefile") return "makefile";
  if (fileName === ".gitignore" || fileName === ".dockerignore") return "plaintext";

  // Match by extension
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "plaintext";
  const ext = fileName.slice(dotIndex);
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/code-editor/lib/language-map.ts
git commit -m "feat(code-editor): add file extension to Monaco language mapping"
```

---

### Task 3: Add `isCodeFile` Helper to Constants

**Files:**
- Modify: `src/shared/lib/constants.ts`

- [ ] **Step 1: Add `isCodeFile` function at the end of `constants.ts`**

Add after the `getImageExt` function (line 26):

```typescript
/**
 * Returns true if the file should be opened in the code editor
 * (i.e., it is not Markdown, Office, PDF, image, mindmap, or video JSON).
 */
export function isCodeFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md")) return false;
  if (lower.endsWith(".video.json")) return false;
  if (getOfficeExt(lower)) return false;
  if (getPdfExt(lower)) return false;
  if (getMindmapExt(lower)) return false;
  if (getImageExt(lower)) return false;
  return true;
}
```

- [ ] **Step 2: Verify the build**

Run:
```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/lib/constants.ts
git commit -m "feat(code-editor): add isCodeFile helper to constants"
```

---

### Task 4: Create CodeEditorPanel Component

**Files:**
- Create: `src/features/code-editor/components/CodeEditorPanel.tsx`
- Create: `src/features/code-editor/components/CodeEditorPanel.css`

- [ ] **Step 1: Create the CSS file**

```css
/* src/features/code-editor/components/CodeEditorPanel.css */

.code-editor-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.code-editor-panel__editor {
  flex: 1;
  min-height: 0;
}
```

- [ ] **Step 2: Create the CodeEditorPanel component**

```tsx
// src/features/code-editor/components/CodeEditorPanel.tsx

import { useCallback, useRef } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import { getMonacoLanguage } from "../lib/language-map";
import "./CodeEditorPanel.css";

export function CodeEditorPanel() {
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const language = activeTab?.filePath
    ? getMonacoLanguage(activeTab.filePath)
    : "plaintext";

  const handleEditorDidMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.focus();
  }, []);

  const handleChange: OnChange = useCallback(
    (value) => {
      if (activeTab && value !== undefined) {
        updateTabContent(activeTab.id, value);
      }
    },
    [activeTab, updateTabContent]
  );

  if (!activeTab) return null;

  return (
    <div className="code-editor-panel">
      <div className="code-editor-panel__editor">
        <Editor
          key={activeTab.id}
          defaultValue={activeTab.content}
          language={language}
          theme={themeType === "dark" ? "vs-dark" : "vs"}
          onChange={handleChange}
          onMount={handleEditorDidMount}
          options={{
            fontSize: 14,
            minimap: { enabled: true },
            wordWrap: "on",
            automaticLayout: true,
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            renderLineHighlight: "line",
            bracketPairColorization: { enabled: true },
            tabSize: 4,
            insertSpaces: true,
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify the build**

Run:
```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/code-editor/components/CodeEditorPanel.tsx src/features/code-editor/components/CodeEditorPanel.css
git commit -m "feat(code-editor): create CodeEditorPanel with Monaco Editor"
```

---

### Task 5: Add `isCodeFile` Property to Tab Type

**Files:**
- Modify: `src/stores/tab-store.ts`

- [ ] **Step 1: Add `isCodeFile` to the `Tab` interface**

In `src/stores/tab-store.ts`, add the new property to the `Tab` interface (around line 26, after the `imageCanvasJson` property):

```typescript
  /** Whether this tab should use the code editor (non-markdown text file) */
  isCodeFile?: boolean;
```

- [ ] **Step 2: Verify the build**

Run:
```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/tab-store.ts
git commit -m "feat(code-editor): add isCodeFile property to Tab interface"
```

---

### Task 6: Integrate CodeEditorPanel into App.tsx

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Add imports**

Add at the top of `App.tsx`, after the existing imports (around line 10, near the other `import` from `@/shared/lib/constants`):

Change the existing import:
```typescript
import { getOfficeExt, getMindmapExt, getImageExt, getPdfExt } from "@/shared/lib/constants";
```
to:
```typescript
import { getOfficeExt, getMindmapExt, getImageExt, getPdfExt, isCodeFile } from "@/shared/lib/constants";
```

Add the `CodeEditorPanel` import near the other feature imports (around line 23):
```typescript
import { CodeEditorPanel } from "@/features/code-editor/components/CodeEditorPanel";
```

- [ ] **Step 2: Add code file detection in `handleFileSelect`**

In the `handleFileSelect` function, the `else` branch (around line 387-395) currently handles all non-special text files. Modify it to set an `isCodeFile` flag on the tab:

Replace:
```typescript
        } else {
          const content = await invoke<string>("read_text_file", { path: filePath });
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content,
          });
        }
```

With:
```typescript
        } else {
          const content = await invoke<string>("read_text_file", { path: filePath });
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content,
            isCodeFile: isCodeFile(filePath),
          });
        }
```

- [ ] **Step 3: Update editor visibility logic in `handleFileSelect`**

The existing visibility logic (around lines 399-405) currently shows the editor only for `.md` files. Update it to also hide editor for code files:

Replace:
```typescript
        // Hide editor panel for non-.md files
        const isMd = filePath.toLowerCase().endsWith(".md");
        const isVideoJson = filePath.toLowerCase().endsWith(".video.json");
        useUiStore.getState().setEditorVisible(isMd && !imageExt && !isVideoJson);
        if (isVideoJson) {
          useUiStore.getState().setActiveViewTab("video");
        }
```

With:
```typescript
        // Hide editor panel for non-.md files
        const isMd = filePath.toLowerCase().endsWith(".md");
        const isVideoJson = filePath.toLowerCase().endsWith(".video.json");
        const isCode = isCodeFile(filePath);
        useUiStore.getState().setEditorVisible(isMd && !imageExt && !isVideoJson && !isCode);
        if (isVideoJson) {
          useUiStore.getState().setActiveViewTab("video");
        }
```

- [ ] **Step 4: Update the editor visibility `useEffect`**

The `useEffect` that toggles editor visibility on tab switch (around lines 263-272) needs to handle code files:

Replace:
```typescript
  useEffect(() => {
    if (activeTab) {
      const isSpecialFile = activeTab.mindmapFileType || activeTab.imageFileType || activeTab.officeFileType;
      const isVideoJson = activeTab.filePath?.toLowerCase().endsWith(".video.json");
      useUiStore.getState().setEditorVisible(!isSpecialFile && !isVideoJson);
      if (isVideoJson) {
        useUiStore.getState().setActiveViewTab("video");
      }
    }
  }, [activeTab?.id]);
```

With:
```typescript
  useEffect(() => {
    if (activeTab) {
      const isSpecialFile = activeTab.mindmapFileType || activeTab.imageFileType || activeTab.officeFileType;
      const isVideoJson = activeTab.filePath?.toLowerCase().endsWith(".video.json");
      const isCode = activeTab.isCodeFile;
      useUiStore.getState().setEditorVisible(!isSpecialFile && !isVideoJson && !isCode);
      if (isVideoJson) {
        useUiStore.getState().setActiveViewTab("video");
      }
    }
  }, [activeTab?.id]);
```

- [ ] **Step 5: Add CodeEditorPanel rendering in the editor area**

In the JSX render section (around lines 968-1009), the editor area currently routes between mindmap, image, and the editor+preview split. Add a code editor route.

Replace:
```tsx
            {activeTab ? (
              activeTab.mindmapFileType && activeTab.binaryData ? (
                <MindmapEditor
                  ref={mindmapEditorRef}
                  fileData={activeTab.binaryData}
                  fileType={activeTab.mindmapFileType}
                  filePath={activeTab.filePath}
                  theme={themeType}
                  onSave={handleMindmapSave}
                  onDirtyChange={handleMindmapDirtyChange}
                />
              ) : activeTab.imageFileType && activeTab.imageBlobUrl ? (
                <div className="app__image-area">
                  <ImageCanvas
                    ref={imageCanvasRef}
                    imageSrc={activeTab.imageBlobUrl}
                    canvasJson={activeTab.imageCanvasJson}
                    onCanvasModified={handleImageCanvasModified}
                  />
                </div>
              ) : (
                <>
                  {editorVisible && (
                    <div className="app__editor-pane" style={{ flex: `0 0 ${editorRatio}%` }}>
                      <EditorPanel editorRef={editorRef} />
                    </div>
                  )}
                  {editorVisible && (
                    <div
                      className="app__divider"
                      onMouseDown={handleEditorDividerMouseDown}
                    />
                  )}
                  <div className="app__preview-pane" style={editorVisible ? { flex: 1 } : undefined}>
                    <PreviewPanel
                      previewRef={previewRef}
                      onOpenFile={handleFileSelect}
                      onRefreshFileTree={loadFileTree}
                    />
                  </div>
                </>
              )
```

With:
```tsx
            {activeTab ? (
              activeTab.mindmapFileType && activeTab.binaryData ? (
                <MindmapEditor
                  ref={mindmapEditorRef}
                  fileData={activeTab.binaryData}
                  fileType={activeTab.mindmapFileType}
                  filePath={activeTab.filePath}
                  theme={themeType}
                  onSave={handleMindmapSave}
                  onDirtyChange={handleMindmapDirtyChange}
                />
              ) : activeTab.imageFileType && activeTab.imageBlobUrl ? (
                <div className="app__image-area">
                  <ImageCanvas
                    ref={imageCanvasRef}
                    imageSrc={activeTab.imageBlobUrl}
                    canvasJson={activeTab.imageCanvasJson}
                    onCanvasModified={handleImageCanvasModified}
                  />
                </div>
              ) : activeTab.isCodeFile ? (
                <CodeEditorPanel />
              ) : (
                <>
                  {editorVisible && (
                    <div className="app__editor-pane" style={{ flex: `0 0 ${editorRatio}%` }}>
                      <EditorPanel editorRef={editorRef} />
                    </div>
                  )}
                  {editorVisible && (
                    <div
                      className="app__divider"
                      onMouseDown={handleEditorDividerMouseDown}
                    />
                  )}
                  <div className="app__preview-pane" style={editorVisible ? { flex: 1 } : undefined}>
                    <PreviewPanel
                      previewRef={previewRef}
                      onOpenFile={handleFileSelect}
                      onRefreshFileTree={loadFileTree}
                    />
                  </div>
                </>
              )
```

- [ ] **Step 6: Verify the build**

Run:
```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(code-editor): integrate CodeEditorPanel into App layout routing"
```

---

### Task 7: Handle Keyboard Shortcuts for Code Files

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Prevent Ctrl+F/Ctrl+H from opening the app's SearchReplace when code editor is active**

In the keyboard shortcut handler `useEffect` (around lines 829-907), update the Ctrl+F and Ctrl+H handlers to skip when a code file is active (Monaco has its own find/replace):

Replace the Ctrl+F handler:
```typescript
      } else if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        if (!showSearch) {
          useUiStore.getState().setSearchMode("search");
          setShowSearch(true);
        } else {
          setShowSearch(false);
        }
      } else if (e.ctrlKey && e.key === "h") {
        e.preventDefault();
        if (!showSearch) {
          useUiStore.getState().setSearchMode("replace");
          setShowSearch(true);
        } else {
          const currentMode = useUiStore.getState().searchMode;
          if (currentMode === "search") {
            useUiStore.getState().setSearchMode("replace");
          } else {
            setShowSearch(false);
          }
        }
```

With:
```typescript
      } else if (e.ctrlKey && e.key === "f") {
        // Let Monaco handle its own find when code editor is active
        if (activeTab?.isCodeFile) return;
        e.preventDefault();
        if (!showSearch) {
          useUiStore.getState().setSearchMode("search");
          setShowSearch(true);
        } else {
          setShowSearch(false);
        }
      } else if (e.ctrlKey && e.key === "h") {
        // Let Monaco handle its own replace when code editor is active
        if (activeTab?.isCodeFile) return;
        e.preventDefault();
        if (!showSearch) {
          useUiStore.getState().setSearchMode("replace");
          setShowSearch(true);
        } else {
          const currentMode = useUiStore.getState().searchMode;
          if (currentMode === "search") {
            useUiStore.getState().setSearchMode("replace");
          } else {
            setShowSearch(false);
          }
        }
```

- [ ] **Step 2: Prevent Ctrl+Z/Ctrl+Y from triggering app-level undo/redo for code files**

Monaco has its own undo/redo. Update the Ctrl+Z and Ctrl+Y handlers at the top of the keydown handler:

Replace:
```typescript
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
      } else if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        handleRedo();
```

With:
```typescript
      if (e.ctrlKey && e.key === "z") {
        // Let Monaco handle its own undo when code editor is active
        if (activeTab?.isCodeFile) return;
        e.preventDefault();
        handleUndo();
      } else if (e.ctrlKey && e.key === "y") {
        // Let Monaco handle its own redo when code editor is active
        if (activeTab?.isCodeFile) return;
        e.preventDefault();
        handleRedo();
```

- [ ] **Step 3: Verify the build**

Run:
```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(code-editor): delegate keyboard shortcuts to Monaco for code files"
```

---

### Task 8: Handle Save for Code Files

**Files:**
- Modify: `src/app/App.tsx`

The existing `handleSave` function (around line 476-518) already handles text files via `invoke("write_text_file", { path, content })`. Since `CodeEditorPanel` updates `tab.content` via `updateTabContent` on every change, the existing save logic already works for code files. No changes needed for basic save.

However, ensure the `handleSaveAs` function also handles code files. Check the current logic:

- [ ] **Step 1: Update `handleSaveAs` to offer appropriate file filters for code files**

Replace the `handleSaveAs` callback (around lines 444-473):

```typescript
  const handleSaveAs = useCallback(async () => {
    if (!activeTab) return;
    try {
      const isMindmap = !!activeTab.mindmapFileType;
      const isCode = !!activeTab.isCodeFile;
      const ext = activeTab.filePath
        ? (activeTab.filePath.split(".").pop() ?? "txt")
        : "txt";
      const selected = await save({
        filters: isMindmap
          ? [{ name: "Mindmap", extensions: ["km"] }]
          : isCode
            ? [{ name: "Code", extensions: [ext] }, { name: "All", extensions: ["*"] }]
            : [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!selected) return;

      let text: string;
      if (isMindmap) {
        const json = mindmapEditorRef.current?.getJson();
        if (!json) return;
        text = JSON.stringify(json, null, 2);
      } else {
        text = activeTab.content;
      }

      await invoke("write_text_file", { path: selected, content: text });
      const fileName = selected.split(/[\\/]/).pop() ?? "untitled";
      updateTabFilePath(activeTab.id, selected, fileName);
      setActiveFile(selected);
      addRecentFile(selected);
      loadFileTree();
    } catch (e) {
      console.error("Failed to save as:", e);
    }
  }, [activeTab, updateTabFilePath, setActiveFile, addRecentFile, loadFileTree]);
```

- [ ] **Step 2: Verify the build**

Run:
```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(code-editor): update SaveAs dialog filters for code files"
```

---

### Task 9: Smoke Test and Final Verification

- [ ] **Step 1: Run the full build**

Run:
```bash
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Run the dev server**

Run:
```bash
npm run tauri dev
```

- [ ] **Step 3: Manual smoke test**

1. Open a folder containing `.bas`, `.cls`, `.py`, `.json`, `.ts` files
2. Click a `.bas` file → verify Monaco Editor appears full-width (no preview pane)
3. Click a `.md` file → verify original textarea+preview layout
4. Click a `.json` file → verify Monaco with JSON syntax highlighting
5. Edit a code file → verify dirty indicator appears on tab
6. Press Ctrl+S → verify file saves
7. Press Ctrl+F in code editor → verify Monaco's find widget (not app's SearchReplace)
8. Press Ctrl+Z/Ctrl+Y → verify Monaco's undo/redo works
9. Switch between dark/light theme → verify Monaco theme changes

- [ ] **Step 4: Commit any final fixes and tag as complete**

```bash
git add -A
git commit -m "feat(code-editor): Monaco Editor for non-markdown text files"
```
