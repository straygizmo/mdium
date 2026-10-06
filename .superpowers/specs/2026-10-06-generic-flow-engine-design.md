# 汎用フローエンジンとフローエディタ 設計仕様

- 日付: 2026-10-06
- 対象: mdium に、ノードとエッジで表す汎用のフロー定義、その実行エンジン、ReactFlow によるビューア／エディタ、実行状況の重ね表示を、既存の開発ワークフロー（`src/features/workflow`、`src-tauri/src/workflow`）とは別の機能モジュールとして追加する
- 位置付け: 既存の開発ワークフロー（設計 → 実装 → レビュー、2026-09-24-agent-workflows-design.md のパート 3・4）は書き換えない。新エンジンが同等の機能に達した後、開発ワークフローを新エンジン上のテンプレートとして再表現し、同等性を確認してから旧エンジンを退役させる
- 本仕様は設計のみを扱う。実装は 10 章の PR 分割に従い、PR ごとに実装計画（`.superpowers/plans/`）を作成して進める

| パート | 内容 | 主な依存 |
|---|---|---|
| 1 | フロー定義モデル（ファイル形式・検証）と ReactFlow ビューア／エディタ | なし |
| 2 | 実行状況の重ね表示（イベント → ノード状態・費用・再試行回数） | 1, 3 |
| 3 | 実行エンジン（長時間実行、チェックポイントと再開、停止、承認待ち、並列度、費用集計、外部プロジェクトの呼び出し） | 1 |
| 4 | 既存の開発ワークフローのテンプレート化、同等性の基準、併存期間 | 1〜3 |

---

## 0. 用語

既存のワークフロー機能の識別子（`workflow` / `stage` / `task` / `workflowRun` / `attempt`）と衝突しない識別子を使う。コード・i18n キー・ファイル名・イベント名はこの識別子に従い、別名を併用しない。

| UI 表示 | 識別子 | 定義 |
|---|---|---|
| フロー | `flow` | ノードとエッジからなる、名前を持つ処理グラフの定義。1 ファイル 1 フロー |
| ノード | `flowNode` | フロー内の処理単位。種別 `kind`（エージェント、コマンド、承認、ループ、分岐、サブフロー、組込みアクション）を持つ |
| エッジ | `flowEdge` | ノード間の遷移。出口 `port`（`success` / `failure` / 分岐の出口名）を持つ |
| フロー実行 | `flowRun` | フロー 1 件の 1 回の実行。開始時の定義スナップショットと引数を持つ |
| ノード実行 | `nodeRun` | フロー実行中の、あるノードのある反復での 1 回の実行（再試行ごとに別の `nodeRun`） |
| ノードキー | `nodeKey` | ループ・サブフローを展開したノードの一意な位置（例: `docs[3]/summarize`） |
| 実行イベント | `flowEvent` | フロー実行の追記専用ログの 1 行。状態・費用・出力・進捗のすべてを表す |
| ノード出力 | `nodeOutput` | ノード実行が返すキーと値（JSON）。後続ノードの引数・条件で参照する |
| フロー引数 | `flowParam` | フロー実行の開始時に与える値（例: 入力文書のディレクトリ） |
| 外部プロトコル | `flowProtocol` | コマンドノードが MDium に構造化イベントを返すための JSON 行の取り決め（5.3） |

---

## 1. 背景と方針

### 1.1 既存の開発ワークフローの制約

- 工程は `Role`（`design` / `implement` / `review`）固定の 3 段で、順序も固定（`Workflow.stages`、`reviewReturnTo` による差し戻しのみ）。任意の遷移グラフは対象外としていた。
- 試行はアプリのプロセスを越えない（`AttemptRecord.runnerPid` は常に null、起動時の回復で running は `attention` になる）。60 分程度のエージェントのターンには十分だが、数時間かかる外部プロジェクトの処理には合わない。
- git worktree・Issue 連携・ガード（入力検査、実行時ガード、環境による封じ込め、事後検査）・ローカルマージが工程の実行と一体になっている。

### 1.2 方針

- 新エンジンは汎用のグラフ実行に徹し、開発ワークフロー固有の振る舞い（worktree、Issue、ローカルマージ、設計書のコミット）は**組込みアクションノード**と**ノードのポリシー**として外から与える（8 章）。
- エージェントの呼び出しは既存のエージェントランナー（`runner_host` / `runner_client`）と安全機構（`containment`、`screening`、`integrity`）を再利用し、作り直さない。
- 外部プロジェクト固有のロジックは MDium に持ち込まない（MDium は公開リポジトリ）。外部プロジェクトはフロー定義ファイルと、5.3 のプロトコルを話すコマンドを自分のリポジトリに置く。
- 併存期間中、新旧は保存場所・イベント・UI を共有しない（7.4）。

---

## 2. フロー定義モデル（パート 1）

### 2.1 ファイル形式と置き場所

- 形式: **YAML を正とする**（`*.flow.yaml`）。人が書き、コメントを残し、外部プロジェクトのリポジトリで差分レビューされる文書であるため。読み込みは `serde_yaml_ng`（既に依存にある）で行い、JSON（`*.flow.json`）も同じスキーマで受け付ける。実行時のデータ（3 章の保存レイアウト）は既存どおり JSON とする。
- 置き場所: プロジェクトの `.mdium/flows/*.flow.yaml` を自動で一覧する。外部プロジェクトはそのリポジトリ内に置く（MDium でそのフォルダを開くと一覧に出る）。
- 1 ファイル 1 フロー。サブフローはファイル相対パス（`./per-doc.flow.yaml`）で参照し、プロジェクトのルート外・シンボリックリンクは拒否する。
- `schemaVersion` を持つ（初版 `1`）。未知のトップレベルキーは警告、未知のノード属性は検証エラーとする（綴りの誤りを黙って無視しないため）。
- エディタで保存すると正規化した形で書き出すため、**YAML のコメントは保たれない**。エディタはコメントを含むファイルを開いたとき、保存前に警告する（コメントは `description` 属性に移すよう案内）。

### 2.2 トップレベル

```yaml
schemaVersion: 1
id: doc-digest              # unique within the project, [a-z0-9-]
name: Document digest
description: ...
params:                     # flow arguments given at run start
  sourceDir: { type: path, required: true }
  reviewBeforePublish: { type: bool, default: true }
defaults:                   # inherited by every node unless overridden
  timeout: 2h
  retry: { max: 0 }
  workingDir: "${{ project.root }}"
limits:
  maxConcurrentNodes: 1     # per run
  budgetUsd: 30             # pause for approval when actual cost exceeds this
env:                        # non-secret env for command nodes
  PYTHONUTF8: "1"
nodes: [ ... ]
edges: [ ... ]
outputs:                    # flow outputs, exposed to a parent subflow/loop node
  digest: "${{ nodes.compile.outputs.digest }}"
ui:                         # editor-only data, ignored by the engine
  positions: { collect: { x: 120, y: 40 } }
  viewport: { x: 0, y: 0, zoom: 1 }
```

### 2.3 ノード種別

全ノード共通の属性:

| 属性 | 型 | 既定 | 意味 |
|---|---|---|---|
| `id` | string | 必須 | フロー内で一意（`[a-z0-9_]+`） |
| `kind` | enum | 必須 | `agent` / `command` / `approval` / `loop` / `branch` / `subflow` / `action` |
| `name` | string | `id` | 表示名（フロー定義は外部の文書なので i18n しない） |
| `description` | string | — | 説明（ツールチップ・詳細欄） |
| `timeout` | duration | `defaults.timeout` | `30s` / `15m` / `2h` 形式 |
| `retry` | `{ max, backoff?, on? }` | `{ max: 0 }` | 失敗時の自動再試行。`on` は再試行する失敗種別（`failed` / `timeout`、既定は両方） |
| `cost` | `{ estimateUsd?, budgetUsd? }` | — | 見積もり（重ね表示と事前合計に使う）とノード単位の上限 |
| `when` | 条件（2.6） | — | 偽ならノードを `skipped` にする |
| `concurrencyKey` | string | — | 同じキーのノードは全フロー実行を通じて同時に 1 つ（例: GPU・API の枠） |

種別ごとの属性:

| 種別 | 主な属性 | 振る舞い |
|---|---|---|
| `agent` | `provider`（`codex` / `copilot` / `opencode` / `claude`）、`model`、`prompt`（本文）または `promptRef`（ファイル相対パス）、`permission`（`read-only` / `full-access`）、`outputContract`（`outcome` / `free`）、`policy`（7 章のガード群） | 既存のエージェントランナーで 1 ターン実行。`outcome` 契約では最終応答の frontmatter（`outcome`、`reason`、任意の `outputs`）を解析して出口と出力にする |
| `command` | `run`（argv 配列。シェル文字列は `shell: true` のときのみ）、`workingDir`、`env`、`successCodes`（既定 `[0]`）、`protocol`（`mdium-v1` / `none`）、`detach`（既定 `true`、5.4） | 子プロセスを起動し、終了コードと 5.3 のイベントで結果を決める |
| `approval` | `message`、`show`（表示する出力・成果物の参照）、`options`（既定 `approve` / `reject`）、`timeout`（既定なし） | 利用者の操作まで実行を止める。選んだ選択肢が出口名になる。`when` が偽で `skipped` になった場合は `options` の先頭を選んだものとして進む |
| `loop` | `mode`（`foreach` / `while`）、`items`（`foreach`）、`until`（`while`、条件。直前の反復の本体の出力を `iteration.outputs.<key>` で参照する）、`params`（本体がファイル参照のときの引数の対応）、`maxIterations`（必須）、`parallelism`（既定 1）、`body`（サブフローのファイル参照またはインラインの `nodes` / `edges`）、`as`（反復変数名、既定 `item`） | 本体を反復する。反復ごとに `nodeKey` に `[i]` を付ける。本体の失敗時の扱いは `onItemFailure`（`stop` / `continue`、既定 `stop`） |
| `branch` | `cases`（`[{ when, port }]`）、`default`（出口名） | 条件を上から評価し、最初に真になった出口へ進む。副作用を持たない |
| `subflow` | `flow`（ファイル相対パス）、`params`（引数の対応） | 別のフローを子として実行し、子のフローの `outputs`（2.2）を自分の出力にする |
| `action` | `uses`（`mdium/<name>`）、`with`（引数） | MDium に組み込まれたアクション（8.2）を実行する。外部プロジェクトは追加できない |

### 2.4 エッジと出口

```yaml
edges:
  - { from: collect, to: docs }                       # port defaults to success
  - { from: quality_gate, to: summarize, port: low, maxTraversals: 2 }
  - { from: docs, to: notify, port: failure }
```

- `agent` で `outputContract: outcome` の場合、工程結果 `completed` は `success`、`attention` は出口 `attention`（エッジがなければ `failure` と同じ扱い）、`awaiting_user` は承認待ち（4.3）になる。
- 出口 `port` の既定は `success`。ノードの失敗は `failure` 出口へ進む。`failure` 出口のエッジがなければ、失敗したノードはフロー実行を `failed` にする（ただし `retry` を使い切った後）。
- `branch` と `approval` の出口名は `cases[].port` / `options` で定義した名前。定義にない出口名のエッジは検証エラー。
- 入口: 入る**前進エッジ**（後退エッジ以外）のないノードが開始ノード。後退エッジだけで入られるノード（例: 9.2 の `summarize`）も開始ノードになる。複数あれば並行に開始する（`maxConcurrentNodes` の範囲で）。
- 合流: 複数の入りエッジを持つノードは、**前進エッジ**（後退エッジ以外）のうち実際に通ったものがすべて確定してから開始する（通らなかった分岐は `skipped` として伝播する）。後退エッジは合流の待ち合わせに数えない。
- 後退エッジ（閉路を作るエッジ）は、**エッジ自身に** `maxTraversals` を書く（既定値はない。2026-10-06 決定）。`maxTraversals` を書いたエッジが後退エッジとして扱われ、上限に達したら遷移せずにノードを `failed`（理由 `FLOW_TRAVERSAL_LIMIT`）にする。閉路は後退エッジを除くと DAG になることを検証する（違反は `FLOW_CYCLE_WITHOUT_LIMIT`）。`maxTraversals` を書いたのに閉路を作らないエッジは警告（`FLOW_TRAVERSAL_LIMIT_UNUSED`）とする。
- 旧版にあった `limits.maxTraversals` は廃止した。書かれていても無視し、警告（`FLOW_DEPRECATED_FIELD`）を出す。
- 後退エッジの通過は、その閉路の**新しい周回（pass）**を開く。行き先のノードと、そこから閉路内で前進エッジだけで到達できるノードを `pending` に戻し、`nodeKey` に周回番号を付ける（例: `design@2`）。閉路外のノードと、前の周回の記録・出力はそのまま残る。参照 `nodes.<id>.outputs` は最新の周回の出力を指す。重ね表示はこの周回番号を再入回数として表示する。
- 前進エッジのグラフが DAG であれば、すべてのノードはいずれかの開始ノードから到達できる。そのため「開始ノードがない」「到達できない」は検査しない。

### 2.5 値の参照（テンプレート）

文字列の中で `${{ 式 }}` を使い、実行時に展開する。参照できるのは次に限る（任意のコード実行はしない）。

| 参照 | 内容 |
|---|---|
| `params.<name>` | フロー引数 |
| `nodes.<id>.outputs.<key>` | 同じスコープ（インラインの `body` からは外側のスコープも含む）で確定した最新のノード出力。ファイル参照のフロー（サブフロー、ファイルの `body`）は外側を参照できず、`params` だけを受け取る |
| `iteration.outputs.<key>` | `while` の `until` 内でのみ: 直前の反復の本体の出力 |
| `item` / `<as>`、`index` | ループ本体内の反復変数とその位置 |
| `run.id`、`run.dir`、`node.dir` | 実行 ID、実行ディレクトリ、ノード実行のディレクトリ（3 章） |
| `project.root` | 開いているプロジェクトのルート |
| `env.<NAME>` | MDium プロセスの環境変数のうち、フローの `envPassthrough` に列挙したもの |

- `command.run` の各要素は展開後もそのまま 1 引数になる（シェルを通さないため、値に空白や記号が含まれても注入にならない）。
- 秘密情報はフロー定義に書かない。API キーは外部プロジェクト自身の `.env` などで解決する（MDium は渡さない）。

### 2.6 条件

条件は最小限の比較のみとする（式言語は持たない）。

```yaml
when: { ref: nodes.audit.outputs.score, op: ">=", value: 7 }
until: { any: [ { ref: nodes.gen.outputs.coverage, op: ">=", value: 0.95 },
                { ref: nodes.gen.outputs.exhausted, op: "==", value: true } ] }
```

- `op`: `==` / `!=` / `<` / `<=` / `>` / `>=` / `in` / `exists`。`all` / `any` / `not` で組み合わせる。
- 参照先が無い場合は偽（`exists` を除く）。型が合わない比較は実行時エラー（`FLOW_CONDITION_TYPE`）としてノードを `failed` にする。

### 2.7 データモデル（スケッチ）

```rust
// src-tauri/src/flow/model.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")] // unknown top-level keys: warning (collected separately)
pub struct FlowDef {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)] pub description: Option<String>,
    #[serde(default)] pub params: BTreeMap<String, ParamDef>,
    #[serde(default)] pub defaults: NodeDefaults,
    #[serde(default)] pub limits: FlowLimits,
    #[serde(default)] pub env: BTreeMap<String, String>,
    #[serde(default)] pub env_passthrough: Vec<String>,
    pub nodes: Vec<FlowNode>,
    #[serde(default)] pub edges: Vec<FlowEdge>,
    #[serde(default)] pub outputs: BTreeMap<String, String>, // templates, see 2.5
    #[serde(default)] pub ui: Option<serde_json::Value>, // editor-only, opaque to the engine
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    pub id: String,
    #[serde(flatten)] pub kind: NodeKind, // tagged by "kind"; unknown-attribute check is done
                                          // by the validator, since serde's flatten and
                                          // deny_unknown_fields do not combine
    #[serde(default)] pub name: Option<String>,
    #[serde(default)] pub timeout: Option<Duration>,
    #[serde(default)] pub retry: Option<RetryPolicy>,
    #[serde(default)] pub cost: Option<CostSpec>,
    #[serde(default)] pub when: Option<Condition>,
    #[serde(default)] pub concurrency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NodeKind {
    Agent(AgentNode),       // reuses workflow::runner_client::RunnerPermission, Provider
    Command(CommandNode),
    Approval(ApprovalNode),
    Loop(LoopNode),
    Branch(BranchNode),
    Subflow(SubflowNode),
    Action(ActionNode),
}

pub struct FlowEdge { pub from: String, pub to: String, pub port: String /* "success" */, pub max_traversals: Option<u32> }
```

