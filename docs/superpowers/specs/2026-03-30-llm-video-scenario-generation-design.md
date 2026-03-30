# LLMによるビデオシナリオ生成コマンド設計

## 概要

現在 `convertMdToVideoProject()` で機械的に行っているMarkdown→VideoProject JSON変換を、OpenCodeビルトインコマンド `/generate-video` によるLLMベースの変換に置き換える。LLMがMarkdownの内容を理解し、適切なシーン分割・自然なナレーション・最適なアニメーション/トランジション選択を含むVideoProject全体を生成する。

## UXフロー

```
▷ボタンクリック
  ↓
既存 .video.json チェック
  ↓
[存在しない場合]
  チャットパネルにフォーカス（未接続なら自動接続）
  チャット入力に `/generate-video <md-path> {basename}.video.json` をセット

[存在する場合]
  確認ダイアログ「既存のビデオ設定を上書きしますか？」
    [はい]     → `/generate-video <md-path> {basename}.video.json`
    [いいえ]   → `/generate-video <md-path> {basename_YYYYMMDDHHmmss}.video.json`
    [キャンセル] → 終了
  ↓
ユーザーがEnterでコマンド実行
  ↓
OpenCodeサーバーがLLMを実行（ストリーミング表示）
  → コマンド未登録の場合: チャット上にエラーメッセージ表示
  → 正常: LLMがMD読み込み→VideoProject JSON生成→output pathに書き出し
  ↓
コマンド完了検知 → output pathの .video.json を自動オープン → VideoPanel表示
```

### 出力パスの例

`report.md` の場合:
- はい（上書き）→ `report.video.json`
- いいえ（新規）→ `report_20260330143025.video.json`

## アーキテクチャ

### 実装パターン

既存の `builtin-skills.ts`, `builtin-mcp-servers.ts` と同じパターンで `builtin-commands.ts` を新規作成する。

### 新規ファイル

#### `src/features/opencode-config/lib/builtin-commands.ts`

`BUILTIN_COMMANDS` レコードに `generate-video` コマンドを定義する。

```typescript
import type { BuiltinCommand } from "@/shared/types";

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  "generate-video": {
    name: "generate-video",
    description: "Convert Markdown to VideoProject JSON with AI-powered scene splitting and narration",
    template: `...（後述のプロンプトテンプレート全文）`,
  },
};
```

### 型定義追加

#### `src/shared/types/index.ts`

```typescript
export interface BuiltinCommand {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
}
```

### 変更ファイル

#### `src/features/preview/components/PreviewPanel.tsx`

`handleEnterVideoMode` を以下のように変更:

1. 既存の `convertMdToVideoProject()` / `mergeWithSavedProject()` の直接呼び出しを削除
2. 既存 `.video.json` の存在チェック（Tauri `video_load_project` で確認）
3. 存在する場合: 3択確認ダイアログ表示
4. outputパスの決定（上書き or タイムスタンプ付き新規）
5. チャットパネルにフォーカス移動
6. チャット入力に `/generate-video <md-path> <output-path>` をセット

#### `src/features/opencode-config/hooks/useOpencodeChat.ts`

コマンド完了後の自動オープン:

1. `/generate-video` コマンド実行時に第2引数（outputパス）を記憶
2. SSEイベントでコマンド完了を検知
3. 記憶したoutputパスを `onOpenFile()` で自動オープン

#### コマンド登録ロジック

ビルトインスキル・MCPサーバーの登録処理と同じ場所で、`BUILTIN_COMMANDS` をOpenCode設定に自動書き込みする。

#### `src/shared/i18n/locales/*/video.json`

確認ダイアログのテキスト追加:
- `overwriteDialogTitle`: "既存のビデオ設定を上書きしますか？"
- `overwriteDialogYes`: "はい"
- `overwriteDialogNo`: "いいえ"
- `overwriteDialogCancel`: "キャンセル"

## コマンドプロンプトテンプレート

`generate-video` コマンドのテンプレートに含める内容:

### 実行手順

1. 第1引数のMarkdownファイルを読み込む
2. 内容を分析し、VideoProject JSONを生成する
3. 第2引数のパスにJSONファイルを書き出す

### シーン分割ルール

- `<!-- pagebreak -->` マーカーがあればシーン境界として尊重する
- マーカーがなければ、見出し（h1/h2）やトピックの切り替わりで自動分割
- 1シーンあたりナレーション30〜60秒程度を目安にする
- 情報量が多すぎるシーンは分割、少なすぎるシーンは統合

### ナレーションルール

- `<!-- narration: テキスト -->` マーカーがあればそのシーンのナレーションとして使用
- マーカーがなければ、内容を自然な語り口で要約したナレーションを作成
- ソースコンテンツと同じ言語で記述する
- プレゼンターが話すような自然な口調

### 画像の取り込みルール

- Markdown内の画像（`![alt](path)` や `<img>` タグ）はImageElementとして取り込む
- 相対パスはMarkdownファイルのディレクトリ基準で絶対パスに解決する
- position: 画像単体なら `"center"`、テキストと並ぶなら `"left"` or `"right"`
- animation: 内容に応じて `fade-in` / `zoom-in` / `ken-burns` を選択
- 背景画像として使うべきものは position: `"background"` を指定

### アニメーション・トランジション選択ガイド

- 内容の流れに合ったトランジションを選択
- タイトルシーンは `fade`、説明の続きは `none` or `slide-left`
- 箇条書きは `sequential`、コードブロックは `fade-in`
- 不必要に派手にしない

### メタ情報ガイド

- `title`: ドキュメントの主見出しから取得
- デフォルト: `1920x1080`, `16:9`, `30fps`
- 縦型コンテンツの場合は `9:16` を検討

### VideoProject JSONスキーマ

プロンプトテンプレートには `src/features/video/types.ts` の全型定義をそのまま埋め込み、LLMが正確なスキーマに従えるようにする。含める型:

- `VideoProject`, `VideoMeta`, `AspectRatio`
- `AudioConfig`, `BgmConfig`, `TTSConfig`, `TTSProviderName`
- `Scene`, `TransitionConfig`, `TransitionType`, `CaptionsConfig`
- `SceneElement` (全6種: `TitleElement`, `TextElement`, `BulletListElement`, `ImageElement`, `TableElement`, `CodeBlockElement`)
- デフォルト値: `DEFAULT_META`, `DEFAULT_TRANSITION`, `DEFAULT_TTS_CONFIG`

## 設計判断の根拠

| 判断 | 理由 |
|------|------|
| ビルトインコマンド方式 | ユーザー要望に忠実。`/generate-video` として手動実行も可能。既存パターン（builtin-skills/mcp-servers）と統一 |
| チャットUI経由の実行 | ストリーミング表示でLLMの進捗が見える。ユーザーがEnterで実行タイミングを制御できる |
| `<output>` 引数 | コマンド完了後に開くべきファイルパスが明示的。自動オープンのロジックがシンプル |
| 3択ダイアログ | 上書き/新規生成/キャンセルの柔軟な選択。タイムスタンプ付き新規でデータ損失を防止 |
| マーカーをヒントとして尊重 | 既存のワークフローとの後方互換性。マーカーがなくてもLLMが適切に判断 |
| VideoProject全体をLLMが生成 | meta, audio, transitions, animations含め最適化。手動調整は生成後にVideoPanelで可能 |
