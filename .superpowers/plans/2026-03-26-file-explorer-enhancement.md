# File Explorer Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance MDium's file explorer with full file display, cut/copy/paste, drag-and-drop reordering, OS drag-drop import, and open-in-default-app.

**Architecture:** Frontend-centric approach using React + Zustand for D&D and clipboard state, HTML5 Drag and Drop API for tree-internal D&D, Tauri `onDragDropEvent` for OS→tree drops. Backend adds `copy_file`, `move_file`, `open_in_default_app` Tauri commands and modifies `get_file_tree` to support an unfiltered "show all" mode.

**Tech Stack:** Tauri 2.x (Rust backend), React 19, Zustand, TypeScript, HTML5 Drag and Drop API, Vite

---

## File Structure

### Files to modify

| File | Responsibility |
|------|---------------|
| `src-tauri/src/commands/file.rs` | Add `copy_file`, `move_file`, `open_in_default_app`; modify `get_file_tree` for show-all mode |
| `src-tauri/src/lib.rs` | Register new Tauri commands |
| `src/stores/file-store.ts` | Add `clipboardEntry`, `dragState` state and actions |
| `src/shared/hooks/useFileFilters.ts` | Add `showAll` mode, change to multi-select filter logic |
| `src/features/file-tree/components/LeftPanel.tsx` | Update filter bar UI with "All" button |
| `src/features/file-tree/components/FileTree.tsx` | Context menu, keyboard shortcuts, tree D&D |
| `src/features/file-tree/components/FileTree.css` | D&D visual feedback styles |
| `src/app/App.tsx` | OS→tree D&D drop target detection |
| `src/shared/i18n/locales/en/file-tree.json` | English translations |
| `src/shared/i18n/locales/ja/file-tree.json` | Japanese translations |

---

### Task 1: Add backend commands (Rust)

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `copy_file` command to `file.rs`**

Append after the `create_folder` function (after line 347):

```rust
/// ファイルまたはフォルダをコピーする（フォルダは再帰的にコピー）
#[tauri::command]
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
    let s = Path::new(&src);
    let d = Path::new(&dest);
    if !s.exists() {
        return Err("Source path does not exist".to_string());
    }
    if d.exists() {
        return Err("Destination path already exists".to_string());
    }
    if s.is_dir() {
        copy_dir_recursive(s, d)
    } else {
        fs::copy(s, d)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy file: {}", e))
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;
    let entries = fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }
    Ok(())
}
```

- [ ] **Step 2: Add `move_file` command to `file.rs`**

Append after `copy_file`:

```rust
/// ファイルまたはフォルダを移動する
#[tauri::command]
pub fn move_file(src: String, dest: String) -> Result<(), String> {
    let s = Path::new(&src);
    let d = Path::new(&dest);
    if !s.exists() {
        return Err("Source path does not exist".to_string());
    }
    if d.exists() {
        return Err("Destination path already exists".to_string());
    }
    fs::rename(s, d).map_err(|e| format!("Failed to move: {}", e))
}
```

- [ ] **Step 3: Add `open_in_default_app` command to `file.rs`**

Append after `move_file`:

```rust
/// ファイルをOS関連付けアプリで開く
#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}
```

- [ ] **Step 4: Modify `get_file_tree` for show-all mode**

Add a new parameter `show_all` to `get_file_tree`. When `show_all` is true, skip filtering and show all files (except hidden/node_modules/etc.).

Add a new function after `build_tree_filtered`:

```rust
/// ディレクトリを再帰的に読み取り、すべてのファイルとフォルダを返す（隠しファイル等は除外）
fn build_tree_all(dir: &Path, depth: u32) -> Vec<FileEntry> {
    if depth > 10 {
        return Vec::new();
    }
    let mut entries = Vec::new();
    let Ok(read_dir) = fs::read_dir(dir) else {
        return entries;
    };

    let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    for entry in items {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.')
            || name == "node_modules"
            || name == "target"
            || name == "dist"
        {
            continue;
        }

        if path.is_dir() {
            let children = build_tree_all(&path, depth + 1);
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: true,
                children: Some(children),
            });
        } else {
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: false,
                children: None,
            });
        }
    }

    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}
```

Then modify `get_file_tree` to add `show_all` parameter:

```rust
#[tauri::command]
pub fn get_file_tree(
    path: String,
    show_all: Option<bool>,
    include_docx: Option<bool>,
    include_xls: Option<bool>,
    include_km: Option<bool>,
    include_images: Option<bool>,
    include_pdf: Option<bool>,
    include_empty_dirs: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Not a directory".to_string());
    }
    if show_all.unwrap_or(false) {
        Ok(build_tree_all(root, 0))
    } else {
        Ok(build_tree_filtered(
            root,
            0,
            include_docx.unwrap_or(false),
            include_xls.unwrap_or(false),
            include_km.unwrap_or(false),
            include_images.unwrap_or(false),
            include_pdf.unwrap_or(false),
            include_empty_dirs.unwrap_or(false),
        ))
    }
}
```

- [ ] **Step 5: Register new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add three lines in the `invoke_handler` block after `commands::file::folder_exists,` (line 116):

```rust
            commands::file::copy_file,
            commands::file::move_file,
            commands::file::open_in_default_app,
```