```ts
// src/features/flow/lib/types.ts (generated shape mirrors the Rust model)
export type NodeKind = "agent" | "command" | "approval" | "loop" | "branch" | "subflow" | "action";
export interface FlowDef { schemaVersion: 1; id: string; name: string; params?: Record<string, ParamDef>;
  defaults?: NodeDefaults; limits?: FlowLimits; nodes: FlowNode[]; edges: FlowEdge[]; ui?: FlowUi; }
export type NodeRunStatus = "pending" | "ready" | "running" | "awaiting_approval" | "retry_wait"
  | "succeeded" | "failed" | "skipped" | "cancelled" | "interrupted";
export interface NodeRunView { nodeKey: string; status: NodeRunStatus; attempt: number; retries: number;
  costUsd: { actual: number; estimated: number; unknownCount: number }; startedAt?: string; finishedAt?: string;
  lastProgress?: string; outputs?: Record<string, unknown>; reason?: AttentionLikeReason; }
```

### 2.8 検証

保存時・読み込み時・実行開始時に同じ検証（Rust 側が正、TS 側はエディタの即時表示用に同じ規則の部分集合）を行う。検証エラーは `{ code, path, params }` で返し、表示文は i18n で生成する。

| コード | 内容 |
|---|---|
| `FLOW_SCHEMA_UNSUPPORTED` | `schemaVersion` が未対応 |
| `FLOW_PARSE_FAILED` | YAML/JSON として読めない（行・列を含む） |
| `FLOW_DUPLICATE_NODE_ID` | ノード ID の重複 |
| `FLOW_UNKNOWN_NODE_REF` | エッジ・参照が存在しないノードを指す |
| `FLOW_UNKNOWN_PORT` | ノードが持たない出口名 |
| `FLOW_CYCLE_WITHOUT_LIMIT` | `maxTraversals` のない閉路 |
| `FLOW_LOOP_LIMIT_MISSING` | `loop` に `maxIterations` がない |
| `FLOW_SUBFLOW_RECURSION` | サブフローの参照が循環する |
| `FLOW_PATH_OUTSIDE_PROJECT` | `promptRef` / `flow` / `body` がプロジェクト外・リンクを指す |
| `FLOW_TEMPLATE_INVALID` | `${{ }}` の構文誤り、許されない参照 |
| `FLOW_ACTION_UNKNOWN` | 存在しない `uses` |
| `FLOW_PROVIDER_UNAVAILABLE` | 実行開始時のみ: `agent` のプロバイダーが使えない |
| `FLOW_UNKNOWN_FIELD` | ノード・エッジ・入れ子のオブジェクトに未定義の属性がある |
| `FLOW_UNKNOWN_NODE_KIND` | `kind` がない、または未定義の種別 |
| `FLOW_INVALID_VALUE` | 型・範囲の誤り（理由は `params.reason`） |
| `FLOW_INVALID_ID` | フロー・ノード・引数・出口・変数の名前の形式が不正 |
| `FLOW_CONDITION_INVALID` | `when` / `until` / `cases[].when` の形式が不正 |
| `FLOW_REF_NOT_FOUND` | 参照したプロンプト・フローのファイルがない |
| `FLOW_SUBFLOW_INVALID` | 参照したフローファイルにエラーがある |
| `FLOW_PARAM_MISMATCH` | サブフローに渡す引数が `params` と合わない |
| `FLOW_FILE_TOO_LARGE` | フローファイルが 1 MiB を超える |

警告（実行は妨げない）:

| コード | 内容 |
|---|---|
| `FLOW_UNKNOWN_KEY` | 未知のトップレベルキー（無視する） |
| `FLOW_DEPRECATED_FIELD` | 廃止した属性（無視する。`params.replacement` に後継） |
| `FLOW_TRAVERSAL_LIMIT_UNUSED` | `maxTraversals` を書いたエッジが閉路を作らない |

---

## 3. 保存レイアウト

既存のワークフローの `.mdium/` 配下とは別のディレクトリを使う。書き込みはすべて一時ファイル＋rename の原子的置換（既存の `fsutil` を共有ライブラリとして使う）。

| パス | 内容 |
|---|---|
| `.mdium/flows/<name>.flow.yaml` | フロー定義（リポジトリで管理してよい） |
| `.mdium/flow-runs/<runId>/run.json` | 実行のメタ情報: フロー定義のスナップショット（サブフローを含めて解決済み）、引数、開始者、作成・更新時刻、`schemaVersion` |
| `.mdium/flow-runs/<runId>/events.jsonl` | **追記専用の実行イベント**（正。4.4） |
| `.mdium/flow-runs/<runId>/state.json` | イベントから再構成できる現在状態のチェックポイント（読み込みの高速化用、壊れていれば捨ててイベントから作り直す） |
| `.mdium/flow-runs/<runId>/nodes/<nodeKey>/<n>/` | ノード実行ごとのディレクトリ: `stdout.log`、`stderr.log`、`events.jsonl`（5.3 で外部が書く）、`outputs.json`、`exit.json`（5.4）、`prompt.md` / `response.md`（agent） |
| `.mdium/flow-runs/<runId>/STOP` | 停止要求（5.5）。UI の停止操作でも作られる |

- `nodeKey` のディレクトリ名は `/` と `[i]` を安全な形（`docs.3__summarize`）に変換する。
- 初回利用時、`.mdium/flow-runs/` を `.gitignore` に追加するよう案内する（自動追記はしない。既存と同じ）。
- 実行データの保持: 完了したフロー実行は一覧から削除でき、削除はディレクトリごと消す（進行中は不可）。

---

## 4. 実行エンジン（パート 3）

### 4.1 全体構成

```
[React UI]  features/flow/        フロー一覧、ビューア/エディタ、実行一覧、重ね表示、承認
               │ invoke / Tauri event（flow://...、ポーリングしない）
[Rust]      flow/  model, parse+validate, template, condition, store(events, state),
                   scheduler(run loop), executors{agent, command, approval, loop, branch, subflow, action},
                   process(detach+reattach), cost
               │ agent: 既存 workflow::runner_host / runner_client（stdio JSON）
               │ command: 子プロセス（5 章）
[外部]      外部プロジェクトのコマンド（5.3 のプロトコルを話す）
```

- 実行制御はすべて Rust のスケジューラが行う。UI は表示と操作要求のみ。複数ウィンドウでも実行主体は一つ。
- スケジューラはフロー実行ごとに 1 つの非同期タスクとして動き、状態の変更はすべてイベントの追記を経由する（4.4）。

### 4.2 フロー実行の状態遷移

| 状態 | 識別子 | 意味 |
|---|---|---|
| 準備中 | `pending` | 作成済み、未開始 |
| 実行中 | `running` | 1 つ以上のノードが実行中または開始可能 |
| 承認待ち | `awaiting_approval` | 実行中のノードがなく、承認ノード（または予算超過）だけが待っている |
| 停止中 | `stopping` | 停止要求を受け、実行中ノードの区切りを待っている |
| 一時停止 | `paused` | 停止要求により区切りで止まった。再開できる |
| 中断 | `interrupted` | アプリ終了などで止まった（起動時の回復で設定）。再開できる |
| 完了 | `completed` | 終端まで成功 |
| 失敗 | `failed` | 失敗が出口なしで伝播した。失敗ノードから再開できる |
| 中止 | `cancelled` | 利用者が取りやめた（再開不可） |

| from → to | 契機 |
|---|---|
| pending → running | 開始 |
| running → awaiting_approval | 実行中ノードが 0 で、待ちが承認だけ |
| awaiting_approval → running | 承認・却下の操作 |
| running / awaiting_approval → stopping | 停止要求（UI、STOP ファイル） |
| stopping → paused | 実行中ノードがすべて区切りに達した（または停止の猶予切れで打ち切った） |
| paused / interrupted / failed → running | 再開 |
| running → completed / failed | 終端に達した |
| running / awaiting_approval / stopping → interrupted | 起動時の回復で、プロセスが残っていない場合（4.6） |
| 完了・中止以外 → cancelled | 中止（実行中ノードのプロセスツリーを終了する） |

