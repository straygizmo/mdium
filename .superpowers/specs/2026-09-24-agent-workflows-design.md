# エージェントワークフローと関連機能 設計仕様

- 日付: 2026-09-24
- 対象: mdium に、LLM エージェントが「設計 → 実装 → レビュー」を担う開発ワークフロー機能と、その周辺機能（要件整理、Issue トラッカー連携、タスク添付、定期 JOB、AGENT CHAT、複数ターミナル等）を追加する
- 実装単位: 本仕様は 5 つのパートからなり、パートごとに実装計画を作成し、この順で実装する

| パート | 内容 | 主な依存 |
|---|---|---|
| 1 | 小規模 UI 改善（複数ターミナル、テーマ対応スイッチ、MCP 一覧スクロール、opencode 使用量表示、確認ダイアログのオーバーレイ設定） | なし |
| 2 | 共通エージェントランナーと AGENT CHAT パネル | なし |
| 3 | ワークフロー基盤と UI（タスク、フロー実行、worktree、orchestrator、カンバン、タスク詳細、フロー編集） | 1, 2 |
| 4 | 要件整理、Issue トラッカー連携、タスク添付 | 3 |
| 5 | 定期 JOB | 3 |

---

## 0. 用語

UI 表示名とコード上の識別子を次のとおり統一する。コード・i18n キー・ファイル名はこの識別子に従い、別名を併用しない。

| UI 表示 | 識別子 | 定義 |
|---|---|---|
| ワークフロー | `workflow` | プロジェクト内で名前を持つ、役割固定の工程列（設計・実装・レビュー）と各工程の設定 |
| 工程 | `stage` | ワークフローの一段階。役割 `role`（`design` / `implement` / `review`）を必ず持つ |
| タスク | `task` | カンバンで追跡する仕事項目。一つの工程に対する一つの作業単位 |
| ルートタスク | `rootTask` | 要件整理から作成された、フロー実行の起点となるタスク |
| 子タスク | `childTask` | 前工程の完了により作られる後続タスク。本文は前工程の成果物 |
| フロー実行 | `workflowRun` | ルートタスク 1 件に対する、ワークフロー全体の実行単位 |
| 試行 | `attempt` | 一つのタスクに対する工程の 1 回の実行 |
| 工程結果 | `stageOutcome` | 試行の終了時に LLM が宣言する `completed` / `attention` / `awaiting_user` とその理由 |
| 要件整理 | `intake` | 利用者と LLM が対話で要件を確定するセッション |
| タスク添付 | `attachment` | ルートタスクに属する、登録時点で固定されたファイル |
| 定期 JOB | `scheduledJob` | 時刻または間隔でエージェントを起動する、ワークフローから独立した自動化 |
| エージェントランナー | `agentRunner` | Codex / Copilot / opencode / Claude を統一インターフェースで呼び出す Node サイドカー（opencode・Claude のアダプタはパート 3 で追加） |

タスク状態:

| 状態 | 識別子 | 意味 |
|---|---|---|
| 受信箱 | `inbox` | 実行待ち |
| 実行中 | `running` | エージェントが処理中 |
| 承認/回答待ち | `awaiting_user` | 計画の承認または質問への回答を待っている |
| 要対応 | `attention` | 失敗・中断・上限到達などで利用者の対応が必要 |
| 保留 | `on_hold` | 利用者が一時停止した |
| 完了 | `completed` | 工程が終了した（最終工程では「取込み待ち」を含む） |
| 中止 | `cancelled` | 利用者が取りやめた（通常のカンバンには表示しない） |

---

## パート 1: 小規模 UI 改善

### 1.1 複数ターミナルセッション

下部ターミナルビューで、起動する CLI の種類を選んで複数の独立したセッションをタブで管理できるようにする。