- [ ] **Step 6: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add copy_file, move_file, open_in_default_app commands and show_all mode"
```

---

### Task 2: Add i18n translation keys

**Files:**
- Modify: `src/shared/i18n/locales/en/file-tree.json`
- Modify: `src/shared/i18n/locales/ja/file-tree.json`

- [ ] **Step 1: Update English translations**

Replace the full content of `src/shared/i18n/locales/en/file-tree.json`:

```json
{
  "openInNewTab": "Open in New Tab",
  "openInExplorer": "Open in Explorer",
  "openInDefaultApp": "Open with Default App",
  "cut": "Cut",
  "copy": "Copy",
  "paste": "Paste",
  "rename": "Rename",
  "delete": "Delete",
  "newFile": "New File",
  "newFolder": "New Folder",
  "refresh": "Refresh",
  "collapseAll": "Collapse All",
  "noFolder": "No folder is open",
  "noFilesWithFilter": "No files to display (please check your filter settings)",
  "deleteConfirm": "Delete \"{{name}}\"?",
  "overwriteConfirm": "\"{{name}}\" already exists. Overwrite?",
  "filterAll": "Show all files",
  "filterImages": "Filter: image files",
  "filterDocx": "Filter: .docx files",
  "filterXls": "Filter: .xls* files",
  "filterKm": "Filter: .km / .xmind files",
  "filterPdf": "Filter: .pdf files"
}
```

- [ ] **Step 2: Update Japanese translations**

Replace the full content of `src/shared/i18n/locales/ja/file-tree.json`:

```json
{
  "openInNewTab": "新しいタブで表示",
  "openInExplorer": "エクスプローラーで開く",
  "openInDefaultApp": "既定のアプリで開く",
  "cut": "切り取り",
  "copy": "コピー",
  "paste": "貼り付け",
  "rename": "名前の変更",
  "delete": "削除",
  "newFile": "新規ファイル",
  "newFolder": "新規フォルダ",
  "refresh": "更新",
  "collapseAll": "すべて折りたたむ",
  "noFolder": "フォルダが開かれていません",
  "noFilesWithFilter": "表示できるファイルがありません（フィルタ設定をご確認ください）",
  "deleteConfirm": "\"{{name}}\" を削除しますか？",
  "overwriteConfirm": "\"{{name}}\" は既に存在します。上書きしますか？",
  "filterAll": "すべてのファイルを表示",
  "filterImages": "フィルタ: 画像ファイル",
  "filterDocx": "フィルタ: .docx ファイル",
  "filterXls": "フィルタ: .xls* ファイル",
  "filterKm": "フィルタ: .km / .xmind ファイル",
  "filterPdf": "フィルタ: .pdf ファイル"
}
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/file-tree.json src/shared/i18n/locales/ja/file-tree.json
git commit -m "feat(i18n): add translation keys for explorer enhancement"
```

---

### Task 3: Extend file-store with clipboard and drag state

**Files:**
- Modify: `src/stores/file-store.ts`

- [ ] **Step 1: Add clipboard and drag state to the store**

Replace the full content of `src/stores/file-store.ts`:

```typescript
import { create } from "zustand";
import type { FileEntry } from "@/shared/types";

interface ClipboardEntry {
  path: string;
  mode: "cut" | "copy";
}

interface DragState {
  sourcePath: string;
  dropTargetPath: string | null;
}

interface FileState {
  /** 現在アクティブなフォルダパス（tab-store の activeFolderPath と同期） */
  folderPath: string | null;
  activeFile: string | null;
  /** フォルダパスごとのファイルツリーキャッシュ */
  fileTrees: Record<string, FileEntry[]>;
  /** フォルダパスごとのディレクトリ展開状態 (dirPath → expanded) */
  expandedDirs: Record<string, Record<string, boolean>>;
  /** クリップボード（切り取り/コピー対象） */
  clipboardEntry: ClipboardEntry | null;
  /** ドラッグ中の状態 */
  dragState: DragState | null;

  setFolderPath: (path: string | null) => void;
  setActiveFile: (path: string | null) => void;
  /** 特定フォルダのファイルツリーを設定 */
  setFileTree: (folderPath: string, tree: FileEntry[]) => void;
  /** 特定フォルダのキャッシュを削除 */
  removeFileTree: (folderPath: string) => void;
  /** 現在のフォルダのファイルツリーを取得 */
  getActiveFileTree: () => FileEntry[];
  /** ディレクトリの展開状態をトグル */
  toggleDir: (dirPath: string, defaultExpanded: boolean) => void;
  /** ディレクトリが展開されているか（未設定時はdefaultExpandedを返す） */
  isDirExpanded: (dirPath: string, defaultExpanded: boolean) => boolean;
  /** 現在のフォルダの全ディレクトリを折りたたむ */
  collapseAllDirs: () => void;
  /** クリップボードにセット */
  setClipboard: (path: string, mode: "cut" | "copy") => void;
  /** クリップボードをクリア */
  clearClipboard: () => void;
  /** ドラッグ状態を更新 */
  setDragState: (sourcePath: string, dropTargetPath: string | null) => void;
  /** ドラッグ状態をクリア */
  clearDragState: () => void;
}