表にない遷移は拒否する。遷移は単一の関数 `transition_run(runId, expectedFrom, to, reason)` に集約し（既存の `transition` と同じ楽観的排他）、イベントとして追記する。

### 4.3 ノード実行の状態遷移

| from → to | 契機 |
|---|---|
| pending → ready | 入りエッジが確定し `when` が真 |
| pending → skipped | `when` が偽、または通らなかった分岐の下流 |
| ready → running | 並列度・`concurrencyKey`・予算の枠が空いた |
| running → succeeded / failed | 実行の終了（終了コード、プロトコルの `outcome`、エージェントの出力契約） |
| running → awaiting_approval | 承認ノードの開始、またはコマンドが `outcome: needs_approval` を報告 |
| awaiting_approval → succeeded | 承認操作（出口は選んだ選択肢） |
| running → retry_wait → ready | 失敗し `retry.max` が残っている（`backoff` 待ち） |
| running → cancelled | 中止 |
| running → failed | ノードのタイムアウト（理由 `FLOW_NODE_TIMEOUT`。プロセスツリーを終了したうえで、失敗として再試行規則（`retry.on: timeout`）に従う） |
| running → ready | 停止要求で区切りに達した（`outcome: stopped`、理由 `FLOW_NODE_STOPPED`）、または停止の猶予切れで打ち切った（理由 `FLOW_STOP_GRACE_EXCEEDED`）。再開すると同じノードを次の試行として実行する |
| running → interrupted | 起動時の回復で再接続できなかった |
| failed / interrupted / cancelled → ready | 利用者の「このノードから再実行」 |
| failed → succeeded | 利用者の「成功扱いにする」（出力は空。下流で参照されると警告） |

- 再試行回数は `nodeRun` の連番として数え、重ね表示に出す（6 章）。
- 承認ノードは `ready → running → awaiting_approval` と進む。承認待ちの間も、他の独立したノードは実行できる（実行は直列）。
- ループ: `loop` ノード自身は本体の反復をすべて管理する親として `running` を保ち、各反復の本体ノードは `nodeKey` で区別される。`while` は各反復の終了後に `until` を評価する。`maxIterations` に達したら `succeeded`（出力 `limitReached: true`）とし、失敗にはしない（上限到達を失敗とするかは `branch` で表す）。

### 4.4 イベントとチェックポイント

- 正は `events.jsonl` とする。1 行 1 イベントで、`seq`（単調増加）、`ts`、`type`、`nodeKey?`、`data` を持つ。

| `type` | `data` |
|---|---|
| `run_status` | `from`、`to`、`reason?` |
| `node_status` | `from`、`to`、`attempt`、`reason?` |
| `node_output` | `key`、`value` |
| `node_artifact` | `path`、`label?` |
| `node_progress` | `text`、`fraction?` |
| `cost` | `usd`、`kind`（`actual` / `estimated`）、`provider?`、`model?`、`units?`（`tokens` / `chars` / `images` 等の内訳） |
| `loop_items` | 反復対象の確定した一覧（`foreach` の開始時。再開時に同じ一覧を使う） |
| `traversal` | エッジの通過（後退エッジの回数を数える） |
| `approval` | `choice`、`comment?`、`by` |
| `process` | `pid`、`startedAt`（OS のプロセス作成時刻）、`exitFile`（5.4） |

- 追記は 1 イベントごとに `write` + `flush` を行う（fsync は状態遷移イベントのみ）。末尾の不完全な行は読み込み時に捨てる。
- `state.json` は N イベント（既定 50）ごと、および状態遷移ごとに書き直す。読み込み時は `state.json` の `seq` 以降のイベントだけを適用する。`state.json` が壊れていれば捨てて全イベントから作り直す。
- 重ね表示（6 章）・費用集計・再開位置はすべてイベントの再生で決まり、表示専用の別の保存は持たない。

### 4.5 並列度

- フロー実行内: `limits.maxConcurrentNodes`（既定 1）。ループの `parallelism` はこの範囲内で効く。
- アプリ全体: 同時に `running` のフロー実行数の上限（設定、既定 2）。超えた開始要求は `pending` で待つ。
- `concurrencyKey`: 全フロー実行を通じたキーごとのセマフォ（同時 1）。外部 API の枠や GPU の取り合いを防ぐ。
- 既存のワークフローのエージェントランナーとは別プロセスのランナーを使うか共有するかは実装計画で決める（同時セッション数の上限はランナー側の設定に従う）。

### 4.6 長時間実行と再開

- **コマンドノードはアプリの再起動を越えて動き続ける（既定 `detach: true`）。** 数時間かかる外部処理（大量の生成・変換処理など）を、MDium の更新・再起動で失わないため。
  - 起動は 5.4 のラッパー経由で行い、`process` イベント（pid、プロセス作成時刻、終了ファイルのパス）を記録する。
  - 起動時の回復で、`running` のコマンドノードについて「pid が生存し、作成時刻が一致する」なら再接続して監視を続ける。終了していて `exit.json` があればその結果で確定する。どちらでもなければ `interrupted`。
  - 再接続中は標準出力を直接受け取れないため、`stdout.log` / `events.jsonl` のファイル末尾を追う方式で進捗を読む（起動直後から同じ方式で読み、経路を一つにする）。
- **エージェントノードは既存の不変条件を保つ**（ターンはアプリのプロセスを越えない）。起動時の回復で `interrupted` とし、自動では再実行しない（既存の `ATTENTION_INTERRUPTED` と同じ考え方。ターンの途中から再開する手段がなく、無言の再実行は費用と副作用を生むため）。
- 承認待ちはプロセスを持たないので、再起動後もそのまま `awaiting_approval` に戻る。
- 再開は「最後の確定状態からの続き」とする。同じ周回（2.4）で `succeeded` のノードは再実行しない（後退エッジによる新しい周回での再実行は別扱い）。`interrupted` / `failed` のノードは利用者の操作で `ready` に戻す。外部プロジェクト側の冪等性（既にできた成果物を飛ばす）を前提にし、MDium は成果物の有無を判断しない。
- 利用者の操作（PR 3a で実装）:
  - 再開（`resume`）: `paused` / `interrupted` / `failed` の実行（および再起動後にドライバのない `awaiting_approval` の実行）を続ける。`interrupted` / `cancelled` のノード、または `failure` 出口のない `failed` のノードが残っていれば拒否する（`FLOW_NODE_NEEDS_ACTION`）。STOP ファイルは再開時に消す。
  - このノードから再実行（`rerun_node`）: `interrupted` / `cancelled` / `failure` 出口のない `failed` のノードを `ready` に戻し、ほかに対応の要るノードがなければ続ける。`failure` 出口で処理済みの失敗は下流が進んでいるため対象外。
  - 成功扱い（`mark_succeeded`）: `failure` 出口のない `failed` のノードを `succeeded`（出口 `success`、出力は空）にして続ける。
- アプリ終了時に実行中のノードがなければ、実行の状態は変えない（承認待ちはそのまま残る）。実行中のノードがあれば、そのノードと実行を `interrupted` にする（PR 3a。PR 3b 以降は切り離したプロセスを残して再接続する）。

### 4.7 停止・中止・タイムアウト

- 停止（一時停止）は**協調的**に行う。`STOP` ファイル（3 章）を作り、実行中のコマンドには環境変数 `MDIUM_FLOW_STOP_FILE` でそのパスを知らせる。外部プロジェクトは自分の区切り（例: 1 件の処理の区切り）でこれを見て終了コード 0 と `outcome: stopped` を返す。スケジューラは新しいノードを開始しない。
- 停止の猶予（フロー設定 `limits.stopGrace`、既定なし＝区切りまで待つ）を過ぎたら中止と同じ扱いでプロセスツリーを終了する。
- 中止: 実行中ノードのプロセスツリーを終了する（既存のランナーの `cancel` と、Windows のジョブオブジェクト／`taskkill /T` 相当）。
- タイムアウト: ノードの `timeout` を超えたら中止し、`failed`（`FLOW_NODE_TIMEOUT`）として再試行規則に従う。`detach` のノードは再接続後も開始時刻から数える。

### 4.8 費用

