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

orchestrator が UI へ送るタスク・フロー実行のイベントは次の 3 種類とする（要件整理とワークフロー定義のイベントは 4.5。ペイロードは camelCase。`projectRoot` は正規化済みのプロジェクトルートで、UI 側も正規化してから比較する）。

| イベント | ペイロード | 契機 |
|---|---|---|
| `workflow://task-changed` | `projectRoot`、`taskId`、`rootId`、`status` | タスクの状態変化 |
| `workflow://run-changed` | `projectRoot`、`rootTaskId`、`status` | フロー実行の状態変化（完了・取込み待ち、マージ、破棄など） |
| `workflow://progress` | `projectRoot`、`taskId`、`attemptId`、`kind`、`text` | 試行中の進捗メッセージ（試行の停止後は送らない） |

### 3.5 orchestrator

- 取得: 有効なワークフローごとに、同時実行中のフロー実行数が `maxConcurrentRuns` 未満なら inbox のタスクを古い順に取得する。排他はプロセス内のミューテックスで行う。
  - 同時実行数は進行中（Active）のフロー実行の数で数える。上限が効くのは新しいフロー実行の開始（ルートタスクの取得）だけで、既存のフロー実行の後続タスクは上限で待たされない。
  - 要対応（attention）・承認待ち（awaiting_user）のタスクを抱えるフロー実行も進行中であり、枠を占有する（UI ではこの占有が分かるように表示する）。
- 実行記録: 試行開始時、フロー実行に `{ attemptId, startedAt }` を記録する。`runnerPid` は予約項目で、現在は常に null とする（ランナー API がプロセス ID を公開せず、回復もランナーの生存確認を行わないため）。
- 回復: アプリのプロセス起動後、各プロジェクトへ最初に接続したときに一度だけ、running のタスクをすべて `attention`（理由: 中断）にし、終了時刻のない試行記録を「中断」として閉じる。試行はアプリのプロセスを越えて継続しないため、ランナーの生存確認は行わない。WebView のリロードや同じプロジェクトへの再接続では回復処理を行わない。自動の再実行もしない。
- 遷移予定の回復: 最初の接続時と各取得処理のたびに、遷移予定（3.10）が残っているフロー実行について遷移を冪等に再開する。親タスクが既に保留・中止になっている場合は遷移予定を破棄する。
- キャンセル: on_hold / cancelled への遷移時、該当セッションを `cancel` し、ランナー側でプロセスツリーを終了する。成果は worktree に残る。
- タイムアウト: 工程の `timeoutMinutes` を超えたらキャンセルし `attention`（理由: タイムアウト）にする。ランナーにはターンの制限時間として `timeoutMinutes` に 60 秒を加えた値を渡し、通常は MDium 側の期限が先に到達するようにする。ランナー側の制限時間で終わったターン（`turn_failed` の `TIMEOUT`）もタイムアウトとして扱う。
- 依頼していないキャンセル: MDium がキャンセルを依頼していないのにランナーがターンをキャンセルした場合は、`attention`（`ATTENTION_ATTEMPT_FAILED`、`code`: `RUNNER_TURN_CANCELLED`）にする。
- 試行の終了処理（試行記録・状態の更新）自体が失敗した場合も、タスクを running のまま残さず `attention`（`ATTENTION_ATTEMPT_FAILED`、`code` は失敗した処理のコード）にする。
- アプリ終了時は全セッションをキャンセルし、試行の終了を最大 6 秒待つ（キャンセル完了の待機 4 秒と、セッションの終了・事後検査・記録の 2 秒）。running のタスクは次回起動時の回復で `attention` になる。

### 3.6 worktree とブランチ

- フロー実行の開始時（設計工程の前）に作成する。
  - 場所: `%LOCALAPPDATA%\mdium\worktrees\<リポジトリパスのハッシュ>\<rootTaskId>`（リポジトリ外。ファイルツリー・RAG・git status に現れない）
  - ブランチ: `mdium/<rootTaskId 先頭8文字>-<タイトルのスラッグ>`
  - base: 開始時の HEAD のブランチ名とコミットをフロー実行に記録する
- 全工程のエージェントはこの worktree を作業ディレクトリとして実行する。レビューは `base..branch` の差分を対象にする。
- プロジェクトが git リポジトリでない場合、ワークフローは実行不可とし理由を表示する。
- worktree を作成した後にフロー実行を記録できなかった場合は、その worktree とブランチを削除する（ベストエフォート）。以前の開始で作成済みのまま記録されなかった worktree が、期待する場所に期待するブランチで git に登録されていて、そのブランチに現在のブランチとの merge-base より先のコミットがない場合（base が一意に決まる場合）は、作り直さずに再利用する。それ以外は `ATTENTION_WORKTREE_FAILED`（`GIT_WORKTREE_EXISTS`）とし、利用者に破棄を委ねる。

### 3.7 工程の権限と安全ガード

| 役割 / モード | 権限（2.1） |
|---|---|
| 設計 | read-only |
| 実装（計画、`requiresApproval` が true の場合のみ） | read-only |
| 実装（本実行） | full-access（作業ディレクトリは worktree） |
| レビュー | read-only |

実装の本実行は利用者の承認なしで全権限を与えてよい。その代わり、次の多層の安全ガードを必ず適用する。ガードは危険操作の検出を完全には保証しない（難読化されたコマンドやネットワーク送信は網羅できない）ため、ワークフローを初めて有効にするときにこの限界を説明し、利用者の確認を得る。

1. 入力検査: 工程の開始前に、エージェントへ渡す外部由来テキスト（タスク本文、Issue 本文・コメント、テキスト系の添付）を検査する。既知のインジェクション表現（以前の指示の無視、システムプロンプトの上書き、資格情報や環境変数の送信依頼など）、不可視文字・双方向制御文字、長大なエンコード済みペイロードを検出した場合は実行せず `attention`（理由: 入力に危険な指示の疑い、該当箇所を表示）とする。利用者は内容を確認して「このまま続行」できる。
   - 検査対象: ルートタスクはタイトル・本文・利用者入力（回答・修正依頼）を、後続タスクは自身の本文と利用者入力のみを検査する（ルートの本文は開始時に検査済みのため）。ルートタスクの検査は worktree の作成前に行い、検出時は worktree を作らない。
   - 「このまま続行」は検査対象テキストのハッシュとしてタスクに記録する。タスク自身の内容（ルートタスクはタイトルと本文、後続タスクは本文）と利用者入力は別々のハッシュとして記録し、それぞれ一致する間は検出を再度報告しない。テキストが変われば、変わった部分だけを改めて検査する。これにより、回答や修正依頼を送っても、確認済みの要件が再び検出されることはない。
2. 実行時ガード: 2.1 のガードフックで、次の操作を拒否リストとして判定する。
   - `git push`、リモートの追加・変更、`gh` / `glab` による外部変更
   - worktree 外への書き込み・削除
   - 資格情報の読み取り（`~/.ssh`、`~/.aws`、`~/.config/gh`、`.git-credentials`、`.env` 系、ブラウザのプロファイル等）
   - 外部への送信系コマンド（`curl` / `wget` / `Invoke-WebRequest` / `Invoke-RestMethod` 等でのアップロード・POST）
   - システム設定の変更（レジストリ、サービス、スケジュールタスク、環境変数の永続変更）
   - エージェント・ツール設定の書き込み（`.claude/`、`.opencode/`、`opencode.json(c)`、`.mcp.json`、`.codex/`、`.copilot/`、`.vscode/` の設定類、`.git/` 内部、`.gitmodules`）。次のターンの CLI が読み込んで実行したり、取込み後に利用者のリポジトリへ持ち込まれたりするのを防ぐ。
   - `git config` による永続設定（コマンドを保持するキー、`core.hooksPath`、`include.path`、`alias.*`、`remote.*` 等）の書き込み。worktree は元のリポジトリと `.git/config` を共有するため。
   Copilot / opencode / Claude は実行前に拒否する。Codex は実行開始イベントで検出した時点でターンを中止する。いずれも `attention`（理由: 危険操作を検出、内容を表示）とする。