export const useFileStore = create<FileState>()((set, get) => ({
  folderPath: null,
  activeFile: null,
  fileTrees: {},
  expandedDirs: {},
  clipboardEntry: null,
  dragState: null,

  setFolderPath: (path) => set({ folderPath: path }),
  setActiveFile: (path) => set({ activeFile: path }),
  setFileTree: (folderPath, tree) =>
    set((s) => ({
      fileTrees: { ...s.fileTrees, [folderPath]: tree },
    })),
  removeFileTree: (folderPath) =>
    set((s) => {
      const { [folderPath]: _, ...restTrees } = s.fileTrees;
      const { [folderPath]: __, ...restExpanded } = s.expandedDirs;
      return { fileTrees: restTrees, expandedDirs: restExpanded };
    }),
  getActiveFileTree: () => {
    const { folderPath, fileTrees } = get();
    return folderPath ? fileTrees[folderPath] ?? [] : [];
  },
  toggleDir: (dirPath, defaultExpanded) => {
    const { folderPath, expandedDirs } = get();
    if (!folderPath) return;
    const folderExpanded = expandedDirs[folderPath] ?? {};
    const current = folderExpanded[dirPath];
    set({
      expandedDirs: {
        ...expandedDirs,
        [folderPath]: {
          ...folderExpanded,
          [dirPath]: current === undefined ? !defaultExpanded : !current,
        },
      },
    });
  },
  isDirExpanded: (dirPath, defaultExpanded) => {
    const { folderPath, expandedDirs } = get();
    if (!folderPath) return defaultExpanded;
    const val = expandedDirs[folderPath]?.[dirPath];
    return val === undefined ? defaultExpanded : val;
  },
  collapseAllDirs: () => {
    const { folderPath, expandedDirs, fileTrees } = get();
    if (!folderPath) return;
    const tree = fileTrees[folderPath] ?? [];
    const collapsed: Record<string, boolean> = {};
    const collectDirs = (entries: FileEntry[]) => {
      for (const e of entries) {
        if (e.is_dir) {
          collapsed[e.path] = false;
          if (e.children) collectDirs(e.children);
        }
      }
    };
    collectDirs(tree);
    set({
      expandedDirs: { ...expandedDirs, [folderPath]: collapsed },
    });
  },
  setClipboard: (path, mode) => set({ clipboardEntry: { path, mode } }),
  clearClipboard: () => set({ clipboardEntry: null }),
  setDragState: (sourcePath, dropTargetPath) =>
    set({ dragState: { sourcePath, dropTargetPath } }),
  clearDragState: () => set({ dragState: null }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/file-store.ts
git commit -m "feat(store): add clipboard and drag state to file-store"
```

---

### Task 4: Update filter system for show-all mode with multi-select

**Files:**
- Modify: `src/shared/hooks/useFileFilters.ts`

- [ ] **Step 1: Add `showAll` state and modify filter logic**

Replace the full content of `src/shared/hooks/useFileFilters.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { FileEntry } from "@/shared/types";

export function useFileFilters(folderPath: string | null, setFileTree: (folderPath: string, entries: FileEntry[]) => void, isZennMode = false) {
  const migrateOld = localStorage.getItem("md-office-viewer") === "true";

  // showAll defaults to true; stored in localStorage
  const [showAll, setShowAll] = useState(
    () => localStorage.getItem("md-filter-show-all") !== "false"
  );

  const [filterDocx, setFilterDocx] = useState(
    () => localStorage.getItem("md-filter-docx") !== null
      ? localStorage.getItem("md-filter-docx") === "true"
      : migrateOld
  );
  const [filterXls, setFilterXls] = useState(
    () => localStorage.getItem("md-filter-xls") !== null
      ? localStorage.getItem("md-filter-xls") === "true"
      : migrateOld
  );
  const [filterKm, setFilterKm] = useState(
    () => localStorage.getItem("md-filter-km") === "true"
  );
  const [filterImages, setFilterImages] = useState(
    () => localStorage.getItem("md-filter-images") === "true"
  );
  const [filterPdf, setFilterPdf] = useState(
    () => localStorage.getItem("md-filter-pdf") === "true"
  );

  const [showDocxBtn, setShowDocxBtn] = useState(
    () => localStorage.getItem("md-show-docx-btn") !== "false"
  );
  const [showXlsBtn, setShowXlsBtn] = useState(
    () => localStorage.getItem("md-show-xls-btn") !== "false"
  );
  const [showKmBtn, setShowKmBtn] = useState(
    () => localStorage.getItem("md-show-km-btn") === "true"
  );
  const [showImagesBtn, setShowImagesBtn] = useState(
    () => localStorage.getItem("md-show-images-btn") === "true"
  );
  const [showPdfBtn, setShowPdfBtn] = useState(
    () => localStorage.getItem("md-show-pdf-btn") === "true"
  );

  const handleSaveFilterVisibility = useCallback((v: { showDocx: boolean; showXls: boolean; showKm: boolean; showImages: boolean; showPdf: boolean }) => {
    setShowDocxBtn(v.showDocx);
    setShowXlsBtn(v.showXls);
    setShowKmBtn(v.showKm);
    setShowImagesBtn(v.showImages);
    setShowPdfBtn(v.showPdf);
    localStorage.setItem("md-show-docx-btn", String(v.showDocx));
    localStorage.setItem("md-show-xls-btn", String(v.showXls));
    localStorage.setItem("md-show-km-btn", String(v.showKm));
    localStorage.setItem("md-show-images-btn", String(v.showImages));
    localStorage.setItem("md-show-pdf-btn", String(v.showPdf));
    if (!v.showDocx && filterDocx) {
      setFilterDocx(false);
      localStorage.setItem("md-filter-docx", "false");
    }
    if (!v.showXls && filterXls) {
      setFilterXls(false);
      localStorage.setItem("md-filter-xls", "false");
    }
    if (!v.showKm && filterKm) {
      setFilterKm(false);
      localStorage.setItem("md-filter-km", "false");
    }
    if (!v.showImages && filterImages) {
      setFilterImages(false);
      localStorage.setItem("md-filter-images", "false");
    }
    if (!v.showPdf && filterPdf) {
      setFilterPdf(false);
      localStorage.setItem("md-filter-pdf", "false");
    }
  }, [filterDocx, filterXls, filterKm, filterImages, filterPdf]);

  // 「すべて」ボタンをクリック → 個別フィルタをすべてOFFにして全表示
  const activateShowAll = useCallback(() => {
    setShowAll(true);
    localStorage.setItem("md-filter-show-all", "true");
    setFilterDocx(false);
    setFilterXls(false);
    setFilterKm(false);
    setFilterImages(false);
    setFilterPdf(false);
    localStorage.setItem("md-filter-docx", "false");
    localStorage.setItem("md-filter-xls", "false");
    localStorage.setItem("md-filter-km", "false");
    localStorage.setItem("md-filter-images", "false");
    localStorage.setItem("md-filter-pdf", "false");
  }, []);

  // 個別フィルタをトグル → showAll を OFF にする。全フィルタOFFなら showAll に戻る
  const makeToggle = useCallback((
    setter: React.Dispatch<React.SetStateAction<boolean>>,
    key: string,
    otherFilters: boolean[],
  ) => () => {
    setter((prev) => {
      const next = !prev;
      localStorage.setItem(key, String(next));
      // If turning off and all others are also off, revert to showAll
      if (!next && otherFilters.every((f) => !f)) {
        setShowAll(true);
        localStorage.setItem("md-filter-show-all", "true");
      } else {
        setShowAll(false);
        localStorage.setItem("md-filter-show-all", "false");
      }
      return next;
    });
  }, []);

  const toggleFilterDocx = useCallback(() => {
    makeToggle(setFilterDocx, "md-filter-docx", [filterXls, filterKm, filterImages, filterPdf])();
  }, [makeToggle, filterXls, filterKm, filterImages, filterPdf]);

  const toggleFilterXls = useCallback(() => {
    makeToggle(setFilterXls, "md-filter-xls", [filterDocx, filterKm, filterImages, filterPdf])();
  }, [makeToggle, filterDocx, filterKm, filterImages, filterPdf]);

  const toggleFilterKm = useCallback(() => {
    makeToggle(setFilterKm, "md-filter-km", [filterDocx, filterXls, filterImages, filterPdf])();
  }, [makeToggle, filterDocx, filterXls, filterImages, filterPdf]);

  const toggleFilterImages = useCallback(() => {
    makeToggle(setFilterImages, "md-filter-images", [filterDocx, filterXls, filterKm, filterPdf])();
  }, [makeToggle, filterDocx, filterXls, filterKm, filterPdf]);

  const toggleFilterPdf = useCallback(() => {
    makeToggle(setFilterPdf, "md-filter-pdf", [filterDocx, filterXls, filterKm, filterImages])();
  }, [makeToggle, filterDocx, filterXls, filterKm, filterImages]);

  // フォルダツリーをフィルター変更時に再取得
  useEffect(() => {
    if (!folderPath) return;
    let cancelled = false;
    const fp = folderPath;
    (async () => {
      try {
        const entries: FileEntry[] = await invoke("get_file_tree", {
          path: fp,
          showAll: isZennMode ? false : showAll,
          includeDocx: isZennMode ? false : filterDocx,
          includeXls: isZennMode ? false : filterXls,
          includeKm: isZennMode ? false : filterKm,
          includeImages: isZennMode ? true : filterImages,
          includePdf: isZennMode ? false : filterPdf,
          includeEmptyDirs: isZennMode,
        });
        if (!cancelled) setFileTree(fp, entries);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [showAll, filterDocx, filterXls, filterKm, filterImages, filterPdf, folderPath, setFileTree, isZennMode]);

  // ファイルツリーを再取得するコールバック
  const refreshFileTree = useCallback(async () => {
    if (!folderPath) return;
    try {
      const entries: FileEntry[] = await invoke("get_file_tree", {
        path: folderPath,
        showAll: isZennMode ? false : showAll,
        includeDocx: isZennMode ? false : filterDocx,
        includeXls: isZennMode ? false : filterXls,
        includeKm: isZennMode ? false : filterKm,
        includeImages: isZennMode ? true : filterImages,
        includePdf: isZennMode ? false : filterPdf,
        includeEmptyDirs: isZennMode,
      });
      setFileTree(folderPath, entries);
    } catch { /* ignore */ }
  }, [folderPath, showAll, filterDocx, filterXls, filterKm, filterImages, filterPdf, setFileTree, isZennMode]);

  return {
    showAll, activateShowAll,
    filterDocx, filterXls, filterKm, filterImages, filterPdf,
    toggleFilterDocx, toggleFilterXls, toggleFilterKm, toggleFilterImages, toggleFilterPdf,
    showDocxBtn, showXlsBtn, showKmBtn, showImagesBtn, showPdfBtn,
    handleSaveFilterVisibility,
    refreshFileTree,
  } as const;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/hooks/useFileFilters.ts
git commit -m "feat(filters): add show-all mode with multi-select filter support"
```

---

### Task 5: Update LeftPanel filter bar UI

**Files:**
- Modify: `src/features/file-tree/components/LeftPanel.tsx`

- [ ] **Step 1: Add `showAll` and `activateShowAll` to props and render "All" button**

In `LeftPanel.tsx`, update the `FileFilterProps` interface to add the new props:

```typescript
export interface FileFilterProps {
  showAll: boolean;
  activateShowAll: () => void;
  filterDocx: boolean;
  filterXls: boolean;
  filterKm: boolean;
  filterImages: boolean;
  filterPdf: boolean;
  toggleFilterDocx: () => void;
  toggleFilterXls: () => void;
  toggleFilterKm: () => void;
  toggleFilterImages: () => void;
  toggleFilterPdf: () => void;
  showDocxBtn: boolean;
  showXlsBtn: boolean;
  showKmBtn: boolean;
  showImagesBtn: boolean;
  showPdfBtn: boolean;
}
```

Update the `LeftPanel` function's destructured props to include `showAll, activateShowAll`:

```typescript
export function LeftPanel({
  onFileSelect, onRefresh, onNewFile, onNewFolder, previewRef, onImageDragStart,
  showAll, activateShowAll,
  filterDocx, filterXls, filterKm, filterImages, filterPdf,
  toggleFilterDocx, toggleFilterXls, toggleFilterKm, toggleFilterImages, toggleFilterPdf,
  showDocxBtn, showXlsBtn, showKmBtn, showImagesBtn, showPdfBtn,
}: LeftPanelProps) {
```

- [ ] **Step 2: Replace the filter bar rendering**

Replace the filter bar section (the `<div className="file-tree__header">...</div>` block, lines 261-311) with:

```tsx
        {leftPanel === "folder" && !!activeFolderPath && (
          <div className="file-tree__header">
            <div className="file-tree__filters">
              <button
                className={`file-tree__filter-btn ${showAll ? "file-tree__filter-btn--active" : ""}`}
                onClick={activateShowAll}
                title={t("filterAll", { ns: "fileTree" })}
              >
                📁
              </button>
              <button
                className={`file-tree__filter-btn ${!showAll && filterImages ? "file-tree__filter-btn--active" : ""}`}
                onClick={toggleFilterImages}
                title={t("filterImages", { ns: "fileTree" })}
              >
                🖼️
              </button>
              {showDocxBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterDocx ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterDocx}
                  title={t("filterDocx", { ns: "fileTree" })}
                >
                  .docx
                </button>
              )}
              {showXlsBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterXls ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterXls}
                  title={t("filterXls", { ns: "fileTree" })}
                >
                  .xls*
                </button>
              )}
              {showKmBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterKm ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterKm}
                  title={t("filterKm", { ns: "fileTree" })}
                >
                  .km
                </button>
              )}
              {showPdfBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterPdf ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterPdf}
                  title={t("filterPdf", { ns: "fileTree" })}
                >
                  .pdf
                </button>
              )}
            </div>
          </div>
        )}
```

Note: The `.md` "always" button is removed since all files are shown by default. The 🖼️ button is always visible (no longer conditional on `showImagesBtn`) since images are a commonly used filter.

- [ ] **Step 3: Update the call site in `App.tsx` that passes filter props to `LeftPanel`**

Find the `<LeftPanel ... />` usage in `App.tsx` and add the two new props: `showAll={ff.showAll}` and `activateShowAll={ff.activateShowAll}`. The filter props are spread from the `useFileFilters` hook return. Search for where `LeftPanel` is rendered and add these props.

- [ ] **Step 4: Verify the app compiles**

Run: `npm run build` (or `npm run dev` to check)
Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/file-tree/components/LeftPanel.tsx src/app/App.tsx
git commit -m "feat(ui): update filter bar with show-all button and multi-select"
```

---

### Task 6: Add context menu enhancements and clipboard shortcuts to FileTree

**Files:**
- Modify: `src/features/file-tree/components/FileTree.tsx`

- [ ] **Step 1: Add clipboard imports and handlers**

At the top of `FileTree.tsx`, add `ask` is already imported. Add file-store clipboard usage. Update the imports block:

The `useFileStore` import is already present. Inside the `FileTree` component function, add clipboard state and handlers after the existing state declarations (after `const menuRef = ...`):

```typescript
  const clipboardEntry = useFileStore((s) => s.clipboardEntry);
  const setClipboard = useFileStore((s) => s.setClipboard);
  const clearClipboard = useFileStore((s) => s.clearClipboard);

  const handleCut = useCallback((entry: FileEntry) => {
    setClipboard(entry.path, "cut");
    setContextMenu(null);
  }, [setClipboard]);

  const handleCopy = useCallback((entry: FileEntry) => {
    setClipboard(entry.path, "copy");
    setContextMenu(null);
  }, [setClipboard]);

  const handlePaste = useCallback(async (targetEntry: FileEntry) => {
    setContextMenu(null);
    if (!clipboardEntry) return;

    const sep = clipboardEntry.path.includes("\\") ? "\\" : "/";
    const fileName = clipboardEntry.path.split(sep).pop()!;
    const targetDir = targetEntry.is_dir ? targetEntry.path : targetEntry.path.substring(0, targetEntry.path.lastIndexOf(sep));
    const destPath = targetDir + sep + fileName;

    // Check if destination already exists — ask to overwrite
    if (destPath !== clipboardEntry.path) {
      try {
        if (clipboardEntry.mode === "cut") {
          await invoke("move_file", { src: clipboardEntry.path, dest: destPath });

          // Update tabs whose paths are under the moved item
          const { tabs, closeTab } = useTabStore.getState();
          for (const tab of tabs) {
            if (tab.filePath === clipboardEntry.path || tab.filePath.startsWith(clipboardEntry.path + sep)) {
              closeTab(tab.id);
            }
          }
          clearClipboard();
        } else {
          await invoke("copy_file", { src: clipboardEntry.path, dest: destPath });
        }
        onRefresh?.();
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.includes("already exists")) {
          const overwrite = await ask(t("overwriteConfirm", { name: fileName }), { kind: "warning" });
          if (overwrite) {
            try {
              await invoke("delete_file", { path: destPath });
              if (clipboardEntry.mode === "cut") {
                await invoke("move_file", { src: clipboardEntry.path, dest: destPath });
                clearClipboard();
              } else {
                await invoke("copy_file", { src: clipboardEntry.path, dest: destPath });
              }
              onRefresh?.();
            } catch (e2) {
              console.error("Paste (overwrite) failed:", e2);
            }
          }
        } else {
          console.error("Paste failed:", err);
        }
      }
    }
  }, [clipboardEntry, clearClipboard, onRefresh, t]);

  const handleOpenInDefaultApp = useCallback(async (entry: FileEntry) => {
    setContextMenu(null);
    try {
      await invoke("open_in_default_app", { path: entry.path });
    } catch (err) {
      console.error("Open in default app failed:", err);
    }
  }, []);
```

- [ ] **Step 2: Update keyboard shortcut handler**

Replace the existing `handleKeyDown` callback (around lines 281-295) with:

```typescript
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (renamingPath) return;
    if (!activeFile) return;

    const entry = findEntry(tree, activeFile);
    if (!entry) return;

    if (e.key === "Delete") {
      e.preventDefault();
      deleteEntry(entry);
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename(entry);
    } else if (e.ctrlKey && e.key === "x") {
      e.preventDefault();
      setClipboard(entry.path, "cut");
    } else if (e.ctrlKey && e.key === "c") {
      e.preventDefault();
      setClipboard(entry.path, "copy");
    } else if (e.ctrlKey && e.key === "v") {
      e.preventDefault();
      handlePaste(entry);
    }
  }, [renamingPath, activeFile, tree, findEntry, deleteEntry, startRename, setClipboard, handlePaste]);
```

- [ ] **Step 3: Remove `handleCopyName` callback**

Delete the `handleCopyName` callback (lines 261-266 in the original file):

```typescript
  // DELETE THIS:
  const handleCopyName = useCallback(async () => {
    if (!contextMenu) return;
    const name = contextMenu.entry.name;
    await navigator.clipboard.writeText(name);
    setContextMenu(null);
  }, [contextMenu]);
```

- [ ] **Step 4: Replace the context menu rendering**

Replace the context menu JSX (the `{contextMenu && ( ... )}` block, lines 326-357) with:

```tsx
      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.entry.is_dir && (
            <div className="ctx-group">
              <button onClick={handleOpenInNewTab}>
                <span className="ctx-label">{t("openInNewTab")}</span>
              </button>
            </div>
          )}
          <div className="ctx-group">
            <button onClick={() => handleOpenInDefaultApp(contextMenu.entry)}>
              <span className="ctx-label">{t("openInDefaultApp")}</span>
            </button>
          </div>
          <div className="ctx-group">
            <button onClick={() => handleCut(contextMenu.entry)}>
              <span className="ctx-label">{t("cut")}</span>
              <span className="ctx-shortcut">Ctrl+X</span>
            </button>
            <button onClick={() => handleCopy(contextMenu.entry)}>
              <span className="ctx-label">{t("copy")}</span>
              <span className="ctx-shortcut">Ctrl+C</span>
            </button>
            <button
              onClick={() => handlePaste(contextMenu.entry)}
              disabled={!clipboardEntry}
              style={!clipboardEntry ? { opacity: 0.4 } : undefined}
            >
              <span className="ctx-label">{t("paste")}</span>
              <span className="ctx-shortcut">Ctrl+V</span>
            </button>
          </div>
          <div className="ctx-group">
            <button onClick={handleRename}>
              <span className="ctx-label">{t("rename")}</span>
              <span className="ctx-shortcut">F2</span>
            </button>
            <button onClick={handleDelete}>
              <span className="ctx-label">{t("delete")}</span>
              <span className="ctx-shortcut">Del</span>
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Add visual feedback for cut items in TreeNode**

In the `TreeNode` component, add a clipboard-aware opacity. After the `const isImage = ...` line, add:

```typescript
  const isCutTarget = useFileStore((s) => s.clipboardEntry?.mode === "cut" && s.clipboardEntry.path === entry.path);
```

Then in the `<div className={...}` element, add the opacity style:

```tsx
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          ...(isCutTarget ? { opacity: 0.4 } : {}),
        }}
