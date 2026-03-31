# Excel マクロ エクスポート/インポート 設計仕様

## 概要

`.xlsm` / `.xlam` ファイルのプレビューパネルに「マクロのエクスポート」「マクロのインポート」ボタンを追加し、VBA マクロモジュールをファイルとして保存・編集・再取り込みできるようにする。

### 目的

- opencode 等のエディタ/AI エージェントで VBA マクロをテキスト編集可能にする
- 編集後のマクロを Excel ファイルに安全に書き戻す

### 対象ファイル形式

- `.xlsm` (マクロ有効ブック)
- `.xlam` (Excel アドイン)

### エクスポート対象モジュール

- 標準モジュール → `.bas`
- クラスモジュール → `.cls`
- ドキュメントモジュール (`ThisWorkbook`, `Sheet1` 等) → `.cls`

### 対象外 (初期スコープ)

- ユーザーフォーム (`.frm` + `.frx`)
- 新規モジュールの追加 (既存モジュールの差し替えのみ)
- VBA プロジェクトのパスワード保護解除
- `.xlsx` → `.xlsm` への変換

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  フロントエンド (React/TypeScript)                     │
│                                                       │
│  PreviewPanel.tsx                                     │
│    convert-bar に「マクロのエクスポート」              │
│               「マクロのインポート」ボタン追加          │
│         (.xlsm / .xlam の場合のみ表示)                │
│                                                       │
│  エクスポート: invoke("extract_vba_modules", {path})  │
│  インポート:  invoke("inject_vba_modules", {path, dir})│
└──────────────────────┬────────────────────────────────┘
                       │ Tauri IPC
┌──────────────────────▼────────────────────────────────┐
│  バックエンド (Rust)                                    │
│                                                       │
│  extract_vba_modules(xlsm_path)                       │
│    1. ZIP展開 → xl/vbaProject.bin 取得                │
│    2. cfb クレートで OLE2 パース                       │
│    3. VBA圧縮ストリーム解凍                            │
│    4. モジュールごとに .bas/.cls ファイル書き出し       │
│    → 戻り値: { dir, modules: [{name, type, path}] }  │
│                                                       │
│  inject_vba_modules(xlsm_path, macros_dir)            │
│    1. .xlsm.bak にバックアップ                         │
│    2. macros_dir の .bas/.cls ファイル読み込み         │
│    3. vbaProject.bin の対応ストリームをソース差し替え  │
│    4. VBA圧縮 → OLE2 再パック → ZIP 内の bin を置換   │
│    5. .xlsm を上書き保存                              │
│    → 戻り値: { backup_path, updated_modules: [string] }│
└───────────────────────────────────────────────────────┘
```

---

## Rust バックエンド詳細

### 依存クレート

- `zip` — ZIP アーカイブの読み書き
- `cfb` — OLE2 Compound File Binary 形式のパース・書き込み
- `encoding_rs` — Shift_JIS 等のコードページ ⇔ UTF-8 変換

### `extract_vba_modules` コマンド

**入力:**

```rust
{ xlsm_path: String }
```

**出力:**

```rust
{
  macros_dir: String,           // "C:/.../Book1_macros"
  modules: [
    { name: "Module1",   module_type: "standard",  path: "...Module1.bas" },
    { name: "Class1",    module_type: "class",     path: "...Class1.cls" },
    { name: "ThisWorkbook", module_type: "document", path: "...ThisWorkbook.cls" },
    { name: "Sheet1",    module_type: "document",  path: "...Sheet1.cls" },
  ]
}
```

**処理フロー:**

1. `zip` クレートで `.xlsm` を開き、`xl/vbaProject.bin` エントリを読み出す
2. `cfb` クレートで OLE2 として開く
3. `dir` ストリームを解凍・パースしてモジュール一覧 (名前・タイプ・ストリームパス) を取得
4. 各モジュールのストリームを読み出し、VBA 圧縮を解凍してソースコードを取得
5. `{ファイル名}_macros/` ディレクトリを作成し、モジュールごとにファイル書き出し:
   - 標準モジュール → `Module1.bas`
   - クラスモジュール → `Class1.cls`
   - ドキュメントモジュール → `ThisWorkbook.cls`, `Sheet1.cls`
6. 各ファイルの先頭に `Attribute` 行を含める (VBA の標準形式)

### `inject_vba_modules` コマンド

**入力:**

```rust
{ xlsm_path: String, macros_dir: String }
```

**出力:**

```rust
{ backup_path: String, updated_modules: [String] }
```

**処理フロー:**

1. `{xlsm_path}.bak` にファイルコピーでバックアップ
2. `macros_dir` 内の `.bas` / `.cls` ファイルを列挙・読み込み
3. `.xlsm` を ZIP として開き `xl/vbaProject.bin` を取得
4. `cfb` で OLE2 を開き、`dir` ストリームからモジュール名⇔ストリームパスのマッピングを取得
5. ファイル名 (拡張子除く) でモジュールを照合し、ソースコードを VBA 圧縮してストリームに書き戻す
6. 更新した OLE2 をバイト列にシリアライズ
7. ZIP 内の `xl/vbaProject.bin` を置換して `.xlsm` を上書き保存

### 文字エンコーディング

VBA ソースコードは `vbaProject.bin` 内で **コードページ依存のエンコーディング** で格納されている。日本語環境では通常 **Shift_JIS (code page 932)** が使われる。

**エクスポート時:**
1. `dir` ストリーム内の `PROJECTCODEPAGE` レコードからコードページを取得
2. 各モジュールのソースバイト列を、取得したコードページから **UTF-8 に変換** して `.bas` / `.cls` に書き出す
3. ファイルは BOM なし UTF-8 で保存（エディタ/opencode での編集互換性のため）

**インポート時:**
1. `.bas` / `.cls` ファイルを UTF-8 として読み込み
2. エクスポート時に記録したコードページ（または `vbaProject.bin` から再取得）で **UTF-8 → 元のコードページに逆変換**
3. 変換後のバイト列を VBA 圧縮してストリームに書き戻す

**Rust 実装:**
- `encoding_rs` クレートを使用（Shift_JIS, Windows-1252 等の主要コードページに対応）
- コードページ番号 → `encoding_rs::Encoding` へのマッピングテーブルを用意
- 変換不能文字が検出された場合はエラーを返す（黙って `?` に置換しない）

**エクスポートフォルダにコードページ情報を保持:**
- `_macros/` フォルダ内に `.codepage` ファイル（内容: `932` 等の数値）を生成
- インポート時にこのファイルを読み、逆変換に使用
- `.codepage` が存在しない場合は `vbaProject.bin` の `PROJECTCODEPAGE` から取得

### VBA 圧縮/解凍

MS-OVBA 仕様 (MS-OVBA 2.4.1) に基づく実装:

- **解凍:** `CompressedContainer` → `DecompressedChunk` のスライディングウィンドウ方式
- **圧縮:** 逆変換。最長一致検索でトークン列を生成

---

## フロントエンド詳細

### PreviewPanel.tsx の変更

既存の `convert-bar` に `.xlsm` / `.xlam` 判定でボタン2つを追加:

```tsx
{isMacroEnabled && (
  <>
    <button onClick={handleExportMacros} disabled={macroExporting}>
      {macroExporting ? t("exportingMacros") : t("exportMacros")}
    </button>
    <button onClick={handleImportMacros} disabled={macroImporting}>
      {macroImporting ? t("importingMacros") : t("importMacros")}
    </button>
  </>
)}
```

### 判定ロジック

```typescript
const isMacroEnabled =
  activeTab?.filePath?.toLowerCase().endsWith(".xlsm") ||
  activeTab?.filePath?.toLowerCase().endsWith(".xlam");
