# AGENT CHAT を文書検索の唯一の入口にする（RAG パネル縮退）設計

日付: 2026-10-20
状態: 利用者承認済み（レビュー反映版）

## 1. 意図と背景

MDium には文書検索の入口が二つある。

- **RAG パネル**（左アクティビティバーの「RAG」、および下部フォルダパネルの「RAG」タブ）: 索引の構築・設定と、API キーで AI を直接呼ぶ簡易 Q&A。
- **AGENT CHAT**: opencode / Claude / Codex / Copilot のチャット。opencode には組み込み `rag` エージェントがあり、HTTP ブリッジ経由で同じ索引を検索できる。

利用者は「RAG かエージェントかで迷わない」ことを求めている。質問応答はエージェントの方が能力が高い（検索結果を読み足せる）ので、**簡易 Q&A は削除し、AGENT CHAT を唯一の入口にする**。ただし RAG パネルが担っていた「索引の構築・削除・設定」は残す必要があり、その置き場所を AGENT CHAT の上部に移す。

さらに、索引の対象は Markdown 系テキストだけなので、フォルダに未変換の Office 文書（docx/xlsx/pptx/pdf）があると検索から漏れる。利用者は「Office 文書を MD に変換するかはエージェントが会話の中で聞く」流れを望んでいる。

## 2. ゴール / 非ゴール / アンチゴール

### ゴール
1. 文書への質問は AGENT CHAT から始まり、どのプロバイダタブでも同じ索引検索ツールが使える。
2. 索引の構築・更新・削除・設定は AGENT CHAT 上部の 1 行の帯（以後「インデックス帯」）から行える。
3. 未変換の Office 文書があるとき、エージェントが変換を提案し、了承後に変換と索引更新までツールで完了する。
4. RAG の簡易 Q&A（RAG パネルのチャット欄、ローカル履歴、音声入力、直接 API 呼び出し）を削除する。

### 非ゴール
- エージェントの回答内の出典（ファイル:行）をクリックして該当行へジャンプする機能。別件とする。
- 索引エンジン（埋め込み・ハイブリッド検索・SQLite 保存）の変更。
- 既存の組み込み MCP サーバ `mdium-docs` / `nano-banana-2` の登録方式の変更（手動追加のまま）。
- サーバ版 / Web 版への対応（デスクトップ版のみ）。

### アンチゴール（技術的に動いても失敗とみなす）
- RAG ボタンや RAG タブが残っていて、入口が二つあるように見える。
- Claude/Codex/Copilot のタブで索引検索が使えず、opencode だけの機能になる。
- 索引の更新や Office 変換がツールのタイムアウトで途中失敗する。
- 利用者がオフにした `mdium-rag` の登録を、アプリが勝手に戻す。
- 既定の権限モードで、検索のたびに許可ダイアログが出る。

## 3. 制約

- UI 文字列はすべて i18n（`src/shared/i18n/locales/{en,ja}`）。コメントは英語。
- 遅延読み込みは使わない（Proxy 環境で認証ダイアログが出るため、静的インポート）。
- 索引の構築（埋め込み計算）と Office→MD 変換は webview 側の JS で動く。Rust 側はブリッジとイベント中継のみ。
- HTTP ブリッジ（`src-tauri/src/http_bridge.rs`）はアプリ起動時に起動し、ポートとトークンは起動ごとに変わる。
- 閉域環境では埋め込みモデルの手動配置 UI（モデル未検出時の案内）が必要。これは残す。
- プロバイダの実装系統は二つある。Claude タブは `sidecar/claude-sidecar.ts`（Claude Agent SDK 直）、Codex/Copilot は `sidecar/agent-runner` の adapter。権限判定もそれぞれ別（Claude は `canUseTool`、agent-runner は `guard.ts` と `permissions.ts`）。

## 4. 画面（A 案、利用者承認済み）