```

- [ ] **Step 6: Verify the app compiles**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/features/file-tree/components/FileTree.tsx
git commit -m "feat(explorer): add cut/copy/paste, open-in-default-app, keyboard shortcuts"
```

---

### Task 7: Add tree-internal drag-and-drop

**Files:**
- Modify: `src/features/file-tree/components/FileTree.tsx`
- Modify: `src/features/file-tree/components/FileTree.css`

- [ ] **Step 1: Add D&D handlers to TreeNode**

In the `TreeNode` component, add drag event handlers. After the `handleMouseDown` callback:

```typescript
  const dragState = useFileStore((s) => s.dragState);
  const setDragState = useFileStore((s) => s.setDragState);
  const clearDragState = useFileStore((s) => s.clearDragState);

  const isDragOver = dragState?.dropTargetPath === entry.path && entry.is_dir;
  const isDragging = dragState?.sourcePath === entry.path;

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "copyMove";
    setDragState(entry.path, null);
  }, [entry.path, setDragState]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragState) return;

    // Determine target dir: if hovering over a folder, use it; if a file, use its parent
    const targetDir = entry.is_dir ? entry.path : entry.path.substring(0, entry.path.lastIndexOf(entry.path.includes("\\") ? "\\" : "/"));

    // Prevent dropping on self or descendant
    const sep = dragState.sourcePath.includes("\\") ? "\\" : "/";
    if (targetDir === dragState.sourcePath || targetDir.startsWith(dragState.sourcePath + sep)) {
      e.dataTransfer.dropEffect = "none";
      return;
    }

    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    if (entry.is_dir && dragState.dropTargetPath !== entry.path) {
      setDragState(dragState.sourcePath, entry.path);
    }
  }, [entry, dragState, setDragState]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (dragState && dragState.dropTargetPath === entry.path) {
      setDragState(dragState.sourcePath, null);
    }
  }, [entry.path, dragState, setDragState]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragState) return;

    const sourcePath = dragState.sourcePath;
    clearDragState();

    const sep = sourcePath.includes("\\") ? "\\" : "/";
    const targetDir = entry.is_dir ? entry.path : entry.path.substring(0, entry.path.lastIndexOf(sep));

    // Prevent dropping on self or descendant
    if (targetDir === sourcePath || targetDir.startsWith(sourcePath + sep)) return;

    const fileName = sourcePath.split(sep).pop()!;
    const destPath = targetDir + sep + fileName;

    try {
      if (e.ctrlKey) {
        await invoke("copy_file", { src: sourcePath, dest: destPath });
      } else {
        await invoke("move_file", { src: sourcePath, dest: destPath });
        // Close tabs for moved items
        const { tabs, closeTab } = useTabStore.getState();
        for (const tab of tabs) {
          if (tab.filePath === sourcePath || tab.filePath.startsWith(sourcePath + sep)) {
            closeTab(tab.id);
          }
        }
      }
      onFileSelect(destPath);
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes("already exists")) {
        const overwrite = await ask(t("overwriteConfirm", { name: fileName }), { kind: "warning" });
        if (overwrite) {
          try {
            await invoke("delete_file", { path: destPath });
            if (e.ctrlKey) {
              await invoke("copy_file", { src: sourcePath, dest: destPath });
            } else {
              await invoke("move_file", { src: sourcePath, dest: destPath });
            }
          } catch (e2) {
            console.error("D&D overwrite failed:", e2);
          }
        }
      } else {
        console.error("D&D failed:", err);
      }
    }
    // Need onRefresh from parent — we'll get it via the FileTree re-render
  }, [dragState, clearDragState, entry, onFileSelect, t]);

  const handleDragEnd = useCallback(() => {
    clearDragState();
  }, [clearDragState]);
```