3. 環境による封じ込め: エージェントの子プロセス環境（2.1 の `env`）で、`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` により `protocol.allow=never` を既定とし `protocol.file.allow=always` のみ許可したうえで、`protocol.https.allow` / `protocol.http.allow` / `protocol.ssh.allow` / `protocol.git.allow` / `protocol.ext.allow` をそれぞれ `never` にする（環境変数由来の設定はリポジトリローカルの `protocol.<name>.allow` より優先されるため、リポジトリ設定で再許可できない）。あわせて `GIT_TERMINAL_PROMPT=0`・`GCM_INTERACTIVE=never` とし、`GH_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` / `GITLAB_ACCESS_TOKEN` を無効値に、`GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` を空ディレクトリにする。MDium 自身の Issue 連携は Rust から通常の環境で行うため影響を受けない。
   - この環境はエージェントの子プロセスだけでなく、ワークフロー用ランナーのプロセス全体に適用する（ランナーをこの環境で起動するため、ランナーが起動する opencode の専用サーバも含めて同じ封じ込めを受ける）。
   - opencode の専用サーバは非表示ウィンドウで起動し、起動ごとに生成したランダムなパスワード（`OPENCODE_SERVER_PASSWORD`、HTTP Basic 認証）を必須とする。ポートは既定値に頼らず空きポートを明示指定する（MDium の opencode パネルが使うサーバと衝突させないため）。
   - 読み取り専用の Claude セッションでは WebSearch も拒否する（ネットワークアクセスとして扱う）。
4. 事後検査: 工程の終了後、利用者のリポジトリのブランチ位置と HEAD、base ブランチ、共有される `.git/config` と hooks（`core.hooksPath` を含む）が工程開始前から変化していないこと、worktree の管理ディレクトリ（`<common-dir>/worktrees/<name>`）の `config.worktree`、および worktree 内でエージェント設定ファイル（`.claude/`・`.mdium/` 等）が変更されていないことを確認し、変化していれば `attention`（理由: 作業ツリー外への変更を検出）とする。利用者が並行して編集しうる作業ツリーのファイル内容は検査対象にしない。MDium が worktree 内で git を実行する前には、`<worktree>/.git` が通常ファイルで、その `gitdir:` が利用者リポジトリの `<common-dir>/worktrees/<name>` を指していることを確認し（違えば `GIT_WORKTREE_LINK_TAMPERED`）、読み取り系の git は `-c core.fsmonitor=false` 付きで実行する。取込み（ローカルマージ）の前には、`.github/`・`AGENTS.md`・`CLAUDE.md`・`.husky/`・`.githooks/`・`.devcontainer/` を含む設定系ファイルの変更一覧を示し、利用者の明示的な確認を求める。
   - 比較の基準: 試行ごとに、試行開始直前のスナップショットと試行後を比較する。基準はフロー実行開始時ではなく試行ごとに取り直すため、利用者が工程の合間に base ブランチへコミットしたりブランチを切り替えたりしても次の試行を妨げない。試行中に変化した場合は `attention` となり、再試行すると新しい基準を取って実行し直す。
   - フロー実行に保存する整合性の基準（取込み時の判定に使う）は、事後検査がすべて通った試行でのみ更新する。変化を検出した試行や検査に失敗した試行では以前の基準を保持し、検出した変化を基準に取り込まない。
   - 試行中に共有される git 設定や hooks が変化した場合（`INTEGRITY_GIT_CONFIG_CHANGED`・`INTEGRITY_HOOKS_CHANGED`・`INTEGRITY_HOOKS_PATH_CHANGED`）、再試行には利用者の明示的な確認（「整合性の変化を確認済み」）を要し、確認なしの再試行は `WORKFLOW_INTEGRITY_ACK_REQUIRED` で拒否する。確認すると現在の状態が新しい基準になる。ブランチ位置や HEAD の移動だけの場合は確認なしで再試行できる。
   - 各試行の開始前にも、取り直したスナップショットの git 設定・hooks・`core.hooksPath` をフロー実行の基準（ある場合）と比較し、違えばセッションを開始せずに `attention`（`ATTENTION_INTEGRITY_CHANGED`）とする。保留中など、検出の理由が失われた変化も次の試行で必ず検出する。手動で完了扱いにする操作も、工程によらず同じ比較で変化があれば `WORKFLOW_INTEGRITY_CHANGED` で拒否する。
   - 取込み時の判定: 取込み（差分のプレビュー・ローカルマージ）の前には、共有される git 設定と hooks の変化のみ利用者の確認を要する。ブランチ位置や HEAD の移動は利用者の通常の作業であり対象外とする。確認が済むまで MDium は worktree 内で git を実行しない。取込みで利用者の作業ツリーに対して実行する git（状態確認・マージ・コミットの参照）も `-c core.fsmonitor=false` 付きで実行する。
   - エージェント設定の確認: worktree 内のエージェント設定ファイルの変更（`ATTENTION_AGENT_CONFIG_CHANGED`）は、利用者が内容を確認したうえで再試行時に「確認済み」とできる。確認済みの記録はファイルのパスと内容ハッシュの組でフロー実行に保存し、同じ内容である限り以降の試行で再び報告しない。内容が変われば再度報告する。設定ディレクトリがファイルやシンボリックリンクに置き換えられた場合も変更として検出する。

補足（ガードの限界）: Codex には実行前フックがないため、ガードはコマンド開始後に検出してターンを中止する（最初の操作自体は防げない場合がある）。Claude は SDK の PreToolUse フックで全ツール呼び出しを検査し、ガード付き・読み取り専用のセッションでは利用者・プロジェクト設定のフックと許可ルールを無視する。ただし、組織（Enterprise）のポリシーとして配布された Claude の管理設定（managed settings）のフックと許可ルールは引き続き適用されうる。これは MDium から無効化できないため、管理設定がガードと異なる判定をする可能性がある。opencode もシステムの管理設定と利用者のグローバル設定は MDium から上書きできない。

### 3.8 工程の入出力

- 入力: ルートタスクの本文（要件整理結果）、直前工程の成果物、レビュー差し戻し時は指摘内容、添付参照、工程の指示と完了要件、出力契約。
- 前回の試行: 同じタスクの前回の試行から引き継ぐ内容を、データとして囲んだ「Previous attempt」節で渡す。
  - 承認後の本実行: そのタスクで最後に完了した計画モードの試行の成果物本文（承認済みの計画）。
  - 計画の修正依頼: 同じく最後に完了した計画（修正対象の計画）。修正の指示は利用者の追加指示として渡す。
  - 質問への回答: 前回の試行が `awaiting_user` で終わっていた場合、その質問と、その試行の成果物本文。回答は利用者の追加指示として渡す。
- 出力契約: 最終応答は YAML frontmatter（`outcome`、`reason`、必要に応じ `question`）＋ Markdown 本文とする。frontmatter が無い・解析できない場合は `attention`（理由: 出力形式不正）とする。
- 成果物の保存はエージェントではなく MDium（Rust）が行う: 試行成果物ファイル、子タスク本文、Issue コメント（パート4）。
- `designDocPath` が設定されている場合、設計工程の完了時に MDium が worktree の該当パスへ設計書を書き出してコミットする（再設計時は上書きして新しいコミット）。
  - 主に Issue トラッカーを使わない運用で、設計の記録をリポジトリに残すための設定である（Issue 連携の有無とは独立して設定できる）。
  - ワークフロー編集ダイアログで保存を有効にすると、初期値として `docs/designs/{date}-{slug}-design.md` が入る。`{date}` はフロー実行開始日（YYYY-MM-DD）、`{slug}` はルートタスクのタイトルから生成する。
  - パスはリポジトリ相対とし、リポジトリ外・`.git/`・`.mdium/` を指すものは保存時に検証エラーとする。
  - 利用者が設計タスクを手動で完了扱いにした場合も、整合性チェックの後に同じく設計書を保存・コミットする。整合性に変化がある場合や書き出し・コミットに失敗した場合は操作エラー（`WORKFLOW_INTEGRITY_CHANGED` / `WORKFLOW_DESIGN_DOC_FAILED`）として理由を表示し、タスクは `attention` のまま次工程へ進まない。
