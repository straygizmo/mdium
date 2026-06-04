# 一括 .md 削除モード Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一括変換モーダルに「削除」モードを追加し、ソース (docx/pdf/xlsx) と同名の生成済み `.md` を再帰的にゴミ箱へ一括移動できるようにする。

**Architecture:** バックエンドに `.md` パスを解決してゴミ箱へ移動する Tauri コマンド `delete_generated_md` を追加 (`trash` クレート使用)。フロントは既存 `BatchConvertModal` に `mode: "convert" | "delete"` を追加し、削除モードでは「`.md` が存在するソースのみ」を表示するツリー・場所トグル・確認ダイアログを提供する。新フック `useBatchDeleteMd` がコマンドを呼び出し既存サマリ形へマッピングする。

**Tech Stack:** Rust (Tauri 2, `trash` crate), React 19 + TypeScript, react-i18next, Vitest。

参照スペック: `.superpowers/specs/2026-06-04-batch-delete-generated-md-design.md`

---

## File Structure

- `src-tauri/Cargo.toml` — `trash` 依存を追加
- `src-tauri/src/commands/file.rs` — `resolve_generated_md_path` ヘルパー、`delete_generated_md` コマンド、Rust 単体テスト
- `src-tauri/src/lib.rs` — `delete_generated_md` を invoke_handler に登録
- `src/features/export/lib/collectConvertibleFiles.ts` — `pruneTreeByHasMd` 追加
- `src/features/export/lib/__tests__/pruneTreeByHasMd.test.ts` — 新規テスト
- `src/features/export/hooks/useBatchDeleteMd.ts` — 新規フック
- `src/features/export/components/BatchConvertModal.tsx` — モード切替・削除ビュー・確認ダイアログ (全面改訂)
- `src/features/export/components/BatchConvertModal.css` — モード切替・確認ダイアログの最小スタイル
- `src/shared/i18n/locales/ja/common.json`, `src/shared/i18n/locales/en/common.json` — 文言追加

---

## Task 1: バックエンド — ゴミ箱移動コマンド

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands/file.rs` (末尾の `check_mdium_md_exists` 周辺 `:609-630` を含む)

- [ ] **Step 1: `trash` クレートを追加**

`src-tauri/Cargo.toml` の `[dependencies]` 末尾 (`rand = "0.8"` の下、`:37` 付近) に追加:

```toml
trash = "5"
```

- [ ] **Step 2: パス解決ヘルパーの失敗テストを書く**

`src-tauri/src/commands/file.rs` の末尾 (`:630` の後) にテストモジュールを追加:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn resolves_sibling_md_path() {
        let p = resolve_generated_md_path(Path::new("/tmp/docs/report.docx"), false).unwrap();
        assert_eq!(p, PathBuf::from("/tmp/docs/report.md"));
    }

    #[test]
    fn resolves_mdium_md_path() {
        let p = resolve_generated_md_path(Path::new("/tmp/docs/report.pdf"), true).unwrap();
        assert_eq!(p, PathBuf::from("/tmp/docs/.mdium/report.md"));
    }

    #[test]
    fn returns_none_for_root_without_stem() {
        assert!(resolve_generated_md_path(Path::new("/"), false).is_none());
    }
}
```

- [ ] **Step 3: テストがコンパイルエラー/失敗することを確認**

Run: `cd src-tauri && cargo test --lib resolve_generated_md_path`
Expected: コンパイルエラー (`resolve_generated_md_path` 未定義)。

- [ ] **Step 4: ヘルパーとコマンドを実装**

`src-tauri/src/commands/file.rs` の末尾 (テストモジュールの**前**) に追加。先頭 import に `PathBuf` が無いので、ヘルパー内では `src.parent()` の戻り値から `to_path_buf()` で生成する (追加 import 不要):