Note: `TreeNode` needs `onFileSelect` and `t` available. `onFileSelect` is already a prop. We need to add `t` — either pass it as a prop or import `useTranslation` in TreeNode. The simpler approach is to pass a `onDrop` callback from FileTree to TreeNode. However, to keep changes minimal, we'll use `useTranslation` inside TreeNode.

Add `useTranslation` to TreeNode imports at the top of the TreeNode function:

```typescript
function TreeNode({
  entry, depth, activeFile, onFileSelect, onContextMenu,
  renamingPath, renameValue, onRenameChange, onRenameSubmit, onRenameCancel,
  onImageDragStart,
}: TreeNodeProps) {
  const { t } = useTranslation("fileTree");
```

- [ ] **Step 2: Update TreeNode's JSX to add drag attributes**

Update the `<div className={...}` element for the tree node to include drag attributes:

```tsx
      <div
        className={`file-tree__node ${isActive ? "file-tree__node--active" : ""} ${isDragOver ? "file-tree__node--drag-over" : ""} ${isDragging ? "file-tree__node--dragging" : ""}`}
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          ...(isCutTarget ? { opacity: 0.4 } : {}),
        }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseDown={isImage ? handleMouseDown : undefined}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      >
```

- [ ] **Step 3: Add onDragOver/onDrop to the tree list container**

