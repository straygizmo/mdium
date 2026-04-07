# Batch Convert Tree View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat file list in BatchConvertModal with a recursive tree view that supports per-folder checkbox toggling.

**Architecture:** Add `buildConvertibleTree` and `pruneTreeByFilter` utilities to produce a pruned tree from `FileEntry[]`. Create `BatchConvertTree` + `BatchConvertTreeNode` components for recursive rendering with checkboxes. Modify `BatchConvertModal` to pass the tree (instead of flat array) and wire up folder-level selection logic.

**Tech Stack:** React, TypeScript, CSS (BEM), i18next

---

### Task 1: Add tree data utilities to collectConvertibleFiles.ts

**Files:**
- Modify: `src/features/export/lib/collectConvertibleFiles.ts`

- [ ] **Step 1: Add `ConvertibleTreeNode` interface and `buildConvertibleTree` function**

Append to the end of `src/features/export/lib/collectConvertibleFiles.ts`:

```typescript
export interface ConvertibleTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ConvertibleTreeNode[] | null;
  fileType?: "docx" | "pdf" | "xlsx";
  hasExistingMd?: boolean;
}

/**
 * Build a tree of convertible files, preserving folder hierarchy.
 * Folders that contain no convertible files (recursively) are pruned.
 */
export function buildConvertibleTree(tree: FileEntry[]): ConvertibleTreeNode[] {
  const result: ConvertibleTreeNode[] = [];
  const siblingNames = new Set(
    tree.filter((e) => !e.is_dir).map((e) => e.name.toLowerCase())
  );

  for (const entry of tree) {
    if (entry.is_dir) {
      const children = entry.children
        ? buildConvertibleTree(entry.children)
        : [];
      if (children.length > 0) {
        result.push({
          name: entry.name,
          path: entry.path,
          isDir: true,
          children,
        });
      }
      continue;
    }

    const lower = entry.name.toLowerCase();
    let fileType: "docx" | "pdf" | "xlsx" | null = null;
    if (lower.endsWith(".docx")) fileType = "docx";
    else if (lower.endsWith(".pdf")) fileType = "pdf";
    else if (
      lower.endsWith(".xlsx") ||
      lower.endsWith(".xlsm") ||
      lower.endsWith(".xls")
    )
      fileType = "xlsx";

    if (!fileType) continue;

    const baseName = entry.name.replace(/\.\w+$/i, "");
    const hasExistingMd = siblingNames.has(`${baseName}.md`.toLowerCase());

    result.push({
      name: entry.name,
      path: entry.path,
      isDir: false,
      children: null,
      fileType,
      hasExistingMd,
    });
  }

  return result;
}
```

- [ ] **Step 2: Add `pruneTreeByFilter` function**

Append after `buildConvertibleTree`:

```typescript
/**
 * Prune the convertible tree to only include files matching the given filter.
 * Folders with no matching descendants are removed.
 */
export function pruneTreeByFilter(
  tree: ConvertibleTreeNode[],
  filter: "all" | "docx" | "pdf" | "xlsx"
): ConvertibleTreeNode[] {
  if (filter === "all") return tree;
  const result: ConvertibleTreeNode[] = [];
  for (const node of tree) {
    if (node.isDir) {
      const children = pruneTreeByFilter(node.children ?? [], filter);
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else if (node.fileType === filter) {
      result.push(node);
    }
  }
  return result;
}
```

- [ ] **Step 3: Add `collectFilePaths` helper**

Append after `pruneTreeByFilter`:

```typescript
/**
 * Recursively collect all file paths from a ConvertibleTreeNode tree.
 */
export function collectFilePaths(tree: ConvertibleTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of tree) {
    if (node.isDir) {
      paths.push(...collectFilePaths(node.children ?? []));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

/**
 * Recursively collect all file paths from a single node's descendants.
 */
export function collectDescendantPaths(node: ConvertibleTreeNode): string[] {
  if (!node.isDir) return [node.path];
  const paths: string[] = [];
  for (const child of node.children ?? []) {
    paths.push(...collectDescendantPaths(child));
  }
  return paths;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/export/lib/collectConvertibleFiles.ts
git commit -m "feat(batch-convert): add tree builder, filter pruner, and path collection utilities"
```

---

### Task 2: Create BatchConvertTreeNode component

**Files:**
- Create: `src/features/export/components/BatchConvertTreeNode.tsx`

- [ ] **Step 1: Create the recursive tree node component**

Create `src/features/export/components/BatchConvertTreeNode.tsx`:

```tsx
import { useCallback, useEffect, useRef } from "react";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import { collectDescendantPaths } from "../lib/collectConvertibleFiles";
import { getFileIcon } from "@/features/file-tree/components/FileTree";

type CheckState = "checked" | "unchecked" | "indeterminate";

interface BatchConvertTreeNodeProps {
  node: ConvertibleTreeNode;
  depth: number;
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleFolder: (paths: string[], select: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapse: (path: string) => void;
  skipExisting: boolean;
}

function getCheckState(
  node: ConvertibleTreeNode,
  selected: Set<string>,
  skipExisting: boolean
): CheckState {
  if (!node.isDir) {
    if (skipExisting && node.hasExistingMd) return "unchecked";
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const paths = collectDescendantPaths(node);
  const selectablePaths = skipExisting
    ? paths.filter((p) => {
        // find matching node to check hasExistingMd — use a simple approach:
        // we only need to check if the path is in selected
        return true; // all paths are potentially selectable at this level
      })
    : paths;
  if (selectablePaths.length === 0) return "unchecked";
  const selectedCount = selectablePaths.filter((p) => selected.has(p)).length;
  if (selectedCount === 0) return "unchecked";
  if (selectedCount === selectablePaths.length) return "checked";
  return "indeterminate";
}

export function BatchConvertTreeNode({
  node,
  depth,
  selected,
  onToggleFile,
  onToggleFolder,
  collapsed,
  onToggleCollapse,
  skipExisting,
}: BatchConvertTreeNodeProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const isCollapsed = collapsed.has(node.path);

  const checkState = node.isDir
    ? getCheckState(node, selected, skipExisting)
    : selected.has(node.path)
      ? "checked"
      : "unchecked";

  const isDisabled = !node.isDir && skipExisting && !!node.hasExistingMd;

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = checkState === "indeterminate";
    }
  }, [checkState]);

  const handleCheckboxChange = useCallback(() => {
    if (node.isDir) {
      const paths = collectDescendantPaths(node);
      // If currently all checked, deselect; otherwise select all
      const shouldSelect = checkState !== "checked";
      onToggleFolder(paths, shouldSelect);
    } else {
      onToggleFile(node.path);
    }
  }, [node, checkState, onToggleFile, onToggleFolder]);

  const handleNameClick = useCallback(() => {
    if (node.isDir) {
      onToggleCollapse(node.path);
    }
  }, [node, onToggleCollapse]);

  const icon = node.isDir
    ? isCollapsed
      ? "+"
      : "−"
    : getFileIcon(node.name);

  return (
    <>
      <div
        className="batch-convert__tree-node"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={checkState === "checked"}
          onChange={handleCheckboxChange}
          disabled={isDisabled}
          className="batch-convert__tree-checkbox"
        />
        <span
          className={`batch-convert__tree-icon ${node.isDir ? "batch-convert__tree-icon--dir" : ""}`}
          onClick={node.isDir ? handleNameClick : undefined}
        >
          {icon}
        </span>
        <span
          className={`batch-convert__tree-name ${node.isDir ? "batch-convert__tree-name--dir" : ""}`}
          title={node.path}
          onClick={node.isDir ? handleNameClick : undefined}
        >
          {node.name}
        </span>
        {!node.isDir && node.hasExistingMd && (
          <span className="batch-convert__item-badge">.md exists</span>
        )}
      </div>
      {node.isDir && !isCollapsed && node.children && (
        <div className="batch-convert__tree-children">
          {node.children.map((child) => (
            <BatchConvertTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onToggleFile={onToggleFile}
              onToggleFolder={onToggleFolder}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              skipExisting={skipExisting}
            />
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/export/components/BatchConvertTreeNode.tsx
git commit -m "feat(batch-convert): create BatchConvertTreeNode recursive component"
```

---

### Task 3: Create BatchConvertTree container component

**Files:**
- Create: `src/features/export/components/BatchConvertTree.tsx`

- [ ] **Step 1: Create the tree container component**

Create `src/features/export/components/BatchConvertTree.tsx`:

```tsx
import { useState, useCallback } from "react";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import { BatchConvertTreeNode } from "./BatchConvertTreeNode";

interface BatchConvertTreeProps {
  tree: ConvertibleTreeNode[];
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleFolder: (paths: string[], select: boolean) => void;
  skipExisting: boolean;
}

export function BatchConvertTree({
  tree,
  selected,
  onToggleFile,
  onToggleFolder,
  skipExisting,
}: BatchConvertTreeProps) {
  // Collapsed stores paths of collapsed folders (default: all expanded)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <div className="batch-convert__tree">
      {tree.map((node) => (
        <BatchConvertTreeNode
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          onToggleFile={onToggleFile}
          onToggleFolder={onToggleFolder}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
          skipExisting={skipExisting}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/export/components/BatchConvertTree.tsx
git commit -m "feat(batch-convert): create BatchConvertTree container component"
```

---

### Task 4: Update BatchConvertModal to use tree

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.tsx`
- Modify: `src/features/file-tree/components/LeftPanel.tsx`

- [ ] **Step 1: Update BatchConvertModal props and imports**

In `src/features/export/components/BatchConvertModal.tsx`, replace the imports and interface:

Replace:
```typescript
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
```

With:
```typescript
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import {
  pruneTreeByFilter,
  collectFilePaths,
} from "../lib/collectConvertibleFiles";
import { BatchConvertTree } from "./BatchConvertTree";
```

Replace:
```typescript
interface BatchConvertModalProps {
  files: ConvertibleFile[];
  onClose: () => void;
  onComplete: () => void;
}
```

With:
```typescript
interface BatchConvertModalProps {
  files: ConvertibleFile[];
  tree: ConvertibleTreeNode[];
  onClose: () => void;
  onComplete: () => void;
}
```

- [ ] **Step 2: Update the component function signature and add tree-related state**

Replace:
```typescript
export function BatchConvertModal({ files, onClose, onComplete }: BatchConvertModalProps) {
```

With:
```typescript
export function BatchConvertModal({ files, tree, onClose, onComplete }: BatchConvertModalProps) {
```

- [ ] **Step 3: Add filteredTree memo and folder toggle handlers**

After the existing `filteredFiles` memo (line 35), add:

```typescript
  const filteredTree = useMemo(
    () => pruneTreeByFilter(tree, filter),
    [tree, filter]
  );

  const handleToggleFolder = useCallback(
    (paths: string[], select: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of paths) {
          // When skipExisting is on, find if this file has existing md
          if (skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file?.hasExistingMd) continue;
          }
          if (select) {
            next.add(p);
          } else {
            next.delete(p);
          }
        }
        return next;
      });
    },
    [skipExisting, files]
  );
```

- [ ] **Step 4: Replace flat list with tree component in selection view**

In the selection view JSX section, replace the file list block (lines 206-226):

Replace:
```tsx
        {filteredFiles.length === 0 ? (
          <div className="batch-convert__empty">{t("batchConvertNoFiles")}</div>
        ) : (
          <ul className="batch-convert__list">
            {filteredFiles.map((file) => (
              <li key={file.path} className="batch-convert__item">
                <input
                  type="checkbox"
                  checked={selected.has(file.path)}
                  onChange={() => handleToggle(file.path)}
                  disabled={skipExisting && file.hasExistingMd}
                />
                <span className="batch-convert__item-name" title={file.path}>
                  {file.name}
                </span>
                {file.hasExistingMd && (
                  <span className="batch-convert__item-badge">.md exists</span>
                )}
              </li>
            ))}
          </ul>
        )}
```

With:
```tsx
        {filteredTree.length === 0 ? (
          <div className="batch-convert__empty">{t("batchConvertNoFiles")}</div>
        ) : (
          <div className="batch-convert__list">
            <BatchConvertTree
              tree={filteredTree}
              selected={selected}
              onToggleFile={handleToggle}
              onToggleFolder={handleToggleFolder}
              skipExisting={skipExisting}
            />
          </div>
        )}
```

- [ ] **Step 5: Update select all / deselect all to work with filtered tree**

Replace `handleSelectAll`:
```typescript
  const handleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = collectFilePaths(filteredTree);
      for (const p of paths) {
        if (skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file?.hasExistingMd) continue;
        }
        next.add(p);
      }
      return next;
    });
  }, [filteredTree, skipExisting, files]);
```

Replace `handleDeselectAll`:
```typescript
  const handleDeselectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = collectFilePaths(filteredTree);
      for (const p of paths) {
        next.delete(p);
      }
      return next;
    });
  }, [filteredTree]);