```

既存の `isXlsx` にも `.xlam` を追加:

```typescript
const isXlsx =
  activeTab?.filePath?.toLowerCase().endsWith(".xlsx") ||
  activeTab?.filePath?.toLowerCase().endsWith(".xlsm") ||
  activeTab?.filePath?.toLowerCase().endsWith(".xlam");
```

### constants.ts の変更

```typescript
export const OFFICE_EXTENSIONS = [".docx", ".xlsx", ".xlsm", ".xlam"];
```

### handleExportMacros

1. `macroExporting = true`
2. `invoke("extract_vba_modules", { xlsmPath: activeTab.filePath })`
3. 成功 → toast で「{N}個のモジュールをエクスポートしました」+ `macros_dir` パス表示
4. ファイルツリーをリフレッシュ (`onRefreshFileTree`)
5. `macroExporting = false`

### handleImportMacros

1. `macroImporting = true`
2. `macros_dir` を `activeTab.filePath` から推定 (`{ファイル名}_macros`)
3. `macros_dir` が存在しない場合 → エラー表示して終了
4. `invoke("inject_vba_modules", { xlsmPath: activeTab.filePath, macrosDir })`
5. 成功 → toast で「{N}個のモジュールをインポートしました (バックアップ: .bak)」
6. `binaryData` を再読み込みしてプレビューを更新
7. `macroImporting = false`

### i18n キー

| キー | ja | en |
|------|----|----|
| `exportMacros` | マクロのエクスポート | Export Macros |
| `importMacros` | マクロのインポート | Import Macros |
| `exportingMacros` | エクスポート中... | Exporting... |
| `importingMacros` | インポート中... | Importing... |
| `macroExportSuccess` | {{count}}個のモジュールをエクスポートしました | Exported {{count}} modules |
| `macroImportSuccess` | {{count}}個のモジュールをインポートしました | Imported {{count}} modules |
| `macroExportNoVba` | このファイルにはVBAマクロが含まれていません | No VBA macros found |
| `macroDirNotFound` | マクロフォルダが見つかりません | Macro folder not found |

---

## エラーハンドリング

### エクスポート時

| ケース | 対応 |
|--------|------|
| `vbaProject.bin` が存在しない | `macroExportNoVba` エラーを表示 |
| `vbaProject.bin` のパースに失敗 | Rust 側でエラーを返し、フロントで表示 |
| 出力先 `_macros/` が既に存在する | 既存ファイルを上書き。新規モジュールは追加、削除はしない |
| ファイルが他プロセスにロック中 | OS のファイルロックエラーをそのまま表示 |

### インポート時

| ケース | 対応 |
|--------|------|
| `_macros/` フォルダが存在しない | `macroDirNotFound` エラー表示 |
| `.bas`/`.cls` ファイルが0個 | 「インポート対象のファイルがありません」エラー |
| ファイル名に対応するモジュールが `vbaProject.bin` に存在しない | スキップし、警告を toast で表示 |
| `.bak` ファイルが既に存在する | 上書きする (直前のバックアップのみ保持) |
| VBA 圧縮後のデータ書き戻しに失敗 | `.bak` から復元する手順をエラーメッセージに含める |

---

## ファイル出力例

```
Book1.xlsm
Book1_macros/
  .codepage          ← コードページ番号 (例: "932")
  Module1.bas
  Class1.cls
  ThisWorkbook.cls
  Sheet1.cls
  Sheet2.cls
```

各ファイルは VBA ソースコードをテキストとして格納。先頭に `Attribute` 行を含む:

```vba
Attribute VB_Name = "Module1"
Sub Hello()
    MsgBox "Hello, World!"
End Sub
```