In the `FileTree` component, add drag handlers to the root `<div className="file-tree__list">` so dropping on empty space puts files in the root folder. Before the return statement, add:

```typescript
  const clearDragState = useFileStore((s) => s.clearDragState);
  const dragState = useFileStore((s) => s.dragState);

  const handleListDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Allow drop on empty space
  }, []);

  const handleListDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragState) return;
    const sourcePath = dragState.sourcePath;
    clearDragState();

    // Get root folder path from the first tree entry
    if (tree.length === 0) return;
    const sep = sourcePath.includes("\\") ? "\\" : "/";
    const rootDir = tree[0].path.substring(0, tree[0].path.lastIndexOf(sep));
    const fileName = sourcePath.split(sep).pop()!;
    const destPath = rootDir + sep + fileName;

    if (destPath === sourcePath) return;

    try {
      if (e.ctrlKey) {
        await invoke("copy_file", { src: sourcePath, dest: destPath });
      } else {
        await invoke("move_file", { src: sourcePath, dest: destPath });
      }
      onRefresh?.();
    } catch (err) {
      console.error("D&D to root failed:", err);
    }
  }, [dragState, clearDragState, tree, onRefresh]);
```

Then update the list div:

```tsx
        <div className="file-tree__list" onDragOver={handleListDragOver} onDrop={handleListDrop}>
```

