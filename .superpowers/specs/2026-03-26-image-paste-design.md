# 画像ペースト機能 設計書

## 概要

MDエディタでCtrl+Vを押した際、クリップボードに画像がある場合に、画像ファイルを自動保存しMarkdownリンクを挿入する機能。

## 要件

- **テキスト優先**: クリップボードにテキストと画像の両方がある場合、テキストを貼り付ける
- **画像形式**: 常にPNGとして保存
- **保存先**: MDファイルと同階層の `images/` サブフォルダ
- **ファイル名**: `image-YYYYMMDD-HHmmss.png`（タイムスタンプベース）
- **altテキスト**: ダイアログでユーザー入力。AIによる自動生成オプション付き（sparkleアイコン）
- **AI説明言語**: アプリのi18n言語設定に従う
- **未保存ファイル**: `filePath` がない場合は画像貼り付け不可（トースト通知）

## アーキテクチャ

アプローチA（フロントエンド完結型）を採用。画像保存は `@tauri-apps/plugin-fs` で行い、AI Vision対応のみRust側に新コマンドを追加する。

**Tauriパーミッション**: 既存の `default.json` に `fs:write-all`, `fs:allow-mkdir`（scope `**`）が設定済みのため、追加のパーミッション変更は不要。

## 処理フロー

```
Ctrl+V (onPaste)
  → clipboardData.items をチェック
  → テキストあり → デフォルト動作（テキスト貼り付け）
  → テキストなし & 画像あり → e.preventDefault()
    → activeTab.filePath がない → トースト通知で中断
    → 画像 Blob を取得
    → ImagePasteDialog を表示
      → ユーザーが alt テキストを入力（任意）
      → オプション: AI sparkle ボタンで画像説明を自動生成
    → キャンセル → 何もしない
    → 挿入 →
      1. mkdir(imagesDir, { recursive: true })
      2. Blob → Uint8Array → writeFile(savePath, data)
      3. カーソル位置に ![alt](images/image-YYYYMMDD-HHmmss.png) を挿入
```

## コンポーネント設計

### 1. useImagePaste フック

**ファイル**: `src/features/editor/hooks/useImagePaste.ts`

**責務**:
- onPaste イベントハンドラ
- クリップボードからの画像 Blob 抽出
- テキスト優先判定
- 画像保存処理（mkdir + writeFile）
- タイムスタンプファイル名生成
- Markdownリンク文字列の生成とカーソル位置への挿入

**インターフェース**:
```typescript
interface UseImagePasteParams {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  filePath: string | null;
  onContentChange: (newContent: string) => void;
}

interface UseImagePasteReturn {
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  pasteDialogState: {
    visible: boolean;
    imageBlob: Blob | null;
    imageUrl: string | null;  // URL.createObjectURL for preview
    cursorPos: number;
  } | null;
  closePasteDialog: () => void;
  confirmPaste: (altText: string) => Promise<void>;
}
```

### 2. ImagePasteDialog コンポーネント

**ファイル**: `src/features/editor/components/ImagePasteDialog.tsx`

**責務**:
- 画像プレビュー表示（`URL.createObjectURL`）
- altテキスト入力フィールド
- AI生成 sparkle ボタン（Git commit UIと同パターン）
- 挿入 / キャンセルボタン
- クリーンアップ: ダイアログ閉じ時に `URL.revokeObjectURL` でメモリ解放（`closePasteDialog` 内で実行）

**UI構成**:
```
┌─────────────────────────────────┐
│  画像貼り付け                     │
│                                 │
│  [画像プレビュー (サムネイル)]      │
│                                 │
│  alt テキスト:                    │
│  ┌───────────────────────┬──┐  │
│  │                       │✨│  │
│  └───────────────────────┴──┘  │
│                                 │
│  [キャンセル]     [挿入]          │
└─────────────────────────────────┘
```

**スタイル**: `ImagePasteDialog.css` — 既存 `AiGenerateModal.css` と同様のパターン

**操作**:
- Enter キーで挿入
- Escape キーでキャンセル
- altテキスト空でも挿入可（`![](images/...)` になる）

### 3. AI画像説明生成（sparkleボタン）

**フロントエンド側**:
- 画像 Blob → `FileReader.readAsDataURL()` → base64文字列を取得
- `data:image/png;base64,` プレフィックスをフロントエンドで除去し、純粋なbase64データのみをRustに送信
- `invoke("ai_chat_with_image", { req })` でRustコマンド呼び出し
- レスポンスをaltテキスト入力欄に挿入
- AI設定未構成の場合はsparkleボタン非活性
- 挿入ボタンも保存中は非活性にし、ローディング表示する