- 費用は `cost` イベントの合計で、`actual`（外部が実測で報告した額）と `estimated`（見積もり）を分けて集計する。報告のないノードは「不明」として数える（0 として扱わない）。
- エージェントノード: ランナーが返す使用量（プロバイダーが費用を返す場合）を `actual` として記録する。返さない場合は不明。
- 予算: ノードの `cost.budgetUsd`、フローの `limits.budgetUsd` を `actual + estimated` が超えたら、新しいノードを開始せず `awaiting_approval`（理由 `FLOW_BUDGET_EXCEEDED`）にし、承認で上限を一度だけ引き上げて続行できる。
- 事前の見積もり: エディタは各ノードの `estimateUsd` × 反復数の見込み（`foreach` は開始前は不明として表示）を合計して表示する。

---

## 5. 外部プロジェクトの呼び出し（パート 3）

### 5.1 原則

- MDium は外部プロジェクトのログ形式を解釈しない。外部プロジェクトが 5.3 のプロトコルで状態・出力・費用を返す。既存のログ（例: 外部の使用量ログ）を変換するアダプタは外部プロジェクト側に置く。
- フロー定義ファイルは外部プロジェクトのリポジトリに置き、外部プロジェクトの変更と同じ PR でレビューする。

### 5.2 入力

- 引数: `run` の argv（テンプレート展開済み）。
- 環境変数（MDium が必ず設定する）:

| 変数 | 内容 |
|---|---|
| `MDIUM_FLOW_RUN_ID` | フロー実行 ID |
| `MDIUM_FLOW_NODE_KEY` | ノードキー |
| `MDIUM_FLOW_NODE_DIR` | ノード実行のディレクトリ（成果物・ログの置き場に使ってよい） |
| `MDIUM_FLOW_EVENTS_FILE` | プロトコルのイベントを追記するファイル |
| `MDIUM_FLOW_STOP_FILE` | 存在したら区切りで止まるべき停止ファイル |
| `MDIUM_FLOW_INPUTS_FILE` | ノードの入力（展開済みの `with` / ループの `item`）を JSON で置いたファイル |

### 5.3 プロトコル（`mdium-v1`）

`MDIUM_FLOW_EVENTS_FILE` に JSON 行を追記する（標準出力はログとして扱い、解析しない。ログとイベントが混ざらないようにするため）。

```jsonl
{"v":1,"type":"progress","text":"document 3/15: extracting","fraction":0.2}
{"v":1,"type":"cost","usd":0.42,"kind":"actual","provider":"example-llm","model":"example-model","units":{"tokens_in":1751,"tokens_out":58}}
{"v":1,"type":"cost","usd":1.5,"kind":"estimated","provider":"example-cli","note":"not metered"}
{"v":1,"type":"output","key":"score","value":7.5}
{"v":1,"type":"artifact","path":"out/digest.md","label":"digest"}
{"v":1,"type":"outcome","status":"ok"}
```

- `outcome.status`: `ok` / `fail`（`reason`）/ `needs_approval`（`message`。ノードを承認待ちにし、承認されたら成功、却下されたら失敗）/ `stopped`（停止要求に応じて区切りで終えた）。
- `outcome` がない場合は終了コードで決める（`successCodes` に含まれれば成功）。`outcome` と終了コードが食い違う場合は `fail` を優先する。
- 1 行 64 KiB、1 ノード実行あたり 10 万行を上限とし、超過分は捨てて警告イベントを残す。不正な行は捨てて警告する（ノードは失敗にしない）。
- `protocol: none` のコマンドは終了コードだけで判断し、費用は不明とする。

### 5.4 プロセスの起動と再接続

- `detach: true` のコマンドは、MDium 同梱の小さなラッパー（Rust のサブコマンドまたは別バイナリ）を介して起動する。ラッパーは子を起動・待機し、終了時に `exit.json`（`code`、`finishedAt`）を原子的に書く。MDium 本体が終了してもラッパーと子は残る（Windows では MDium のジョブオブジェクトから外して起動する）。
- 標準出力・標準エラーはラッパーがファイルに書く。
- 再接続（4.6）は pid とプロセス作成時刻の一致で判定し、pid の再利用による取り違えを防ぐ。

### 5.5 外部の停止ファイルとの関係

外部プロジェクトが独自の停止ファイル（例: 1 件ごとの区切りで見る `STOP`）を持つ場合は、そのプロジェクトのアダプタが `MDIUM_FLOW_STOP_FILE` も見るようにする。MDium は外部のファイルを直接作らない。

---

## 6. UI（パート 1・2）

### 6.1 配置

- アクティビティバーに「フロー」（`flow`）を追加する。既存の「ワークフロー」とは別の入口とし、併存期間中は両方を表示する。
- 左パネル: フロー一覧（`.mdium/flows/` のファイル。検証エラーのあるものは警告アイコン）、その下に実行一覧（状態バッジ、開始時刻、費用、フィルタ）。
- メイン領域: フローを選ぶと**定義ビュー**、実行を選ぶと**実行ビュー**（同じキャンバスに 6.4 の重ね表示）。

### 6.2 キャンバス（ReactFlow）

- `@xyflow/react` v12（既存の依存。`features/mindmap` と同じく `ReactFlow` と独自のノード・エッジコンポーネントを使う）。
- レイアウト: マインドマップの配置（`mindmap/lib/layout.ts`）は木構造専用で、合流と後退エッジを持つフローには使えない。**elkjs の layered レイアウト**（左 → 右、後退エッジは `elk.layered.cycleBreaking` に任せる）を追加の依存として使い、Web Worker（`elkjs/lib/elk-api` ＋ `elk-worker.min.js`）で計算する（Worker を使えないテスト環境では同梱版を同じスレッドで使う）。`ui.positions` に位置があるノードはその位置を使い、ない場合だけ自動配置する。
- ノードの表示: 種別ごとのアイコンと色（テーマ変数のトークン `flowNode*` を全テーマプリセットに追加）、名前、要点（agent はプロバイダーとモデル、command は実行ファイル名、loop は `foreach` の対象と並列度、承認はメッセージの先頭）、見積もり費用。
- `loop` と `subflow` は折りたたみ可能なグループノードとして描き、展開すると本体を中に描く（サブフローは読み取り専用で、編集は元ファイルを開く）。
- エッジ: 出口名をラベル表示し、`failure` は破線、後退エッジは曲線で `maxTraversals` を表示する。

### 6.3 エディタ（パート 1 の後半）

- ツールバー: ノード追加（種別のパレット）、自動整列、元に戻す／やり直し、検証、保存、YAML 表示（読み取り専用の分割表示）。
- 右側の属性パネル: 選択ノードの属性を種別ごとのフォームで編集する（モデル、プロンプト参照、しきい値、見積もり費用、タイムアウト、再試行、条件）。条件は 2.6 の構造をフォームで組む。
- 保存時に 2.8 の検証を行い、エラーはパネルとキャンバス上のノードに表示する。外部でファイルが変わった場合はファイル監視で検知し、未保存の編集があれば確認する。
- 文言はすべて i18n（フロー定義内の名前・説明は除く）。

### 6.4 実行状況の重ね表示（パート 2）

- 実行ビューでは各ノードに状態（色と小さなアイコン）、反復の進み（`loop`: `12/15`、失敗数）、再試行回数、費用（実測・見積もり・不明の件数）、経過時間を重ねる。
- ノードをクリックすると下部のドロワーに `nodeRun` の一覧（再試行・反復ごと）、最新の進捗、出力、成果物（パスをクリックで MDium で開く）、ログ末尾（`stdout.log`）を表示する。
- 承認待ちのノードには「承認」と選択肢のボタン、コメント欄を出す。実行一覧にも承認待ちのバッジを出す。
- 実行の操作: 開始（引数のフォーム）、一時停止、再開、中止、ノードからの再実行、成功扱い。
- 更新はイベント（`flow://run-changed`、`flow://node-changed`、`flow://progress`）で行い、ポーリングしない。UI は開いたときに `state.json` 相当のスナップショットを 1 回取得し、以後はイベントを適用する（`seq` で取りこぼしを検出したら取り直す）。

| イベント | ペイロード |
|---|---|
| `flow://run-changed` | `projectRoot`、`runId`、`status`、`seq` |
| `flow://node-changed` | `projectRoot`、`runId`、`nodeKey`、`status`、`attempt`、`costUsd`、`seq` |
| `flow://progress` | `projectRoot`、`runId`、`nodeKey`、`text`、`fraction?` |
| `flow://flows-changed` | `projectRoot` |

### 6.5 承認の通知（拡張点）