- [ ] **Step 4: Add D&D CSS styles**

Append to `src/features/file-tree/components/FileTree.css`:

```css
.file-tree__node--drag-over {
  background: rgba(74, 158, 255, 0.15);
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
  border-radius: 3px;
}

.file-tree__node--dragging {
  opacity: 0.4;
}
```

- [ ] **Step 5: Add `onRefresh` to TreeNode**

The `handleDrop` in TreeNode needs to call `onRefresh`. The simplest way: lift `onRefresh` through the TreeNode props.

Add `onRefresh` to `TreeNodeProps`:

```typescript
interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onImageDragStart?: (path: string) => void;
  onRefresh?: () => void;
}
```

Add `onRefresh` to the destructured props in TreeNode, and call `onRefresh?.()` after successful D&D operations (in the `handleDrop` callback, after the invoke calls, before the catch).

Pass `onRefresh` through TreeNode's children rendering:

```tsx
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              activeFile={activeFile}
              onFileSelect={onFileSelect}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              renameValue={renameValue}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onImageDragStart={onImageDragStart}
              onRefresh={onRefresh}
            />
```

Also pass `onRefresh` from `FileTree` to each top-level `TreeNode`:

```tsx
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              activeFile={activeFile}
              onFileSelect={onFileSelect}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              renameValue={renameValue}
              onRenameChange={setRenameValue}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              onImageDragStart={onImageDragStart}
              onRefresh={onRefresh}
            />
```