**Rustコマンド** (`ai_chat_with_image`):

**ファイル**: `src-tauri/src/commands/ai.rs`

**リクエスト構造体**:
```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatWithImageRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub api_format: String,
    #[serde(default)]
    pub azure_api_version: String,
    pub system_prompt: String,
    pub user_message: String,
    pub image_base64: String,  // 純粋なbase64データ（data:プレフィックスはフロントエンドで除去済み）
}
```

**base64データの扱い**:
- フロントエンドが `data:image/png;base64,` プレフィックスを除去して純粋なbase64を送信
- Rust側で各APIフォーマットに合わせて適切な形式に組み立てる
  - OpenAI/Azure: `data:image/png;base64,` を先頭に付与して `image_url.url` に設定
  - Anthropic: 純粋なbase64をそのまま `source.data` に設定

**APIフォーマット別メッセージ構築**:

OpenAI:
```json
{
  "messages": [
    { "role": "system", "content": "システムプロンプト" },
    { "role": "user", "content": [
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } },
      { "type": "text", "text": "ユーザーメッセージ" }
    ]}
  ],
  "max_tokens": 256
}
```

Azure:
```json
{
  "messages": [
    { "role": "system", "content": "システムプロンプト" },
    { "role": "user", "content": [
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } },
      { "type": "text", "text": "ユーザーメッセージ" }
    ]}
  ],
  "max_completion_tokens": 256
}
```
※ AzureはURL・ヘッダーも既存 `ai_chat` と同じAzure固有パターンに従う

Anthropic:
```json
{
  "system": "システムプロンプト",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } },
      { "type": "text", "text": "ユーザーメッセージ" }
    ]
  }],
  "max_tokens": 256
}
```

**実装方針**: 既存の `ai_chat` と HTTP クライアント生成・URL構築・ヘッダー設定・レスポンスパースのロジックが共通するため、共通部分をヘルパー関数に抽出して `ai_chat` と `ai_chat_with_image` で共有する。

- システムプロンプト: i18n言語設定に応じて切り替え
  - ja: 「画像のalt属性に使用する簡潔な説明を1文で返してください」
  - en: "Return a concise one-sentence description for use as an image alt attribute."

### 4. EditorPanel.tsx の変更

- `useImagePaste` フックを呼び出し
- `<textarea>` に `onPaste={handlePaste}` を追加
- `ImagePasteDialog` のレンダリング追加（`pasteDialogState.visible` で制御）

### 5. コマンド登録

**ファイル**: `src-tauri/src/lib.rs`

- `ai_chat_with_image` コマンドを `.invoke_handler()` に登録

## i18n

**`src/shared/i18n/locales/ja/editor.json`** に追加:
```json
{
  "imagePaste": "画像貼り付け",
  "imagePasteAlt": "alt テキスト",
  "imagePasteInsert": "挿入",
  "imagePasteAiGenerate": "AIで説明を生成",
  "imagePasteNoFile": "ファイルを保存してから画像を貼り付けてください",
  "imagePasteError": "画像の保存に失敗しました"
}
```

**`src/shared/i18n/locales/en/editor.json`** に追加:
```json
{
  "imagePaste": "Paste Image",
  "imagePasteAlt": "Alt text",
  "imagePasteInsert": "Insert",
  "imagePasteAiGenerate": "Generate description with AI",
  "imagePasteNoFile": "Save the file before pasting images",
  "imagePasteError": "Failed to save image"
}
```

## ファイル変更一覧

| ファイル | 変更種別 |
|---|---|
| `src/features/editor/hooks/useImagePaste.ts` | 新規 |
| `src/features/editor/components/ImagePasteDialog.tsx` | 新規 |
| `src/features/editor/components/ImagePasteDialog.css` | 新規 |
| `src/features/editor/components/EditorPanel.tsx` | 変更（onPaste + Dialog追加） |
| `src-tauri/src/commands/ai.rs` | 変更（Vision対応コマンド追加） |
| `src-tauri/src/lib.rs` | 変更（コマンド登録） |
| `src/shared/i18n/locales/ja/editor.json` | 変更（翻訳キー追加） |
| `src/shared/i18n/locales/en/editor.json` | 変更（翻訳キー追加） |

## エラーハンドリング

- **未保存ファイル**: `filePath` なし → トースト通知、処理中断
- **mkdir失敗**: エラーメッセージ表示
- **writeFile失敗**: エラーメッセージ表示
- **AI生成失敗**: ダイアログ内にエラー表示、手動入力にフォールバック
- **AI設定未構成**: sparkleボタン非活性（ツールチップで説明）
