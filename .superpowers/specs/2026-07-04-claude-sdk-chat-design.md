# Claude SDK チャット/設定パネル 設計書

日付: 2026-07-04
ステータス: 承認済み(ブレインストーミング完了)

## 目的

opencode統合と同様のチャット/設定UIを、Claude Agent SDK(Claude Code)ベースで提供する。
opencodeとは**完全に独立した別パネル**として追加し、既存のopencode統合には手を入れない。

## 要件

- 位置づけ: 左アクティビティバーの新項目「Claude」。パネル内は chat / settings の2タブ(opencodeパネルと同型)。
- 実行前提: ユーザー環境に `claude` CLI(Claude Code)がインストール・ログイン済み。加えて Node.js が必要(未検出時は案内表示)。
- チャットはMVPから段階的に構築: 送信 / ストリーミング表示 / セッション継続(resume)/ 中断 / ツール実行の可視化。
  - 画像添付・スラッシュ/@補完・使用量表示・セッション一覧は後続フェーズ。
- ツール実行許可: チャット内の許可カードでUI確認(許可/拒否)。
- 設定タブ: 既存の未接続 `claude-config` コンポーネント(MCP/Skills)を接続し、モデル選択・permission mode・CLAUDE.mdルール編集を追加。
- mdium連携: 現在開いているファイルのパス+選択範囲をプロンプトに前置注入するのみ。プレビュー連携(動画生成フロー等)は引き続きopencode担当。
- UI文字列は全てi18n(en/ja)。コードコメントは英語。

## アーキテクチャ(採用案: Nodeサイドカー + 公式 Agent SDK)

```
mdium (Tauri WebView)
  ClaudePanel / useClaudeChat / useClaudeChatStore
        │  Tauriイベント / invoke
Tauri Rust: claude_sidecar.rs(汎用stdioブリッジ)
        │  stdio (JSON Lines)
Nodeサイドカー: claude-sidecar.cjs(esbuildバンドル、リソース同梱)
  @anthropic-ai/claude-agent-sdk の query() をラップ
        │  SDK内部(ユーザーのインストール済み claude CLI を起動)
  Claude API(認証はユーザーの claude CLI のログイン資格情報に従う)
```

### 検討した代替案

- 案B: Rustから `claude --input-format stream-json --output-format stream-json` を直接駆動し、controlプロトコルを自前実装。
  → 準公開のSDK内部ワイヤ形式への依存となり、CLI自動更新での破損リスクを自前で負うため不採用(opencodeでのバージョン乖離バグの再演を回避)。
- 案C: ターン毎に `claude -p --resume <id>` をワンショット起動。
  → 双方向でないため許可プロンプトUI要件と両立しない。不採用。

### プロセス構成の要点

- サイドカーは**開いているフォルダごとに1プロセス**。パネル初回表示時に遅延起動、フォルダを閉じたらkill。
- ビルド時にesbuildでサイドカーコード+SDKのJS部分を単一 `.cjs` にバンドルし、リソースとして同梱。SDKのプラットフォーム別バイナリ(optionalDependencies)は同梱しない(external指定)。実行時は `node <リソースパス>` で起動。
- **エージェント実行ファイルはユーザーのインストール済み claude CLI を利用**: サイドカーが起動時に検出(`where claude` → ネイティブ `.exe` はそのまま、npm版 `.cmd` シムは `node_modules/@anthropic-ai/claude-code/cli.js` を導出)し、`pathToClaudeCodeExecutable` に指定(cli.jsの場合は `executable: "node"` を併用)。検出失敗時は `error {fatal}` でi18n案内を表示。
- 通信はstdioのJSON Linesのみ。**ポート不使用**のため、ポート割当・死活監視・プロキシ迂回(WinINET問題)は構造的に発生しない。
- Rust側 `claude_sidecar.rs` は汎用stdioブリッジ(spawn / stdin 1行書込 / stdout行→Tauriイベントemit / kill)のみ。プロトコル内容には関知しない。既存 `spawn_background_process` はdetached起動でstdioを扱えないため流用しない。
- 認証はユーザーの claude CLI のログイン資格情報(サブスクリプション/APIキー)に従う。mdium側でAPIキーは扱わない。
- 接続時に `node --version` で前提チェック。無ければi18n化した案内を表示。
- リスク: CLI自動更新とSDKバージョンの互換性ズレ。SDKはpackage.jsonでピン留めし、プロトコルエラーは `error` イベントで表面化させる。

## サイドカー通信プロトコル(stdio JSON Lines)

### mdium → サイドカー(stdin)

| type | ペイロード | 説明 |
|---|---|---|
| `start_session` | `{cwd, model, permissionMode, resumeSessionId?, systemPromptAppend?}` | 長寿命の `query()` をストリーミング入力モードで開始 |
| `user_message` | `{text}` | 入力キュー経由で同一セッションに次ターンを投入(ファイルコンテキストはmdium側で前置済み) |
| `permission_response` | `{id, behavior: "allow"\|"deny", updatedInput?, message?}` | 許可カードの回答を `canUseTool` コールバックへ返す |
| `interrupt` | — | 実行中ターンの中断(`query.interrupt()`) |
| `stop` | — | セッション終了。プロセスは次の `start_session` を待機 |

### サイドカー → mdium(stdout)