- セッションは `{ id, kind, folderPath }`。`kind` は `claude-code`（`claude`）、`codex`（`codex`）、`github-copilot`（`copilot`）、`opencode`（`opencode`）、`terminal`（OS 標準シェル）。
- `folderPath` は作成時点のアクティブフォルダで固定する。タブ一覧はアクティブフォルダのセッションだけを表示する。
- ツールバー右側の追加ドロップダウン（種類名は i18n）で追加し、追加したセッションを選択する。タブ名は種類名＋種類ごとの連番。各タブに終了ボタンを置き、選択中を終了したら右隣、なければ左隣を選択する。
- ビューを初めて開いたときは、現在フォルダで `terminal` セッションを一つ作る（既存ショートカットとの互換）。
- PTY はビューの非表示・再表示では kill しない。再マウント時は同一 ID で `spawn_pty` を呼び、バックエンドは既存 ID なら成功を返すだけにする。タブの終了時と、そのセッションのフォルダを閉じたときにのみ `kill_pty(id)` を呼ぶ。
- `codex` は暗色 ANSI 背景を使うため、アプリが明色テーマでも端末パレットを暗色にする。
- 状態は `ui-store` に保持する。

### 1.2 テーマ対応スイッチ

- `src/shared/styles/switch.css` を追加し、`[data-switch]`（checkbox）と `[data-switch][role="switch"]` に、テーマ変数（`--bg-surface`、`--primary`、`--border`、`--bg-base`）による配色、フォーカスリング、無効時表示を与える。形状と動きは各機能の CSS が持つ。
- 既存のトグル（設定ダイアログ、プレビュー、opencode 設定各セクション、Claude プラグインタブ、動画設定）に `data-switch` と `role="switch"` を付け、各 CSS の重複した配色定義を削除する。
- つまみは各トラック内で上下中央に配置する（`top: 50%` ＋負の `margin-top`）。
- スイッチの配色はテーマ変数のみで決まり、各機能の CSS に固定色（`white`、`#fff`、`--accent*`、`--text-muted`、フォールバック付き `var()`）を残さないことをテストで保証する。既存テーマの基本色は変更しない。
- `span` によるスイッチ（プレビューの VBA 取込み許可、動画の画像表示・字幕）は、クリック・Enter・Space のそれぞれで状態が 1 回だけ切り替わることをテストで保証し、`aria-label` を i18n で付ける。

### 1.3 MCP サーバ一覧のスクロール

opencode 設定ダイアログの MCP サーバ一覧が多件数でダイアログからはみ出さないよう、一覧領域をスクロール可能にする。

### 1.4 opencode 使用量表示

- 使用量表示をチャットツールバーから入力欄の上へ移す。
- 現在セッションの費用が 0（サブスクリプション認証等）のときは表示しない。表示時は枠なしの金額ボタンとし、クリックでポップオーバーを開く。

### 1.5 確認ダイアログのオーバーレイ設定

`showConfirm` に `closeOnOverlayClick?: boolean` を追加する。`false` のときはオーバーレイのクリックで閉じない（誤操作で破棄されると困る確認に使う）。

---

## パート 2: 共通エージェントランナーと AGENT CHAT

### 2.1 エージェントランナー（Node サイドカー）

Codex（`@openai/codex-sdk`）、Copilot（`@github/copilot-sdk`）、Claude（`@anthropic-ai/claude-agent-sdk`）、opencode（ランナー専用の `opencode serve`）を統一インターフェースで呼び出すサイドカー。AGENT CHAT はチャット用ランナー（Codex / Copilot のみ）、ワークフロー／要件整理／定期 JOB はワークフロー用ランナー（4 プロバイダー）を使う。

- 起動: Tauri が `node` で起動し、stdio の JSON 行プロトコルで通信する。ビルド成果物（esbuild バンドル）は `resources/agent-runner/` に生成し、git 管理しない（`.gitignore`）。`build:sidecar` に組み込む。
- プロバイダーアダプタのインターフェース:

```ts
interface ProviderAdapter {
  probe(): Promise<Availability>;                 // CLI/認証の有無
  startSession(opts: SessionOptions): Promise<SessionHandle>;
  send(session: SessionHandle, input: AgentInput): AsyncIterable<AgentEvent>; // 進捗・最終応答
  cancel(session: SessionHandle): Promise<void>;
  listSessions?(): Promise<SessionSummary[]>;     // 対応プロバイダーのみ
}

interface SessionOptions {
  workingDirectory: string;
  model?: string;
  // cli-default: MDium は権限を指定せず各 CLI の利用者設定に従う（AGENT CHAT）
  // read-only: 読み取りのみを強制（設計・計画・レビュー・要件整理・定期 JOB）
  // full-access: 制限なし。安全ガード（3.7）と組み合わせてのみ使用（実装本実行）
  permission: "cli-default" | "read-only" | "full-access";
  env?: Record<string, string>;   // 子プロセス環境の上書き（3.7 の封じ込めに使用）
  timeoutMs?: number;
}
```