- レビュー工程には、差分に加えて、そのフロー実行で最後に完了した設計タスクの成果物（設計書）を入力として渡す（再設計があった場合は最新のもの）。
- `reviewReturnTo` が実装工程で、レビューの差し戻しから作られた実装タスクにも、同じく最後に完了した設計タスクの成果物を入力として渡す（最初の実装タスクは設計の成果物を自身の本文として受け取る）。

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
  - 未コミット変更の判定は追跡ファイルのみを対象とし、未追跡ファイルはマージを妨げない。
  - マージ前に 3.7-4 の取込み時の判定（git 設定・hooks の変化）と設定系ファイルの変更一覧の確認を行う。
- 「破棄」: 確認のうえ worktree とブランチを削除する。
- push・PR 作成は行わない。

### 3.12 UI

- アクティビティバーに「ワークフロー」を追加する。選択時、左パネルにワークフロー一覧・定期 JOB 一覧・フィルタ、メイン領域にワークスペースを表示する。
- ワークスペース: カンバン表示（状態別の列、件数バッジ）とマトリクス表示（工程 × 状態）を切り替える。カードに状態別背景色、更新日時、要対応理由を表示する。完了タスクのアーカイブ・削除ができる（フロー実行が進行中・取込み待ちの間は、そのフロー実行のタスクを削除できない）。
- 表示の更新は 3.4 のイベント（`workflow://task-changed` / `workflow://run-changed` / `workflow://progress`）で行い、ポーリングしない。
- タスク詳細: アプリ内モーダル。本文、状態履歴、LLM 作業状況（最新の進捗メッセージ）、フロー実行情報（再入回数、直近遷移を工程名で表示）、ブランチと差分、状態に応じた操作ボタン。
- ワークフロー編集ダイアログ: 3.3 の各項目を編集。保存時に権限・プロバイダー可否を検証し、エラーをダイアログ内に表示する。
- テーマ: タスク状態ごとの背景色トークン（`taskStatus*Background`）を全テーマプリセットに追加する。
- 文言・日付書式・要対応理由の表示文はすべて i18n（要対応理由は機械可読なコード＋パラメータで保存し、表示時に翻訳する）。
- LLM 出力やタスク本文の Markdown は、HTML 化した後にサニタイズ（DOMPurify を追加）してから表示する。

### 3.13 エラー処理

- UI からの操作失敗は、該当ダイアログまたはトーストで理由を表示する（握りつぶさない）。
- orchestrator 内部の失敗は該当タスクを `attention` にし、理由コードを記録する。同じ失敗を短周期で再試行しない（自動の再試行は行わず、再試行は利用者操作のみ）。
- UI 操作のコマンドの失敗は `{ code, message }` で返す。`message` はログ用の詳細であり、表示文は `code` から i18n で生成する。

要対応理由コード（パラメータ）:

| コード | パラメータ | 意味 |
|---|---|---|
| `ATTENTION_INTERRUPTED` | — | 実行中にアプリが終了した（再起動後の回復で設定） |
| `ATTENTION_TIMEOUT` | — | `timeoutMinutes` を超えた |
| `ATTENTION_ATTEMPT_FAILED` | `code`、`message` | 試行の失敗（下記の失敗コード） |
| `ATTENTION_GUARD_BLOCKED` | `rule`、`summary` | 実行時ガードが危険操作を検出 |
| `ATTENTION_SCREENING_FLAGGED` | `items`（`kind`、`line`、`excerpt`） | 入力検査で危険な指示の疑いを検出 |
| `ATTENTION_INTEGRITY_CHANGED` | `items`（`code`、`detail`） | 事後検査で作業ツリー外への変更を検出 |
| `ATTENTION_INTEGRITY_CHECK_FAILED` | `code` | 事後検査自体が失敗（安全側に倒して要対応） |
| `ATTENTION_AGENT_CONFIG_CHANGED` | `items`（パス） | worktree 内のエージェント設定ファイルの未確認の変更 |
| `ATTENTION_OUTPUT_INVALID` | `code` | 最終応答が出力契約に従っていない |
| `ATTENTION_STAGE_REPORTED` | `reason` | 工程自身が要対応を報告（レビュー以外） |
| `ATTENTION_REENTRY_LIMIT` | `count` | 再入上限に達した |
| `ATTENTION_WORKTREE_FAILED` | `code` | worktree の作成・差分取得に失敗 |
| `ATTENTION_DESIGN_DOC_FAILED` | `code` | 設計書の保存・コミットに失敗 |
| `ATTENTION_NOT_A_REPO` | — | プロジェクトが git リポジトリでない |
| `ATTENTION_WORKFLOW_MISSING` | `workflowId` | ワークフローが存在しない・無効・アーカイブ済み |
| `ATTENTION_ISSUE_SYNC_FAILED` | `code`、`message`、`entry` | 工程結果を Issue に記録できなかった（4.3）。`entry` は記録種別 |

- `ATTENTION_INTEGRITY_CHANGED` の項目コード: `INTEGRITY_BRANCH_SWITCHED`、`INTEGRITY_HEAD_MOVED`、`INTEGRITY_BASE_BRANCH_MOVED`、`INTEGRITY_GIT_CONFIG_CHANGED`、`INTEGRITY_HOOKS_CHANGED`、`INTEGRITY_HOOKS_PATH_CHANGED`、`INTEGRITY_BASELINE_MISSING`、`INTEGRITY_IO_FAILED`。
- `ATTENTION_ATTEMPT_FAILED` の失敗コード（`code`）には、ランナー由来のエラーコードのほか、MDium 側で付与する `RUNNER_EXITED`（ランナーの異常終了）、`RUNNER_TURN_CANCELLED`（依頼していないランナー側のキャンセル）、`AGENT_RUNNER_MISSING`（同梱のランナーが見つからない）、`WORKFLOW_WORKTREE_PATH_NOT_UTF8`（worktree のパスを UTF-8 で表せない）、`WORKFLOW_ATTEMPT_PANICKED`（試行処理の内部異常）、`WORKFLOW_THREAD_SPAWN_FAILED`（試行スレッドを起動できない）、試行の終了処理に失敗した場合の `STORE_*` / `TRANSITION_*` がある。整合性チェック中の内部異常は `ATTENTION_INTEGRITY_CHECK_FAILED`（`code`: `WORKFLOW_ATTEMPT_PANICKED`）とする。
- `ATTENTION_INTEGRITY_CHECK_FAILED` のコードには、`INTEGRITY_*`（例: `INTEGRITY_IO_FAILED`、エージェント設定ファイルが大きすぎて検査できない `INTEGRITY_FILE_TOO_LARGE`）と `GIT_*` がある。
- `ATTENTION_GUARD_BLOCKED` は、ランナーがガードによる中止（`GUARD_BLOCKED`）を報告したのに違反内容が届かなかった場合、`rule` を `unknown`、`summary` を空とする。
- `ATTENTION_ISSUE_SYNC_FAILED` のパラメータ:
  - `code`: CLI の失敗（`FORGE_*`）、`WORKFLOW_ISSUE_ENTRY_FAILED`（実装要約に使うコミット一覧を取得できない、または worktree がない）、`WORKFLOW_ISSUE_SYNC_INTERRUPTED`（記録中にアプリが終了した、または終了処理中で記録しなかった）、「記録中」の印を保存できなかった場合の `STORE_*`。
  - `message`: 失敗の詳細（160 文字まで）。
  - `entry`: `design` / `implement` / `review`。

UI 操作のコマンドが返す主な失敗コード（`{ code, message }` の `code`）:

| コード | 意味 |
|---|---|
| `WORKFLOW_MERGE_INTEGRITY_CHANGED` | 取込み: 共有される git 設定・hooks が基準から変化しており、確認されていない |
| `WORKFLOW_MERGE_REVIEW_CHANGED` | 取込み: 確認済みの設定系ファイルの変更一覧が現在の一覧と一致しない |
| `WORKFLOW_INTEGRITY_ACK_REQUIRED` | 再試行: 試行中の git 設定・hooks の変化を確認していない |
| `WORKFLOW_INTEGRITY_CHANGED` | worktree 内で git を実行する操作（設計書のコミット、エージェント設定の確認）の前に、未確認の整合性の変化がある |
| `WORKFLOW_RUN_IN_PROGRESS` | 削除: タスクのフロー実行が進行中（Active）または取込み待ち |
| `WORKFLOW_TASK_NOT_FINISHED` | アーカイブ・削除: タスクが完了・中止していない |
| `WORKFLOW_ISSUE_ENTRY_FAILED` | Issue 同期の再試行: 実装要約に使うコミット一覧を取得できない、または worktree がない |
| `ISSUE_SYNC_NOT_PENDING` | Issue 同期の再試行・同期せずに続行: タスクが Issue 同期失敗の要対応でない、フロー実行が進行中でない、または現在タスクでない |
| `ISSUE_SYNC_OUTPUT_INVALID` | Issue 同期の再試行・同期せずに続行: 最後の試行の成果物を工程結果として解釈できない |
| `ISSUE_SYNC_IN_PROGRESS` | Issue 同期の再試行・同期せずに続行: 同じタスクに対する操作が実行中 |
| `ISSUE_NOT_TRACKED` | クローズの再試行: フロー実行が Issue を連携していない |
| `ISSUE_RUN_NOT_MERGED` | クローズの再試行: フロー実行がマージ済みでない |
| `ISSUE_TRACKING_UNAVAILABLE` | 確定: Issue 連携が有効だが、連携先の検出・CLI・認証のいずれかがそろわない |
| `INTAKE_NOT_FOUND` | 要件整理のセッション、または文書更新提案が存在しない |
| `INTAKE_NOT_ACTIVE` | 要件整理が対話中でない（確定済み・破棄済み、または破棄できない段階の確定処理中） |
| `INTAKE_TOO_LARGE` | メッセージが 64 KiB を超える、または編集した案の本文が 256 KiB を超える |
| `INTAKE_EMPTY_MESSAGE` | メッセージに本文も添付下書きもない |
| `INTAKE_NO_PENDING_MESSAGE` | 再試行: 未応答の利用者メッセージがない |
| `INTAKE_TURN_BUSY` | 送信・再試行・案の編集: 同じ要件整理のターンが実行中 |
| `INTAKE_DOC_UPDATE_NOT_PENDING` | 文書更新提案が判断済み |
| `INTAKE_INVALID_PATH` | 文書更新提案の承認: 書き込み先が 4.1 の検査を通らない（提案は未判断のまま残る） |
| `INTAKE_DOC_CHANGED_SINCE_PROPOSAL` | 文書更新提案の承認: 提案の受信後に対象の文書が変更・作成・削除された（提案は未判断のまま残る） |
| `INTAKE_NO_PROPOSAL` | 確定・案の編集: 要件整理結果の案がない |
| `INTAKE_PROPOSAL_TITLE_INVALID` | 案の編集: タイトルが空、または 100 文字を超える |
| `INTAKE_PROPOSAL_BODY_EMPTY` | 案の編集: 本文が空 |
| `INTAKE_TURN_PENDING` | 確定: 最新の利用者メッセージが未応答 |
| `INTAKE_WORKFLOW_UNAVAILABLE` | 要件整理の開始・確定: ワークフローが存在しない・無効・アーカイブ済み |
| `INTAKE_FINALIZE_IN_PROGRESS` | 確定・破棄・対話への復帰: 同じ要件整理の確定処理が実行中 |
| `INTAKE_NOT_REOPENABLE` | 対話への復帰: 確定処理中でない、または Issue の作成に着手した後の段階 |
| `INTAKE_PROJECT_PATH_NOT_UTF8` | プロジェクトのパスを UTF-8 で表せない（ターンを準備できない） |

- Issue の CLI 操作（確定での Issue 作成、Issue 同期の再試行、クローズの再試行、`issueCloseError`）の失敗コード: `FORGE_NOT_INSTALLED`（CLI がない）、`FORGE_NOT_AUTHENTICATED`（未認証）、`FORGE_COMMAND_FAILED`（その他の CLI の失敗）、`FORGE_BAD_RESPONSE`（応答を解釈できない）、`FORGE_TIMEOUT`（期限切れ）。
- 添付の操作の失敗コード: `ATTACHMENT_INVALID_ID`（ID が 16 桁の小文字 16 進数でない）、`ATTACHMENT_NOT_A_FILE`（登録元が通常ファイルでない、またはリンク）、`ATTACHMENT_TOO_LARGE`（20 MiB 超）、`ATTACHMENT_TOO_MANY`（20 件超）、`ATTACHMENT_OUTSIDE_ROOT`（添付領域の外、または途中の階層がリンク）、`ATTACHMENT_NOT_FOUND`（存在しない）、`ATTACHMENT_IO`（入出力の失敗）、`ATTACHMENT_CORRUPT`（メタデータや内容の不整合）、`ATTACHMENT_INVALID_DATA`（Base64 として不正）。
- 確定処理の失敗コードは、セッションが `finalizing` になった後の失敗に限り `finalize.lastError` にも記録する（開始前の検査で拒否した場合は記録しない。4.2）。

要件整理のターンの失敗コード（`error` メッセージの本文として記録する。4.1）:

| コード | 意味 |
|---|---|
| `INTAKE_TURN_FAILED` | ランナーがターンの失敗・拒否や依頼していないキャンセルを報告した |
| `INTAKE_INVALID_IMAGES` | ランナーがターンに添付した画像を拒否した（ランナーの `INVALID_IMAGES`。4.4） |
| `INTAKE_TURN_TIMEOUT` | 30 分の制限時間を超えた（ランナー側の制限時間による終了を含む） |
| `INTAKE_TURN_CANCELLED` | 利用者またはアプリの終了によるキャンセル |
| `INTAKE_GUARD_BLOCKED` | 実行時ガードが操作を拒否した |
| `INTAKE_INVALID_OUTPUT` | 最終応答が出力契約に従っていない（応答の原文を 16 KiB まで `detail` に残す） |
| `INTAKE_TURN_PANICKED` | ターン処理の内部異常 |

- このほか、ランナー由来のコード（`RUNNER_EXITED`、`AGENT_RUNNER_MISSING` 等。工程の試行と同じ）と、ターンの準備に失敗した場合のコード（`ATTACHMENT_*`、`STORE_*`、`INTAKE_PROJECT_PATH_NOT_UTF8`）を記録する。

文書更新提案を受信時に却下した理由コード（提案の `reason`。4.1）:

| コード | 意味 |
|---|---|
| `INTAKE_DOC_PATH_INVALID` | パスが不正（リポジトリ外、`.git`・`.mdium`、許可しない拡張子など） |
| `INTAKE_DOC_PATH_PROTECTED` | エージェントの指示・設定ファイルなどの保護対象 |
| `INTAKE_DOC_TOO_LARGE` | 内容が 256 KiB を超える |

---

## パート 4: 要件整理、Issue トラッカー連携、タスク添付

### 4.1 要件整理