### 4.1 削除するもの
- 左アクティビティバーの RAG ボタンと `leftPanel === "rag"` の分岐（`LeftPanel.tsx`）。
- 下部フォルダパネルの RAG タブ（`App.tsx` の `folderPanelTab === "rag"` 周辺）。`FolderPanelTab` 型から `"rag"` を外し、`"terminal"` のみにする。
- `LeftPanel` 型の `"rag"`、`ui-store` の `ragChatInput` / `setRagChatInput`。
- `RagPanel.tsx` のチャット部分（入力欄、回答表示、保存/破棄/履歴ボタン、履歴一覧、音声入力）。
- `useRagFeatures.ts` の `askQuestion` / `callAI` / セッション永続化（localStorage の RAG 履歴）。
- RAG 関連の i18n キーのうち、チャット専用のもの（`ragLoadChatConfirm`, `ragChatHistory`, `ragSaveAndNew`, `ragDiscardAndNew`, `ragNoChatHistory`, `ragDeleteChat`, `ragApiKeyMissing`, `ragInputTooltip`, `ragPleaseBuildIndex` など）。索引管理のキーは残して流用する。
- `Ctrl+Shift+R` のショートカット（`App.tsx` 付近 1154 行）は RAG タブ切替だったので、**AGENT CHAT の左パネルを開く**動作に付け替える（私の判断）。

### 4.2 インデックス帯（新規）
AGENT CHAT のプロバイダタブ列の直下、どのタブでも共通に 1 行表示する。

- **構築済み**: 緑の状態ピル「索引 N chunks」、モデル名（`embeddingModel` の末尾セグメント）、ファイル数、「更新」ボタン、設定（歯車）ボタン。
- **未構築**: 黄色の帯、「索引がありません」、「構築」ボタン、歯車。
- **更新中 / 変換中**: 進捗テキスト（今の RagPanel の `ragPhaseScanning` / `ragPhasePreparing` / `ragPhaseEmbedding` / `ragPhaseSaving` と `ragDownloadingModel` をそのまま流用。変換中は「変換中 n/m」）。
- **モデル未検出 / エラー**: 今の RagPanel の案内ブロック（モデル配置フォルダ、必要ファイル、再確認ボタン）とエラー文言を帯の下に展開表示する。
- **フォルダ未選択**: 帯は非表示。
- 歯車で開く**設定ドロワー**は帯の直下に展開し、今の RagPanel の設定項目をそのまま置く: 埋め込みモデル、対象拡張子、最小チャンク長、topK、最低スコア、検索モード、BM25 重み、「索引を削除」、保存/キャンセル。モデル変更時の警告文も流用する。全再構築は「索引を削除」→「構築」で行う。
- ドロワーには **`mdium-rag` ツールの有効/無効トグル**（Claude / Codex / Copilot の 3 つ、既定オン）も置く（5.3 参照）。
- 帯のタイトルや文言は AGENT CHAT の i18n 名前空間（`agent-chat`）に新設する。索引管理のキーは `rag` 系の既存キーを `agent-chat` 名前空間へ移す（`index` 接頭辞に改名して良い。私の判断）。

実装上の置き場所: `src/features/agent-chat/components/IndexStrip.tsx`（+ CSS）。索引の状態・構築・削除ロジックは `useRagFeatures` から索引管理部分だけを残した `src/features/rag/hooks/useRagIndex.ts` に切り出し、`IndexStrip` と後述のブリッジ処理の両方から使う。`src/features/rag/components/RagPanel.tsx` は削除する。

### 4.3 LeftPanel ヘッダ
AGENT CHAT のセクションヘッダは現状どおり（opencode タブのときのモデル名表示も維持）。RAG 用の `(provider / model)` 表示は削除。

## 5. エージェント側のツール（全プロバイダ共通）

### 5.1 組み込み MCP サーバ `mdium-rag`
`resources/mcp-servers/mdium-rag/dist/index.js`。**手本は `mdium-docs`**（`sidecar/doc-converter/mcp-main.ts` + `mcp-server.ts` の依存なし手書き JSON-RPC stdio サーバを `scripts/build-doc-converter.mjs` が esbuild で束ね、`npm run build:sidecar` で呼ばれる）。ソースは `sidecar/rag-mcp/` に置き、同じビルドスクリプトに追加する。`mdium-vba` はリポジトリから撤去済みの旧サーバなので参考にしない。

ツールはすべて HTTP ブリッジ経由で mdium 本体に委譲する。ブリッジの接続情報は**サイドカーファイルを呼び出し時に読む**（ポート/トークンが起動ごとに変わるため、登録時の env 固定にしない）。パスは `~/.mdium/bridge.json`（新設、provider 非依存）。既存の `~/.config/opencode/.mdium-bridge.json` も互換のため書き続ける。env `MDIUM_BRIDGE_PORT` / `MDIUM_BRIDGE_TOKEN` があればそれを優先する。