- 権限の対応付け:
  - `read-only`: Codex は sandbox `read-only`、Copilot は権限ハンドラで `read` 以外の要求をすべて拒否、opencode は専用の読み取り専用エージェント（乱数付きの名前、`"*": deny` のうえで読み取り系のみ許可）で実行。
  - opencode 専用サーバ: ランナーが 1 つ起動し、プロジェクト設定を無効化（`OPENCODE_DISABLE_PROJECT_CONFIG`）、LSP・フォーマッタを無効化し、全ツールの権限を ask にしてランナーの判定を必ず通す。エージェント名に乱数を付け、ユーザー・プロジェクト設定から上書きされないようにする。
  - ガード付き・制限付きセッションでは、MCP など中身を検査できないツール（opaque tool）は全プロバイダーで拒否し、`guard_violation`（`opaque-tool`）として報告する。
  - `full-access`: Codex は sandbox `danger-full-access`、Copilot と opencode はすべて許可（ただしランナーのガードフックを通す。3.7）。Copilot の拡張機能・環境変数アクセス系の要求（`extension-management`、`extension-permission-access`、`extension-env-access`、`factory`、`custom-tool`、`hook`）は full-access でも拒否する。
  - Claude（Claude Agent SDK）: `read-only` は `canUseTool` で読み取り系ツール（Read / Grep / Glob / LS 等）以外を拒否、`full-access` は `permissionMode: "default"` のまま `canUseTool` で許可し、ガードフックを通す（`bypassPermissions` は使わない）。AGENT CHAT の Claude タブは既存の Claude パネルを使うため、ランナーの Claude アダプタは工程専用とする。
  - `cli-default`: Codex は sandbox を指定しない（`~/.codex/config.toml` に従う）。Copilot の権限要求は CLI と同じく利用者に都度確認する（チャット UI で承認・拒否）。
- ガードフック: アダプタはツール実行要求を正規化した `ToolRequest`（種別 `shell` / `write` / `read` / `network` / `other`、コマンドまたはパス）として呼び出し側のポリシーに渡す。事前フックを持つ Copilot / opencode は実行前に判定し、拒否できる。事前フックを持たない Codex は実行開始イベントで判定し、違反時は直ちにターンを中止する。
- タイムアウトは呼び出し側が指定する。SDK 既定の短いタイムアウトに依存しない。
- `cancel` は子プロセスツリーまで終了させる。stdin が閉じたらランナーは全セッションをキャンセルしてから終了する。
- Codex 実行ファイルの解決は `MDIUM_CODEX_PATH` → PATH 上の `codex` → npm グローバルの順。見つからなければ `probe` が理由付きで unavailable を返す。
- 出力契約: 最終応答をテキストで返す。ファイルへの書き出しは呼び出し側（Rust）が行う。

### 2.2 AGENT CHAT パネル

左パネルの opencode ボタンを「AGENT CHAT」に置き換え、上部タブで opencode / Claude / Codex / Copilot を切り替えるチャットにする。

- opencode タブは既存の opencode パネルを、Claude タブは既存の Claude パネル（チャット・設定）をそのまま表示する。独立した Claude ボタンは廃止し、保存済みの「最後に開いたパネル」が Claude の場合は AGENT CHAT を開く。Claude パネルを開くショートカット（Ctrl+Shift+O）は AGENT CHAT の Claude タブを開く。
- Codex / Copilot タブはランナーを使うネイティブチャット（新規セッション、送信、履歴一覧と再開は対応プロバイダーのみ）。
- 利用できないプロバイダーのタブは無効表示とし、理由をツールチップで示す。
- パネルを切り替えてもチャット状態を保持する。
- チャットの権限は `cli-default`（各 CLI の利用者設定に従う）。Copilot の権限要求はチャット内に承認・拒否ボタンとして表示する。
- 表示文言（パネル名「AGENT CHAT」を含む）はすべて i18n。

---

## パート 3: ワークフロー基盤と UI

### 3.1 全体構成