- 別ウィンドウ（`intake-<id>`）で開く。ワークフローを選んで「新規タスク」を押すと起動する。新規タスクは必ず要件整理を経由する。
- 開始前に、種別（機能要望 / バグ報告）、プロバイダーとモデルを選ぶ。選んだワークフローが存在し、有効で、アーカイブされていないことを要する（`INTAKE_WORKFLOW_UNAVAILABLE`）。ワークフロー用ランナーの 4 プロバイダーすべてに対応し、read-only で実行する。
  - 機能要望: 目的、制約、受入条件、未解決事項を一問ずつ深掘りする。
  - バグ報告: 症状、期待結果、実際の結果、再現手順、環境、未解決事項を収集する。
  - いずれの手順も組込みプロンプト（英語）に含め、外部スキルに依存しない。プロンプトでは、質問は一度に一つだけとすること、リポジトリは読み取りのみとすること、コード変更や実装計画を提案しないこと、更新提案は文書ファイルに限ることを指示する。
  - 選択中（事前選択を含む）のワークフローが開始前に使えなくなった場合は、黙って別のワークフローに切り替えず、その旨を表示して選び直しを求める（選ぶまで開始できない）。
  - プロバイダーの利用可否と Issue 連携先（4.3）の確認結果は、ウィンドウがフォーカスを得たとき（連続したフォーカス変化はまとめて 1 回）と、開始フォームの「再確認」ボタンで取り直す。CLI のインストールやログインをウィンドウを開いたまま反映するため。確認に失敗した場合は直前の結果を保つ。
- 対話中、LLM は質問（選択肢付き可）または要件整理結果の案を返す。利用者は選択肢・自由入力・音声入力・画像貼り付けで回答する。
- AI 応答の失敗時も、再試行ボタンと自由入力欄を常に表示する。
- メインウィンドウでのモデル設定変更・ワークフロー変更はイベントで要件整理ウィンドウへ反映する（4.5）。
- 確定の完了後（4.2）の「タスクを開く」: 要件整理ウィンドウは自身のラベルを含めてメインウィンドウへ `workflow://open-task`（プロジェクトの正規化済みルート、タスク ID、送信元ラベル）を送る。メインウィンドウは、そのプロジェクトがアクティブなフォルダーであればそこで、開いている別のフォルダー（正規化したルートで比較する）であればそのフォルダーに切り替えてから、ワークフロー表示でタスクを開き、自身を前面に出すことを試みる（権限がなければ無視する）。いずれでもなければ開かない。結果は送信元ウィンドウへ `workflow://open-task-ack`（タスク ID、開いたかどうか）で返す。要件整理ウィンドウは「開いた」の応答を受けたときだけ閉じる。「開けなかった」の応答、または 3 秒以内に応答がない場合は閉じずに、メインウィンドウでプロジェクトを開くよう案内する。

セッション:

- `.mdium/intakes/<id>.json` に保存し、一覧（更新の新しい順）から再開できる。読めない・壊れたファイルは一覧から除外して警告を出す。
- 状態は `active`（対話中）→ `finalizing`（確定処理中）→ `done`、または `abandoned`（破棄）。変更操作はすべて ProjectGuard の下で行う。
- 利用者メッセージは 64 KiB 以下とし（`INTAKE_TOO_LARGE`）、本文と添付下書きの少なくとも一方を要する（`INTAKE_EMPTY_MESSAGE`）。指定した下書きが存在しない場合は `ATTACHMENT_NOT_FOUND` とする。ターンの実行中は送信を受け付けない（`INTAKE_TURN_BUSY`）。続けて送るには、先に実行中のターンをキャンセルする（UI はターンの実行中は送信を無効にし、キャンセルの操作を表示する）。
- 破棄すると、そのセッションの添付下書きも削除し、実行中のターンがあればキャンセルする。したがって破棄はターンの実行中も受け付け、要件整理ウィンドウと一覧のどちらからも行える。破棄済みのセッションを再度破棄すると、下書きの削除だけをやり直す。
  - 確定処理中（`finalizing`）のセッションは、Issue の作成に着手する前（段階が `ready`、Issue が未記録、作成中の印がない）に限り破棄できる。このプロセスで確定処理が実行中の場合は `INTAKE_FINALIZE_IN_PROGRESS`、それより後の段階や `done` は `INTAKE_NOT_ACTIVE` で拒否する。

ターンの実行（ターンごとに独立したセッション）:

- ターンのたびにワークフロー用ランナーで新しい read-only セッションを開始し、会話全体をプロンプトに含めて送る。プロバイダー側のセッション再開には依存しない（プロバイダーやモデルの差、ランナーの再起動に左右されない）。ターンの終了時にセッションは必ず閉じる。
- 作業ディレクトリと実行時ガード（3.7）の作業領域はプロジェクトのルートとする。エージェントからの権限要求はすべて拒否し、利用者には問い合わせない。
- プロンプトは次の順で構成する。
  1. `# Requirement intake` と種別ごとの指示
  2. `## Conversation`: 利用者と AI の発言をデータとして囲んだもの（エラーの記録は含めない）。256 KiB を上限とし、超える場合は古いターンから省き、先頭に `[earlier turns omitted]` を置く。
  3. `## Attached files`: そのセッションのすべての添付下書きの絶対パスをデータとして列挙する（画像以外の添付もエージェントが読めるようにするため）。
  4. 出力契約
- 最新の利用者メッセージに付いた画像の下書き（MIME が `image/*`、最大 10 件）は画像としても送る（4.4 のプロバイダー別の扱い）。
- 制限時間は 30 分とし、ランナーには 60 秒を加えた値を渡す（3.5 と同じ考え方）。ProjectGuard はプロンプトの準備と結果の記録のときだけ取得し、ターンの間は保持しない。
- 応答は、それが答える利用者メッセージが依然として最新（エラーを除く）である場合にだけ記録する。キャンセルしたターンの応答が遅れて届いた場合などに、それより新しいメッセージがあればその応答は破棄し、新しいメッセージが未応答のまま残る。セッションが `active` でなくなっていた場合も応答を破棄する。
- 同じ要件整理で同時に実行できるターンは 1 つだけとする（`INTAKE_TURN_BUSY`）。実行中のターンはプロジェクトのルートと要件整理 ID の組で管理し、アプリ終了時にはすべてキャンセルする。セッションを返すコマンドは、ターンが実行中かどうか（`busy`）を併せて返し、ウィンドウを開き直しても実行中であることが分かるようにする。
- ターンの失敗（ランナーの失敗・タイムアウト・キャンセル・ガード・画像の拒否・出力形式不正・準備の失敗・内部異常）は、失敗コードを本文とする `error` メッセージとして記録する（コードは 3.13）。出力形式不正の場合は、表示・調査用に応答の原文を 16 KiB まで（文字の境界で切り詰めて）メッセージの `detail` に残す。利用者メッセージは未応答のまま残り、「再試行」で同じメッセージに対して新しいターンを始める。未応答のメッセージがなければ再試行は `INTAKE_NO_PENDING_MESSAGE` で拒否する。

出力契約:

- 最終応答は YAML frontmatter ＋ Markdown 本文とし、次のいずれかの形式に従う。前後を囲むコードフェンスは取り除いてから解釈する。
  - 質問: `type: question`、`question`（必須、一文）、`options`（任意。最大 6 件、各 200 文字まで。超えた分は切り詰める。単一キーの対応付けは `キー: 値` の文字列として受け付け、その他の値は無視する）。本文は質問の背景。
  - 案: `type: proposal`、`title`（必須。空白を詰めて 100 文字に切り詰める）、`doc_updates`（任意。`path` と `content` の組のリスト）。本文（必須）は要件整理結果の全文。
- それ以外は出力形式不正（`INTAKE_INVALID_OUTPUT`）としてターンの失敗にする。
- 質問を受けると直前の質問を置き換える。案を受けると案を置き換えて質問を消し、未判断の文書更新提案を新しい提案で置き換える（判断済みの提案は履歴として残す）。
- 案の編集: 利用者は対話中（`active`）のセッションの案のタイトルと本文を直接編集できる。案がなければ `INTAKE_NO_PROPOSAL`。タイトルは空白を詰めたうえで空でなく 100 文字以内（`INTAKE_PROPOSAL_TITLE_INVALID`）、本文は空でなく（`INTAKE_PROPOSAL_BODY_EMPTY`）256 KiB 以下（`INTAKE_TOO_LARGE`）とする。ターンの実行中は編集を受け付けない（`INTAKE_TURN_BUSY`。応答が編集を上書きするため）。編集の間はターンを開始させない。