- 承認待ち（承認ノード、`needs_approval`、予算超過）になったとき、スケジューラは `flow://approval-requested`（`projectRoot`、`runId`、`nodeKey`、`message`、`reason`）を送り、同じ内容を `ApprovalNotifier` トレイトの実装へ渡す。
- 初版の実装はアプリ内の表示（実行一覧のバッジとトースト）だけとする。外部への通知（メール・チャット等）は、後からこのトレイトの実装を追加して行う（通知先の設定はマシンごとの設定とし、フロー定義には書かない）。
- 通知の失敗はフロー実行の状態に影響させない（ログに残すのみ）。

```rust
pub trait ApprovalNotifier: Send + Sync {
    fn approval_requested(&self, req: &ApprovalRequest); // must not block the scheduler
}
```

---

## 7. 安全とエージェントノード

### 7.1 エージェントノード

- 既存の `runner_client` の権限（`read-only` / `full-access`）とプロバイダーの対応付けをそのまま使う。`cli-default` はフローでは使わない。
- `full-access` は**既存のガード一式の適用を必須とする**（`policy` を省略しても有効）: 入力検査（`screening`）、実行時ガード、環境による封じ込め（`containment`）、事後検査（`integrity`）。作業ディレクトリが git の worktree でない場合の事後検査は、作業ディレクトリ外への変更の検出に限る。
- 出力契約 `outcome` の解析は既存の `outcome.rs` を共有する（`outputs` キーを追加で許す）。

### 7.2 コマンドノード

- コマンドは利用者が書いた（またはリポジトリに入っている）フロー定義に従い、利用者の権限でそのまま実行する。サンドボックスはしない。
- そのため、**フロー定義ファイルを初めて実行する前、および前回の実行から内容が変わったときは、実行するコマンドの一覧（展開前の argv）を表示して確認を求める**。確認済みの記録はフローのパスと内容ハッシュでマシンごとの設定に保存する（リポジトリを開いただけでコマンドが走らないようにする。既存の定期 JOB の有効化と同じ考え方）。
  - 一覧はバックエンドがファイルから作る（UI からの入力は使わない）。確認と開始はどちらも内容の SHA-256 を受け取り、開始時はファイルを 1 回だけ読み、そのバイト列をハッシュ・解析・実行に使う（確認後のすり替えを防ぐ）。保存先は `%LOCALAPPDATA%/mdium/flow-command-confirmations.json`（OS の local data ディレクトリ）。
  - 確認した一覧が実行内容を決めるように、**実行するプログラム（argv の先頭）と `shell: true` の文字列にはテンプレートを使えない**（開始時に `FLOW_RUN_UNSAFE_TEMPLATE`）。引数・作業ディレクトリ・環境変数のテンプレートは使えるが、確認画面ではテンプレートを含むことを示す。
  - シェル（`shell: true`）でパラメータを使う場合は環境変数で渡す。ただし Windows の `cmd` では `%VAR%` の展開が構文解析の前に行われるため、値がそのまま構文として解釈されうる。信頼できない値を渡すときは argv 形式を使う。
  - コマンドは MDium の環境変数を引き継ぐ（PATH や利用者の API キーを含む）。外部プロジェクトの CLI を動かすための前提であり、確認画面でもその旨を示す。
  - `experimentalFlows` はフロントエンドの設定で、バックエンドからは見えない。実行を実際に止めているのは、この確認の記録である。

### 7.3 組込みアクション

`action` ノードは MDium が実装する決まった処理だけを実行する（外部からは追加できない）。初期は 8.2 の開発ワークフロー用のアクションを提供する。

### 7.4 既存機能との分離

- 新エンジンは `src-tauri/src/flow/` と `src/features/flow/` に置き、既存の `workflow` モジュールの型を直接変更しない。共有する部品（ランナー、ガード、`fsutil`、`forge`、`gitops`）は `workflow` から公開範囲を広げて使う（移動は旧エンジンの退役時に行う）。
- 保存場所（`.mdium/flows/`、`.mdium/flow-runs/`）、イベント名（`flow://`）、Tauri コマンド名（`flow_*`）を既存と共有しない。

---

## 8. 既存の開発ワークフローの移行（パート 4）

### 8.1 テンプレート

開発ワークフローを組込みテンプレート `dev-workflow` として表す（テンプレートの名称・説明は i18n、LLM に渡すプロンプトは既存と同じ英語の組込みプロンプト）。

```yaml
schemaVersion: 1
id: dev-workflow
name: Standard development workflow
params:
  title: { type: string, required: true }
  requirement: { type: string, required: true }   # intake result
  issue: { type: string, default: "" }            # empty = no issue tracking for this run
  designDocPath: { type: string, default: "" }
limits: { maxConcurrentNodes: 1 }
nodes:
  - { id: screen, kind: action, uses: mdium/screen-input, with: { text: "${{ params.requirement }}" } }
  - { id: worktree, kind: action, uses: mdium/git-worktree-create, with: { title: "${{ params.title }}" } }
  - id: design
    kind: agent
    provider: codex
    permission: read-only
    promptRef: builtin:design            # built-in English prompt
    outputContract: outcome
    workingDir: "${{ nodes.worktree.outputs.path }}"   # all agents run in the run's worktree (3.6)
    timeout: 60m
  - { id: design_doc, kind: action, uses: mdium/design-doc-commit, when: { ref: params.designDocPath, op: "!=", value: "" } }
  - { id: issue_design, kind: action, uses: mdium/issue-entry, with: { entry: design }, when: { ref: params.issue, op: "!=", value: "" } }
  - { id: plan, kind: agent, provider: codex, permission: read-only, promptRef: builtin:implement-plan, outputContract: outcome, workingDir: "${{ nodes.worktree.outputs.path }}" }
  - { id: approve_plan, kind: approval, options: [approve, revise] }
  - { id: implement, kind: agent, provider: codex, permission: full-access, promptRef: builtin:implement, outputContract: outcome, workingDir: "${{ nodes.worktree.outputs.path }}" }
  - { id: issue_impl, kind: action, uses: mdium/issue-entry, with: { entry: implement }, when: { ref: params.issue, op: "!=", value: "" } }
  - { id: review, kind: agent, provider: codex, permission: read-only, promptRef: builtin:review, outputContract: outcome, workingDir: "${{ nodes.worktree.outputs.path }}" }
  - { id: issue_review, kind: action, uses: mdium/issue-entry, with: { entry: review }, when: { ref: params.issue, op: "!=", value: "" } }
  - { id: issue_review_return, kind: action, uses: mdium/issue-entry, with: { entry: review }, when: { ref: params.issue, op: "!=", value: "" } }
  - { id: merge_gate, kind: approval, options: [merge, discard] }
  - { id: merge, kind: action, uses: mdium/git-merge-local }
  - { id: close_issue, kind: action, uses: mdium/issue-close, when: { ref: params.issue, op: "!=", value: "" } }
  - { id: discard, kind: action, uses: mdium/git-worktree-discard }
edges:
  - { from: screen, to: worktree }
  - { from: worktree, to: design }
  - { from: design, to: design_doc }
  - { from: design_doc, to: issue_design }
  - { from: issue_design, to: plan }
  - { from: plan, to: approve_plan }
  - { from: approve_plan, to: implement, port: approve }
  - { from: approve_plan, to: plan, port: revise, maxTraversals: 10 }
  - { from: implement, to: issue_impl }
  - { from: issue_impl, to: review }
  - { from: review, to: issue_review }
  - { from: issue_review, to: merge_gate }
  - { from: review, to: issue_review_return, port: attention }
  - { from: issue_review_return, to: design, maxTraversals: 5 }   # reviewReturnTo / maxReentryCount
  - { from: merge_gate, to: merge, port: merge }
  - { from: merge, to: close_issue }
  - { from: merge_gate, to: discard, port: discard }
```

- `when` が偽で `skipped` になったノードは、後続への遷移では成功と同じに扱う（`skipped` は下流を止めない。2.4 の「通らなかった分岐」による `skipped` だけが伝播する）。
- `requiresApproval: false` の場合は `plan` / `approve_plan` を除いた形にする（テンプレートの生成時に組み立てる）。
- エージェントの出力契約の `awaiting_user`（質問）は、新エンジンでは「ノードが `needs_approval` を返し、回答をコメントとして次の再実行に渡す」で表す（8.3 の同等性で確認する）。

### 8.2 組込みアクション（開発ワークフロー用）

既存のモジュールを呼ぶ薄いアダプタとして実装する。