```
[React UI]  features/workflows/        ワークスペース(カンバン/マトリクス)、タスク詳細、ワークフロー編集
            features/intake/           要件整理ウィンドウ（パート4）
            features/scheduled-jobs/   定期JOB（パート5）
               │ invoke / Tauri event（状態変化を push 通知）
[Rust]      workflow/  store(tasks, runs, attachments), state machine, orchestrator, scheduler
            workflow/git_worktree.rs, workflow/issue_tracker.rs
               │ stdio JSON
[Node]      agent-runner（パート2）
```

- 工程の実行制御（取得、実行、結果処理、次工程への遷移、回復）はすべて Rust の orchestrator が行う。UI は表示と操作要求のみを行い、ポーリングしない。複数ウィンドウが開いていても実行主体は一つである。
- orchestrator は AGENT CHAT とは別に、ワークフロー専用のエージェントランナープロセスを 1 つ起動し、Rust から直接 stdin/stdout の JSON 行プロトコル（2.1）でやり取りする。ランナーの出力を WebView 経由で中継しない。
- orchestrator はワークフローが有効なプロジェクトに対してのみ動作する。

### 3.2 データ（プロジェクトの `.mdium/` 配下）

| パス | 内容 |
|---|---|
| `workflows.json` | ワークフロー定義。`schemaVersion` を持つ |
| `tasks/<taskId>.md` | タスク文書。YAML frontmatter（id、状態、ルート／親 ID、工程 ID、状態履歴、更新日時、`schemaVersion`）＋本文 |
| `runs/<rootTaskId>.json` | フロー実行。開始時のワークフロー定義スナップショット、現在タスク、再入回数、worktree パス、ブランチ、base コミット、状態 |
| `runs/<rootTaskId>/<taskId>/<attemptId>.md` | 試行の成果物（最終応答） |
| `runs/<rootTaskId>/<taskId>/<attemptId>.log` | 試行のログ（進捗イベント） |
| `task-attachments/<rootTaskId>/` | タスク添付（パート4） |
| `intakes/<intakeId>.json` | 要件整理セッション（パート4） |
| `schedules.json` | 定期 JOB 定義（パート5） |

- 書き込みはすべて一時ファイル＋rename による原子的置換とし、一時ファイル名は一意にする。
- 読めない・壊れたタスク文書は一覧から除外して警告を出し、他のタスクの処理は継続する。
- 初回利用時、`.mdium/` の実行データ（`tasks/`、`runs/`、`task-attachments/`、`intakes/`）を `.gitignore` に追加するよう案内する（自動追記はしない）。

### 3.3 ワークフローモデル

```ts
interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  stages: [Stage<"design">, Stage<"implement">, Stage<"review">]; // 役割と順序は固定
  reviewReturnTo: "design" | "implement";   // 既定 "design"
  maxReentryCount: number;                  // 既定 5
  maxConcurrentRuns: number;                // 既定 1
  designDocPath?: string;                   // 設計書の保存先（空なら保存しない）。有効化時の初期値 "docs/designs/{date}-{slug}-design.md"
  issueTracking: "auto" | "off";            // auto: origin が GitHub/GitLab なら連携
}

interface Stage<R extends "design" | "implement" | "review"> {
  id: string;
  role: R;
  name: string;
  prompt: string;              // 工程の指示
  completionCriteria: string;  // 完了要件
  provider: "codex" | "copilot" | "opencode" | "claude";
  model?: string;
  requiresApproval: boolean;   // implement のみ有効。既定 false
  timeoutMinutes: number;      // 既定 60
}
```

- 工程の判定は常に `role` で行い、配列位置に依存しない。
- 組込みワークフロー「標準開発ワークフロー」をテンプレートとして提供する。追加すると編集可能なコピーになる。テンプレートの名称・説明は i18n、LLM に渡す組込みプロンプトは英語で統一する。
- 組込みプロンプトは外部スキルに依存せず自己完結とする（設計手順、TDD による実装手順、レビュー観点を本文に含める）。
- ワークフローの削除・アーカイブ時、進行中のフロー実行があれば件数を示して確認する。進行中のフロー実行はスナップショットで最後まで動く。

### 3.4 状態遷移

状態遷移は Rust の単一関数 `transition(taskId, expectedFrom, to, reason)` に集約し、UI 操作・orchestrator のいずれもこれを経由する。現在状態が `expectedFrom` と一致しない場合は拒否する（楽観的排他）。