```

- [ ] **Step 6: Update LeftPanel to pass tree prop**

In `src/features/file-tree/components/LeftPanel.tsx`, add the import:

Replace:
```typescript
import { collectConvertibleFiles } from "@/features/export/lib/collectConvertibleFiles";
```

With:
```typescript
import { collectConvertibleFiles, buildConvertibleTree } from "@/features/export/lib/collectConvertibleFiles";
```

After the existing `convertibleFiles` memo (line 69), add:

```typescript
  const convertibleTree = useMemo(() => buildConvertibleTree(fileTree), [fileTree]);
```

Update the `BatchConvertModal` usage (line 345-349):

Replace:
```tsx
        <BatchConvertModal
          files={convertibleFiles}
          onClose={() => setShowBatchConvert(false)}
          onComplete={onRefresh}
        />
```

With:
```tsx
        <BatchConvertModal
          files={convertibleFiles}
          tree={convertibleTree}
          onClose={() => setShowBatchConvert(false)}
          onComplete={onRefresh}
        />
```

- [ ] **Step 7: Commit**

```bash
git add src/features/export/components/BatchConvertModal.tsx src/features/file-tree/components/LeftPanel.tsx
git commit -m "feat(batch-convert): replace flat list with tree view in BatchConvertModal"
```

---

### Task 5: Add tree view CSS styles

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.css`

- [ ] **Step 1: Add tree node styles**

Append to the end of `src/features/export/components/BatchConvertModal.css`:

```css
/* Tree view */
.batch-convert__tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.batch-convert__tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.batch-convert__tree-node:hover {
  background: var(--bg-overlay);
}

.batch-convert__tree-checkbox {
  flex-shrink: 0;
  margin: 0;
  cursor: pointer;
}

.batch-convert__tree-checkbox:disabled {
  cursor: default;
  opacity: 0.4;
}

.batch-convert__tree-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 12px;
  user-select: none;
}

.batch-convert__tree-icon--dir {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-muted);
}

.batch-convert__tree-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.batch-convert__tree-name--dir {
  cursor: pointer;
  font-weight: 500;
}
```

- [ ] **Step 2: Update the `.batch-convert__list` to work as tree container**

Replace the existing `.batch-convert__list` rule:

```css
.batch-convert__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}
```

With:

```css
.batch-convert__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/export/components/BatchConvertModal.css
git commit -m "feat(batch-convert): add tree view styles"
```

---

### Task 6: Fix getCheckState to properly handle skipExisting for folders

**Files:**
- Modify: `src/features/export/components/BatchConvertTreeNode.tsx`

- [ ] **Step 1: Refine getCheckState to collect hasExistingMd info recursively**

The initial `getCheckState` in Task 2 has a simplification for `skipExisting` folder logic. Replace the `getCheckState` function:

```typescript
function collectDescendantFiles(
  node: ConvertibleTreeNode
): ConvertibleTreeNode[] {
  if (!node.isDir) return [node];
  const files: ConvertibleTreeNode[] = [];
  for (const child of node.children ?? []) {
    files.push(...collectDescendantFiles(child));
  }
  return files;
}

function getCheckState(
  node: ConvertibleTreeNode,
  selected: Set<string>,
  skipExisting: boolean
): CheckState {
  if (!node.isDir) {
    if (skipExisting && node.hasExistingMd) return "unchecked";
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const files = collectDescendantFiles(node);
  const selectable = skipExisting
    ? files.filter((f) => !f.hasExistingMd)
    : files;
  if (selectable.length === 0) return "unchecked";
  const selectedCount = selectable.filter((f) => selected.has(f.path)).length;
  if (selectedCount === 0) return "unchecked";
  if (selectedCount === selectable.length) return "checked";
  return "indeterminate";
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/export/components/BatchConvertTreeNode.tsx
git commit -m "fix(batch-convert): accurate folder check state with skipExisting support"
```

---

### Task 7: Verify and test

- [ ] **Step 1: Run the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Manual verification checklist**

Open a folder with nested subfolders containing docx/pdf/xlsx files. Click the batch convert button and verify:

1. Files are displayed in a tree matching the folder structure
2. Clicking a folder checkbox selects/deselects all descendant files
3. Partially selected folders show indeterminate (`-`) checkbox
4. Filter tabs (docx/pdf/xlsx) prune folders with no matching files
5. "Select All" / "Deselect All" work on the filtered tree
6. "Skip existing .md files" disables checkboxes for files with existing .md
7. Folder expand/collapse works (click folder name or icon)
8. Converting proceeds correctly with selected files
9. Result summary still displays correctly after conversion

- [ ] **Step 3: Commit any fixes found during testing**

```bash
git add -u
git commit -m "fix(batch-convert): address issues found during manual testing"
```