文書更新提案:

- LLM が CONTEXT.md 等の更新案を `doc_updates` で返した場合、差分を表示し、利用者が承認したものだけを MDium が利用者の作業ツリーへ書き込む（原子的置換）。却下したものは書き込まない。各提案は `pending` → `applied` / `rejected` と遷移し、判断済みの提案への操作は `INTAKE_DOC_UPDATE_NOT_PENDING` で拒否する。
- 提案の受信時に、対象の文書の現在の内容の SHA-256 を提案に記録する（`baseSha256`。文書がなければ `null`、通常ファイルでなければ `null`）。承認時には書き込みの直前に同じ値を計算し直し、一致しない場合（提案後に利用者が編集した、作成した、削除した）は `INTAKE_DOC_CHANGED_SINCE_PROPOSAL` で拒否して提案を `pending` のまま残す。利用者の変更を黙って上書きしない。
- セッションを返すコマンドは、承認して書き込んだ文書のパス一覧（`appliedDocPaths`）を併せて返す。書き込みは作業ツリーへの変更でありコミットはしないため、UI はこれを使ってコミットを促す。
- 一つの案の中で同じパスが複数回現れた場合（大文字小文字と区切り文字の違いを無視して比較）は最後のものを採る。
- 対象にできるファイル:
  - パスはリポジトリ相対とし、区切りは `/` と `\` のどちらも受け付けて `/` に正規化する。各要素は空・`.`・`..` でなく、添付のファイル名の正規化（4.4）で変化しないこと（ドライブ指定、代替データストリームの `:`、予約デバイス名、制御文字、末尾のドット・空白を拒否する）。
  - 拡張子は `md`、`markdown`、`mdx`、`txt`、`rst`、`adoc` のいずれか。
  - どの階層にも `.git`・`.mdium` を含まない（大文字小文字を区別しない）。
  - 保護対象（取込み時に確認を求める設定系ファイルの一覧。3.7 のエージェント設定ファイルに加え、`.github/`、`AGENTS.md`、`CLAUDE.md`、`.husky/`、`.githooks/`、`.devcontainer/`）に該当しない。
  - 内容は 256 KiB 以下。
- 提案の受信時に上記を検査し、満たさない提案は内容を保持せずに直ちに `rejected` とし、理由コード（`reason`）を記録する: `INTAKE_DOC_PATH_INVALID`（パスが不正）、`INTAKE_DOC_PATH_PROTECTED`（保護対象）、`INTAKE_DOC_TOO_LARGE`（256 KiB 超）。
- 承認時の検査（書き込みの前に行う）:
  - プロジェクトのルートから既存のディレクトリを一つずつたどり、シンボリックリンク・ジャンクションを含む場合は拒否する。
  - 存在する最も深い祖先を正規化し、プロジェクト内かつ `.git`・`.mdium` の外であることを確かめ、実在の名前（8.3 形式の短い名前を解決したもの）で上記の検査をやり直す。
  - その後に不足するディレクトリを作成し、最終的な親をもう一度確かめる。書き込み先が既に存在する場合は、リンクでない通常ファイルであり、その実在の名前でも拡張子と保護対象の検査を通ることを要する。
  - 拒否した場合は `INTAKE_INVALID_PATH` を返し、提案は `pending` のまま残す（利用者は却下できる）。
  - 上記の検査の後、書き込みの前に `baseSha256` との一致を確かめる（`INTAKE_DOC_CHANGED_SINCE_PROPOSAL`）。

### 4.2 確定とタスク化

確定処理は段階ごとに完了を記録し、失敗した段階から再開できるようにする。

```
ready → issue_created（Issue 連携時のみ）→ attachments_committed → task_created → done
```

- 開始条件（いずれも状態を変える前に検査し、拒否されたセッションは `active` のまま残す）:
  - `done` のセッションに対する確定は何もせずにそのセッションを返す。`abandoned` は `INTAKE_NOT_ACTIVE`。
  - 案がない場合は `INTAKE_NO_PROPOSAL`。最新の利用者メッセージが未応答の場合は `INTAKE_TURN_PENDING`（応答を待つか、破棄してから確定する）。
  - `task_created` より前の段階では、ワークフローが存在し、有効で、アーカイブされていないことを要する（`INTAKE_WORKFLOW_UNAVAILABLE`）。
  - 同じ要件整理の確定処理は同時に一つだけとする（`INTAKE_FINALIZE_IN_PROGRESS`）。Issue の作成は ProjectGuard の外で行うため、これにより並行した確定で Issue が二重に作られることを防ぐ。セッションを返すコマンドは、このプロセスで確定処理が実行中かどうか（`finalizeRunning`）を併せて返し、確定処理は実行を始めた時点でセッションの変更を通知する。UI は実行中であれば進行中の表示にし、確定・再試行・対話への復帰・破棄の操作を出さない（ウィンドウを開き直した場合や一覧でも同じ）。
  - これから Issue を作成する場合（段階が `ready`、`issueTracking` が `auto`、Issue を省略していない）は、連携先（4.3）の検出・CLI・認証の確認も状態を変える前に ProjectGuard の外で行い、そろわなければ `ISSUE_TRACKING_UNAVAILABLE` とする。したがって、これらで拒否された対話中のセッションは `active` のまま残り、対話を続けられる。確認の後、ProjectGuard の下でセッションを読み直して上記の検査をやり直してから状態を変える。
- 段階:
  1. 状態を `finalizing` にし、ルートタスク ID を一度だけ決めてセッションに保存する（再試行でも同じ ID を使う）。
  2. Issue の作成（ワークフローの `issueTracking` が `auto` で、Issue を省略していない場合のみ）: 開始前の確認の結果を使う（確認の後に Issue 連携が有効になった場合はここで確認し、そろわなければ `ISSUE_TRACKING_UNAVAILABLE`）。タイトルは案のタイトル、本文は案の本文＋`## Attachments`（下書きのファイル名一覧）＋`<!-- mdium:intake:<intakeId> -->`。本文のメンションは無効化する（4.3）。作成に着手する前に「作成中」の印をセッションに保存し、作成した Issue を記録して `issue_created` にするときに消す。
  3. 添付下書きの本登録（4.4）。下書きの読み込みと検証は ProjectGuard の外で行い、書き込みは ProjectGuard の下で行う。登録された添付 ID を記録して `attachments_committed` にする。
  4. ルートタスクを 1 で決めた ID で作成する。本文は案の本文＋`## Attachments`（ファイル名と添付 ID の一覧）、タイトルは案のタイトル、Issue を連携した場合はタスクに Issue を記録する。同じ ID のタスクが既に存在すれば作成済みとみなす。`task_created` にする。
  5. `done`（状態も `done`）にし、orchestrator に取得を促す。
- 各段階の結果（Issue、添付 ID、タスク ID）は段階の完了ごとにセッションへ保存し、再試行時は完了済みの段階を再実行しない。失敗時は失敗コードを `finalize.lastError` に記録してエラーを返す。
- Issue の二重作成の防止: 再試行時に「作成中」の印が残っていて Issue が記録されていない場合（作成の直後にアプリが終了した場合など）は、利用者が最近作成した Issue（最大 50 件）から本文に `<!-- mdium:intake:<intakeId> -->` を含むものを探し、見つかればそれを採用する。見つからなければ作成する。
- 対話への復帰: 確定処理中（`finalizing`）のセッションのうち、Issue の作成に着手する前（段階が `ready`、Issue が未記録、作成中の印がない）に止まったものは、対話中（`active`）に戻せる。`finalize.lastError` を消し、Issue の省略の指定も取り消す（次の確定で改めて選ぶ）。ルートタスク ID は、添付が本登録済みの可能性があるため保持する。このプロセスで確定処理が実行中の場合は `INTAKE_FINALIZE_IN_PROGRESS`、それ以外（対話中・完了・破棄済み、または Issue の作成に着手した後の段階）は `INTAKE_NOT_REOPENABLE` で拒否する。
- Issue を省略して確定する操作（「Issue なしで続行」）を用意する。一度省略を指定すると、そのセッションの以降の再試行でも省略する。`ISSUE_TRACKING_UNAVAILABLE` で拒否されたセッションは、連携先が使えるようになってからの再試行か、省略による確定で完了させる。省略時は Issue を検索しないため、終了前に作成された Issue が連携されずに残ることはあるが、二重に作られることはない。