| from → to | 契機 |
|---|---|
| inbox → running | orchestrator が取得 |
| running → completed / attention / awaiting_user | 試行終了（工程結果による） |
| running → attention | 失敗、タイムアウト、中断検出 |
| running → on_hold / cancelled | 利用者操作（ランナーの停止を伴う） |
| awaiting_user → inbox | 承認または回答・修正依頼 |
| attention → inbox | 再試行 |
| attention → completed | 利用者が手動で完了扱い（次工程へ進む） |
| on_hold → inbox | 再開 |
| inbox / awaiting_user / attention / on_hold → cancelled | 中止 |

表にない遷移は拒否する。状態変化のたびに状態履歴へ追記し、`workflow://task-changed` イベントを送る。

### 3.5 orchestrator

- 取得: 有効なワークフローごとに、同時実行中のフロー実行数が `maxConcurrentRuns` 未満なら inbox のタスクを古い順に取得する。排他はプロセス内のミューテックスで行う。
- 実行記録: 試行開始時、フロー実行に `{ attemptId, runnerPid, startedAt }` を記録する。
- 回復: アプリのプロセス起動時に一度だけ、running のタスクのうち実行記録のランナーが存在しないものを `attention`（理由: 中断）にする。WebView のリロードでは回復処理を行わない。
- キャンセル: on_hold / cancelled への遷移時、該当セッションを `cancel` し、ランナー側でプロセスツリーを終了する。成果は worktree に残る。
- タイムアウト: 工程の `timeoutMinutes` を超えたらキャンセルし `attention`（理由: タイムアウト）にする。
- アプリ終了時は全セッションをキャンセルする。running のタスクは次回起動時の回復で `attention` になる。

### 3.6 worktree とブランチ

- フロー実行の開始時（設計工程の前）に作成する。
  - 場所: `%LOCALAPPDATA%\mdium\worktrees\<リポジトリパスのハッシュ>\<rootTaskId>`（リポジトリ外。ファイルツリー・RAG・git status に現れない）
  - ブランチ: `mdium/<rootTaskId 先頭8文字>-<タイトルのスラッグ>`
  - base: 開始時の HEAD のブランチ名とコミットをフロー実行に記録する
- 全工程のエージェントはこの worktree を作業ディレクトリとして実行する。レビューは `base..branch` の差分を対象にする。
- プロジェクトが git リポジトリでない場合、ワークフローは実行不可とし理由を表示する。

### 3.7 工程の権限と安全ガード

| 役割 / モード | 権限（2.1） |
|---|---|
| 設計 | read-only |
| 実装（計画、`requiresApproval` が true の場合のみ） | read-only |
| 実装（本実行） | full-access（作業ディレクトリは worktree） |
| レビュー | read-only |

実装の本実行は利用者の承認なしで全権限を与えてよい。その代わり、次の多層の安全ガードを必ず適用する。ガードは危険操作の検出を完全には保証しない（難読化されたコマンドやネットワーク送信は網羅できない）ため、ワークフローを初めて有効にするときにこの限界を説明し、利用者の確認を得る。

1. 入力検査: 工程の開始前に、エージェントへ渡す外部由来テキスト（タスク本文、Issue 本文・コメント、テキスト系の添付）を検査する。既知のインジェクション表現（以前の指示の無視、システムプロンプトの上書き、資格情報や環境変数の送信依頼など）、不可視文字・双方向制御文字、長大なエンコード済みペイロードを検出した場合は実行せず `attention`（理由: 入力に危険な指示の疑い、該当箇所を表示）とする。利用者は内容を確認して「このまま続行」できる。
2. 実行時ガード: 2.1 のガードフックで、次の操作を拒否リストとして判定する。
   - `git push`、リモートの追加・変更、`gh` / `glab` による外部変更
   - worktree 外への書き込み・削除
   - 資格情報の読み取り（`~/.ssh`、`~/.aws`、`~/.config/gh`、`.git-credentials`、`.env` 系、ブラウザのプロファイル等）
   - 外部への送信系コマンド（`curl` / `wget` / `Invoke-WebRequest` / `Invoke-RestMethod` 等でのアップロード・POST）
   - システム設定の変更（レジストリ、サービス、スケジュールタスク、環境変数の永続変更）
   - エージェント・ツール設定の書き込み（`.claude/`、`.opencode/`、`opencode.json(c)`、`.mcp.json`、`.codex/`、`.copilot/`、`.vscode/` の設定類、`.git/` 内部、`.gitmodules`）。次のターンの CLI が読み込んで実行したり、取込み後に利用者のリポジトリへ持ち込まれたりするのを防ぐ。
   - `git config` による永続設定（コマンドを保持するキー、`core.hooksPath`、`include.path`、`alias.*`、`remote.*` 等）の書き込み。worktree は元のリポジトリと `.git/config` を共有するため。
   Copilot / opencode / Claude は実行前に拒否する。Codex は実行開始イベントで検出した時点でターンを中止する。いずれも `attention`（理由: 危険操作を検出、内容を表示）とする。
