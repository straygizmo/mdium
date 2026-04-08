# Git Graph Feature Design

## Overview

VS Code style Git Graph panel that displays commit history with branch/merge graph lines, integrated into the existing Git panel as a bottom section with a resizable splitter.

## Requirements

- Commit history list with author, date, message, and branch/merge graph lines
- SVG-based graph line rendering with color-coded branches
- "Outgoing Changes" section to clearly show unpushed commits
- Click to expand commit and view changed files; click file to open diff tab
- Initial load of 100 commits with "Load more" button
- Resizable splitter between Changes (top) and Graph (bottom)

## Layout

The existing Git panel is split vertically into two sections:

```
+---------------------------+
| SOURCE CONTROL  (header)  |
+---------------------------+
| Branch selector           |
| Remote URL                |
| Commit message + AI btn   |
| [Commit] [Push (n)]      |
| Staged Changes            |
|   file1.ts  M             |
| Changes                   |
|   file2.rs  M             |
+======= splitter =========+  <- drag to resize
| GRAPH  (header)           |
+---------------------------+
| > Outgoing Changes        |
|  * feat: add graph... main|
| -------------------------  |
|  * docs: screenshot o/main|
|  * docs: v0.2.1 notes     |
|  * feat(file-tree): ...   |
|    +- file1.ts             |  <- expanded on click
|    +- file2.rs             |
|  * fix(opencode): ...      |
|  [Load more]               |
+---------------------------+
```

- Top: existing GitPanel (Changes section)
- Bottom: new GitGraphPanel
- Splitter: 4px drag handle, ratio persisted in `useUiStore`

## Backend (Rust/Tauri)

Two new Tauri commands:

### `git_log_graph`

```rust
#[tauri::command]
pub fn git_log_graph(path: String, count: u32, skip: u32) -> Result<String, String>
```

Runs:
```
git log --format="<hash>%H<author>%an<date>%aI<message>%s<parents>%P<refs>%D"
        --topo-order -n {count} --skip={skip}
```

Returns raw text. Parsing is done in the frontend.

- `--topo-order` for topological ordering suitable for graph rendering
- `%P` for parent hashes (needed for graph lane calculation)
- `%D` for ref names (`HEAD -> main`, `origin/main`, etc.)

### `git_diff_commit`

```rust
#[tauri::command]
pub fn git_diff_commit(path: String, hash: String) -> Result<String, String>
```

Runs:
```
git diff-tree --no-commit-id --name-status -r {hash}
```

Returns file name + status (M/A/D) list for a commit's changed files.

## Data Model (TypeScript)

### Types

```typescript
interface GraphCommit {
  hash: string;           // full hash
  shortHash: string;      // first 7 characters
  author: string;
  date: string;           // ISO 8601
  message: string;        // one-line summary
  parents: string[];      // parent hashes (2 for merge commits)
  refs: string[];         // "HEAD -> main", "origin/main", etc.
  // Graph rendering (computed)
  lane: number;           // column position (0-based)
  lines: GraphLine[];     // lines to draw from this row
}

interface GraphLine {
  fromLane: number;       // line start column
  toLane: number;         // line end column (in next row)
  type: "straight" | "merge-in" | "branch-out";
  colorIndex: number;     // branch color index
}
```

### Graph Lane Algorithm

Located in `src/features/git/lib/graph-lanes.ts`.

1. Process commits in topological order (top to bottom)
2. Maintain an "active lanes" array (which commit hash flows through each column)
3. For each commit:
   - If its hash is in an active lane, that column becomes its `lane`
   - Otherwise, add a new column
   - Register parent hashes into active lanes (merge = 2 lines)
   - Release and compact lanes that are no longer needed
4. Assign `colorIndex` per branch, cycling through a 6-color palette

## SVG Graph Rendering

### Row Layout

Each commit row has a fixed height of 24px. Left side is SVG, right side is text.

```
| SVG (dynamic width) | Text info                                    |
|  *---               | feat: add graph...   main  straygizmo  2h   |
|  |  *               | docs: screenshot     origin/main             |
|  | -+               | docs: v0.2.1 notes                          |
```

### Drawing Rules

- **Commit node**: `<circle>` r=4, filled with lane's `colorIndex` color
- **Straight line**: `<line>` vertical from same lane in row above to row below
- **Merge line (merge-in)**: `<path>` bezier curve from another lane into commit node
- **Branch line (branch-out)**: `<path>` bezier curve from commit node to another lane

