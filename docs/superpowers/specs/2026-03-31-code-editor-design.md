# Code Editor with Monaco Editor

**Date:** 2026-03-31
**Status:** Approved

## Summary

Markdown以外のテキストファイル（`.bas`, `.cls`, `.py`, `.js`, `.json` 等）を開いた際に、プレビューパネルを非表示にし、Monaco Editorによる全幅のコードエディタを表示する。

## Background

VBAエクスポート後の `.bas`/`.cls` ファイルを選択すると、現在はMarkdown用のtextarea+プレビューが表示されるが、VBAコードに対してMarkdownプレビューは無意味。コード編集にはシンタックスハイライト・検索・置換を備えた本格的なコードエディタが必要。

## Design

### File Type Routing

ファイル選択時の表示ルーティング:

| File Type | View |
|-----------|------|
| `.md` | 既存 textarea + Markdown preview（変更なし） |
| Office (`.docx`, `.xlsx`, `.xlsm`, `.xlam`, `.pdf`) | 既存 OfficePreview（変更なし） |
| Image (`.png`, `.jpg`, `.gif`, `.bmp`, `.svg`, `.webp`) | 既存 ImageCanvas（変更なし） |
| Mindmap (`.km`, `.xmind`) | 既存 MindmapEditor（変更なし） |
| Video (`.video.json`) | 既存 VideoPanel（変更なし） |
| **その他すべてのテキストファイル** | **Monaco Editor（全幅）** |

### 判定ロジック

`App.tsx` の `handleFileSelect` で、既存の専用ビューに該当しないテキストファイルをコードファイルとして判定する。新規ヘルパー関数 `isCodeFile(path)` を追加。

```typescript
// 既存の専用ビューに該当しない、かつバイナリでないファイル
function isCodeFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return false;
  if (getOfficeExt(lower)) return false;
  if (getMindmapExt(lower)) return false;
  if (getImageExt(lower)) return false;
  if (getPdfExt(lower)) return false;
  if (lower.endsWith(".video.json")) return false;
  return true;  // それ以外はすべてコードエディタ
}
```

### Monaco Editor Component

新規コンポーネント `src/features/code-editor/components/CodeEditorPanel.tsx`:

- **ライブラリ:** `@monaco-editor/react` (React用Monaco Editorラッパー)
- **言語検出:** ファイル拡張子から自動判定（Monaco組み込み）
- **機能:**
  - シンタックスハイライト（多言語対応）
  - 検索・置換 (Ctrl+F / Ctrl+H — Monaco組み込み)
  - 行番号表示
  - ミニマップ
  - 自動インデント
  - 括弧マッチング
- **テーマ:** アプリのテーマ（ダーク/ライト）に連動
  - ダーク系テーマ → `vs-dark`
  - ライト系テーマ → `vs`

### Language Mapping

拡張子からMonaco言語IDへのマッピング:

| Extension | Monaco Language |
|-----------|----------------|
| `.bas` | `vb` |
| `.cls` | `vb` |
| `.py` | `python` |
| `.js`, `.mjs`, `.cjs` | `javascript` |
| `.ts`, `.mts`, `.cts` | `typescript` |
| `.tsx` | `typescript` |
| `.jsx` | `javascript` |
| `.json` | `json` |
| `.yaml`, `.yml` | `yaml` |
| `.toml` | `ini` |
| `.xml` | `xml` |
| `.html`, `.htm` | `html` |
| `.css` | `css` |
| `.scss` | `scss` |
| `.sql` | `sql` |
| `.rs` | `rust` |
| `.go` | `go` |
| `.java` | `java` |
| `.c`, `.h` | `c` |
| `.cpp`, `.hpp` | `cpp` |
| `.cs` | `csharp` |
| `.sh`, `.bash` | `shell` |
| `.ps1` | `powershell` |
| `.rb` | `ruby` |
| `.php` | `php` |
| `.lua` | `lua` |
| `.r` | `r` |
| `.swift` | `swift` |
| `.kt` | `kotlin` |
| `.dart` | `dart` |
| その他 | `plaintext` |

### State Management (Tab Store Integration)

既存の `tab-store.ts` に統合:

- `Tab` に `isCodeFile?: boolean` フラグを追加
- `content` フィールド（既存）にファイル内容を格納
- `dirty` フラグ（既存）で未保存状態を管理
- Monaco内蔵のUndo/Redoを使用（tab-storeのundoStack/redoStackは不使用）

### UI Layout Changes

`App.tsx` のレイアウト制御:

```
コードファイル選択時:
┌─────────┬──────────────────────────────┐
│LeftPanel│   CodeEditorPanel (全幅)      │
│         │   Monaco Editor               │
│         │                               │
│         │                               │
└─────────┴──────────────────────────────┘

Markdownファイル選択時 (変更なし):
┌─────────┬──────────────┬───────────────┐
│LeftPanel│ EditorPanel  │ PreviewPanel  │
│         │ (textarea)   │ (HTML)        │
└─────────┴──────────────┴───────────────┘
```

- `isCodeFile` が true の場合: `EditorPanel` と `PreviewPanel` を非表示、`CodeEditorPanel` を全幅で表示
- 既存の `showEditor` / `showPreview` の状態とは独立して制御

### Save Integration

- Ctrl+S はアプリレベルでハンドリング（既存）
- 保存時に Monaco の現在の値を取得して `invoke("write_text_file")` で書き込み
- 保存後 `dirty` フラグをリセット

### File Reading

- `handleFileSelect` でコードファイルの場合は `invoke("read_text_file")` でテキスト読み込み（Markdown と同じ流れ）
- `openTab()` で `isCodeFile: true` を設定

## Out of Scope

- 自動保存
- フォーマッタ連携（Prettier等）
- LSP連携
- 複数ファイルのスプリットビュー
- ターミナル統合
- Git diff表示

## Dependencies

- `@monaco-editor/react` — npm パッケージ
- `monaco-editor` — ピア依存