3. 環境による封じ込め: エージェントの子プロセス環境（2.1 の `env`）で、`GIT_CONFIG_COUNT` 等により全リモートの push 先を無効な URL に上書きし、`GH_TOKEN` / `GITLAB_TOKEN` を無効値にする。MDium 自身の Issue 連携は Rust から通常の環境で行うため影響を受けない。
4. 事後検査: 工程の終了後、利用者のリポジトリのブランチ位置と HEAD、base ブランチ、共有される `.git/config` と hooks（`core.hooksPath` を含む）が工程開始前から変化していないこと、および worktree 内でエージェント設定ファイル（`.claude/` 等）が変更されていないことを確認し、変化していれば `attention`（理由: 作業ツリー外への変更を検出）とする。利用者が並行して編集しうる作業ツリーのファイル内容は検査対象にしない。取込み（ローカルマージ）の前には、`.github/`・`AGENTS.md`・`CLAUDE.md`・`.husky/`・`.githooks/`・`.devcontainer/` を含む設定系ファイルの変更一覧を示し、利用者の明示的な確認を求める。

補足（ガードの限界）: Codex には実行前フックがないため、ガードはコマンド開始後に検出してターンを中止する（最初の操作自体は防げない場合がある）。Claude は SDK の PreToolUse フックで全ツール呼び出しを検査し、ガード付き・読み取り専用のセッションでは利用者・プロジェクト設定のフックと許可ルールを無視する。

### 3.8 工程の入出力

- 入力: ルートタスクの本文（要件整理結果）、直前工程の成果物、レビュー差し戻し時は指摘内容、添付参照、工程の指示と完了要件、出力契約。
- 出力契約: 最終応答は YAML frontmatter（`outcome`、`reason`、必要に応じ `question`）＋ Markdown 本文とする。frontmatter が無い・解析できない場合は `attention`（理由: 出力形式不正）とする。
- 成果物の保存はエージェントではなく MDium（Rust）が行う: 試行成果物ファイル、子タスク本文、Issue コメント（パート4）。
- `designDocPath` が設定されている場合、設計工程の完了時に MDium が worktree の該当パスへ設計書を書き出してコミットする（再設計時は上書きして新しいコミット）。
  - 主に Issue トラッカーを使わない運用で、設計の記録をリポジトリに残すための設定である（Issue 連携の有無とは独立して設定できる）。
  - ワークフロー編集ダイアログで保存を有効にすると、初期値として `docs/designs/{date}-{slug}-design.md` が入る。`{date}` はフロー実行開始日（YYYY-MM-DD）、`{slug}` はルートタスクのタイトルから生成する。
  - パスはリポジトリ相対とし、リポジトリ外・`.git/`・`.mdium/` を指すものは保存時に検証エラーとする。

### 3.9 承認（実装工程）

- `requiresApproval` が true の場合、まず計画モード（read-only）で実行し、計画を本文に表示して `awaiting_user` にする。
- タスク詳細に「承認」と「修正を依頼」を別ボタンで置く。
  - 承認: 本実行（full-access、3.7 のガード適用）へ進む。
  - 修正を依頼: 入力した指示を加えて計画をやり直す（承認フラグは立てない）。
- 承認はその試行に対してのみ有効で、次の計画には引き継がない。

### 3.10 遷移と再入

- 設計 completed → 実装タスク作成。実装 completed → レビュータスク作成。
- レビュー completed → フロー実行完了。ルートタスクは「完了（取込み待ち）」。
- レビュー attention（指摘あり）→ 指摘を入力に `reviewReturnTo` の工程へ子タスクを作る。フロー実行の再入回数を 1 増やし、`maxReentryCount` に達していれば遷移せず `attention`（理由: 再入上限）にする。
- 子タスク作成とフロー実行の更新は、「フロー実行に遷移予定を記録 → 子タスク作成 → 親を completed → 遷移予定を消去」の順で行い、途中で失敗した場合は起動時の回復で遷移予定から再開する（子タスクは作成済みなら再作成しない）。