ツール（名前は MCP 上でそのまま露出する）:

| ツール | 引数 | 戻り | ブリッジ | 権限区分 |
|---|---|---|---|---|
| `rag_search` | `query`, `search_mode?`, `bm25_weight?`, `limit?` | 既存 `.opencode/tools/rag_search.ts` と同じ（file, heading, content, line_number, score） | `POST /rag/search`（既存） | 読み取り |
| `rag_status` | なし | `{ state: "ready"\|"empty"\|"updating"\|"converting"\|"error", total_chunks, total_files, embedding_model, progress?: {phase, current, total}, unconverted_office_docs: [{path, type, size}], job?: {kind, state, done, total, errors[]}, error? }` | `POST /rag/status`（新設） | 読み取り |
| `convert_office_docs` | `paths: string[]`（絶対パス、またはフォルダ相対） | `{ job_id, accepted: string[], rejected: [{path, reason}] }` を即返す | `POST /rag/convert`（新設） | 書き込み |
| `rag_update_index` | なし | `{ job_id }` を即返す | `POST /rag/update`（新設） | 書き込み |

- `rag_update_index` は現行 `buildIndex` と同じ**増分更新**（ハッシュ一致はスキップ、消えたファイルは削除）。全再構築はインデックス帯のドロワーから「索引を削除」→「構築」で行い、ツールには持たせない（私の判断）。
- `convert_office_docs` と `rag_update_index` は**非同期ジョブ**。開始を即返し、進捗と完了は `rag_status` の `job` と `state` で追う。同時に走れるジョブは 1 つ。走行中に別のジョブを要求したら webview が `{ ok: false, error: "job_running" }` を返し、Rust 側がそれを HTTP `409` に写像する（現行の `/rag/search` は webview の返却をそのまま 200 で返すだけなので、`error` フィールド→ステータスの写像を Rust に追加する）。
- 変換は **webview 側の `convertFileToMarkdown`（`src/features/export/lib`）で行う**。`mdium-docs` の `convert_to_markdown` と機能は重なるが、インデックス帯に進捗を出し、同じジョブ状態を UI と共有するために webview 側に寄せる（私の判断）。`mdium-docs` には手を入れない。
- 変換の出力は元ファイルと同じフォルダに同名 `.md`（画像は隣に書き出す）。既に同名 `.md` があれば上書きせず `rejected` に `exists` で返す（私の判断）。
- 対象拡張子: `.docx`, `.xlsx`, `.xls`, `.xlsm`, `.pptx`, `.pdf`。**`.xlsm` も含める**（利用者指示。マクロブックもシート内容を検索対象にする）。`.doc`（旧 Word）は `rejected: unsupported`（Word COM 変換は一括変換機能に残す。私の判断）。
- `unconverted_office_docs` の定義: フォルダ配下（`build_tree_all` の範囲、深さ 10 まで）の上記拡張子のファイルのうち、隣に同名 `.md` が存在しないもの。`collectConvertibleFiles` と `detectConvertibleType` を再利用する。
- ツール説明文に手順を埋め込む。要旨: 「文書についての質問では最初に `rag_status` を見て、`unconverted_office_docs` が空でなければ件数とファイル名を示して変換を提案し、利用者が了承したら `convert_office_docs` → 完了後 `rag_update_index` → 完了後 `rag_search`。`state` が `empty` なら構築を提案する。利用者に聞かずに変換や索引更新を始めない。」

### 5.2 本体側（webview + Rust）
- Rust `http_bridge.rs` に `/rag/status`、`/rag/convert`、`/rag/update` を追加。いずれも既存 `/rag/search` と同じ「イベント発行 → pending に登録 → webview が `rag_bridge_respond` で返す」方式。`/rag/convert` と `/rag/update` は webview が受理した時点で即応答する。webview 返却の `error` を HTTP ステータスに写像する（`job_running` → 409、`no_folder` → 400、その他 → 500）。
- アプリ起動時のサイドカー書き出し（`write_bridge_sidecar`）に `~/.mdium/bridge.json` を追加する。
- webview 側は `useRagBridge` を拡張し、4 種のリクエストを処理する。索引更新は `useRagIndex`、変換は `convertFileToMarkdown` を使う。ジョブの状態は新設の `rag-index-store` に持ち、インデックス帯も同じストアを表示する（UI からの更新とツールからの更新が同じ状態を共有し、UI 側の「更新」ボタンもジョブ走行中は無効になる）。
- マスキング: `rag_search` の結果には既存どおり順方向マスキングを適用する。`rag_status` の `unconverted_office_docs` のパスにもファイル名部分へ順方向マスキングを適用する（私の判断）。