| `uses` | 既存の実装 | 内容 |
|---|---|---|
| `mdium/screen-input` | `screening.rs` | 入力検査。検出時は `needs_approval`（「このまま続行」の確認） |
| `mdium/git-worktree-create` | `gitops.rs`（3.6） | worktree とブランチの作成、base の記録。以降のエージェントノードの作業ディレクトリになる |
| `mdium/design-doc-commit` | `flow.rs` の設計書保存 | 設計書の書き出しとコミット |
| `mdium/issue-entry` | `issue_sync.rs` | 工程結果の Issue コメント（重複防止の印を含む） |
| `mdium/git-merge-local` | `actions.rs` / `gitops.rs`（3.11） | 取込み前の判定と `git merge --no-ff` |
| `mdium/issue-close` | `forge.rs` | マージ後のクローズ |
| `mdium/git-worktree-discard` | `gitops.rs` | worktree とブランチの削除 |

既存どおり、push・PR 作成・リモートでのマージは行わない（2026-09-24 仕様の 3.11・対象外）。

### 8.3 同等性の基準

旧エンジンを退役させる条件は次のすべてを満たすこと。

1. **振る舞いの対応表**: 2026-09-24 仕様の 3.4〜3.11、4.3 の各規則と、要対応理由コード（`ATTENTION_*`、`INTEGRITY_*`、`FORGE_*`）のすべてについて、新エンジンでの表し方（ノード状態、理由コード、アクションの失敗コード）を対応表にし、対応のない項目が 0 であること。対応表は移行 PR の一部として `.superpowers/specs/` に置く。
2. **同等性テスト**: フェイクのランナー・フェイクの forge（既存の `FakeForgeCli`）・一時 git リポジトリで、同じシナリオ（正常完了、レビュー差し戻し、再入上限、計画の修正依頼、質問への回答、ガード違反、整合性の変化、Issue 同期の失敗と再試行・同期せずに続行、マージ、破棄、実行中の終了と回復）を新旧両方で実行し、最終状態（git のブランチと差分、Issue のコメントとクローズ、成果物）が一致すること。
3. **実運用**: 新エンジンのテンプレートで実際のフロー実行を一定数（目安 10 件）完了し、新たな不具合が残っていないこと。
4. **利用者の判断**: 1〜3 を満たした後、退役は利用者が判断する。

### 8.4 併存期間

- 併存中は両方の UI を表示する。新エンジンのテンプレートは「試験的」と表示する。
- 既存のタスク・フロー実行を新エンジンへ変換することはしない。旧エンジンの実行中のものは旧エンジンで最後まで動かす。
- 要件整理（intake）・定期 JOB は当面旧エンジンにつながった独立した機能のままとし、移行先は退役の判断時に決める（13 章の決定 8）。
- 退役時: 旧 UI を外し、`workflow` モジュールのうち共有部品を `flow` 側（または共通モジュール）へ移し、残りを削除する。

---

## 9. 外部プロジェクトのフロー定義（例示）

### 9.1 外部プロジェクトがフローを公開する方法

1. リポジトリに `.mdium/flows/<name>.flow.yaml` を置く（外部プロジェクトの変更と同じ PR で管理）。
2. 各コマンドノードが呼ぶ入口（CLI）を用意し、5.3 のプロトコルで `progress` / `cost` / `output` / `outcome` を返す。既存ログからの変換は外部側のアダプタで行う。
3. `MDIUM_FLOW_STOP_FILE` を自分の区切りで確認する。
4. 冪等にする（既にできた成果物は飛ばす）。MDium の再開はこれを前提にする。

MDium のコードには外部プロジェクト固有の処理を入れない。

### 9.2 例: 文書の要約・確認・公開

以下は**説明用の汎用的な例**である（特定のプロジェクトのものではない）。ある外部プロジェクトが、文書フォルダの各文書を要約し、品質が足りなければやり直し、まとめを人が確認してから公開する。コマンド（`docsflow`、名前は仮）は外部プロジェクト側の CLI で、5.3 のプロトコルを話す。

```yaml
# <external-project>/.mdium/flows/doc-digest.flow.yaml  (illustration only)
schemaVersion: 1
id: doc-digest
name: Document digest
params:
  sourceDir: { type: path, required: true }
  minScore: { type: number, default: 7 }
  reviewBeforePublish: { type: bool, default: true }
limits: { maxConcurrentNodes: 2, budgetUsd: 10 }
defaults: { timeout: 30m, workingDir: "${{ project.root }}" }
nodes:
  - id: collect
    kind: command                    # lists documents; outputs.docs = ["a.md", "b.md", ...]
    run: [docsflow, collect, "${{ params.sourceDir }}"]
  - id: docs
    kind: loop
    mode: foreach
    items: "${{ nodes.collect.outputs.docs }}"
    maxIterations: 200
    parallelism: 2
    as: doc
    onItemFailure: continue
    body:
      nodes:
        - id: summarize
          kind: agent
          provider: claude
          permission: read-only
          promptRef: ./prompts/summarize.md
          outputContract: outcome    # outputs.summaryPath
          cost: { estimateUsd: 0.05 }
        - id: check
          kind: command              # scores the summary; outputs.score
          run: [docsflow, score, "${{ doc }}", "${{ nodes.summarize.outputs.summaryPath }}"]
          retry: { max: 2 }
        - id: quality_gate
          kind: branch
          cases: [ { when: { ref: nodes.check.outputs.score, op: "<", value: 7 }, port: low } ]
          default: ok
      edges:
        - { from: summarize, to: check }
        - { from: check, to: quality_gate }
        - { from: quality_gate, to: summarize, port: low, maxTraversals: 2 }   # retry branch
  - id: compile
    kind: command                    # outputs.digest, reports an artifact
    run: [docsflow, compile, --out, "${{ node.dir }}/digest.md"]
  - id: review
    kind: approval
    when: { ref: params.reviewBeforePublish, op: "==", value: true }
    message: "Review the digest before publishing"
    show: [ "nodes.compile.outputs.digest" ]
    options: [publish, reject]
  - id: publish
    kind: command
    run: [docsflow, publish, "${{ nodes.compile.outputs.digest }}"]
  - id: notify_failure
    kind: command
    run: [docsflow, notify, --status, failed]
outputs:
  digest: "${{ nodes.compile.outputs.digest }}"
edges:
  - { from: collect, to: docs }
  - { from: docs, to: compile }
  - { from: docs, to: notify_failure, port: failure }
  - { from: compile, to: review }
  - { from: review, to: publish, port: publish }
```

補足:

- 各ノードが使う要素: `command`（collect / check / compile / publish）、`agent`（summarize）、`loop`（docs、並列 2）、`branch` と後退エッジによる再試行（quality_gate → summarize、最大 2 回）、`approval`（review）。
- `review` が `when` で `skipped` になった場合は、先頭の選択肢 `publish` を選んだものとして `publish` へ進む（2.3）。`reject` を選ぶと出口のエッジがないため終端になる。
- `docsflow` は 5.3 のイベント（`progress`、`cost`、`output`、`artifact`、`outcome`）を `MDIUM_FLOW_EVENTS_FILE` に書き、`MDIUM_FLOW_STOP_FILE` を文書 1 件ごとの区切りで確認する。成果物が既にある文書は飛ばす（冪等）。
- 同じ形で、デプロイ（テスト → ステージング → 承認 → 本番）、定期の集計（取込み → `agent` による候補生成 → 承認 → 反映）なども表せる。本番への反映や外部公開は必ず `approval` の後に置く。

---

## 10. PR 分割

各 PR は単独でレビュー・リリースでき、未完成の機能は UI に出さない（設定の試験的フラグ `experimental.flows` が有効なときだけアクティビティバーに出す）。