### 4.3 Issue トラッカー連携

- 対象: `issueTracking: "auto"` のワークフローで、`origin` が GitHub または GitLab（セルフホスト含む）の場合。`gh` / `glab` CLI とその認証を前提とする。UI は要件整理の開始前に疎通（リポジトリの検出、CLI の有無、認証）を確認できる。
- 連携先の検出:
  - `origin` の URL を解析する（`https://`・`http://`、`ssh://`、`user@host:path` 形式）。URL に含まれる利用者情報（トークンを含みうる）は捨て、保存しない。ホスト名とパスの各要素は許可した文字だけからなることを要し、それ以外（ローカルパス、`file://`、`git://` 等）は連携の対象外とする。https の `:443`・http の `:80` は省き、それ以外のポートはホスト名に含める。
  - `github.com` は GitHub、`gitlab.com` は GitLab とし、CLI を呼ばずに決める。それ以外のホストは、`gh auth status --hostname <host>`、`glab auth status --hostname <host>` の順に認証を確かめ、認証済みの側とする（パスが 3 階層以上なら GitHub の確認を省く）。どちらでもなければ連携の対象外とする。GitHub のパスは `owner/repo` の 2 階層に限る。
- CLI の呼び出し: すべて `gh api` / `glab api` で、`--hostname` を明示し、リポジトリは API のパスで指定する（GitLab はパスを URL エンコードしたプロジェクト ID）。MDium の通常の環境で、標準入力を閉じ、対話の抑止（`GH_PROMPT_DISABLED=1`、`NO_PROMPT=1`）とウィンドウ非表示で実行する。
  - 期限: API 呼び出しは 60 秒、`--version` と `auth status` は 15 秒。期限を過ぎたらプロセスツリーを終了して `FORGE_TIMEOUT` とする。
  - 失敗の分類: CLI がない場合は `FORGE_NOT_INSTALLED`、終了コード 4 か認証エラーを示す出力は `FORGE_NOT_AUTHENTICATED`、その他の失敗は `FORGE_COMMAND_FAILED`（標準エラーは 500 文字まで保持）、応答を解釈できない場合は `FORGE_BAD_RESPONSE`。
  - 本文・コメントは一時ファイル経由で渡す（GitHub は `-F body=@<file>`、GitLab は JSON 本文を `--input <file>`）。一時ファイルは一意の名前で新規作成し（Unix では所有者のみ読み書き可）、成功・失敗・内部異常のいずれでも削除する。GitHub の Issue タイトルは型変換されないよう `-f` で渡す。

| 契機 | 操作 |
|---|---|
| 要件整理の確定 | Issue を作成（本文は要件整理結果。4.2） |
| 設計工程の完了 | 設計書をコメント |
| 実装工程の完了 | 実装要約（ブランチ名、コミット一覧、要約）をコメント |
| レビュー工程の完了 | レビュー結果をコメント（承認、または差し戻しと指摘） |
| ローカルにマージ | Issue をクローズ |

- フロー実行は開始時にルートタスクの Issue を引き継ぐ。記録するのは、フロー実行に Issue があり、ワークフローの `issueTracking` が `auto` の場合だけとする。
- 記録の本文: 見出しは英語（`## Design` / `## Implementation` / `## Review`）。実装要約は切り詰めでも残るよう、ブランチとコミット一覧を先に置く。全体を 60,000 文字に制限し、超える場合は切り詰めた旨を添える。
- メンションの無効化: Issue に投稿する本文（確定で作成する Issue の本文と各工程の記録）では、エージェントや利用者の文章が人やチームへの通知を起こさないよう、`@` の直後が識別子の文字（英数字、`_`、`-`）の場合に単語結合子（U+2060、不可視）を挿入する。フェンスで囲んだコードブロック（```` ``` ```` / `~~~`）とインラインコードの中は変えない（コード中のメンションは通知されない）。`a@b.c` のようなメールアドレスも同様に変わるが、表示は変わらないため許容する。重複防止の印は対象外とする。
- 重複の防止: 各コメントの末尾に `<!-- mdium:entry:<entryId> -->` を埋め込む（`entryId` は `<taskId>-<attemptId>`）。投稿前に既存コメントをすべて取得し、同じ印を含むコメントがあれば投稿しない。取得に失敗した場合は投稿せずに失敗とする（確認なしに投稿しない）。
- 記録してから進める: 工程結果の記録は、試行の事後検査が通り、工程結果が確定した後、タスクを次へ進める前に行う。対象は、完了した設計（計画モードを除く）・実装・レビュー（承認）と、指摘ありのレビュー（再入上限に達した場合を除く）である。
  - 失敗時はタスクを `attention`（`ATTENTION_ISSUE_SYNC_FAILED`、`code`・`message`・`entry`）にし、未記録の記録種別をタスクに保存する。設計書の保存、次工程への遷移、再入、取込み待ちへの移行は行わない。試行の結果（完了、または指摘ありの要対応）はそのまま記録する。
  - 利用者は「再試行」または「同期せずに続行」を選べる。いずれも、タスクがこの理由の `attention` で、フロー実行が進行中で、そのタスクが現在タスクであることを要する（`ISSUE_SYNC_NOT_PENDING`）。同じタスクに対するこれらの操作はプロセス内で同時に一つだけとする（`ISSUE_SYNC_IN_PROGRESS`。投稿は ProjectGuard の外で行うため）。3.7 の git 設定・hooks の変化の確認（`WORKFLOW_INTEGRITY_CHANGED`）を行い、最後の試行の成果物を工程結果として解釈し直す（`ISSUE_SYNC_OUTPUT_INVALID`）。
  - 再試行: 記録を作って ProjectGuard の外で投稿し（重複の防止あり）、成功すれば工程を完了させて次へ進める。投稿に失敗した場合は `FORGE_*` を返し、何も変えない。
  - 同期せずに続行: 投稿せずに工程を完了させて次へ進める。CLI は呼ばない。
  - いずれも未記録の記録種別を消す。工程の完了処理が要対応を返した場合（設計書の保存失敗、再入上限）は、タスクはその理由の `attention` のまま残り、操作自体は成功とする。
  - 投稿の後に利用者がタスクを保留・中止した場合、Issue に記録が残ることは許容する（終了処理はタスクの状態を変えない）。
- 投稿中の終了への備え: 投稿の直前に、試行記録へ「記録中」の印（記録種別）を保存する。印を保存できなければ投稿せずに失敗とする。印は試行の終了処理で必ず消す。起動時の回復（3.5）で、終了していない最新の試行にこの印があり、保存済みの成果物が工程結果として解釈できる場合は、中断ではなく `ATTENTION_ISSUE_SYNC_FAILED`（`code`: `WORKFLOW_ISSUE_SYNC_INTERRUPTED`）とする。再試行すると重複の防止により、投稿済みの記録を二重に投稿しない。アプリの終了処理中に工程が終わった場合も、投稿せずに同じコードで止める。
- 実装要約に使うコミット一覧を取得できない場合や worktree がない場合は `WORKFLOW_ISSUE_ENTRY_FAILED` とする。
- マージ時のクローズ: ローカルマージの成功後、フロー実行が連携対象で未クローズなら Issue をクローズする。結果はフロー実行に記録し（`issueClosed`、失敗時は `issueCloseError` に `FORGE_*` コード）、`workflow://run-changed` を送る。クローズに失敗してもマージは取り消さない。利用者は「クローズを再試行」できる。再試行はマージ済みのフロー実行（`ISSUE_RUN_NOT_MERGED`）で Issue を連携しているもの（`ISSUE_NOT_TRACKED`）に限り、クローズ済みなら何もしない。

