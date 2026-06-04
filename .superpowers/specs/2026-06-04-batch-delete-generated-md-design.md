# 一括 .md 削除モード — 設計仕様

- **日付**: 2026-06-04
- **対象画面**: Office/PDF → Markdown 一括変換 (`BatchConvertModal`)
- **ステータス**: 設計承認済み

## 1. 背景・目的

一括変換機能は docx/pdf/xlsx を Markdown に変換し、`.md` を 2 箇所のいずれかに出力する:

- **兄弟ファイル**: `{ソースのフォルダ}/{ファイル名}.md` (`hasExistingMdSibling`)
- **`.mdium` サブフォルダ**: `{ソースのフォルダ}/.mdium/{ファイル名}.md` (`hasExistingMdInMdium`)

変換で生成した `.md` を、サブフォルダを含むフォルダ全体に対して、ソース (docx/pdf 等) と
同一ファイル名のものだけ一括で削除したい。本機能は変換の逆操作にあたる。

## 2. 要件

- 対象は **ソース (docx/pdf/xlsx) と同一ファイル名の `.md`** のみ。無関係な `.md` は対象外。
- サブフォルダを含めて再帰的に対象を収集する (既存のツリー収集ロジックを再利用)。
- 削除対象の場所は **兄弟ファイル / `.mdium` 内** をトグルで切り替えられる
  (変換時の「`.mdium` に保存」トグルと一貫した UX)。
- 削除前に **確認ダイアログ** を表示する (破壊的操作のため)。
- 削除は **OS のゴミ箱 (リサイクルビン) へ移動**。完全削除はしない (誤操作からの復元可能性を確保)。
- UI は **既存の一括変換モーダル内のモード切替** として実装する (変換 / 削除)。
- ユーザー可視文字列はすべて i18n を経由する (ハードコード禁止)。

## 3. UI 設計

`BatchConvertModal` 内に `mode: "convert" | "delete"` を追加する。

### モード切替

- モーダル上部にセグメントコントロール: **変換** / **削除**。
- モード切替時は選択状態をリセットして再初期化する。

### 削除モード (選択ビュー)

- 既存のフィルタタブ (all / docx / xlsx / pdf) を再利用。
- ツリーには **選択中の場所に実際に `.md` が存在するソースのみ** を表示する
  (新ヘルパー `pruneTreeByHasMd` で絞り込み)。
- 場所トグル: 変換時の `saveToMdium` に相当する **「.mdium 内を削除」** トグル。
  - ON → `.mdium` 内の `.md` を対象 (`hasExistingMdInMdium`)
  - OFF → 兄弟 `.md` を対象 (`hasExistingMdSibling`)
- 初期選択 = 選択中の場所に `.md` が存在する全ファイル。
- プライマリボタンは **削除 (N)**。クリックで確認ダイアログを開く。
- 対象が 0 件のときは既存の空表示 (`batchConvertNoFiles` 相当の削除用文言) を出す。

### 確認ダイアログ

- 削除件数と対象の場所 (兄弟 / `.mdium`) を表示。
- 「削除」「キャンセル」。「削除」で実行に進む。

### 進捗 / 結果ビュー

- 既存の進捗バー・結果サマリのレイアウトを再利用。
- 結果サマリは `deleted` / `failed` / `notfound (skipped)` を表示。
- 各行に対象 `.md` のファイル名とステータスアイコン、失敗時はエラー文言を表示。

## 4. バックエンド設計 (Rust)

### 依存追加

- `Cargo.toml` に `trash` クレートを追加 (クロスプラットフォームでゴミ箱移動)。

### 新コマンド

```rust
#[derive(serde::Serialize)]
pub struct DeleteMdResult {
    source_path: String,
    md_path: String,
    status: String,   // "deleted" | "notfound" | "failed"
    error: Option<String>,
}

#[tauri::command]
pub fn delete_generated_md(paths: Vec<String>, in_mdium: bool) -> Vec<DeleteMdResult>;
```

- `.md` パス解決は `check_mdium_md_exists` と同一ロジック:
  - `in_mdium == true`: `{parent}/.mdium/{stem}.md`
  - `in_mdium == false`: `{parent}/{stem}.md`
- 解決した `.md` が存在しなければ `status = "notfound"`。
- 存在すれば `trash::delete` でゴミ箱へ移動。成功なら `"deleted"`、失敗なら `"failed"` + `error`。
- パス解決ロジックは `check_mdium_md_exists` と共通化できる箇所はヘルパーに切り出す。

### コマンド登録

- `lib.rs` の `invoke_handler` に `delete_generated_md` を登録する。

## 5. フロントエンドロジック

### 新フック `useBatchDeleteMd.ts`

- `useBatchConvert.ts` と同形のインターフェース:
  - `isDeleting`, `progress`, `summary`, `delete(files, inMdium)`, `reset`。
  - `delete_generated_md` を呼び出し、結果を `BatchConvertSummary` 互換の形へマッピング。
  - 件数が多い場合に備え、進捗は呼び出し前後で更新 (単一コマンドのため簡易進捗で可)。

### ツリーヘルパー

- `collectConvertibleFiles.ts` に `pruneTreeByHasMd(tree, inMdium)` を追加:
  - `inMdium` に応じて `hasExistingMdInMdium` / `hasExistingMdSibling` が true のファイルノードのみ残す。
  - 該当ファイルを持たないフォルダは除去。

### モーダル状態

- `mode`, 削除用の `selected`, 場所トグルは削除モード専用の独立 state `deleteInMdium` として持つ
  (変換側の `saveToMdium` とは分離し、モード切替時の混線を防ぐ)。
- 削除実行 → 確認ダイアログ → `delete()` → 結果ビュー → クローズ時に `onComplete` (`onRefresh`) を呼ぶ。

## 6. i18n キー (ja / en)

`common.json` に追加 (値は実装時に確定):

- `batchConvertModeConvert` (変換 / Convert)
- `batchConvertModeDelete` (削除 / Delete)
- `batchDeleteTitle`
- `batchDeleteLocationMdium` (.mdium 内を削除 / Delete in .mdium)
- `batchDeleteStart` (削除 (N) の "削除")
- `batchDeleteConfirmTitle`
- `batchDeleteConfirmMessage` (件数・場所を含む)
- `batchDeleteComplete` (deleted / failed / skipped 件数)
- `batchDeleteNoFiles`
- `batchDeleteProgress`

## 7. 影響ファイル

- `src-tauri/Cargo.toml` — `trash` 追加
- `src-tauri/src/commands/file.rs` — `delete_generated_md` 追加
- `src-tauri/src/lib.rs` — コマンド登録
- `src/features/export/hooks/useBatchDeleteMd.ts` — 新規
- `src/features/export/components/BatchConvertModal.tsx` — モード切替・削除ビュー・確認ダイアログ
- `src/features/export/lib/collectConvertibleFiles.ts` — `pruneTreeByHasMd` 追加
- `src/shared/i18n/locales/ja/common.json`, `.../en/common.json` — 文言追加
- (必要に応じて) `BatchConvertModal.css` — 確認ダイアログ・モード切替の最小スタイル

## 8. スコープ外 (YAGNI)

- ソースファイル自体の削除 (今回は生成 `.md` のみ)。
- 完全削除オプション (今回はゴミ箱移動のみ)。
- 削除のアンドゥ機能 (OS のゴミ箱で代替)。
