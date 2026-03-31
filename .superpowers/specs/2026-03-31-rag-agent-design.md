# RAG Agent Design Spec

## Overview

OpenCodeのデフォルトエージェント「rag」を追加する。ベクトルDB（SQLite）を活用した高精度なドキュメント検索で質問に回答し、インデックス未作成時はOpenCode組み込みツールでフォールバック検索する。必要に応じてMCPツール（Web検索等）も自律的に活用し、ユーザーの依頼があればファイル作成・編集も行う。

## Architecture

```
ユーザー質問 → OpenCode "rag" エージェント → LLM
  ├─ rag_search (カスタムツール) → SQLite ベクトルDB（複数DB横断検索）
  ├─ read / glob / grep / write / edit (組み込みツール) → ファイルシステム
  ├─ MCP ツール (Web検索等) → 外部サービス
  └─ 回答生成（ソース明示）
```

## File Structure

| ファイル | 役割 |
|---------|------|
| `.opencode/tools/rag_search.ts` | カスタムツール。埋め込み生成 + SQLite横断検索 |
| `.opencode/prompts/rag.md` | エージェントプロンプト（モード切替対応） |
| `src/features/opencode-config/lib/builtin-registry.ts` | ビルトイン定義の一元管理 |
| `src/features/opencode-config/components/sections/AgentsSection.tsx` | UI改修（ビルトイン追加ボタン・バッジ） |
| `src/features/opencode-config/components/sections/CommandsSection.tsx` | 共通パターン適用 |
| `src/features/opencode-config/components/sections/McpSection.tsx` | 共通パターン適用 |
| `src/features/opencode-config/components/sections/SkillsSection.tsx` | 共通パターン適用 |
| `src/features/opencode-config/hooks/useOpencodeChat.ts` | Planトグル → エージェントドロップダウンに変更 |
| `src/features/opencode-config/components/OpencodeChat.tsx` | チャットUI: ドロップダウン表示 |

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
        "bash": false
      }
    }
  }
}
```

明示的に制限するのは `bash` のみ。read / write / edit / glob / grep / MCP等は全て利用可能とし、プロンプトで行動方針を制御する。

## Custom Tool: `rag_search`

### Definition

`.opencode/tools/rag_search.ts` に配置。`@opencode-ai/plugin` の `tool()` ヘルパーで定義。

### Arguments

- `query` (string, required): 検索クエリ
- `top_k` (number, optional, default 5): 返却する上位チャンク数
- `min_score` (number, optional, default 0.1): 最低スコア閾値

### Processing Flow

1. クエリ文字列を埋め込みベクトルに変換
2. `{app_data_dir}/rag/` 配下の全サブフォルダを走査し、すべての `.db` ファイルを検出
3. 各DBに対してコサイン類似度検索を実行
4. 全DBの結果を統合し、スコア順にソート
5. 上位チャンクを返却: `{ file, heading, content, score, line_number, db_source }`

### Embedding

- `@huggingface/transformers` を使用
- 既存フロントエンドと同じモデル（設定から読み取り、デフォルト: `Xenova/multilingual-e5-base`）
- 初回ロード後はプロセス内でキャッシュ

### Database Access

- Bun/Nodeから直接SQLiteを読み取り（`better-sqlite3` または Bun組み込みSQLite）
- 既存Tauri側（`rag.rs`）と同じDBファイルを参照
- DBパス: `{app_data_dir}/rag/` 配下のすべての `.db` ファイル（サブフォルダを再帰的に走査）
- 複数DBの横断検索を実行し、結果をスコア順に統合

### Index Not Found Fallback

`{app_data_dir}/rag/` に `.db` ファイルが1つも見つからない場合、以下のメッセージをLLMに返却:

> 「RAGインデックスが未作成です。組み込みのファイル検索ツール（glob, grep, read）を使って検索してください。精度向上にはmdiumのRAG設定画面でインデックスを作成することを推奨します。」

LLMがOpenCodeの組み込みツールでplanモード同等のファイル探索を行う。

## Prompt Design

### File: `.opencode/prompts/rag.md`

### Content

```markdown
あなたはRAGドキュメント検索エージェントです。

## 基本動作
- ユーザーの質問に対し、rag_searchツールでベクトルDBを検索してください
- 必要に応じてglob, grep, readツールでファイルを直接確認してください
- 複数回の検索・読み取りを組み合わせて総合的に判断してください
- 回答にはソース（ファイル名・行番号）を必ず明示してください

## ツール使用方針
- まず rag_search で関連情報を検索
- 詳細が必要なら read でファイル全文を確認
- ローカル検索で十分な情報が得られない場合、MCP経由のWeb検索も活用してよい
- ユーザーが明示的に依頼した場合のみ、write/edit でファイル作成・編集を行ってよい

## モード
[mode:faithful]
- 検索結果に基づいて正確に回答してください
- 情報が見つからない場合は正直に「見つかりませんでした」と回答してください
- 推測や一般知識での補完はしないでください

<!-- advisor モードを使う場合は上の行を [mode:advisor] に変更
- 検索結果を基盤にしつつ、一般知識も交えて補足・提案してください
- 検索結果由来の情報と一般知識を明確に区別して提示してください
-->
```

### Modes

- **faithful（デフォルト）**: 検索結果に基づいて正確に回答。ソースを必ず明示。情報がなければ「見つかりませんでした」と正直に回答
- **advisor**: 検索結果を基盤にしつつ、一般知識も交えて補足・提案する。検索結果と一般知識を区別して提示

### Mode Switching

ユーザーがエージェント設定画面でプロンプト内の `[mode:faithful]` を `[mode:advisor]` に変更。プロンプト全体の自由編集も可能。

## Agent Selection UI

### 変更: Plan トグル → エージェントドロップダウン

現在の Plan トグル（ON/OFF）を、エージェント選択ドロップダウンに変更する。

**ドロップダウン選択肢:**
- **Default** — エージェントなし（通常のOpenCodeチャット）
- **Plan** — 既存のplanエージェント
- **RAG** — 新規ragエージェント
- （ユーザー定義エージェントも表示）

**配置:** 現在のPlanトグルと同じ位置（チャットツールバー内）

**動作:**
- 選択したエージェントが `session.promptAsync` の `agent` パラメータに渡される
- `@rag` メンション入力でも一時的にエージェントを切り替え可能（既存機能）

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

- `bash` のみ明示的に無効化（意図しないコマンド実行を防止）
- write / edit はプロンプトで制御（ユーザーが明示的に依頼した場合のみ使用）
- MCP ツールはLLMが必要と判断した場合に自律的に使用（Web検索等）
- `rag_search` のファイルアクセスはDB読み取りのみ