### 4.4 タスク添付

保存:

- ルートタスクに属し、`.mdium/task-attachments/<rootTaskId>/<attachmentId>/` に登録時点の内容（正規化したファイル名）と `meta.json`（`schemaVersion`、ID、元ファイル名、保存名、MIME、サイズ、SHA-256）を保存する。添付 ID は 16 桁の小文字 16 進数とする。
- 登録はまず下書き（`.mdium/task-attachments/_drafts/<intakeId>/<draftId>/`）に置き、確定処理の段階（4.2）で本登録する。要件整理で貼り付けた画像やファイルは下書きとして扱う。下書き ID はそのまま添付 ID になる。
- 書き込みは内容を先、`meta.json` を最後に、いずれも原子的置換で行う。`meta.json` のない項目、ID として不正な名前、リンクは一覧で無視する。
- 下書きの追加・削除と本登録は ProjectGuard の下で直列化する。ファイルからの追加は、要件整理が `active` であることを確かめてから ProjectGuard の外でファイルを読み、改めて確かめてから保存する。
- 本登録は二段階で行う。まず ProjectGuard の外で下書きを一覧し、未登録の下書きの内容を読んでメタデータと照合する（最大 20 件 × 20 MiB の読み込みでロックを塞がないため）。次に ProjectGuard の下で、下書きの一覧が準備時と完全に一致することを確かめ（一致しなければ `ATTACHMENT_CORRUPT` とし、何も書かない）、登録済みとの突き合わせと件数の上限を検査し直してから、準備した内容を書き込む。確定処理中の要件整理の下書きは変更できないため、通常は一致する。
- ルートタスクを削除すると、そのタスクの本登録済みの添付（`.mdium/task-attachments/<rootTaskId>/`）も削除する。添付を先に削除し、失敗した場合はタスクを削除せずに `ATTACHMENT_*` を返す（再度削除できる）。削除は添付領域の検査（下記）を通して行い、リンクはたどらずにリンク自体を削除する。
- UI が添付や下書きを表示・開くために、検証済みの絶対パスを返すコマンドを用意する（添付: ルートタスク ID と添付 ID、下書き: 要件整理 ID と下書き ID）。パスは下記の封じ込めと内容の照合を通したものに限る。

制限:

- 1 ファイル 20 MiB 以下（`ATTACHMENT_TOO_LARGE`）。サイズはメタデータと読み込み中の両方で確かめる。Base64 で受け取る場合は、復号前に文字数で上限を超えないことを確かめ、不正な Base64 は `ATTACHMENT_INVALID_DATA` とする。
- 1 タスクあたり 20 件まで（`ATTACHMENT_TOO_MANY`）。要件整理ごとの下書きも同じ上限とする。本登録ではコピーの前に上限を確かめる。

登録元の検査（ファイルから追加する場合）:

- 通常ファイルに限る（`ATTACHMENT_NOT_A_FILE`）。シンボリックリンク・ジャンクションは拒否する。
- Windows では、リンクを追わずに開いたハンドル（削除・名前変更を許さない共有モード）でリンクでないことを確かめたうえで、通常の方法で開き直して読む。両ハンドルの作成時刻・更新時刻・サイズが一致することを要する。これにより、OneDrive 等のクラウドのプレースホルダーファイルや重複除去されたファイルは、フィルタードライバ経由で読み込んで受け付ける。Unix では `O_NOFOLLOW` で開く。

ファイル名の正規化（保存名）:

- 最後の要素だけを使う（`/` と `\` のどちらでも区切る）。
- 制御文字と双方向制御文字（U+200E/U+200F、U+202A〜U+202E、U+2066〜U+2069）を除き、`<>:"|?*` を `_` に置き換え、先頭の空白と末尾の空白・ドットを除く。
- 120 文字以内に切り詰める（16 文字以内の拡張子は残す）。
- 予約デバイス名（`CON`、`PRN`、`AUX`、`NUL`、`CONIN$`、`CONOUT$`、`COM0`〜`COM9`、`LPT0`〜`LPT9` と上付き数字の形。拡張子の有無を問わない）と `meta.json` には先頭に `_` を付ける。
- 空になった場合は `attachment` とする。
- 元ファイル名はメタデータとしてのみ保存し、パスの組み立てには使わない。MIME は拡張子から決める。

パスの封じ込めと不変性:

- `.mdium/` から添付の場所まで各階層が実在のディレクトリであること（シンボリックリンク・ジャンクションでないこと）を確かめ、さらに正規化したパスが添付領域の下にあることを確かめる。満たさない場合は `ATTACHMENT_OUTSIDE_ROOT` とする。
- `meta.json` を読むときは、スキーマのバージョン、ID とディレクトリの一致、保存名が正規化済みの形であること、サイズ、ハッシュの形式を検査し、不整合は `ATTACHMENT_CORRUPT` とする（改ざんされたメタデータが添付領域の外を指すことはない）。
- 本登録は冪等とする。下書きの内容はサイズとハッシュをメタデータと照合してからコピーする。同じ ID が同じハッシュで登録済みなら書き直さず、異なるハッシュなら `ATTACHMENT_CORRUPT` とする。最後に下書きを削除し、そのタスクの全添付を返す（下書きの削除後の再試行でも添付 ID が分かる）。
- 添付のファイルを取得するときは、内容のサイズとハッシュをメタデータと照合し、一致しなければ `ATTACHMENT_CORRUPT` とする（登録後の内容の変更を検出する）。

エージェントへの受け渡し:

- 工程のプロンプトには、ルートタスクの本登録済みの添付を `## Requirement` の直後の `## Attachments` 節で、データとして囲んで渡す（絶対パス、ファイル名、MIME、サイズ）。試行の開始時にはハッシュを計算し直さず、通常ファイルでリンクでなく記録どおりのサイズであることだけを確かめ、満たさない添付はログに残して除外する。
- 要件整理のターンでは、下書きの絶対パスを渡し（4.1）、最新の利用者メッセージの画像は画像としても送る。ランナーのプロバイダー別の扱い:
  - Codex: SDK の画像入力（`local_image`）として渡す。
  - Claude: Base64 の画像ブロックとして本文の前に置く。1 枚 5 MiB、1 ターン合計 20 MiB を超える画像や読めない画像は送らず、その旨を本文に注記する。
  - Copilot: ファイル添付として渡す。
  - opencode: ファイルパートとして `file://` のパスを渡す。
- ランナーの画像の検査: 1 ターン 10 件まで、ドライブまたは POSIX の絶対パス（UNC・デバイスパスは拒否）、拡張子 `png` / `jpg` / `jpeg` / `gif` / `webp`、実体のパスがセッションの作業領域（ガードの作業領域、なければ作業ディレクトリ）の内側にある通常ファイルであること。満たさない場合はターンを始めずに `INVALID_IMAGES` を返す（要件整理では `INTAKE_INVALID_IMAGES` として記録する）。プロバイダーには実体のパスを渡す。

### 4.5 イベント

3.4 のイベントに加え、次のイベントを送る（ペイロードは camelCase、`projectRoot` は正規化済み）。

| イベント | ペイロード | 契機 |
|---|---|---|
| `workflow://intake-changed` | `projectRoot`、`intakeId`、`status`、`busy` | 要件整理の作成、メッセージ送信・再試行（ターン開始）、ターン終了、破棄、文書更新提案の判断、確定（成功・失敗とも。失敗時は `lastError` を記録するため） |
| `workflow://workflows-changed` | `projectRoot` | ワークフロー定義の保存・組込みワークフローの追加の成功時 |

Issue のクローズ結果の記録は `workflow://run-changed`、工程結果の記録に失敗したタスクの状態変化は `workflow://task-changed` で通知する。

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