```rust
/// Resolve the generated `.md` path for a source file.
/// - in_mdium == true:  {parent}/.mdium/{stem}.md
/// - in_mdium == false: {parent}/{stem}.md
fn resolve_generated_md_path(src: &Path, in_mdium: bool) -> Option<std::path::PathBuf> {
    let parent = src.parent()?;
    let stem = src.file_stem()?;
    let mut md_path = parent.to_path_buf();
    if in_mdium {
        md_path.push(".mdium");
    }
    md_path.push(format!("{}.md", stem.to_string_lossy()));
    Some(md_path)
}

#[derive(Serialize)]
pub struct DeleteMdResult {
    pub source_path: String,
    pub md_path: String,
    /// "deleted" | "notfound" | "failed"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// For each source file path, resolve its generated `.md` (sibling or `.mdium`)
/// and move it to the OS recycle bin. Files whose `.md` does not exist are
/// reported as "notfound". Per-file results are returned so the UI can show a
/// summary with partial failures.
#[tauri::command]
pub fn delete_generated_md(paths: Vec<String>, in_mdium: bool) -> Vec<DeleteMdResult> {
    let mut results = Vec::with_capacity(paths.len());
    for raw in paths {
        let src = Path::new(&raw);
        let md_path = match resolve_generated_md_path(src, in_mdium) {
            Some(p) => p,
            None => {
                results.push(DeleteMdResult {
                    source_path: raw,
                    md_path: String::new(),
                    status: "failed".to_string(),
                    error: Some("Cannot resolve .md path".to_string()),
                });
                continue;
            }
        };
        let md_str = md_path.to_string_lossy().to_string();
        if !md_path.is_file() {
            results.push(DeleteMdResult {
                source_path: raw,
                md_path: md_str,
                status: "notfound".to_string(),
                error: None,
            });
            continue;
        }
        match trash::delete(&md_path) {
            Ok(()) => results.push(DeleteMdResult {
                source_path: raw,
                md_path: md_str,
                status: "deleted".to_string(),
                error: None,
            }),
            Err(e) => results.push(DeleteMdResult {
                source_path: raw,
                md_path: md_str,
                status: "failed".to_string(),
                error: Some(e.to_string()),
            }),
        }
    }
    results
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib resolve_generated_md_path`
Expected: 3 tests pass。

- [ ] **Step 6: コミット**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/file.rs
git commit -m "feat(export): add delete_generated_md command to move .md to recycle bin"
```

---

## Task 2: コマンド登録

**Files:**
- Modify: `src-tauri/src/lib.rs:208` (`check_mdium_md_exists` の登録行付近)

- [ ] **Step 1: invoke_handler に登録**

`src-tauri/src/lib.rs` の `commands::file::check_mdium_md_exists,` (`:208`) の直後に行を追加:

```rust
            commands::file::check_mdium_md_exists,
            commands::file::delete_generated_md,
```

- [ ] **Step 2: ビルドで配線を確認**

Run: `cd src-tauri && cargo check`
Expected: エラーなし (warning は可)。

- [ ] **Step 3: コミット**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(export): register delete_generated_md command"
```

---

## Task 3: ツリー絞り込みヘルパー `pruneTreeByHasMd`

**Files:**
- Modify: `src/features/export/lib/collectConvertibleFiles.ts` (末尾 `:158-170` 付近に追記)
- Test: `src/features/export/lib/__tests__/pruneTreeByHasMd.test.ts`

- [ ] **Step 1: 失敗テストを書く**

新規 `src/features/export/lib/__tests__/pruneTreeByHasMd.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { pruneTreeByHasMd } from "../collectConvertibleFiles";
import type { ConvertibleTreeNode } from "../collectConvertibleFiles";

const tree: ConvertibleTreeNode[] = [
  {
    name: "sub",
    path: "/r/sub",
    isDir: true,
    children: [
      { name: "a.docx", path: "/r/sub/a.docx", isDir: false, children: null, fileType: "docx", hasExistingMdSibling: true, hasExistingMdInMdium: false },
      { name: "b.pdf", path: "/r/sub/b.pdf", isDir: false, children: null, fileType: "pdf", hasExistingMdSibling: false, hasExistingMdInMdium: true },
    ],
  },
  { name: "c.xlsx", path: "/r/c.xlsx", isDir: false, children: null, fileType: "xlsx", hasExistingMdSibling: false, hasExistingMdInMdium: false },
];

describe("pruneTreeByHasMd", () => {
  it("keeps only sibling-md files when inMdium=false", () => {
    const r = pruneTreeByHasMd(tree, false);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("sub");
    expect(r[0].children).toHaveLength(1);
    expect(r[0].children![0].name).toBe("a.docx");
  });

  it("keeps only mdium-md files when inMdium=true", () => {
    const r = pruneTreeByHasMd(tree, true);
    expect(r).toHaveLength(1);
    expect(r[0].children).toHaveLength(1);
    expect(r[0].children![0].name).toBe("b.pdf");
  });

  it("drops folders with no matching descendants", () => {
    const r = pruneTreeByHasMd([
      {
        name: "x", path: "/x", isDir: true, children: [
          { name: "c.xlsx", path: "/x/c.xlsx", isDir: false, children: null, fileType: "xlsx", hasExistingMdSibling: false, hasExistingMdInMdium: false },
        ],
      },
    ], false);
    expect(r).toHaveLength(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test -- pruneTreeByHasMd`