### 5.3 `mdium-rag` の登録と有効/無効（Claude / Codex / Copilot）
組み込み MCP サーバの自動登録には前例がない（`mdium-docs` / `nano-banana-2` は opencode 設定画面の「組み込みを追加」からの手動追加）。`mdium-rag` は AGENT CHAT の中核機能なので、以下の新しい仕組みで既定オンにする。非対称は許容する（私の判断）。

- アプリ設定 `settings-store` に `mdiumRagTools: { claude: boolean, codex: boolean, copilot: boolean }`（既定すべて `true`）を持つ。インデックス帯のドロワーでトグルする。これが唯一の opt-out で、設定ファイルの有無から推測しない。
- **Claude**: トグルがオンなら、セッション開始時に `claude-sidecar.ts` の SDK `Options.mcpServers` に `mdium-rag`（`command: node`, `args: [<mcp_servers_path>/mdium-rag/dist/index.js]`）を直接渡す。`~/.claude.json` には書かない。
- **Copilot**: 同様に `copilot-adapter.ts` の `createSession(config)` の `mcpServers` に渡す。`~/.copilot/mcp-config.json` には書かない。
- **Codex**: `codex exec` は `config.toml` しか読まないので、トグルがオンならタブ表示時に `codex_write_mcp_server` で `mcp_servers.mdium-rag` を書き、パスが変わっていれば上書きする。トグルをオフにしたら `codex_delete_mcp_server` で消す。Codex 設定画面で利用者が `mdium-rag` を削除または無効化したら、`settings-store` のトグルを `false` にする（設定画面の削除/無効化ハンドラにフックする）。
- `<mcp_servers_path>` は既存 `resolve_mcp_servers_path` で解決する。

### 5.4 権限（利用者承認済み）
現状、MCP ツールは全プロバイダで「不透明な other 種別」扱いで、read-only では拒否、既定モードでは毎回確認になる。`mdium-rag` のツールは名前で区分して扱う。

- `rag_search`, `rag_status`: **読み取り**扱い。read-only / 既定モードとも自動許可。
- `convert_office_docs`, `rag_update_index`: **書き込み**扱い。既定モード（`cli-default`）では利用者に確認、read-only では拒否、full-access では自動許可。
- 実装箇所: agent-runner は `permissions.ts` の正規化で `mdium-rag/<tool>`（Codex は `server/tool`、Copilot は SDK のツール名）を `read` / `write` 種別に写す。`guard.ts` の opaque 無条件ブロックより前にこの判定を置く。Claude は `sidecar-core.ts` の `canUseTool` で `mcp__mdium-rag__<tool>` を同じ区分に写す。

### 5.5 opencode
- 既存 `.opencode/tools/rag_search.ts` と組み込み `rag` エージェントは維持する。`mdium-rag` は opencode には登録しない（薄いツールで十分。私の判断）。
- 組み込みツールに `rag_status` / `convert_office_docs` / `rag_update_index` を追加（`.opencode/tools/*.ts` の薄いクライアントとして、`builtin-registry.ts` に `?raw` で取り込む。`rag_search.ts` と同じサイドカー読み取り）。
- `rag` エージェントの指示文に 5.1 の手順（Office 文書の変換提案、未構築時の構築提案）を追加し、`mdium-agent-version` を上げる。

### 5.6 Claude / Codex / Copilot の指示
専用のエージェント定義は無いので、5.1 のツール説明文に手順を持たせる。Claude サイドカーは `systemPromptAppend` を型に持つ（`src` 側では未使用）ので、同じ手順を 3〜4 行で追記して良い（任意、実装者判断）。

## 6. 索引の対象と Office 文書の流れ（利用者承認済み）