| type | ペイロード | 説明 |
|---|---|---|
| `sdk_event` | `SDKMessage` そのまま | `system:init`(session_id取得)/ `assistant` / `user`(ツール結果)/ `stream_event`(逐次テキスト)/ `result`(usage) |
| `permission_request` | `{id, toolName, input, suggestions?}` | `canUseTool` 発火時。応答が来るまでSDK側はawaitで待機 |
| `error` | `{message, fatal?}` | SDK例外・認証エラー等 |
| `ready` / `session_closed` | — | 起動完了・セッション終了通知 |

### プロトコル設計方針

- SDKメッセージは**生のまま転送**し、UI用整形はフロントの `claude-message-mapper.ts` に集約。サイドカーは「薄いパイプ+許可仲介」に保ち、SDK更新の影響をmapperに閉じ込める。
- `canUseTool` はSDK仕様上ストリーミング入力モードが必須のため、`query()` は非同期ジェネレータ入力で常駐させ、`user_message` をキューでpushする(ターン毎のプロセス再起動はしない)。
- `permission_request` の `id` はサイドカーが採番し応答と突き合わせ。タイムアウトなし(Claude Code本体と同じ挙動)。
- resume: `system:init` の `session_id` をフロントがフォルダ別に永続化し、次回 `start_session` の `resumeSessionId` に渡す。

## フロントエンド構成

新規ファイルは `src/features/claude-config/` に集約(opencode-configがチャットと設定を同居させるパターンを踏襲)。

```
src/features/claude-config/
├─ components/
│  ├─ ClaudePanel.tsx          # 新規: chat/settings 2タブ(OpencodeConfigPanel相当)
│  ├─ ClaudeChat.tsx           # 新規: メッセージリスト/入力欄/中断ボタン
│  ├─ ToolUseCard.tsx          # 新規: ツール実行の折りたたみ表示
│  ├─ PermissionCard.tsx       # 新規: 許可プロンプト(QuestionsCard相当のUX)
│  ├─ sections/
│  │  ├─ GeneralSection.tsx    # モデル選択 + permission mode(開いているフォルダ別に保存)
│  │  └─ RulesSection.tsx      # CLAUDE.md編集(グローバル/プロジェクト)
│  ├─ McpServersTab.tsx        # 既存を接続(設定タブ「MCP」)
│  └─ SkillsTab.tsx            # 既存を接続(設定タブ「Skills」)
├─ hooks/
│  └─ useClaudeChat.ts         # 接続/送信/中断/許可応答。useOpencodeChatと同じ公開I/F形状
└─ lib/
   ├─ claude-message-mapper.ts # SDKMessage → ClaudeMessage(UI型)変換
   └─ claude-sidecar-client.ts # invoke/イベント購読のラッパ(プロトコル層)
```

### ストア

- `useClaudeChatStore`(Zustand、非永続): メッセージ配列・接続状態・実行中フラグ・保留中の許可要求。
- `claude-session-store`(Zustand、persist): フォルダパス → `{lastSessionId, model, permissionMode}`。
- 既存 `claude-config-store`: MCP/Skillsはそのまま利用。CLAUDE.md読み書きが不足していればRust `claude_config.rs` に追補。

### 配線

- `ui-store` の `LeftPanel` 型に `"claude"` を追加。`LeftPanel.tsx` のアクティビティバーにClaudeボタンを追加。
- 既存の未接続 `ProjectConfigPanel` は `ClaudePanel` の設定タブに統合し、コンポーネントとしては廃止。
- ショートカット: Ctrl+Shift+O(opencodeのCtrl+Oに倣う)。
- i18n: 新namespace `claude-config`(en/ja)を `shared/i18n/index.ts` に登録。既存claude-configコンポーネントのハードコード文字列も同namespaceへ移行。
- mdium連携: 送信時に現在ファイルの絶対パス+選択範囲を `useOpencodeChat` の文脈注入と同形式で本文に前置。

## エラー処理

- **前提未充足**: `node --version` 失敗 → 案内バナー。SDK認証エラー(`claude login` 未実施)→ ログイン手順の案内表示。
- **サイドカー異常終了**: Rustがプロセス終了を検知して `exit` イベントをemit → 「切断」状態+再接続ボタン。stderrはRust側でバッファし `[claude][diag]` プレフィックスで診断ログへ。
- **ターンのストール**: opencodeの `stall-watchdog.ts` を流用(60秒無応答で通知)。SDKイベント受信でリセット。
- **許可要求の孤児化**: 許可待ち中に中断/終了した場合、サイドカーが保留中の `canUseTool` をdenyで解決してから閉じる。
- **JSON Linesパース失敗**: 不正行は読み捨てて診断ログへ。プロセスは落とさない。

## テスト

- ユニット(vitest、既存 `__tests__` パターン):
  - `claude-message-mapper.test.ts`: SDKメッセージ列→UIメッセージ変換(init/assistant/stream_event/result/ツール実行組み立て)
  - サイドカーのプロトコル処理: 許可要求の採番・応答突き合わせ、中断時のdeny解決、入力キュー
  - `claude-session-store`: resume ID・設定の永続化
- Rust `claude_sidecar.rs`: ダミースクリプト(echo)を使った統合テスト1本。
- 手動スモーク(実機): 送信→ストリーミング→許可カード→許可→結果→再起動後resume。実CLI認証が必要なため自動化しない(MVP時点)。

## 後続フェーズ(スコープ外)

- 画像添付、スラッシュ/@補完、使用量表示、セッション一覧/切替
- プレビュー連携(動画生成フロー等)のClaude対応
- Agents/Commands等の設定タブ拡充
- 「常に許可」(permissionルールへの保存)対応