Expected: FAIL (`pruneTreeByHasMd` is not a function / import error)。

- [ ] **Step 3: ヘルパーを実装**

`src/features/export/lib/collectConvertibleFiles.ts` の末尾 (`collectDescendantPaths` の後) に追加:

```ts
/**
 * Prune the convertible tree to only files that have an existing generated .md
 * in the selected location (sibling vs .mdium). Folders with no matching
 * descendants are removed.
 */
export function pruneTreeByHasMd(
  tree: ConvertibleTreeNode[],
  inMdium: boolean
): ConvertibleTreeNode[] {
  const result: ConvertibleTreeNode[] = [];
  for (const node of tree) {
    if (node.isDir) {
      const children = pruneTreeByHasMd(node.children ?? [], inMdium);
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else {
      const has = inMdium ? node.hasExistingMdInMdium : node.hasExistingMdSibling;
      if (has) {
        result.push(node);
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test -- pruneTreeByHasMd`
Expected: 3 tests pass。

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/collectConvertibleFiles.ts src/features/export/lib/__tests__/pruneTreeByHasMd.test.ts
git commit -m "feat(export): add pruneTreeByHasMd helper"
```

---

## Task 4: フック `useBatchDeleteMd`

**Files:**
- Create: `src/features/export/hooks/useBatchDeleteMd.ts`

注意: `BatchConvertSummary` / `BatchConvertFileResult` は `useBatchConvert.ts:11-23` で `export interface` 済み。再利用する。

- [ ] **Step 1: フックを実装**

新規 `src/features/export/hooks/useBatchDeleteMd.ts`:

```ts
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import type {
  BatchConvertSummary,
  BatchConvertFileResult,
} from "./useBatchConvert";

interface DeleteMdResult {
  source_path: string;
  md_path: string;
  status: "deleted" | "notfound" | "failed";
  error?: string;
}