### 3.11 取込み

最終工程完了後、タスク詳細に以下を表示する。

- ブランチ名、base、コミット一覧、差分（既存の git 差分ビューアを再利用）
- 「ローカルにマージ」: 利用者の作業ツリーで base ブランチを checkout 済みであることを確認し、`git merge --no-ff <branch>` を実行する。作業ツリーに未コミット変更がある、base 以外のブランチにいる、競合が発生した場合はマージせず（競合時は `merge --abort`）理由を表示する。成功時は Issue をクローズし（パート4）、worktree の削除を提案する。
- 「破棄」: 確認のうえ worktree とブランチを削除する。
- push・PR 作成は行わない。

### 3.12 UI

- アクティビティバーに「ワークフロー」を追加する。選択時、左パネルにワークフロー一覧・定期 JOB 一覧・フィルタ、メイン領域にワークスペースを表示する。
- ワークスペース: カンバン表示（状態別の列、件数バッジ）とマトリクス表示（工程 × 状態）を切り替える。カードに状態別背景色、更新日時、要対応理由を表示する。完了タスクのアーカイブ・削除ができる。
- タスク詳細: アプリ内モーダル。本文、状態履歴、LLM 作業状況（最新の進捗メッセージ）、フロー実行情報（再入回数、直近遷移を工程名で表示）、ブランチと差分、状態に応じた操作ボタン。
- ワークフロー編集ダイアログ: 3.3 の各項目を編集。保存時に権限・プロバイダー可否を検証し、エラーをダイアログ内に表示する。
- テーマ: タスク状態ごとの背景色トークン（`taskStatus*Background`）を全テーマプリセットに追加する。
- 文言・日付書式・要対応理由の表示文はすべて i18n（要対応理由は機械可読なコード＋パラメータで保存し、表示時に翻訳する）。
- LLM 出力やタスク本文の Markdown は、HTML 化した後にサニタイズ（DOMPurify を追加）してから表示する。

### 3.13 エラー処理

- UI からの操作失敗は、該当ダイアログまたはトーストで理由を表示する（握りつぶさない）。
- orchestrator 内部の失敗は該当タスクを `attention` にし、理由コードを記録する。同じ失敗を短周期で再試行しない。

---

## パート 4: 要件整理、Issue トラッカー連携、タスク添付

### 4.1 要件整理

- 別ウィンドウ（`intake-<id>`）で開く。ワークフローを選んで「新規タスク」を押すと起動する。新規タスクは必ず要件整理を経由する。
- 開始前に、種別（機能要望 / バグ報告）、プロバイダーとモデルを選ぶ。3 プロバイダーすべてに対応し、read-only で実行する。
  - 機能要望: 目的、制約、受入条件、未解決事項を一問ずつ深掘りする。
  - バグ報告: 症状、期待結果、実際の結果、再現手順、環境、未解決事項を収集する。
  - いずれの手順も組込みプロンプトに含め、外部スキルに依存しない。
- 対話中、LLM は質問（選択肢付き可）または要件整理結果の案を返す。利用者は選択肢・自由入力・音声入力・画像貼り付けで回答する。
- AI 応答の失敗時も、再試行ボタンと自由入力欄を常に表示する。
- セッションは `.mdium/intakes/<id>.json` に保存し、一覧から再開できる。
- メインウィンドウでのモデル設定変更・ワークフロー変更はイベントで要件整理ウィンドウへ反映する。
- 文書更新提案: LLM が CONTEXT.md 等の更新案を返した場合、差分を表示し、利用者が承認したものだけを MDium が利用者の作業ツリーへ書き込む。

### 4.2 確定とタスク化

確定処理は段階ごとに完了を記録し、失敗した段階から再開できるようにする。

```
ready → issue_created（Issue 連携時のみ）→ attachments_committed → task_created → done
```

- 各段階の結果（Issue URL、添付 ID、タスク ID）をセッションに保存し、再試行時は完了済みの段階を再実行しない。
- ルートタスクの本文は要件整理結果、タイトルは要約から生成する。

