# RAG Agent Design Spec

## Overview

OpenCodeのデフォルトエージェント「rag」を追加する。ベクトルDB（SQLite）を活用した高精度なドキュメント検索で質問に回答し、インデックス未作成時はOpenCode組み込みツールでフォールバック検索する。

## Architecture

```
ユーザー質問 → OpenCode "rag" エージェント → LLM
  ├─ rag_search (カスタムツール) → SQLite ベクトルDB
  ├─ read / glob / grep (組み込みツール) → ファイルシステム
  └─ 回答生成（ソース明示）
```

## File Structure

| ファイル | 役割 |
|---------|------|
| `.opencode/tools/rag_search.ts` | カスタムツール。埋め込み生成 + SQLite検索 |
| `.opencode/prompts/rag.md` | エージェントプロンプト（モード切替対応） |
| `src/features/opencode-config/lib/builtin-registry.ts` | ビルトイン定義の一元管理 |
| `src/features/opencode-config/components/sections/AgentsSection.tsx` | UI改修（ビルトイン追加ボタン・バッジ） |
| `src/features/opencode-config/components/sections/CommandsSection.tsx` | 共通パターン適用 |
| `src/features/opencode-config/components/sections/McpSection.tsx` | 共通パターン適用 |
| `src/features/opencode-config/components/sections/SkillsSection.tsx` | 共通パターン適用 |

## Agent Definition

`opencode.jsonc` に登録される定義:

```jsonc
{
  "agents": {
    "rag": {
      "description": "RAG - ドキュメント検索エージェント",
      "mode": "all",
      "prompt": "{file:.opencode/prompts/rag.md}",
      "tools": {
        "rag_search": true,
        "read": true,
        "glob": true,
        "grep": true,
        "write": false,
        "edit": false,
        "bash": false
      }
    }
  }
}
```

## Custom Tool: `rag_search`

### Definition

`.opencode/tools/rag_search.ts` に配置。`@opencode-ai/plugin` の `tool()` ヘルパーで定義。

### Arguments

- `query` (string, required): 検索クエリ
- `top_k` (number, optional, default 5): 返却する上位チャンク数
- `min_score` (number, optional, default 0.1): 最低スコア閾値

### Processing Flow

1. クエリ文字列を埋め込みベクトルに変換
2. SQLiteのベクトルDBでコサイン類似度検索
3. 上位チャンクを返却: `{ file, heading, content, score, line_number }`

### Embedding

- `@huggingface/transformers` を使用
- 既存フロントエンドと同じモデル（設定から読み取り、デフォルト: `Xenova/multilingual-e5-base`）
- 初回ロード後はプロセス内でキャッシュ

### Database Access

- Bun/Nodeから直接SQLiteを読み取り（`better-sqlite3` または Bun組み込みSQLite）
- 既存Tauri側（`rag.rs`）と同じDBファイルを参照
- DBパス: `{app_data_dir}/rag/{folder_hash}.db`
- `context.worktree` のパスからハッシュを計算し、Rust側と同じロジックでDBファイルを特定

### Index Not Found Fallback

インデックス未作成時、以下のメッセージをLLMに返却:

> 「RAGインデックスが未作成です。組み込みのファイル検索ツール（glob, grep, read）を使って検索してください。精度向上にはmdiumのRAG設定画面でインデックスを作成することを推奨します。」

LLMがOpenCodeの組み込みツール（read, glob, grep）でplanモード同等のファイル探索を行う。

## Prompt Design

### File: `.opencode/prompts/rag.md`

#### Structure

1. **ベースルール**: RAG検索エージェントとしての基本動作定義
2. **モード指示**: `[mode:faithful]` または `[mode:advisor]`
3. **ツール使用ガイドライン**: ツールの使い分け指針

#### Modes

- **faithful（デフォルト）**: 検索結果に基づいて正確に回答。ソースを必ず明示。情報がなければ「見つかりませんでした」と正直に回答
- **advisor**: 検索結果を基盤にしつつ、一般知識も交えて補足・提案する。検索結果と一般知識を区別して提示

#### Mode Switching

ユーザーがエージェント設定画面でプロンプト内の `[mode:faithful]` を `[mode:advisor]` に変更。プロンプト全体の自由編集も可能。

## Auto-Registration

### Trigger

アプリ起動時、`ensureOpencodeServer()` 完了後に実行。

### Flow

1. プロジェクトの `opencode.jsonc` を読み込み
2. `agents.rag` が存在しなければデフォルト定義を書き込み
3. `.opencode/tools/rag_search.ts` が存在しなければ生成
4. `.opencode/prompts/rag.md` が存在しなければ生成

### Re-addition

削除後もUI上の「+ Built-in」ボタンからデフォルト設定で再追加可能。

## Built-in UI Pattern (Common)

Agents / Commands / MCP / Skills の全セクションで統一するUI共通パターン。

### List Display

- ビルトインアイテムには `Built-in` バッジを表示
- ユーザー追加アイテムと視覚的に区別
- 削除は通常のUI操作で可能（ビルトインでも同じ）

### Add Flow

- 「+ Add」ボタンの横に「+ Built-in」ボタンを配置
- 押下 → 未追加のビルトインアイテム一覧をドロップダウン/ダイアログで表示
- 選択するとデフォルト設定で追加

### Registry

`src/features/opencode-config/lib/builtin-registry.ts` にビルトイン定義を一元管理:

```typescript
export const BUILTIN_AGENTS = {
  rag: { /* デフォルト定義 */ }
};
export const BUILTIN_COMMANDS = {};  // 今後追加
export const BUILTIN_MCP = {};       // 今後追加
export const BUILTIN_SKILLS = {};    // 今後追加
```

### Deletion

通常のUI操作で `opencode.jsonc` から削除。ツールファイル・プロンプトファイルはそのまま残す。

## Safety

- `write`, `edit`, `bash` ツールを明示的に無効化（読み取り専用エージェント）
- `rag_read_file` は不要（組み込み `read` を使用）
- `rag_list_dir` は不要（組み込み `glob` を使用）
- `rag_search` のファイルアクセスはDB読み取りのみ