1. 利用者が AGENT CHAT で文書について質問する。
2. エージェントが `rag_status` を呼ぶ。未変換の Office 文書があれば、件数と代表ファイル名を示して「Markdown に変換して索引に含めますか？」と聞く。
3. 了承 → `convert_office_docs`（既定モードでは許可ダイアログ 1 回）→ `rag_status` で完了確認 → `rag_update_index`（同じく 1 回）→ 完了確認 → `rag_search` → 回答。
4. 断る → そのまま `rag_search`。
5. 索引が未構築なら「構築しますか？」と聞き、了承で `rag_update_index`。

インデックス帯は、ツール経由のジョブもリアルタイムに進捗表示する。

## 7. 検証が必要な前提（計画の最初に潰す）

- Claude Agent SDK の `Options.mcpServers` で渡した stdio サーバが、`settingSources` にユーザ設定を含む状態でも読み込まれ、ツール名が `mcp__mdium-rag__rag_search` になること。
- `@github/copilot-sdk` の `SessionConfig.mcpServers` で渡したサーバがセッション内で使えること。使えなければ Copilot だけ `~/.copilot/mcp-config.json` への書き込み方式（Codex と同じ扱い）に切り替える。
- `codex exec` が `config.toml` の `mcp_servers` を読むこと（既存の設定画面機能で確認済みの想定）。

## 8. テストと受け入れ

- 単体: `IndexStrip` の状態別表示（empty / ready / updating / converting / error / model-missing）、`useRagIndex` の切り出し後も既存の構築・削除テストが通ること、`useRagBridge` の 4 種ハンドラと `job_running`、`unconverted_office_docs` の判定（`.xlsm` を含む、同名 `.md` ありは除外）、`permissions.ts` と `sidecar-core` の `mdium-rag` 区分、Codex 設定画面の削除がトグルを落とすこと。
- Rust: 新ルートの JSON 契約と `error` → ステータスの写像（`job_running` → 409）。
- MCP サーバ: 4 ツールのスキーマと、サイドカー未検出時のエラー文。
- 既存テストで RAG パネルや `leftPanel: "rag"` に依存するもの（`LeftPanel.test.tsx`, `ui-store-left-panel.test.ts` など）を更新する。
- 実機: 新規フォルダ（docx/xlsm 混在）で opencode と Claude の両タブから「変換提案 → 了承 → 検索 → 回答」が通ること。read-only モードで検索は通り変換は拒否されること。トグルをオフにした後、Codex 設定に `mdium-rag` が再登録されないこと。

## 9. 実装者に委ねること

- `IndexStrip` の細かな見た目（色トークン、ドロワーのアニメーション）。既存の `OpencodeConfigPanel.css` の変数に合わせる。
- `useRagIndex` と `rag-index-store` の分割粒度。
- `sidecar/rag-mcp/` のファイル構成と `scripts/build-doc-converter.mjs` への追加方法。
- Claude への `systemPromptAppend` 追記の有無。
- 変換ジョブのエラー集約の表現（ファイル単位でエラーを `job.errors` に積む以上の整形）。
- 7 節の検証で Copilot がセッション渡しに対応していなかった場合の、設定ファイル方式への切り替え詳細。

## 10. 私の判断として置いたもの（利用者が確認する箇所）

- `Ctrl+Shift+R` を AGENT CHAT を開く動作に付け替える。
- 変換は同名 `.md` が既にあれば上書きしない。`.doc` は対象外。
- 索引更新は増分のみ。全再構築はドロワーの「削除」→「構築」。ツール名は `rag_update_index`。
- ジョブは同時 1 つ。走行中の要求は `409`。
- 変換は webview 側で行い、`mdium-docs` には触れない。
- `mdium-rag` は Claude/Copilot にはセッション開始時に SDK へ直接渡し、Codex だけ `config.toml` に書く。opt-out はインデックス帯ドロワーのプロバイダ別トグル（既定オン）。opencode には登録しない。
- サイドカーを `~/.mdium/bridge.json` に新設し、opencode 用の既存パスも書き続ける。
- `unconverted_office_docs` のファイル名にも順方向マスキングを適用する。

利用者の決定: 権限区分は 5.4 のとおり。変換候補に `.xls` と `.xlsm` を含める。
