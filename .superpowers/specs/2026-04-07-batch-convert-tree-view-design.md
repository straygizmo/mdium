# Batch Convert Dialog Tree View Design

## Overview

`BatchConvertModal` のファイル一覧を、現在のフラットリストからエクスプローラーと同様の再帰的ツリー表示に変更する。フォルダノードにチェックボックスを設け、配下の全ファイルを再帰的にON/OFFできるようにする。

## Background

現在の `BatchConvertModal` は `collectConvertibleFiles()` でツリーをフラット化し、ファイルを一次元リストとして表示している。ファイル数が多い場合やフォルダ構造が深い場合に、どのファイルがどこにあるのか把握しづらく、フォルダ単位での一括操作もできない。

## Design

### Component Structure

```
BatchConvertModal
├── Toolbar (filter tabs + select all / deselect all + skipExisting)
└── BatchConvertTree (new)
    └── BatchConvertTreeNode (recursive)
        ├── Checkbox (folder or file)
        ├── Icon + name
        └── children (recursive rendering for folders)
```

### Data Flow

#### 1. buildConvertibleTree

新関数 `buildConvertibleTree(fileTree: FileEntry[]): ConvertibleTreeNode[]` を `collectConvertibleFiles.ts` に追加する。

- `FileEntry` ツリーを再帰的に走査し、変換対象ファイル（docx, pdf, xlsx, xlsm, xls）を含むサブツリーだけを抽出する
- 変換対象ファイルを含まないフォルダは結果から除外する
- 各ファイルノードには既存の `ConvertibleFile` 情報（path, name, type, hasExistingMd）を保持する

```typescript
interface ConvertibleTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ConvertibleTreeNode[] | null;
  // File-only properties
  fileType?: "docx" | "pdf" | "xlsx";
  hasExistingMd?: boolean;
}
```

#### 2. Filter Pruning

フィルタータブ（all / docx / pdf / xlsx）の選択に応じて、ツリーを再帰的にプルーニングするユーティリティ `pruneTreeByFilter(tree: ConvertibleTreeNode[], filter: string): ConvertibleTreeNode[]` を追加する。

- `filter === "all"` の場合はツリーをそのまま返す
- それ以外の場合、該当拡張子のファイルを含まないフォルダをツリーから除外する

#### 3. Selection State

選択状態は引き続き `Set<string>`（ファイルパス）で管理する。フォルダ自体はSetに含めず、配下ファイルの選択状態から動的に算出する。

### Checkbox Logic

| Node Type | Click Action |
|-----------|-------------|
| File | Set内のパスをtoggle |
| Folder (unchecked / indeterminate) | 配下の全ファイルパスを一括add |
| Folder (checked) | 配下の全ファイルパスを一括delete |

フォルダの表示状態は配下ファイルの選択状態から算出する:

- 配下全ファイルが選択 → `checked`
- 一部選択 → `indeterminate`
- 全未選択 → `unchecked`

算出ヘルパー: `getCheckState(node: ConvertibleTreeNode, selected: Set<string>): "checked" | "unchecked" | "indeterminate"`

- 再帰的に配下の全ファイルパスを収集し、Setとの交差を計算する
- パフォーマンスのため `useMemo` でキャッシュする

### skipExisting Integration

- `skipExisting` が有効な場合、`hasExistingMd === true` のファイルはチェックボックスを disabled にし、選択Setから自動除外する（現行動作を維持）
- フォルダの一括選択時も、skipExisting対象のファイルはスキップする

### Folder Expand / Collapse

- フォルダ名クリックで展開/折りたたみ（チェックボックス領域とは分離）
- デフォルトは全展開
- 展開状態はローカルstate `useState<Set<string>>` で管理（閉じたフォルダのパスをSetに格納）

### Select All / Deselect All

現在のフィルタービューに表示されている全ファイルに対して動作する（現行動作を維持）。ツリーを再帰的に走査して全ファイルパスを収集する。

### Styling

- 既存の `FileTree.tsx` の `TreeNode` と同様に、depth に応じた `paddingLeft` でインデントを表現する
- フォルダアイコン: `+` / `-`（展開状態に応じて切り替え）
- ファイルアイコン: 既存の `getFileIcon()` を再利用
- indeterminate チェックボックスは HTML の `indeterminate` プロパティを `ref` 経由で設定する

### i18n

新規翻訳キーは不要。既存のラベル（全選択/全解除/フィルタータブなど）をそのまま使用する。

## Files to Modify

| File | Change |
|------|--------|
| `src/features/export/lib/collectConvertibleFiles.ts` | `buildConvertibleTree`, `pruneTreeByFilter`, helper functions を追加 |
| `src/features/export/components/BatchConvertModal.tsx` | フラットリストをツリーコンポーネントに置き換え |
| `src/features/export/components/BatchConvertTree.tsx` | **New** — ツリー表示コンポーネント |
| `src/features/export/components/BatchConvertTreeNode.tsx` | **New** — 再帰ツリーノードコンポーネント |
| `src/features/export/components/BatchConvertModal.css` | ツリー表示用スタイルを追加 |

## Out of Scope

- ドラッグ&ドロップによるファイル並び替え
- ファイル検索/フィルターのテキスト入力
- エクスプローラー本体のツリーコンポーネントとの共通化（将来的な検討事項）