### 4.3 Issue トラッカー連携

- 対象: `issueTracking: "auto"` のワークフローで、`origin` が GitHub または GitLab（セルフホスト含む）の場合。`gh` / `glab` CLI とその認証を前提とし、要件整理の開始前に疎通を確認する。
- 宛先は `origin` から決め、全コマンドで `--repo`（GitLab は `--repo`／プロジェクト指定）を明示する。

| 契機 | 操作 |
|---|---|
| 要件整理の確定 | Issue を作成（本文は要件整理結果） |
| 設計工程の完了 | 設計書をコメント |
| 実装工程の完了 | 実装要約（コミット一覧、ブランチ名）をコメント |
| レビュー工程の完了 | レビュー結果をコメント（差し戻し時は指摘を含む） |
| ローカルにマージ | Issue をクローズ |

- 本文・コメントはファイル経由（`--body-file` 等）で渡す。
- 各コメントに `<!-- mdium:entry:<entryId> -->` を埋め込み、投稿前に既存コメントを確認して重複を防ぐ。`entryId` は試行 ID から決める。
- 同期失敗時はタスクを `attention`（理由: Issue 同期失敗）にし、次工程へ進めない。利用者は「再試行」または「同期せずに続行」を選べる。

### 4.4 タスク添付

- ルートタスクに属し、`.mdium/task-attachments/<rootTaskId>/<attachmentId>/` に登録時点の内容で保存する（以後不変）。メタデータ（元ファイル名、MIME、サイズ、ハッシュ）を併せて保存する。
- 登録は下書き領域に置いてから、タスク作成と同じ確定処理の段階で本登録する（4.2）。
- エージェントには添付 ID、メタデータ、絶対パスを渡す。画像入力に対応するプロバイダーには画像として渡す。
- 添付パスはプロジェクト管理領域内に正規化し、管理領域外を指すパスは拒否する。
- 要件整理で貼り付けた画像は添付下書きとして扱う。

---

## パート 5: 定期 JOB

- 定義（`.mdium/schedules.json`）: 名前、実行タイミング（毎日の時刻 / 間隔）、指示、プロバイダーとモデル、出力先 Markdown パス（プロジェクト内の相対パス）。
- 有効・無効はマシンごとの設定としてアプリ側（プロジェクトパスをキーにした設定ストア）に保存する。リポジトリを開いただけでは JOB は実行されない。
- 実行: read-only 権限で、作業ディレクトリはプロジェクトのルート。最終応答を MDium が出力先へ書き出す。
- スケジューラは Rust 側で動作する。アプリ停止中に過ぎた実行はさかのぼって行わない。一覧に最終実行時刻・結果と次回予定を表示する。
- 実行ごとに「自動生成」タスクを作り、カンバンで追跡する（ワークフローには属さない）。キャンセル・タイムアウト・回復は 3.5 と同じ。
- UI: 左パネルの定期 JOB 一覧、作成・編集ダイアログ（手順ガイド付き）、有効化スイッチ、手動実行ボタン、実行中件数バッジ。

---

## 外部前提

- Node.js 20 以上（エージェントランナー）
- 使用するプロバイダーの CLI と認証（Codex CLI、Copilot、opencode）
- Issue 連携時: `gh` または `glab` と認証
- git（ワークフロー）

## テスト方針

- Rust: 状態遷移表（許可・拒否の全組み合わせ）、orchestrator（取得の排他、キャンセル、タイムアウト、再入上限、遷移予定からの回復、起動時回復）、worktree 作成・マージ・破棄（一時リポジトリ）、Issue 同期の重複防止（CLI をフェイク化）、壊れたタスク文書の扱い、要件整理の段階的確定。
- エージェントランナー: 各アダプタをフェイク SDK でテスト（権限の対応付け、unsupported、キャンセル、タイムアウト）。
- フロントエンド: vitest でストア・コンポーネント（状態別の操作ボタン、承認と修正依頼、i18n キーの ja/en 一致）。
- 各パートの完了時に実機スモーク手順を実施する。

## 対象外

- push、PR / MR 作成、リモートでのマージ
- 工程の追加・削除・並べ替え、任意の遷移グラフ
- 外部スキルパックの取得・同期
- ガードなしの全権限でのエージェント実行
- 書き込み権限を持つ定期 JOB
- アプリ停止中の定期 JOB の補完実行