- [ ] **Step 6: Verify the app compiles**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/features/file-tree/components/FileTree.tsx src/features/file-tree/components/FileTree.css
git commit -m "feat(explorer): add tree-internal drag-and-drop with visual feedback"
```

---

### Task 8: Add OS → tree drag-and-drop

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Extend the existing `onDragDropEvent` handler**

In `App.tsx`, find the existing `onDragDropEvent` listener (around lines 576-620+). The current implementation:
1. Checks if dropped files are images
2. Checks if the drop position is inside the editor textarea
3. Inserts markdown image syntax

We need to add a branch: if the drop position is over the file tree panel, copy the files there instead.

Before the existing `onDragDropEvent` setup, add a ref to track the hovered tree folder:

```typescript
const treeDropTargetRef = useRef<string | null>(null);
```

In the `onDragDropEvent` handler, find the `drop` event handler. Add a check: if the drop position is inside the left panel (file tree area), copy files to the detected folder.

Add this logic at the beginning of the `drop` handler, before the existing editor drop logic:

```typescript
        // Check if drop is over the file tree
        const treeListEl = document.querySelector(".file-tree__list");
        if (treeListEl) {
          const rect = treeListEl.getBoundingClientRect();
          const x = payload.position.x / scaleFactor;
          const y = payload.position.y / scaleFactor;
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            // Find the tree node element under the cursor
            const elements = document.elementsFromPoint(x, y);
            let targetDir = activeFolderPath;
            for (const el of elements) {
              const nodeEl = el.closest(".file-tree__node") as HTMLElement;
              if (nodeEl) {
                // Get the entry path from data attribute — we'll add this
                const nodePath = nodeEl.dataset.path;
                if (nodePath) {
                  // Determine if it's a dir by checking data-is-dir
                  const isDir = nodeEl.dataset.isDir === "true";
                  const sep = nodePath.includes("\\") ? "\\" : "/";
                  targetDir = isDir ? nodePath : nodePath.substring(0, nodePath.lastIndexOf(sep));
                }
                break;
              }
            }

            if (targetDir) {
              for (const filePath of payload.paths) {
                const sep = filePath.includes("\\") ? "\\" : "/";
                const fileName = filePath.split(sep).pop()!;
                const destPath = targetDir + (targetDir.includes("\\") ? "\\" : "/") + fileName;
                try {
                  await invoke("copy_file", { src: filePath, dest: destPath });
                } catch (err) {
                  console.error("OS D&D copy failed:", err);
                }
              }
              handleRefresh();
            }
            return;  // Don't process as editor drop
          }
        }
```

- [ ] **Step 2: Add `data-path` and `data-is-dir` to TreeNode elements**

In `FileTree.tsx`, update the TreeNode's main div to include data attributes:

```tsx
      <div
        className={`file-tree__node ...`}
        data-path={entry.path}
        data-is-dir={entry.is_dir}
        style={...}
        ...
      >
```

- [ ] **Step 3: Add visual feedback for OS drag hover on tree**

In the `onDragDropEvent` handler, handle the `hover` event to highlight the folder under the cursor. In the `hover` branch:

```typescript
      if (payload.type === "hover") {
        // Existing hover handling (if any) ...

        // Highlight file tree folder on hover
        const treeListEl = document.querySelector(".file-tree__list");
        if (treeListEl) {
          const rect = treeListEl.getBoundingClientRect();
          const x = payload.position.x / scaleFactor;
          const y = payload.position.y / scaleFactor;

          // Remove previous highlights
          document.querySelectorAll(".file-tree__node--drag-over").forEach((el) => {
            el.classList.remove("file-tree__node--drag-over");
          });

          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            const elements = document.elementsFromPoint(x, y);
            for (const el of elements) {
              const nodeEl = el.closest(".file-tree__node") as HTMLElement;
              if (nodeEl && nodeEl.dataset.isDir === "true") {
                nodeEl.classList.add("file-tree__node--drag-over");
                break;
              }
            }
          }
        }
      }
```

In the `cancel` handler (or `leave`), clean up:

```typescript
      if (payload.type === "cancel" || payload.type === "leave") {
        document.querySelectorAll(".file-tree__node--drag-over").forEach((el) => {
          el.classList.remove("file-tree__node--drag-over");
        });
      }
```

Also clean up highlights at the start of the `drop` handler before processing.

- [ ] **Step 4: Verify the app compiles**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx src/features/file-tree/components/FileTree.tsx
git commit -m "feat(explorer): add OS-to-tree drag-and-drop file import"
```

---

### Task 9: Manual testing and polish

- [ ] **Step 1: Test filter mode**
  - Open a folder with mixed file types
  - Verify default shows all files and folders
  - Click individual filter buttons (e.g., 🖼️) — verify only that type shows
  - Click multiple filters — verify they combine
  - Click 📁 — verify returns to showing all
  - Turn off all individual filters — verify auto-reverts to "all"

- [ ] **Step 2: Test cut/copy/paste**
  - Right-click a file → Cut → right-click a folder → Paste → verify file moved
  - Right-click a file → Copy → right-click a folder → Paste → verify file copied
  - Use Ctrl+X, Ctrl+C, Ctrl+V shortcuts — verify same behavior
  - Cut a file → verify it appears semi-transparent
  - Paste into a folder with same-name file → verify overwrite dialog

- [ ] **Step 3: Test drag-and-drop within tree**
  - Drag a file onto a folder → verify it moves there
  - Ctrl+drag a file onto a folder → verify it copies there
  - Drag a folder onto itself → verify nothing happens
  - Drag a folder onto its child → verify nothing happens
  - Verify drop target highlights (blue dashed outline)
  - Verify drag source becomes semi-transparent

- [ ] **Step 4: Test OS → tree drag-and-drop**
  - Drag a file from Windows Explorer onto a folder in the tree → verify it copies there
  - Drag onto a file → verify it copies to that file's parent folder
  - Drag onto empty tree space → verify it copies to root folder
  - Verify folder highlights during hover

- [ ] **Step 5: Test "Open with Default App"**
  - Right-click an image → "Open with Default App" → verify opens in image viewer
  - Right-click a .pdf → verify opens in PDF reader
  - Right-click a .docx → verify opens in Word

- [ ] **Step 6: Test edge cases**
  - Delete a file that has an open tab → verify tab closes
  - Move a file that has an open tab → verify tab closes (or updates)
  - Verify tree auto-refreshes after all operations

- [ ] **Step 7: Final commit (if any polish needed)**

```bash
git add -A
git commit -m "fix(explorer): polish and edge case fixes from manual testing"
```