| # | 内容 | 主な成果物 | リリース時に使えるもの |
|---|---|---|---|
| 1 | 定義モデル・解析・検証 | `src-tauri/src/flow/{model,parse,validate,template,condition}.rs`、TS 型、`flow_list` / `flow_load` / `flow_validate` コマンド、ゴールデンファイルのテスト | なし（内部） |
| 2 | 読み取り専用ビューア | `src/features/flow/`、アクティビティバーの入口（試験的フラグ）、elkjs レイアウト（Worker）、ノード種別ごとの描画、テーマトークン、i18n | フロー定義の閲覧と検証エラーの表示 |
| 3a | エンジンの核（バックエンド） | 実行ストア（`events.jsonl` / `state.json`）、実行・ノードの状態遷移、スケジューラ（直列）、`command`（子プロセス、プロトコル `mdium-v1`、`retry`、タイムアウト）、`approval`、`when`、停止・中止・停止の猶予、フロー全体の予算（`limits.budgetUsd`）による承認待ち、起動時の回復（実行中は `interrupted`）、コマンドの初回確認（7.2）、承認通知の拡張点（6.5）、Tauri コマンドとイベント | なし（UI は 3c） |
| 3b | 切り離したプロセスと再接続 | `detach`（ラッパー、`exit.json`）、pid とプロセス作成時刻による再接続、アプリ終了時にプロセスを残す | 再起動を越える長時間コマンド |
| 3c | 最小の実行 UI | 開始（引数フォーム、コマンドの確認）、停止・再開・中止、承認、ノードの再実行・成功扱い、ログ表示、`.gitignore` の案内 | 直列のコマンドフローの実行 |
| 4 | 制御構造と並列度 | `loop`（`foreach` / `while`、`parallelism`）、`branch`、`subflow`、後退エッジと `maxTraversals`、`retry`、`concurrencyKey`、アプリ全体の上限 | 外部プロジェクトのフロー（9.2 相当） |
| 5 | エージェントノードと費用 | `agent`（既存ランナー・ガードの再利用）、`cost` の集計、予算による承認待ち、見積もりの合計 | LLM を含むフロー |
| 6 | 重ね表示と実行履歴 | ノードの状態・反復・再試行・費用の重ね表示、ノードのドロワー（実行一覧、出力、成果物、ログ末尾）、実行一覧のフィルタと削除 | 長時間実行の監視 |
| 7 | エディタ | ノードの追加・削除・接続、属性パネル、条件のフォーム、自動整列、元に戻す、YAML の分割表示、外部変更の検知 | フローの作成・編集 |
| 8 | 開発ワークフローのテンプレート | 8.2 の組込みアクション、`dev-workflow` テンプレート、同等性の対応表、新旧の同等性テスト | 新エンジンでの開発ワークフロー（試験的） |

- PR 3 は規模が大きいため 3a / 3b / 3c に分けた（3b・3c は前の PR に積み重ねる）。ノード単位の予算（`cost.budgetUsd`）は PR 5、アプリ全体の同時実行数の上限と `concurrencyKey` は PR 4 で扱う。直列実行の間は `limits.maxConcurrentNodes` は効かない。
- PR 4 も実装計画の段階で必要ならさらに分ける。
- 旧エンジンの退役は本仕様の範囲外とし、8.3 を満たした後に別の仕様・PR で行う。

---

## 11. テスト方針

- Rust（`cargo test`）:
  - 解析・検証: 正常系・各検証エラーのゴールデンファイル（`src-tauri/tests/fixtures/flows/`）。YAML と JSON の同値性。
  - 状態遷移: 実行・ノードの遷移表について、許可・拒否の全組み合わせ。
  - スケジューラ: 合流と `skipped` の伝播、後退エッジの上限、`while` の `until` と上限、`parallelism` と `concurrencyKey`、予算超過の承認待ち、条件の型エラー。
  - 再開: イベントの末尾が欠けたファイル、`state.json` の破損、`seq` 以降の適用、`loop_items` を使った同じ一覧での再開。
  - 長時間実行: フェイクの長時間コマンド（スリープするテスト用バイナリ）を `detach` で起動 → スケジューラを破棄 → 再構築して再接続 → 終了ファイルで確定、の一連。pid 再利用（作成時刻の不一致）で `interrupted` になること。
  - プロトコル: フェイクの「外部プロジェクト」（テスト用バイナリ）が `progress` / `cost` / `output` / `outcome` を書き、上限超過・不正行・`outcome` と終了コードの食い違いを含めて扱えること。
  - 停止: 協調的停止（`STOP` を見て `stopped` を返す）と猶予切れの強制終了。
  - 同等性（PR 8）: 8.3-2 のシナリオを新旧で実行し最終状態を比較。
- フロントエンド（vitest）: ストアのイベント適用と `seq` の欠落検出、ノード描画（種別・状態）、属性パネルの検証表示、承認ボタン、ja/en の i18n キー一致、elkjs レイアウトは位置の有無で自動配置が切り替わること。
- 各 PR の完了時に実機スモーク手順を実施する（PR 3 以降は、MDium を再起動しても長時間コマンドが続くことを含む）。

---

## 12. リスク

| リスク | 影響 | 対策 |
|---|---|---|
| 切り離したプロセスが残り続ける | MDium を消しても外部処理が走り続ける、二重起動 | 実行一覧に「MDium の外で動作中」を明示、中止でプロセスツリーを終了、`concurrencyKey` で二重起動を防ぐ |
| Windows でのプロセス管理（ジョブオブジェクトからの切り離し、プロセスツリーの終了） | 再接続・中止の失敗 | ラッパーを最小にし、PR 3 で Windows の実機テストを必須にする |
| コマンドノードの任意実行 | 悪意あるリポジトリのフロー定義でコマンドが走る | 7.2 の初回・変更時の確認、リポジトリを開いただけでは実行しない |
| 同等性の範囲が大きい | 旧エンジンの退役が遅れる | 退役を本仕様の範囲外にし、併存を前提にする。対応表を先に作る |
| 費用が計測できないノード | 予算が効かない | 不明を 0 と扱わず表示、見積もりで予算判定 |
| YAML のコメントがエディタの保存で消える | 外部プロジェクトの文書性が下がる | 保存前の警告、`description` への移行案内（コメント保持は将来課題） |
| イベントログの肥大化 | 数時間・数千ノードの実行で読み込みが遅い | `state.json` のチェックポイント、進捗イベントの間引き（同一ノードは 1 秒に 1 件） |

---

## 13. 決定事項（2026-10-06）

起草時の未決事項は、利用者がすべて推奨どおりに決定した。

| # | 項目 | 決定 | 反映先 |
|---|---|---|---|
| 1 | コマンドノードの再起動越え | コマンドノードは切り離して起動し、pid とプロセス作成時刻の一致で再接続する。エージェントノードは既存どおり `interrupted` とし、自動では再実行しない | 4.6、5.4 |
| 2 | レイアウト | npm `elkjs` を依存に追加し、layered レイアウトを使う | 6.2 |
| 3 | フロー定義の形式 | YAML（`*.flow.yaml`）を正とし、JSON も同じスキーマで受け付ける。エディタで保存すると YAML のコメントは失われる（保存前に警告） | 2.1、6.3 |
| 4 | ヘッドレス実行 | 現時点では対象外。MDium 外で定期実行する必要が生じた時点で、独立した CLI エンジンとしての提供を再検討する | 対象外 |
| 5 | 承認の通知 | 当面はアプリ内の表示のみ。外部への通知（メール・チャット等）は後の拡張とし、拡張点（6.5）だけを設計に残す | 6.5 |
| 6 | 外部プロジェクトの定義の置き場所 | 外部プロジェクトのフロー定義とコマンドの入口は、そのプロジェクトのリポジトリに置く（MDium には含めない） | 9.1 |
| 7 | 条件の表現力 | 比較と `all` / `any` / `not` のみ。必要になったら拡張する | 2.6 |
| 8 | 要件整理・定期 JOB | 当面は旧エンジンにつながった独立した機能のまま。移行先は旧エンジンの退役時に決める | 8.4 |

---

## 外部前提

- 既存のエージェントランナーの前提（Node.js 20 以上、各プロバイダーの CLI と認証）
- 外部プロジェクトがプロトコル `mdium-v1` を話す入口を用意すること（9.1）
- 開発ワークフローのテンプレート: git、Issue 連携時は `gh` / `glab`

## 対象外

- 旧エンジンの退役と、既存のタスク・フロー実行の変換
- MDium 外でのヘッドレス実行、リモート・クラウドでの実行（MDium 外での定期実行が必要になった時点で再検討。13 章の決定 4）
- 承認待ちの外部通知（メール・チャット等）。拡張点（6.5）のみ用意する
- 外部からの組込みアクションの追加（プラグイン）
- 式言語（算術・関数を含む条件）
- YAML のコメントを保ったままの編集
- push、PR / MR 作成、リモートでのマージ（既存と同じ）
- エージェントのターンの途中からの再開