SVG width = active lane count x 16px (lane spacing), dynamically calculated.

### Branch Color Palette

```css
--graph-color-0: #f97583;  /* red */
--graph-color-1: #79b8ff;  /* blue */
--graph-color-2: #85e89d;  /* green */
--graph-color-3: #ffab70;  /* orange */
--graph-color-4: #b392f0;  /* purple */
--graph-color-5: #f692ce;  /* pink */
```

Defined as CSS variables integrated with the existing theme system.

### Commit Row Text

```
[short hash] [message ...] [ref badges] [author] [relative date]
```

- **ref badges**: `main` uses `var(--primary)` background, `origin/main` uses `var(--git-added)` background, tags use `var(--git-renamed)` background
- **relative date**: e.g., "2 hours ago" (computed in frontend)

## Component Structure

### Component Tree

```
GitPanel.tsx (modified)
|-- GitBranchSelect
|-- Remote URL
|-- Commit area (message, buttons)
|-- GitFileList (staged)
|-- GitFileList (unstaged)
|
Splitter (4px drag handle)
|
GitGraphPanel.tsx (new)
|-- GitGraphHeader ("GRAPH" title + refresh button)
|-- GitGraphOutgoing (Outgoing Changes section)
|   |-- Collapsible header "> Outgoing Changes"
|   +-- GitGraphRow x commitsAhead items
|-- Separator line
|-- GitGraphRow x N items (pushed commits)
|   |-- SVG (graph lines + node)
|   +-- Text info (hash, message, refs, author, date)
|   +-- [expanded] GitGraphCommitFiles
|       +-- File rows x M (click to open diff tab)
+-- "Load more" button
```

### Interactions

| Action | Behavior |
|---|---|
| Click commit row | Expand/collapse changed files list (calls `git_diff_commit`) |
| Click file row | Open diff tab via existing `openDiffTab` |
| Click Outgoing Changes header | Toggle section expand/collapse |
| Click "Load more" | Increment `skip`, fetch more commits, append to list |
| Drag splitter | Resize top/bottom ratio, persist in `useUiStore` |
| After commit/push | Graph auto-refreshes (triggered by `refresh`) |

## State Management

### `useGitStore` additions

```typescript
// Additional state
graphCommits: GraphCommit[];
graphLoading: boolean;
graphOutgoing: GraphCommit[];

// Additional methods
refreshGraph: (folderPath: string) => Promise<void>;
loadMoreGraph: (folderPath: string) => Promise<void>;
```

`refreshGraph` is called at the end of `refresh`, auto-updating the Graph panel.

### `useUiStore` additions

```typescript
gitGraphRatio: number;        // 0-1, default 0.5
setGitGraphRatio: (ratio: number) => void;
```

Min ratio: 0.15 for both top and bottom to prevent collapse.

## File Structure

### New Files

```
src/features/git/
|-- components/
|   |-- GitGraphPanel.tsx       # Graph main panel
|   |-- GitGraphPanel.css       # Graph styles
|   |-- GitGraphHeader.tsx      # "GRAPH" header + refresh button
|   |-- GitGraphRow.tsx         # Single commit row (SVG + text)
|   +-- GitGraphCommitFiles.tsx # Expanded changed files list
|-- lib/
|   |-- graph-lanes.ts          # Graph lane calculation algorithm
|   +-- parse-log.ts            # git log output parser
```

### Modified Files

| File | Changes |
|---|---|
| `src-tauri/src/commands/git.rs` | Add `git_log_graph`, `git_diff_commit` commands |
| `src-tauri/src/lib.rs` | Register new commands |
| `src/stores/git-store.ts` | Add `graphCommits`, `graphOutgoing`, `refreshGraph`, `loadMoreGraph` |
| `src/stores/ui-store.ts` | Add `gitGraphRatio`, `setGitGraphRatio` |
| `src/features/git/components/GitPanel.tsx` | Wrap in splitter layout with top/bottom sections |
| `src/features/git/components/GitPanel.css` | Add splitter styles, graph color palette CSS |
| `src/shared/i18n/locales/en/git.json` | Add Graph-related translation keys |
| `src/shared/i18n/locales/ja/git.json` | Add Graph-related translation keys |