export function useBatchDeleteMd() {
  const [isDeleting, setIsDeleting] = useState(false);
  const [summary, setSummary] = useState<BatchConvertSummary | null>(null);

  const deleteMd = useCallback(
    async (files: ConvertibleFile[], inMdium: boolean) => {
      setIsDeleting(true);
      setSummary(null);

      const paths = files.map((f) => f.path);
      let results: DeleteMdResult[];
      try {
        results = await invoke<DeleteMdResult[]>("delete_generated_md", {
          paths,
          inMdium,
        });
      } catch (e) {
        // Whole-call failure: mark every requested file as failed.
        results = files.map((f) => ({
          source_path: f.path,
          md_path: "",
          status: "failed" as const,
          error: e instanceof Error ? e.message : String(e),
        }));
      }

      const byPath = new Map(files.map((f) => [f.path, f]));
      const fileResults: BatchConvertFileResult[] = results.map((r) => {
        const file: ConvertibleFile =
          byPath.get(r.source_path) ?? {
            name: r.md_path || r.source_path,
            path: r.source_path,
            type: "docx",
            hasExistingMdSibling: false,
            hasExistingMdInMdium: false,
          };
        const status: BatchConvertFileResult["status"] =
          r.status === "deleted"
            ? "success"
            : r.status === "notfound"
              ? "skipped"
              : "failed";
        return { file, status, error: r.error, mdPath: r.md_path };
      });

      const s: BatchConvertSummary = {
        success: fileResults.filter((r) => r.status === "success").length,
        failed: fileResults.filter((r) => r.status === "failed").length,
        skipped: fileResults.filter((r) => r.status === "skipped").length,
        results: fileResults,
      };
      setSummary(s);
      setIsDeleting(false);
      return s;
    },
    []
  );

  const reset = useCallback(() => {
    setSummary(null);
    setIsDeleting(false);
  }, []);

  return { isDeleting, summary, deleteMd, reset };
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: 本ファイル起因のエラーなし (モーダル未改訂のためモーダル側エラーは Task 6 で解消)。

- [ ] **Step 3: コミット**

```bash
git add src/features/export/hooks/useBatchDeleteMd.ts
git commit -m "feat(export): add useBatchDeleteMd hook"
```

---

## Task 5: i18n キー追加

**Files:**
- Modify: `src/shared/i18n/locales/ja/common.json` (`:90` `batchConvertFilterPdf` の後)
- Modify: `src/shared/i18n/locales/en/common.json` (`:90` `batchConvertFilterPdf` の後)

- [ ] **Step 1: ja キーを追加**

`src/shared/i18n/locales/ja/common.json` の `"batchConvertFilterPdf": "PDF",` の直後に追加:

```json
  "batchConvertModeConvert": "変換",
  "batchConvertModeDelete": "削除",
  "batchDeleteTitle": "生成された .md を一括削除",
  "batchDeleteLocationMdium": ".mdium 内の .md を削除",
  "batchDeleteStart": "削除",
  "batchDeleteDeleting": "削除中...",
  "batchDeleteComplete": "削除完了: {{deleted}}件削除, {{failed}}件失敗, {{skipped}}件対象なし",
  "batchDeleteNoFiles": "削除対象の .md ファイルがありません",
  "batchDeleteConfirmTitle": "削除の確認",
  "batchDeleteConfirmMessage": "選択した {{count}} 件の .md ファイルをゴミ箱に移動します。よろしいですか?",
  "batchDeleteConfirmButton": "ゴミ箱に移動",
```

- [ ] **Step 2: en キーを追加**

`src/shared/i18n/locales/en/common.json` の `"batchConvertFilterPdf": "PDF",` の直後に追加:

```json
  "batchConvertModeConvert": "Convert",
  "batchConvertModeDelete": "Delete",
  "batchDeleteTitle": "Batch Delete Generated .md",
  "batchDeleteLocationMdium": "Delete .md inside .mdium",
  "batchDeleteStart": "Delete",
  "batchDeleteDeleting": "Deleting...",
  "batchDeleteComplete": "Delete complete: {{deleted}} deleted, {{failed}} failed, {{skipped}} not found",
  "batchDeleteNoFiles": "No matching .md files to delete",
  "batchDeleteConfirmTitle": "Confirm Deletion",
  "batchDeleteConfirmMessage": "Move the selected {{count}} .md file(s) to the Recycle Bin?",
  "batchDeleteConfirmButton": "Move to Recycle Bin",
```

- [ ] **Step 3: JSON 妥当性を確認**

Run: `node -e "require('./src/shared/i18n/locales/ja/common.json'); require('./src/shared/i18n/locales/en/common.json'); console.log('ok')"`
Expected: `ok` (構文エラーなし)。

- [ ] **Step 4: コミット**

```bash
git add src/shared/i18n/locales/ja/common.json src/shared/i18n/locales/en/common.json
git commit -m "i18n(export): add batch delete strings"
```

---

## Task 6: モーダルにモード切替・削除ビュー・確認ダイアログを追加

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.tsx` (全面改訂)

`BatchConvertModal.tsx` を以下の内容で**全置換**する。変更点: `mode` / `deleteInMdium` / `confirmOpen` state、`useBatchDeleteMd`、`pruneTreeByHasMd`、モード切替セグメント、削除ツリー/トグル、確認ダイアログ、削除進捗・結果ビュー。

- [ ] **Step 1: ファイルを全置換**

```tsx
import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import {
  pruneTreeByFilter,
  pruneTreeByHasMd,
  collectFilePaths,
} from "../lib/collectConvertibleFiles";
import { useBatchConvert } from "../hooks/useBatchConvert";
import { useBatchDeleteMd } from "../hooks/useBatchDeleteMd";
import { BatchConvertTree } from "./BatchConvertTree";
import "./BatchConvertModal.css";

type FilterTab = "all" | "docx" | "pdf" | "xlsx";
type BatchMode = "convert" | "delete";

interface BatchConvertModalProps {
  files: ConvertibleFile[];
  tree: ConvertibleTreeNode[];
  onClose: () => void;
  onComplete: () => void;
}

function patchTreeWithMdiumFlags(
  nodes: ConvertibleTreeNode[],
  existsMap: Record<string, boolean>
): ConvertibleTreeNode[] {
  return nodes.map((node) => {
    if (node.isDir) {
      return {
        ...node,
        children: node.children
          ? patchTreeWithMdiumFlags(node.children, existsMap)
          : node.children,
      };
    }
    return {
      ...node,
      hasExistingMdInMdium: existsMap[node.path] ?? false,
    };
  });
}

export function BatchConvertModal({ files: propFiles, tree: propTree, onClose, onComplete }: BatchConvertModalProps) {
  const { t } = useTranslation("common");
  const { isConverting, progress, summary, convert, reset } = useBatchConvert();
  const {
    isDeleting,
    summary: deleteSummary,
    deleteMd,
    reset: resetDelete,
  } = useBatchDeleteMd();

  const [files, setFiles] = useState<ConvertibleFile[]>(() => propFiles);
  const [tree, setTree] = useState<ConvertibleTreeNode[]>(() => propTree);

  const [mode, setMode] = useState<BatchMode>("convert");
  const [filter, setFilter] = useState<FilterTab>("all");
  const [skipExisting, setSkipExisting] = useState(true);
  const [saveToMdium, setSaveToMdium] = useState(false);
  const [deleteInMdium, setDeleteInMdium] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const effectiveHasExistingMd = useCallback(
    (f: ConvertibleFile) =>
      saveToMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling,
    [saveToMdium]
  );
  const hasMdInLocation = useCallback(
    (f: ConvertibleFile) =>
      deleteInMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling,
    [deleteInMdium]
  );

  const [selected, setSelected] = useState<Set<string>>(() => {
    // Initially select all files that don't have existing .md (convert mode).
    const set = new Set<string>();
    for (const f of propFiles) {
      if (!f.hasExistingMdSibling) {
        set.add(f.path);
      }
    }
    return set;
  });

  // Fetch .mdium existence flags once when the dialog mounts.
  // propFiles is intentionally not a dep — the parent is expected to provide
  // a stable snapshot for the dialog's lifetime; patching state with flags
  // keyed to a changed propFiles would corrupt local state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    const paths = propFiles.map((f) => f.path);
    if (paths.length === 0) return;
    (async () => {
      try {
        const existsMap = await invoke<Record<string, boolean>>(
          "check_mdium_md_exists",
          { paths }
        );
        if (cancelled) return;
        setFiles((prev) =>
          prev.map((f) => ({
            ...f,
            hasExistingMdInMdium: existsMap[f.path] ?? false,
          }))
        );
        setTree((prev) => patchTreeWithMdiumFlags(prev, existsMap));
      } catch (e) {
        console.error("check_mdium_md_exists failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTree = useMemo(() => {
    if (mode === "delete") {
      return pruneTreeByFilter(pruneTreeByHasMd(tree, deleteInMdium), filter);
    }
    return pruneTreeByFilter(tree, filter);
  }, [tree, filter, mode, deleteInMdium]);

  const totalSelected = useMemo(() => {
    if (mode === "delete") {
      return files.filter((f) => selected.has(f.path) && hasMdInLocation(f)).length;
    }
    return files.filter((f) => selected.has(f.path)).length;
  }, [files, selected, mode, hasMdInLocation]);

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = collectFilePaths(filteredTree);
      for (const p of paths) {
        if (mode === "convert" && skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file && effectiveHasExistingMd(file)) continue;
        }
        next.add(p);
      }
      return next;
    });
  }, [filteredTree, mode, skipExisting, files, effectiveHasExistingMd]);

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

  const handleToggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleToggleFolder = useCallback(
    (paths: string[], select: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of paths) {
          if (mode === "convert" && skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file && effectiveHasExistingMd(file)) continue;
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
    [mode, skipExisting, files, effectiveHasExistingMd]
  );

  const handleConvert = useCallback(async () => {
    const selectedFiles = files.filter((f) => selected.has(f.path));
    if (selectedFiles.length === 0) return;
    await convert(selectedFiles, skipExisting, saveToMdium);
  }, [files, selected, skipExisting, saveToMdium, convert]);

  const handleDelete = useCallback(async () => {
    const selectedFiles = files.filter(
      (f) => selected.has(f.path) && hasMdInLocation(f)
    );
    setConfirmOpen(false);
    if (selectedFiles.length === 0) return;
    await deleteMd(selectedFiles, deleteInMdium);
  }, [files, selected, hasMdInLocation, deleteMd, deleteInMdium]);

  const handleClose = useCallback(() => {
    if (summary || deleteSummary) {
      onComplete();
    }
    reset();
    resetDelete();
    onClose();
  }, [summary, deleteSummary, onComplete, reset, resetDelete, onClose]);

  // Update selection when skipExisting / saveToMdium changes (convert mode).
  useEffect(() => {
    if (mode !== "convert" || !skipExisting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of files) {
        if (effectiveHasExistingMd(f)) {
          next.delete(f.path);
        }
      }
      return next;
    });
  }, [mode, skipExisting, saveToMdium, files, effectiveHasExistingMd]);

  // Reset selection when switching modes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const set = new Set<string>();
    if (mode === "delete") {
      for (const f of files) if (hasMdInLocation(f)) set.add(f.path);
    } else {
      for (const f of files) if (!effectiveHasExistingMd(f)) set.add(f.path);
    }
    setSelected(set);
  }, [mode]);

  // Reselect all matching files when delete location toggles (delete mode).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode !== "delete") return;
    const set = new Set<string>();
    for (const f of files) if (hasMdInLocation(f)) set.add(f.path);
    setSelected(set);
  }, [deleteInMdium]);

  const activeSummary = mode === "delete" ? deleteSummary : summary;

  // --- Result view ---
  if (activeSummary) {
    return (
      <div className="batch-convert__overlay" onClick={handleClose}>
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{mode === "delete" ? t("batchDeleteTitle") : t("batchConvertTitle")}</span>
            <button className="batch-convert__close" onClick={handleClose}>×</button>
          </div>
          <div className="batch-convert__result-summary">
            {mode === "delete"
              ? t("batchDeleteComplete", {
                  deleted: activeSummary.success,
                  failed: activeSummary.failed,
                  skipped: activeSummary.skipped,
                })
              : t("batchConvertComplete", {
                  success: activeSummary.success,
                  failed: activeSummary.failed,
                  skipped: activeSummary.skipped,
                })}
          </div>
          <ul className="batch-convert__list">
            {activeSummary.results.map((r) => (
              <li key={r.file.path} className="batch-convert__result-item">
                <span className={`batch-convert__result-icon batch-convert__result-icon--${r.status}`}>
                  {r.status === "success" ? "✓" : r.status === "failed" ? "✗" : "–"}
                </span>
                <span className="batch-convert__result-name" title={r.mdPath || r.file.path}>
                  {r.file.name}
                </span>
                {r.error && (
                  <span className="batch-convert__result-error" title={r.error}>
                    {r.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="batch-convert__footer">
            <button className="batch-convert__btn-cancel" onClick={handleClose}>
              {t("close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Converting view ---
  if (isConverting && progress) {
    const pct = (progress.current / progress.total) * 100;
    return (
      <div className="batch-convert__overlay">
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{t("batchConvertTitle")}</span>
          </div>
          <div className="batch-convert__progress">
            <div className="batch-convert__progress-bar">
              <div className="batch-convert__progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="batch-convert__progress-text">
              {t("batchConvertProgress", { current: progress.current, total: progress.total })}
            </div>
            <div className="batch-convert__progress-file">
              {t("batchConvertCurrentFile", { file: progress.currentFile })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Deleting view ---
  if (isDeleting) {
    return (
      <div className="batch-convert__overlay">
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{t("batchDeleteTitle")}</span>
          </div>
          <div className="batch-convert__progress">
            <div className="batch-convert__progress-text">
              {t("batchDeleteDeleting")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Selection view ---
  return (
    <div className="batch-convert__overlay" onClick={handleClose}>
      <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
        <div className="batch-convert__header">
          <span>{mode === "delete" ? t("batchDeleteTitle") : t("batchConvertTitle")}</span>
          <button className="batch-convert__close" onClick={handleClose}>×</button>
        </div>
        <div className="batch-convert__mode-switch">
          <button
            className={`batch-convert__mode-btn ${mode === "convert" ? "batch-convert__mode-btn--active" : ""}`}
            onClick={() => setMode("convert")}
          >
            {t("batchConvertModeConvert")}
          </button>
          <button
            className={`batch-convert__mode-btn ${mode === "delete" ? "batch-convert__mode-btn--active" : ""}`}
            onClick={() => setMode("delete")}
          >
            {t("batchConvertModeDelete")}
          </button>
        </div>
        <div className="batch-convert__toolbar">
          {(["all", "docx", "xlsx", "pdf"] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              className={`batch-convert__filter-btn ${filter === tab ? "batch-convert__filter-btn--active" : ""}`}
              onClick={() => setFilter(tab)}
            >
              {tab === "all" ? t("batchConvertFilterAll") : tab === "docx" ? t("batchConvertFilterDocx") : tab === "xlsx" ? t("batchConvertFilterXlsx") : t("batchConvertFilterPdf")}
            </button>
          ))}
          <span className="batch-convert__toolbar-sep" />
          <div className="batch-convert__action-btns">
            <button className="batch-convert__action-btn" onClick={handleSelectAll}>
              {t("batchConvertSelectAll")}
            </button>
            <button className="batch-convert__action-btn" onClick={handleDeselectAll}>
              {t("batchConvertDeselectAll")}
            </button>
          </div>
          {mode === "convert" ? (
            <>
              <label className="batch-convert__skip-label">
                <input
                  type="checkbox"
                  checked={saveToMdium}
                  onChange={(e) => setSaveToMdium(e.target.checked)}
                />
                {t("batchConvertSaveToMdium")}
              </label>
              <label className="batch-convert__skip-label">
                <input
                  type="checkbox"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                />
                {t("batchConvertSkipExisting")}
              </label>
            </>
          ) : (
            <label className="batch-convert__skip-label">
              <input
                type="checkbox"
                checked={deleteInMdium}
                onChange={(e) => setDeleteInMdium(e.target.checked)}
              />
              {t("batchDeleteLocationMdium")}
            </label>
          )}
        </div>
        {filteredTree.length === 0 ? (
          <div className="batch-convert__empty">
            {mode === "delete" ? t("batchDeleteNoFiles") : t("batchConvertNoFiles")}
          </div>
        ) : (
          <div className="batch-convert__list">
            <BatchConvertTree
              tree={filteredTree}
              selected={selected}
              onToggleFile={handleToggle}
              onToggleFolder={handleToggleFolder}
              skipExisting={mode === "convert" ? skipExisting : false}
              saveToMdium={mode === "convert" ? saveToMdium : deleteInMdium}
            />
          </div>
        )}
        <div className="batch-convert__footer">
          <button className="batch-convert__btn-cancel" onClick={handleClose}>
            {t("cancel")}
          </button>
          {mode === "delete" ? (
            <button
              className="batch-convert__btn-delete"
              disabled={totalSelected === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {t("batchDeleteStart")} ({totalSelected})
            </button>
          ) : (
            <button
              className="batch-convert__btn-convert"
              disabled={totalSelected === 0}
              onClick={handleConvert}
            >
              {t("batchConvertStart")} ({totalSelected})
            </button>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div
          className="batch-convert__overlay batch-convert__overlay--confirm"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(false);
          }}
        >
          <div
            className="batch-convert__confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="batch-convert__header">
              <span>{t("batchDeleteConfirmTitle")}</span>
            </div>
            <div className="batch-convert__confirm-message">
              {t("batchDeleteConfirmMessage", { count: totalSelected })}
            </div>
            <div className="batch-convert__footer">
              <button
                className="batch-convert__btn-cancel"
                onClick={() => setConfirmOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="batch-convert__btn-delete" onClick={handleDelete}>
                {t("batchDeleteConfirmButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし。

- [ ] **Step 3: コミット**

```bash
git add src/features/export/components/BatchConvertModal.tsx
git commit -m "feat(export): add delete mode to batch convert modal"
```

---

## Task 7: 最小スタイル追加

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.css` (末尾に追記)

- [ ] **Step 1: スタイルを追記**

`src/features/export/components/BatchConvertModal.css` の末尾に追加 (既存の変数・配色に依存しない最小スタイル。既存クラス `batch-convert__filter-btn` 等の見た目に合わせる):

```css
/* --- Mode switch (convert / delete) --- */
.batch-convert__mode-switch {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
}

.batch-convert__mode-btn {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--border-color, #444);
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
}

.batch-convert__mode-btn--active {
  background: var(--accent-color, #3b82f6);
  color: #fff;
  border-color: var(--accent-color, #3b82f6);
}

/* --- Delete primary button --- */
.batch-convert__btn-delete {
  padding: 6px 16px;
  border: none;
  border-radius: 4px;
  background: var(--danger-color, #dc2626);
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}

.batch-convert__btn-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* --- Confirm dialog --- */
.batch-convert__overlay--confirm {
  background: rgba(0, 0, 0, 0.4);
  z-index: 10;
}

.batch-convert__confirm-dialog {
  background: var(--panel-bg, #1e1e1e);
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
  min-width: 320px;
  max-width: 420px;
}

.batch-convert__confirm-message {
  padding: 16px;
  font-size: 14px;
  line-height: 1.6;
}
```

- [ ] **Step 2: コミット**

```bash
git add src/features/export/components/BatchConvertModal.css
git commit -m "style(export): add styles for delete mode and confirm dialog"
```

---

## Task 8: 統合確認 (型・テスト・ビルド・手動)

**Files:** なし (検証のみ)

- [ ] **Step 1: フロント全テスト**

Run: `npm run test`
Expected: 全テスト pass (新規 `pruneTreeByHasMd` 含む)。

- [ ] **Step 2: 型チェック + ビルド**

Run: `npm run build`
Expected: `tsc` エラーなし、`vite build` 成功。

- [ ] **Step 3: Rust ビルド**

Run: `cd src-tauri && cargo build`
Expected: エラーなし。

- [ ] **Step 4: 手動スモークテスト**

`npm run tauri dev` で起動し、以下を確認:
1. 変換対象ファイルがあるフォルダを開き、ヘッダの一括変換ボタンでモーダルを開く。
2. 上部に「変換 / 削除」セグメントが表示される。
3. **変換モード**が従来通り動作する (既存 .md スキップ等)。
4. **削除モード**に切替 → `.md` が存在するソースのみツリーに表示される。
5. 「.mdium 内の .md を削除」トグルで表示/対象が切り替わる。
6. サブフォルダ内の対象も再帰的に表示される。
7. 「削除 (N)」→ 確認ダイアログ → 「ゴミ箱に移動」で実行。
8. 結果サマリに削除/失敗/対象なしの件数が出る。
9. OS のゴミ箱に該当 `.md` が移動していること、フォルダから消えていることを確認。
10. モーダルを閉じるとファイルツリーが更新される (`onComplete`/`onRefresh`)。

- [ ] **Step 5: 最終コミット (必要なら)**

検証で微修正が出た場合のみコミット。なければスキップ。

---

## Self-Review メモ

- **スペック網羅**: 場所トグル(両方) ✓ Task 6 / モーダル内モード切替 ✓ Task 6 / 確認ダイアログ ✓ Task 6 / ゴミ箱移動 ✓ Task 1 / 再帰収集 ✓ 既存ツリー再利用 + Task 3 / i18n ✓ Task 5 / 影響ファイル全て ✓。
- **型整合**: `delete_generated_md(paths, in_mdium)` ⇔ JS `invoke("delete_generated_md", { paths, inMdium })` (Tauri が camelCase→snake_case 変換)。`DeleteMdResult` の `status` 文字列 ⇔ フックの判定一致。`pruneTreeByHasMd(tree, inMdium)` 引数順一致。
- **削除モードのツリー有効化**: `skipExisting={false}` を渡し、`isDisabled` を無効化してチェック可能にする (TreeNode `:75`)。`.md exists` バッジは `saveToMdium={deleteInMdium}` で表示。
