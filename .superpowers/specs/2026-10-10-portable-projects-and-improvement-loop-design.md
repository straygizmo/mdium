# ポータブルなプロジェクトと外側の改善ループ 設計仕様

- 日付: 2026-10-10
- 対象: 汎用フローエンジン（2026-10-06 仕様）を、「AI を使うアプリをプロジェクトとして丸ごと可搬化し、MDium がそのプロジェクトの改善ループを回せる」基盤へ拡張する。最初の実証として video_gen（CEFR ストーリー生成と動画化の Python アプリ）をプロジェクト化し、既存の開発ワークフローを 2 つ目のプロジェクト（MDium 同梱テンプレート）として表す。最終的にフロー機能をブラウザから使える Web サービスにする
- 位置付け: 2026-10-06 仕様の**追補**。同仕様の用語・データモデル・実行エンジン・保存レイアウト・安全の規則はそのまま有効で、本仕様は追加と変更だけを書く。矛盾する箇所は本仕様が優先する
- 本仕様は設計のみを扱う。実装は 12 章の PR 分割に従い、PR ごとに実装計画（`.superpowers/plans/`）を作成して進める

| 章 | 内容 |
|---|---|
| 1 | 捉え直しと、2026-10-06 仕様からの変更点 |
| 2 | プロジェクト（`.mdium/project.yaml`、可搬性、セットアップ、ランタイム、秘密、指標） |
| 3 | `python` ノードと常駐ワーカー（定義、プロトコル、ライフサイクル、安全） |
| 4 | `mdium-worker` Python パッケージ |
| 5 | 成果物とプレビュー、承認の `show` |
| 6 | エディタ（最小範囲） |
| 7 | `agent` ノード、組込みアクション、テンプレート参照（`mdium:`） |
| 8 | 改善ループ（`improve` フロー） |
| 9 | video_gen プロジェクト |
| 10 | `flow-core` クレートとフロントのトランスポート層 |
| 11 | フローサーバと Web フロント |
| 12 | PR 分割 |
| 13 | テスト方針、14 リスク、15 決定事項 |
| 16 | フローの関数化（署名、ライブラリ、折りたたみとドリルダウン、抽出、粒度） |

---

## 0. 用語（追加）

| UI 表示 | 識別子 | 定義 |
|---|---|---|
| プロジェクト | `project` | MDium で開く 1 つのディレクトリ（git リポジトリ）で、`.mdium/project.yaml` を持つもの。アプリのコード、フロー定義、ランタイム宣言、セットアップ手順を含み、ディレクトリごと移せる |
| ランタイム | `runtime` | プロジェクトが宣言する実行環境（初版は Python のみ）。名前で参照する |
| ワーカー | `worker` | ランタイムごとに MDium が起動する常駐プロセス。`python` ノードの関数を実行する |
| 段階 | `stage` | ワーカーが公開する関数。`python` ノードの `entry` が指す |
| マニフェスト | `manifest` | ワーカーが起動時に返す段階の一覧（名前、説明、入出力、成果物） |
| 指標 | `metric` | 改善ループが比較する、主フローの出力または費用 |
| テンプレート | `template` | MDium 同梱のプロジェクト雛形。`mdium:<name>` で参照するか、プロジェクトへコピーして使う |
| 改善ループ | `improve` | 外側のフロー。主フローの結果を読み、エージェントが提案し、人が承認し、開発ワークフローで変更し、再実行して比較する |

---

## 1. 捉え直しと変更点

### 1.1 捉え直し

MDium のフローは「ある外部プロジェクトの処理をノードで表す」だけではない。次の 2 層を同じエンジンで扱う。

- **内側**: アプリ自身のフロー。video_gen なら「観測 → 評価 → 計画 → 承認 → 生成 → 動画化 → レビュー修正」。アプリはプロジェクトとして可搬で、MDium で開けばセットアップして動かせる。
- **外側**: MDium がアプリを改善するフロー。内側の実行結果（出力、費用、成果物、失敗）を読み、エージェントが変更を提案し、人が承認し、開発ワークフロー（これもプロジェクト）が worktree 上で実装し、内側を再実行して指標を比べ、採用か破棄かを人が決める。

video_gen の `orchestrate.py` が内容（ストーリー）のレベルで回している「観測 → 評価 → 計画 → 承認 → 生成」と、外側の改善ループは相似形である。

### 1.2 2026-10-06 仕様からの変更

| 項目 | 変更 | 参照 |
|---|---|---|
| 決定事項 4（ヘッドレス・リモート実行は対象外） | **撤回**。エンジンを Tauri 非依存の `flow-core` クレートにし、Tauri 版とフローサーバの両方から使う | 10, 11 章 |
| ノード種別 | `python` を追加。`command` と `mdium-v1` プロトコルは残し、`python` はその上に作る | 3 章 |
| フロー定義のトップレベル | `runtimes` は**フローには置かず**、プロジェクトの `project.yaml` に置く | 2 章 |
| `subflow` | `flow` に `mdium:<template>` を認める。`projectRoot`（実行ルートの上書き）を追加 | 7.3, 8 章 |
| サブフローの扱い | **関数として扱う**。`outputs` の宣言を署名とし、呼び出し側の参照を検証する（`FLOW_OUTPUT_UNKNOWN`）。`.mdium/flows/lib/` を部品の置き場にし、一覧を入口・部品・テンプレートに分ける。エディタに折りたたみ表示・ドリルダウン・抽出を足し、実行パネルをサブフロー単位のツリーにする | 16 章 |
| `approval` | 出力 `choice` と `comment` を持つ。`show` に成果物参照を認める | 5.3 |
| 外部プロトコル `artifact` | `mediaType` を任意で追加 | 5.1 |
| 値の参照（2.5） | `nodes.<id>.artifacts` / `nodes.<id>.artifacts.<label>`、`nodes.<id>.costUsd`（サブフローの実費合計）を追加。`with` の値が**ちょうど 1 つの** `${{ }}` だけから成る場合は参照先の型（オブジェクト・配列・数値・真偽）を保ち、それ以外は文字列に展開する | 3.1, 5.1, 8.2 |
| 条件 | 変更なし（指標の比較は組込みアクションで行う） | 8.3 |
| PR の順序 | エディタ（旧 7）と `agent`（旧 5）・開発ワークフローのテンプレート化（旧 8）を前倒し。並列度（旧 4b）と重ね表示（旧 6）は後回し | 12 章 |
| 7.4「MDium のコードに外部プロジェクト固有の処理を入れない」 | **維持**。video_gen 固有の段階・プロンプト・フロー定義は video_gen リポジトリに置く | 9 章 |

---

## 2. プロジェクト

### 2.1 マニフェスト `.mdium/project.yaml`

```yaml
schemaVersion: 1
id: video-gen                      # [a-z0-9-]
name: CEFR video generator
description: ...
runtimes:                          # execution environments the flows refer to by name
  video_gen:
    kind: python
    python: .venv/Scripts/python.exe   # project-relative; `python` on PATH is NOT assumed
    module: video_gen_flow             # the module that registers stages (4 章)
    cwd: .                             # project-relative working dir (default ".")
    env: { PYTHONUTF8: "1" }           # non-secret env
setup:                             # how to make a fresh copy runnable (run on demand, never automatically)
  - { run: [uv, sync], workingDir: . }
secrets: [GOOGLE_API_KEY, ANTHROPIC_API_KEY]   # names only; values come from the machine's environment
flows:
  main: flows/production-cycle.flow.yaml       # "run this app"
  improve: flows/improve.flow.yaml             # the outer loop (optional)
metrics:                           # what the outer loop compares (8.3); refs are relative to the `main` run
  - { ref: outputs.avgVideoCoherence, better: higher }
  - { ref: outputs.coverage, better: higher }
  - { ref: costUsd, better: lower }
```

- `schemaVersion` は初版 `1`。未知のトップレベルキーは警告、`runtimes` / `setup` の未知の属性は検証エラー。
- `runtimes.<name>.kind` は初版 `python` のみ。`python` と `cwd` はプロジェクト相対パスで、ルート外とシンボリックリンクは拒否する（フローファイルと同じ規則）。`python` は文字列または文字列の配列（OS ごとの候補。例 `[.venv/Scripts/python.exe, .venv/bin/python]`）で、配列なら最初に存在するものを使う。
  - V3 実装メモ: `python` と `cwd` はルートから成分ごとに辿り、途中の成分（`.venv` など）がシンボリックリンク・ジャンクションなら拒否する。ただしインタプリタの末端（unix の venv の `bin/python`）だけはリンクでよく、辿った先が通常ファイルであること。`cwd` は末端も含めてリンクを拒否し、ディレクトリであること。
- `setup[].run` は argv 配列（シェル文字列は使わない）。`workingDir` の既定はプロジェクトルート。
- `secrets` は名前だけ。MDium は値を保存せず、フロー実行の開始時に MDium プロセスの環境変数に全名が存在することを確認し、無ければ `FLOW_SECRET_MISSING`（不足した名前の一覧）で開始を拒む。ワーカーとコマンドは MDium の環境変数を引き継ぐ（2026-10-06 仕様 7.2 のとおり）。
- `flows.main` は必須ではない。`.mdium/flows/*.flow.yaml` の自動一覧は変えず、`flows` は役割の印（UI で「主フロー」「改善」と表示）と改善ループの既定値に使う。
- `metrics[].ref` は `outputs.<key>`（主フローの `outputs`）または `costUsd`（実行の実費合計）。`better` は `higher` / `lower`。
- `project.yaml` が無いディレクトリでも、従来どおりフローは使える（`python` ノードと `secrets` の検査だけが使えない）。

### 2.2 可搬性

- プロジェクトはディレクトリごと（git リポジトリとして）移す。MDium で開くと、`project.yaml` を読んで「セットアップ」操作を出す。セットアップは利用者の操作でのみ実行し、`setup` の各コマンドを順に実行してログを表示する。
- 実行データ（`.mdium/flow-runs/`）は既存どおり `.gitignore` の案内対象。
- 秘密の値はプロジェクトに含めない（2.1）。

### 2.3 確認（2026-10-06 仕様 7.2 の拡張）

- フロー実行の初回確認の一覧に、コマンドに加えて**ランタイム**（インタプリタのパス、モジュール名、作業ディレクトリ）を表示する。
- 確認ハッシュの入力に、参照する全フローファイルに加えて `project.yaml` のバイト列を含める。`project.yaml` を変えると再確認になる。
- セットアップの実行は、その操作の直前に `setup` の一覧を表示して確認を取る（毎回）。

### 2.4 Tauri コマンド

| コマンド | 内容 |
|---|---|
| `flow_project_load(projectRoot)` | `project.yaml` の解析結果と検証結果 |
| `flow_project_setup(projectRoot, sha256)` | セットアップの実行（進捗は `flow://setup-progress` イベント）。実行中は同じプロジェクトで二重に走らせない。`sha256` は `flow_project_load` が返す `project.yaml` の内容ハッシュで、一致しなければ `FLOW_FILE_CHANGED`（確認した手順と実行する手順を一致させる。V2 実装時の追加） |
| `flow_runtime_describe(projectRoot, runtime, sha256)` | ワーカーを起動して `describe` だけを行い、マニフェストを返して終了する（エディタ用。3.4）。`sha256` は 3.6 の V3 実装メモ |

---

## 3. `python` ノードと常駐ワーカー

### 3.1 定義

```yaml
nodes:
  - id: render
    kind: python
    runtime: video_gen             # a name in project.yaml `runtimes`
    entry: video.render            # a stage name from the runtime's manifest
    with:                          # inputs (templated); keys must match the stage's input schema
      videoDir: "${{ nodes.assets.outputs.videoDir }}"
      title: "${{ params.title }}"
    timeout: 2h
    retry: { max: 1, on: [timeout] }
```

| 属性 | 型 | 既定 | 意味 |
|---|---|---|---|
| `runtime` | string | 必須 | `project.yaml` の `runtimes` の名前。無ければ検証エラー `FLOW_RUNTIME_UNKNOWN` |
| `entry` | string | 必須 | 段階名（`[a-z0-9_.]+`）。定義の検証では存在を確かめず、実行開始時にマニフェストと照合する（`FLOW_PYTHON_ENTRY_UNKNOWN` で失敗） |
| `with` | map | `{}` | 入力。値はテンプレート展開後に JSON として渡す。文字列以外（数値・真偽・配列・オブジェクト）はそのまま渡す。値がちょうど 1 つの `${{ }}` だけなら参照先の型を保つ（1.2） |

- 共通属性（`timeout` / `retry` / `cost` / `when` / `concurrencyKey`）は他の種別と同じ。
- 出口は `success` / `failure`。段階が `needs_approval` を返した場合は承認待ち（`command` と同じ）。
- 出力は段階が返す `output` イベント。マニフェストの `outputs` に無いキーも受け付ける（警告のみ）。
- `python` ノードは `project.yaml` が必要。無いプロジェクトでは検証エラー `FLOW_PROJECT_REQUIRED`。

### 3.2 ワーカーのライフサイクル

- フロー実行ごと・ランタイムごとに最大 1 プロセス。最初の `python` ノードの開始時に起動し、実行の終了（完了・失敗・停止・中止）で `shutdown` を送り、猶予（`limits.stopGrace`）の後にプロセスツリーを終了する。
- 起動: `<python> -m mdium_worker --module <module>`、作業ディレクトリは `cwd`、環境変数は MDium のもの＋`runtimes.<name>.env`＋`PYTHONUTF8=1`＋`MDIUM_FLOW_RUN_ID` / `MDIUM_FLOW_STOP_FILE` / `MDIUM_PROJECT_ROOT`。起動後まず `describe` を送り、マニフェストを受け取る（`FLOW_RUNTIME_START_FAILED` で失敗）。
- ワーカーは MDium の子プロセスとして動かす（**切り離さない**）。アプリ終了時は `agent` と同じく `interrupted` にし、自動では再実行しない。video_gen の各段階は冪等（既存の `run_state.json`）なので、再開でノードを再実行すると続きから走る。切り離しは将来の拡張（14 章）。
- 1 ワーカーは同時に 1 呼び出しだけを処理する。並列度（旧 PR 4b）を入れる際は、ランタイムごとに複数ワーカーを起動する方式にする（ワーカー側の変更は不要）。
- 呼び出し中にワーカーが終了したら、そのノードは `failed`（`FLOW_PYTHON_WORKER_EXITED`）。次の `python` ノードで新しいワーカーを起動する。
- タイムアウト・中止: `cancel` を送り、`stopGrace` の後にプロセスツリーを終了する。停止（`STOP` ファイル）: `cancel` は送らず、段階が `MDIUM_FLOW_STOP_FILE` を見て区切りで `stopped` を返すのを待つ（`command` と同じ）。
- V3 実装メモ: 利用者の中止では、実行中の各呼び出しに `cancel` を送り、`outcome` かワーカーの終了を `limits.stopGrace`（未指定なら 5 秒）まで待ってからプロセスツリーを終了する（同期・上限あり。タイムアウトと同じ扱い）。実行終了時は `shutdown` の後 `limits.stopGrace`（未指定なら 2 秒）待って終了させる。ワーカーの起動（`describe` の応答待ち、上限 30 秒）中も中止とアプリ終了を受け付け、起動中のワーカーを終了させる。`FLOW_RUNTIME_START_FAILED` の `message` にはワーカーの `stderr.log` の末尾（約 2 KB、`stderr` 属性にも）を付ける。`stderr.log` は追記で開き、ワーカーの再起動をまたいで残す。

### 3.3 プロトコル（`mdium-worker-v1`）

標準入出力の JSON 行。標準エラーはログとして扱い解析しない。全行に `"v": 1`。

MDium → ワーカー:

| `type` | 属性 | 意味 |
|---|---|---|
| `describe` | `requestId` | マニフェストを返す |
| `call` | `requestId`, `callId`, `entry`, `inputs`（JSON）, `context`（`runId`, `nodeKey`, `nodeDir`, `projectRoot`, `stopFile`, `attempt`） | 段階を実行する |
| `cancel` | `callId` | 実行中の段階を中止する。段階は速やかに `outcome: stopped` または `fail` を返す |
| `shutdown` | — | 終了する |

ワーカー → MDium:

| `type` | 属性 | 意味 |
|---|---|---|
| `manifest` | `requestId`, `module`, `stages[]` | 3.4 |
| `progress` / `cost` / `output` / `artifact` | `callId` ＋ 2026-10-06 仕様 5.3 と同じ属性（`artifact` は `mediaType` 任意） | 実行中のイベント。MDium はノード実行ディレクトリの `events.jsonl` に追記し、既存の `parse_line` と同じ処理に流す |
| `log` | `callId`, `level`（`info` / `warning` / `error`）, `text` | 表示用ログ。`stdout.log` に書く |
| `outcome` | `callId`, `status`（`ok` / `fail` / `needs_approval` / `stopped`）, `reason` / `message` | 呼び出しの終了。これ以降その `callId` のイベントは捨てて警告する |
| `error` | `requestId`, `code`, `message` | プロトコル上の失敗（未知の `entry`、入力の検証失敗など）。`call` に対する `error` はノードを `failed` にする |

- 1 行 64 KiB、1 呼び出し 10 万行の上限と不正行の扱いは 5.3 と同じ。
- `outcome` が来ずにワーカーが終了した場合は `fail`（`FLOW_PYTHON_WORKER_EXITED`）。

### 3.4 マニフェスト

```json
{"v":1,"type":"manifest","requestId":"1","module":"video_gen_flow",
 "stages":[{"name":"video.render","description":"Render the MP4 from the composition IR",
            "inputs":{"videoDir":{"type":"path","required":true},"title":{"type":"string","default":"video"}},
            "outputs":{"videoPath":{"type":"path"}},
            "artifacts":[{"label":"video","mediaType":"video/mp4"}]}]}
```

- 入力の型は `string` / `number` / `bool` / `path` / `object` / `array`（フローの `params` の型に `object` / `array` を足したもの）。`required` と `default` を持つ。
- MDium は `call` の前に入力をマニフェストで検証する（必須の欠落と型の不一致は `FLOW_PYTHON_INPUT_INVALID` でノードを `failed`）。ワーカー側も同じ検証をする（二重だが、エディタ外から来るフローも守るため）。
- エディタは `flow_runtime_describe` でマニフェストを取り、`python` ノードのパレットと属性フォームに使う。マニフェストはフロー定義には保存しない（実行時に常に取り直す）。

### 3.5 保存レイアウト（追加）

| パス | 内容 |
|---|---|
| `.mdium/project.yaml` | 2.1 |
| `.mdium/flow-runs/<runId>/runtimes/<name>/stdout.log`, `stderr.log` | ワーカーのログ（呼び出しをまたぐ） |
| `.mdium/flow-runs/<runId>/nodes/<nodeKey>/<n>/events.jsonl` | ワーカーのイベント（MDium が `callId` を外して追記。`command` の外部イベントと同じ形式） |
| `.mdium/flow-runs/<runId>/nodes/<nodeKey>/<n>/inputs.json` | 展開済みの `with` |
| `.mdium/flow-runs/<runId>/nodes/<nodeKey>/<n>/artifacts.json` | 成果物の一覧（5.1） |

### 3.6 安全

- ワーカーは利用者の権限で、`project.yaml` に書かれたインタプリタとモジュールをそのまま実行する。サンドボックスはしない。2.3 の確認がこれを制御する。
- `runtimes.<name>.python` と `module` にはテンプレートを使えない（確認した内容が実行内容を決めるため）。`with` にはテンプレートを使える。
- V3 実装メモ: `flow_runtime_describe(projectRoot, runtime, sha256)` はプロジェクトのコード（モジュールの import）を実行するため、セットアップと同じく、呼び出し側が表示した `project.yaml` の内容ハッシュ（`flow_project_load` の `sha256`）を要求し、一致しなければ `FLOW_FILE_CHANGED` で拒む。呼び出し側はランタイムの概要を表示してから呼ぶ。マニフェストに誤りがあれば `FLOW_PROJECT_INVALID`（問題ごとの詳細付き）、無ければ `FLOW_PROJECT_REQUIRED`。

### 3.7 エラーコード（追加）

`FLOW_PROJECT_INVALID`、`FLOW_PROJECT_REQUIRED`、`FLOW_RUNTIME_UNKNOWN`、`FLOW_RUNTIME_START_FAILED`、`FLOW_PYTHON_ENTRY_UNKNOWN`、`FLOW_PYTHON_INPUT_INVALID`、`FLOW_PYTHON_PROTOCOL`、`FLOW_PYTHON_WORKER_EXITED`、`FLOW_SECRET_MISSING`、`FLOW_SETUP_FAILED`、`FLOW_SUBFLOW_ROOT_INVALID`、`FLOW_TEMPLATE_UNKNOWN`、`FLOW_ARTIFACT_OUTSIDE_PROJECT`、`FLOW_OUTPUT_UNKNOWN`、`FLOW_PARAM_TYPE`（16.1）。

---

## 4. `mdium-worker` Python パッケージ

- 置き場所: MDium リポジトリの `python/mdium-worker/`（`pyproject.toml`、`src/mdium_worker/`）。プロジェクトはこれを依存に取り込む（path または git 参照。PyPI 公開は対象外）。
- 依存: 標準ライブラリのみ（プロジェクトの環境を汚さないため）。Python 3.10 以上。
- API:

```python
from mdium_worker import stage, Context

@stage("video.render", description="Render the MP4 from the composition IR",
       inputs={"videoDir": {"type": "path", "required": True}, "title": {"type": "string", "default": "video"}},
       outputs={"videoPath": {"type": "path"}})
def render(ctx: Context, videoDir: str, title: str = "video") -> None:
    ctx.progress("rendering", fraction=0.1)
    ...
    ctx.artifact(out_mp4, label="video", media_type="video/mp4")
    ctx.output("videoPath", str(out_mp4))
```

- `Context`: `progress(text, fraction=None)`、`cost(usd, kind="actual", provider=None, model=None, units=None)`、`output(key, value)`、`artifact(path, label=None, media_type=None)`、`log(text, level="info")`、`should_stop() -> bool`（停止ファイルと `cancel` の両方を見る）、`needs_approval(message)`（例外として投げると `outcome: needs_approval`）、`node_dir`、`run_id`、`project_root`。
- 段階関数の戻り値: `None` で `ok`。`mdium_worker.StageFailed(reason)` を投げると `fail`、`mdium_worker.Stopped()` で `stopped`。その他の例外は `fail`（トレースバックを `log` の `error` と `reason` に入れる）。
  - V3 実装メモ: 想定外の例外の `reason` は `型名: メッセージ` の短い形にし、トレースバックは `error` レベルの `log` 行にだけ入れる（表示が長くならないため）。段階内の `sys.exit()` も `fail`（`reason` は `SystemExit: <code>`）でワーカーは終了しない。
- `python -m mdium_worker --module <module>`: モジュールを import して登録された段階を集め、3.3 のループに入る。`describe` だけなら `--describe` で起動して 1 行出して終了する（`flow_runtime_describe` 用）。
- 入力検証: `inputs` スキーマに対して必須と型を検証。`path` は文字列として受け、存在は検証しない（段階の責務）。
- 同時実行はしない（3.2）。`cancel` は別スレッドで読み取り、`ctx.should_stop()` が真になる。段階が止まらなければ MDium 側のタイムアウトとプロセス終了に任せる。

---

## 5. 成果物とプレビュー

### 5.1 成果物の記録

- `artifact` イベント（`command` の `mdium-v1`、`python` の `mdium-worker-v1`、`agent` の生成物）を、ノード実行ごとに `artifacts.json` に集める: `[{ index, path, label, mediaType, bytes, recordedAt }]`。
- `path` は絶対パスまたはノード実行ディレクトリ相対。**プロジェクトルートまたは実行ディレクトリの外**は拒否して警告する（`FLOW_ARTIFACT_OUTSIDE_PROJECT`。ノードは失敗にしない）。
- `mediaType` が無い場合は拡張子から推定する（`png` / `jpg` / `webp` / `mp4` / `webm` / `mp3` / `wav` / `json` / `md` / `txt`。それ以外は `application/octet-stream`）。
- 参照: `nodes.<id>.artifacts`（一覧）、`nodes.<id>.artifacts.<label>`（ラベルで最初に一致したもののパス）。テンプレート `${{ nodes.<id>.artifacts.<label> }}` はパスに展開する。

### 5.2 取得

- `FlowTransport.artifactUrl(ref)`（10 章）が、表示に使える URL を返す。
  - Tauri 版: アセットプロトコル（`convertFileSrc`）。実行開始時に、その実行ディレクトリとプロジェクトルートをアセットプロトコルのスコープに動的に追加する。CSP の `img-src` / `media-src` に `asset:` と `http://asset.localhost` を加える（プレビューが真っ白なときは CSP を確認する）。
  - Web 版: `GET /api/projects/{projectId}/runs/{runId}/artifacts/{nodeKey}/{attempt}/{index}`（Range 対応。動画のシークのため）。
- 取得は `artifacts.json` に記録されたパスに限る（任意のパスは読めない）。

### 5.3 実行パネルと承認

- 実行パネルのノード詳細に「成果物」タブを足し、`mediaType` に応じて画像・動画（`<video controls>`）・音声・JSON/テキスト（整形表示、先頭 256 KiB）を表示する。
- 実行パネルのノード一覧はサブフロー単位のツリーにする（16.4）。
- `approval` ノード:
  - `show` に `nodes.<id>.outputs.<key>`（値を表示）、`nodes.<id>.artifacts`、`nodes.<id>.artifacts.<label>`（プレビューを表示）を書ける。
  - 出力 `choice`（選んだ選択肢）と `comment`（入力した文字列。空なら `""`）を持ち、後続ノードから `${{ nodes.review.outputs.comment }}` で参照できる。
  - 承認ダイアログにコメント欄を常に出す（選択肢によっては必須にできる: `options` を `[{ name: revise, commentRequired: true }, accept]` の形でも書ける。文字列だけの要素は従来どおり）。

---

## 6. エディタ（最小範囲）

2026-10-06 仕様 6.3 のうち、初版で入れる範囲を限定する。

- キャンバス: ノードのドラッグ（位置は `ui.positions` に保存）、パレットからの追加（`python` はマニフェストの段階一覧から。`command` / `approval` / `branch` / `loop` / `subflow` / `agent`）、削除、ハンドルのドラッグでエッジ追加（出口はポップオーバーで選ぶ。既定 `success`）、エッジの削除、後退エッジの `maxTraversals` の入力。
- 属性パネル: 種別ごとのフォーム（共通属性＋種別属性）。`python` の `with` はマニフェストの入力スキーマから行を生成し、値はテンプレート文字列として編集する。`when` と `cases` の条件は 2.6 の最小構文のフォーム。
- フローの属性: `params` / `defaults` / `limits` / `outputs` の編集。
- 保存: 正規化した YAML を書き出す（既存の警告: コメントは失われる）。保存前に `flow_validate` を通し、エラーがあれば保存を拒まず警告として表示する（実行は検証エラーがあれば既存どおり拒む）。
- YAML 分割表示: キャンバスの横に YAML のテキストエディタ（既存の CodeMirror）を出し、どちらを編集しても他方へ反映する。インラインの `body` を持つループの中身の編集は、初版ではこのテキスト側で行う（キャンバスでは展開表示のみ。パレットから追加するループの本体はファイル参照にする。16.6）。
- サブフロー: 折りたたみ表示（署名）、ダブルクリックでのドリルダウン、「選択したノード群をサブフローに抽出」（16.3）。
- 外部変更の検知: 開いている間にファイルが変わったら通知し、再読み込みか上書きかを選ぶ。
- 対象外（後続）: 元に戻す／やり直す、自動整列の再実行、複数選択、コピー／貼り付け、ループ本体のキャンバス編集。
- 新規作成: 「空のフロー」と「テンプレートから」（`mdium:` のテンプレートをプロジェクトにコピーする。7.3）。

---

## 7. `agent` ノード、組込みアクション、テンプレート参照

### 7.1 `agent` ノード

2026-10-06 仕様 2.3・7.1 のとおり実装する（旧 PR 5 の内容）。補足:

- 既存の `workflow::runner_client` / `runner_host`（Node サイドカー `agent-runner`）を `flow-core` から使えるように移す（10.1）。
- `prompt` / `promptRef` の本文はテンプレート展開する。実行ディレクトリ、成果物のパス、`inputs.json` の内容を埋め込める。
- `outputContract: outcome` の応答 frontmatter の `outputs` をノード出力にする。`artifacts`（パスの配列）も認め、5.1 の成果物にする。
- 費用: ランナーが返す使用量から `cost` を記録する（提供元が返さない場合は `estimated`）。
- `full-access` のガード一式（screening / containment / integrity）は 7.1 のとおり必須。

### 7.2 組込みアクション

2026-10-06 仕様 8.2 の 7 つに加え、次を追加する。

| `uses` | 内容 | 出力 |
|---|---|---|
| `mdium/project-setup` | `with.projectRoot`（既定は実行のプロジェクト）の `project.yaml` の `setup` を実行する。2.3 の確認は実行開始時の確認に含める（`setup` の一覧も確認画面に出す） | `ok` |
| `mdium/flow-run-latest` | `with.flow`（フローのパス）の、完了した最新の実行を探す | `runId`, `runDir`, `status`, `outputs`（オブジェクト）, `costUsd`, `failedNodes`（配列） |
| `mdium/metrics-compare` | `with.baseline` と `with.candidate`（それぞれ `{ outputs, costUsd }`）を `project.yaml` の `metrics` で比べる。1 つでも悪化があれば `improved: false`。指標が片方に無ければ `unknown` として報告に含め、判定には使わない | `improved`（bool）, `report`（markdown 文字列）, `reportPath`（成果物） |

### 7.3 テンプレート参照 `mdium:`

- `subflow.flow` と「テンプレートから作成」で `mdium:<template>` を認める。`<template>` は MDium 同梱の `resources/flow-templates/<template>/` を指し、その中の `project.yaml` の `flows.main` が参照先のフローになる。未知なら `FLOW_TEMPLATE_UNKNOWN`。
- 同梱テンプレート（初版）: `dev-workflow`（2026-10-06 仕様 8.1 のフロー＋`project.yaml`）、`improve-app`（8 章）。
- テンプレートのフローは `command` ノードを含まない（`action` と `agent` のみ）ので、確認画面には「組込みテンプレート（内容ハッシュ）」として表示する。
- `dev-workflow` の変更点: 引数 `mergeGate`（bool、既定 `true`）を足す。`false` のときは `merge_gate` 以降（`merge` / `close_issue` / `discard`）を `when` で飛ばし、worktree を残したまま終了して `outputs.worktreePath` / `outputs.branch` / `outputs.reviewOutcome` を返す。外側のフローが検証してから採用・破棄を決めるため。
- `subflow.projectRoot`（任意）: 子フローを別のプロジェクトルートで実行する。許すのは**実行中のプロジェクトの git worktree**（`git worktree list` で確認）だけ。それ以外は `FLOW_SUBFLOW_ROOT_INVALID`。子フローのファイルはその worktree 側から読む（変更後のフロー定義で検証するため）。子の確認ハッシュは親の開始時の確認に含められないため、**子フローの `command` と `runtimes` が親プロジェクトの確認済み内容と一致する場合のみ**実行し、違えば承認待ち（`needs_approval` 相当。確認画面で差分を表示）にする。

---

## 8. 改善ループ

### 8.1 位置付け

`improve-app` はテンプレートで、プロジェクトへコピーして `flows.improve` に置く（`subflow` で参照するのではなく、主フローの引数や検証の規模をプロジェクトごとに書き換えるため）。video_gen 用に調整した例を 9.4 に示す。

### 8.2 フロー（テンプレートの既定）

```yaml
schemaVersion: 1
id: improve-app
name: Improve this project
params:
  goal: { type: string, required: true }            # what to improve, in the user's words
  maxIterations: { type: number, default: 3 }
limits: { maxConcurrentNodes: 1, budgetUsd: 50 }
nodes:
  - { id: baseline, kind: action, uses: mdium/flow-run-latest, with: { flow: flows/main.flow.yaml } }
  - id: analyze
    kind: agent
    provider: claude
    permission: read-only
    promptRef: builtin:improve-analyze           # reads goal, metrics, the baseline run dir (outputs, logs, artifacts)
    outputContract: outcome                      # outputs.proposalPath (markdown: what to change and why)
    timeout: 30m
  - id: approve_proposal
    kind: approval
    message: "Review the improvement proposal"
    show: [ "nodes.analyze.artifacts.proposal" ]
    options: [ approve, { name: revise, commentRequired: true }, stop ]
  - id: develop
    kind: subflow
    flow: "mdium:dev-workflow"
    params: { title: "${{ params.goal }}", requirement: "${{ nodes.analyze.outputs.proposalPath }}", mergeGate: false }
  - { id: setup, kind: action, uses: mdium/project-setup, with: { projectRoot: "${{ nodes.develop.outputs.worktreePath }}" } }
  - id: verify
    kind: subflow
    flow: flows/main.flow.yaml
    projectRoot: "${{ nodes.develop.outputs.worktreePath }}"
    params: {}                                   # the project's copy narrows the scale here (e.g. one story)
  - id: compare
    kind: action
    uses: mdium/metrics-compare
    with:
      baseline: { outputs: "${{ nodes.baseline.outputs.outputs }}", costUsd: "${{ nodes.baseline.outputs.costUsd }}" }
      candidate: { outputs: "${{ nodes.verify.outputs }}", costUsd: "${{ nodes.verify.costUsd }}" }
  - id: adopt_gate
    kind: approval
    message: "Adopt the change?"
    show: [ "nodes.compare.artifacts.report", "nodes.develop.outputs.branch" ]
    options: [ merge, discard ]
  - { id: merge, kind: action, uses: mdium/git-merge-local, with: { worktree: "${{ nodes.develop.outputs.worktreePath }}" } }
  - { id: discard, kind: action, uses: mdium/git-worktree-discard, with: { worktree: "${{ nodes.develop.outputs.worktreePath }}" } }
edges:
  - { from: baseline, to: analyze }
  - { from: analyze, to: approve_proposal }
  - { from: approve_proposal, to: develop, port: approve }
  - { from: approve_proposal, to: analyze, port: revise, maxTraversals: 5 }   # the comment feeds the next analysis
  - { from: develop, to: setup }
  - { from: setup, to: verify }
  - { from: verify, to: compare }
  - { from: verify, to: adopt_gate, port: failure }     # a failed verify run is still the human's call
  - { from: compare, to: adopt_gate }
  - { from: adopt_gate, to: merge, port: merge }
  - { from: adopt_gate, to: discard, port: discard }
  - { from: merge, to: baseline, maxTraversals: 3 }     # next iteration starts from the new baseline
  - { from: discard, to: analyze, maxTraversals: 3 }    # try a different proposal
```

- `nodes.verify.outputs` はサブフローの `outputs` 全体（オブジェクト）、`nodes.verify.costUsd` はサブフローの実費合計。テンプレート参照に `nodes.<id>.costUsd` を追加する。
- `approve_proposal` の `revise` のコメントは、次の周回の `analyze` のプロンプトに `${{ nodes.approve_proposal.outputs.comment }}` で入る（周回で `skipped` になった参照は空文字列）。
- 人の判断点は「提案の承認」と「採用」の 2 か所。`stop` は `approve_proposal` の出口にエッジを張らず、フローを正常終了させる。
- `maxIterations` は後退エッジの `maxTraversals` と二重になるため、テンプレートでは後者を正とし、`maxIterations` は表示用の説明に留める（エディタのフォームで同期する）。

### 8.3 指標の比較

- `project.yaml` の `metrics` で比べる。`better: higher` は候補 > 基準、`lower` は候補 < 基準で「改善」。差が 0 は「同等」として改善にも悪化にも数えない。
- 条件（2.6）は値どうしの比較を持たないため、比較は `mdium/metrics-compare` が行い、結果の真偽を `branch` で使える。初版では `adopt_gate` の承認で人が見る。

### 8.4 プロンプト `builtin:improve-analyze`

英語の組込みプロンプト。入力: `goal`、`metrics`、基準実行のディレクトリ（`outputs.json`、ノードごとのログ末尾、成果物の一覧）、前回の `revise` コメント。出力契約: `outcome: completed` と `outputs.proposalPath`（markdown。変更の目的、対象ファイル、検証方法、想定される指標の変化）、`artifacts: [proposalPath]`（ラベル `proposal`）。コードは変更しない（read-only）。

---

## 9. video_gen プロジェクト

### 9.1 配置（video_gen リポジトリ側）

```
video_gen/
  .mdium/project.yaml
  .mdium/flows/production-cycle.flow.yaml   # main (entry)
  .mdium/flows/improve.flow.yaml            # 8 章のテンプレートを調整したもの (entry)
  .mdium/flows/lib/story-run.flow.yaml      # parts (16.2)
  .mdium/flows/lib/video.flow.yaml
  .mdium/flows/lib/video-assets.flow.yaml
  .mdium/flows/lib/video-review.flow.yaml
  video_gen_flow/__init__.py                # registers the stages below
  video_gen_flow/portfolio.py, story.py, video.py
```

- `pyproject.toml` に `mdium-worker` を依存として追加する（path 参照、`uv` で管理）。
- `project.yaml`: 2.1 の例のとおり（`runtimes.video_gen.python: .venv/Scripts/python.exe`、`setup: uv sync`、`secrets: [GOOGLE_API_KEY, ANTHROPIC_API_KEY]`、必要なら `GOOGLE_APPLICATION_CREDENTIALS`）。

### 9.2 段階（`@stage` で登録する既存関数）

| 段階 | 既存の実装 | 入力 → 出力 |
|---|---|---|
| `portfolio.observe` | `orchestrator._observe`, `production_ledger.compute_portfolio_state` | `outputRoot` → `statePath`, `coverageByLevel`, `recordCount` |
| `portfolio.evaluate` | `portfolio_evaluator.evaluate`（Claude Agent SDK の read-only ランナーを Python 内で使う） | `statePath`, `comments?` → `reportPath`, `findingsPath`（成果物） |
| `portfolio.plan` | `production_planner.plan` | `statePath`, `reportPath`, `constraints?` → `orderPath`（成果物 `order`）, `order`（object） |
| `portfolio.record` | `orchestrator._observe`（再観測） | `outputRoot` → `recordedCount`, `avgVideoCoherence`, `coverage` |
| `story.init_run` | `multi_story` の実行ディレクトリ作成 | `level`, `genres`, `relationship`, `resumeDir?` → `runDir` |
| `story.generate_next` | `run_multi_story` を「1 本だけ追加」で呼ぶ薄い包み（`max_stories = 既存本数 + 1`, `resume_parent_dir = runDir`）。章のループ・再試行・チェックポイントは Python 内のまま | `runDir`, `level`, `genre`, `index` → `storyDir`, `coverage`, `done` |
| `story.list_stories` | `multi_story._scan_run_directory` | `runDir` → `storyDirs`, `coverage` |
| `story.continuity_audit` | `story_continuity_audit.gate_story_dir` | `storyDir`, `minScore?` → `eligible`, `score`, 成果物 `audit` |
| `video.label` / `video.script` / `video.voice` / `video.assets` / `video.ir` / `video.render` / `video.quality` / `video.pacing` / `video.review_build` | `run_video_pipeline` の各ブロックを関数に分解したもの。`run_video_pipeline` 自体はその関数を順に呼ぶ形に書き換え、既存テストを維持する | `storyDir`/`videoDir`, 段階ごとの引数 → 段階ごとの出力（`labeledPath`, `scriptPath`, `voiceMapPath`, `sceneCount`, `compositionPath`, `videoPath`, `coherence`, `reviewVideoPath` …）と成果物（画像・音声・動画・JSON） |
| `video.revise` | `video_revise`（feedback JSON） | `videoDir`, `feedback`（承認コメントの JSON 文字列）, `title` → `videoPath`, `reviewVideoPath`, `revisedAssets` |

- 各段階は `ctx.should_stop()` を章・シーンの区切りで見る。
- 費用: 既存のレート制限再試行（`rate_limit_retry.py`）はそのまま。トークン使用量が取れる呼び出しは `ctx.cost` で `actual`、取れないもの（claude CLI）は `estimated` で記録する。
- 画像・音声の成果物は数が多いので、`video.assets` はシーン画像と音声を `label: scene_NN` で記録し、キャラクター参照画像を `label: char_<name>` で記録する。

### 9.3 フロー

`production-cycle.flow.yaml`（主フロー）:

```
observe → evaluate → plan → approve_order(承認: order.json を提示, approve/reject)
  → stories(subflow lib/story-run.flow.yaml, order の level/genres/count/relationship)
  → videos(loop foreach stories.outputs.storyDirs, body: lib/video.flow.yaml, onItemFailure: continue)
  → record
outputs: coverage, avgVideoCoherence, storyCount
```

`lib/story-run.flow.yaml`:

```
params: level, genres, count, relationship, targetCoverage(95), resumeDir("")
init_run → stories(loop while, until: iteration.outputs.done == true, maxIterations: count, body: generate_next)
  → list_stories
outputs: runDir, storyDirs, coverage
```

`lib/video.flow.yaml`（1 ストーリーの動画化。2 つの部品を呼ぶ）:

```
params: storyDir(path), title("video"), imageStyle("Anime"), ttsEngine("Gemini"),
        qualityIters(3), audioPacing(true), minContinuityScore(7)
audit → gate(branch: eligible == false → blocked, default ok)
  blocked → force_gate(承認: audit を提示, force/stop) → produce (force)
  ok → produce(subflow lib/video-assets.flow.yaml)
  → review(subflow lib/video-review.flow.yaml, videoDir/reviewVideoPath を渡す)
outputs: videoPath, coherence, continuityScore
```

`lib/video-assets.flow.yaml`（台本から動画まで）:

```
params: storyDir, videoDir, title, imageStyle, ttsEngine, qualityIters, audioPacing
label → script → voice → assets → ir → render
  → quality(when qualityIters > 0) → pacing(when audioPacing == true) → review_build(when audioPacing == false)
outputs: videoPath, reviewVideoPath, coherence
```

`lib/video-review.flow.yaml`（人のレビューと部分再生成のループ）:

```
params: videoDir, title, reviewVideoPath
review(承認: reviewVideoPath を提示, accept / revise{commentRequired})
  → revise(port revise; feedback = review.outputs.comment) → review(後退エッジ, maxTraversals: 5)
outputs: videoPath, reviewVideoPath, revisionCount
```

- 承認コメントの JSON（`{"revisions":[{"scene":11,"target":"tts","speaker":"Narrator"}]}`）は既存の `video_revise` の形式をそのまま使う。承認ダイアログには、`show` のレビュー動画の下に入力例を説明文として出す（フロー定義の `message` に書く）。

### 9.4 改善フロー（`improve.flow.yaml`）

8.2 のテンプレートをコピーし（部品 `lib/improve-propose.flow.yaml` / `lib/improve-verify.flow.yaml` も一緒にコピーされる。16.5）、`verify` の `params` を小さくする（例: `count: 1`、`qualityIters: 1`）。`metrics` は 2.1 の例のとおり。`analyze` のプロンプトには `goal` の例として「レビュー動画で指摘された台詞の間延びを減らす」「継続性ゲートの誤検出を減らす」のような内容を想定する。

### 9.5 移行しないもの

- 章単位のノード化（`cefr_story_system.py` の章ループ・再試行・チェックポイントは密結合のため、初版ではストーリー単位まで）。
- 既存の Gradio UI と `run_story_loop.ps1`（残すが、フローからは使わない。レート制限の長時間待ちは `rate_limit_retry.py` が吸収する）。
- 旧来の `video_editor/` の WebUI 群。

---

## 10. `flow-core` クレートとトランスポート層

### 10.1 クレート分割

- `src-tauri/Cargo.toml` を cargo ワークスペースにし、`src-tauri/crates/flow-core/` を作る。移すもの: `flow/`（`model`, `parse`, `validate`, `template`, `condition`, `load`, `issues`, `run/*`）、新設の `project`（2 章）、`worker`（3 章）、`artifacts`（5 章）。
- `agent` ノードと組込みアクションが要る共有部品（`workflow::runner_client`, `runner_host`, `outcome`, `screening`, `containment`, `integrity`, `gitops`, `fsutil`, `forge`）は `flow-core`（または `mdium-common`）へ移し、`workflow` 側は再エクスポートで動かす。2026-10-06 仕様 7.4 の「移動は退役時」はこの範囲で前倒しする。
- `flow-core` は `tauri` に依存しない。境界は既存のトレイト（`EventSink`, `ApprovalNotifier`, `Launcher`）と、新設の `FlowService`（Tauri コマンドとサーバのハンドラが共通で呼ぶ関数群。引数と戻り値は serde 型）。
- Node サイドカー（`agent-runner`）の起動は `node_sidecar` に依存しているため、`flow-core` ではトレイト `SidecarSpawner` にし、Tauri 版とサーバ版で実装する。

### 10.2 フロントのトランスポート層

```ts
export interface FlowTransport {
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;   // flow_* commands
  subscribe(event: FlowEventName, handler: (payload: unknown) => void): Promise<() => void>;
  artifactUrl(ref: ArtifactRef): Promise<string>;
}
```

- `src/features/flow/lib/transport.ts` に置き、`flow-api.ts` / `flow-run-api.ts` はこれを通す。Tauri 実装（`invoke` / `listen` / `convertFileSrc`）と HTTP 実装（`fetch` / WebSocket / URL）を用意し、起動時に選ぶ。
- `src/features/flow/` 配下は `@tauri-apps/*` を直接 import しない（vitest の import 検査で守る）。
- コマンド名と引数は Tauri とサーバで同じにし、HTTP では `POST /api/projects/{projectId}/call/{name}` に JSON で渡す（1 対 1 対応。REST らしい設計は複数利用者化のときに見直す）。

---

## 11. フローサーバと Web フロント

### 11.1 サーバ `mdium-flow-server`

- `src-tauri/crates/flow-server/`（axum）。起動引数: `--project <root>`（初版は 1 プロジェクト。`projectId` は `default`）、`--listen 127.0.0.1:8787`、`--token <bearer>`（または環境変数）。
- エンドポイント: `POST /api/projects/{projectId}/call/{name}`（10.2）、`GET /api/projects/{projectId}/events`（WebSocket。`flow://run-changed` / `node-changed` / `progress` / `approval-requested` / `setup-progress` を同じ JSON で流す）、`GET /api/projects/{projectId}/runs/{runId}/artifacts/...`（5.2）、`GET /`（Web フロントの静的配信）。
- 認証: ベアラートークン。トークンなしで起動した場合は `127.0.0.1` 以外からの接続を拒む。
- 実行主体は 1 プロセス 1 つ。Tauri 版と同じプロジェクトを同時に開いて実行すると二重になるため、実行ディレクトリにロックファイル（`.mdium/flow-runs/.lock`、所有者の pid と作成時刻）を置き、他方は読み取り専用で開く。
- 複数利用者化（対象外だが前提として残す）: `projectId` を実体のプロジェクト一覧に対応付け、利用者ごとの認可を `call` の前段に足す。API のパスに `projects/{projectId}` を最初から入れておくのはこのため。

### 11.2 Web フロント

- `src/web/main.tsx` と `index.web.html` を vite の 2 つ目の入力にし、フローのワークスペース（一覧、エディタ、実行、承認、成果物）だけを描画する。Markdown エディタ・プレビュー・RAG などは含めない。
- 設定（言語、テーマ）は `localStorage`。`experimentalFlows` のゲートは Web では無効（常に表示）。
- ビルド: `npm run build:web` → `dist-web/`。サーバがこれを配信する。

---

## 12. PR 分割

各 PR は単独でレビュー・リリースでき、未完成の機能は UI に出さない。

| # | 内容 | 主な成果物 | リリース時に使えるもの |
|---|---|---|---|
| V1 | `flow-core` クレート分離、`FlowService`、フロントのトランスポート層（Tauri 実装のみ） | cargo ワークスペース、`transport.ts`、import 検査 | なし（挙動変更なし） |
| V2（実装済み 2026-10-10。差分: `flow_project_setup` に `sha256` を追加、`ProjectLoadResult.sha256`。V3 への申し送り: マニフェストに誤りがあるときの実行開始の扱い、`python` / `cwd` / `workingDir` のシンボリックリンク拒否、プロジェクトヘッダでのエラー一覧表示） | プロジェクトマニフェストと関数化の基盤 | `project.yaml` の解析・検証、`flow_project_load` / `flow_project_setup`、確認画面へのランタイムと `setup` の追加、`secrets` の検査、セットアップ UI、サブフローの戻り値検証（`FLOW_OUTPUT_UNKNOWN`）、`lib/` と一覧の 3 群（16.1, 16.2） | プロジェクトのセットアップ、部品の区別 |
| V3（実装 2026-10-11。計画のインタフェースからの差分: `flow_runtime_describe` に `sha256` を追加（3.6）、インタプリタ末端のシンボリックリンクを許可し途中の成分と `cwd` は拒否（2.1）、利用者の中止で `cancel` を送り `stopGrace` 後に終了（計画は即時終了。3.2）、実行終了時の猶予は `limits.stopGrace`（3.2）、想定外例外の `reason` は短い形（4）） | `python` ノードとワーカー | `NodeKind::Python`、ワーカープロトコル、ライフサイクル、`flow_runtime_describe`、`python/mdium-worker/`（pytest 付き）、偽ワーカーでの Rust テスト | Python の段階をノードとして実行 |
| V4 | 成果物とプレビュー | `artifacts.json`、`mediaType`、アセットプロトコルのスコープと CSP、実行パネルの成果物タブ、承認の `show` と `comment`、実行パネルのサブフロー単位のツリー（16.4） | 画像・動画の確認と、コメント付き承認 |
| V5 | エディタ（6 章） | パレット、属性パネル、エッジ編集、YAML 分割表示、保存、新規作成、サブフローの折りたたみ表示・ドリルダウン・抽出（16.3） | キャンバスでの編集 |
| V6 | video_gen プロジェクト化（video_gen リポジトリ側） | `video_gen_flow/`、`run_video_pipeline` の段階分解、入口 2 本と部品 4 本のフロー、`project.yaml`、デスクトップでの通し確認 | **デスクトップで video_gen をフローとして運用** |
| V7 | `agent` ノード、組込みアクション、テンプレート | 7.1、8.2 の 7 アクション＋7.2 の 3 アクション、`mdium:` 参照、`dev-workflow` テンプレート（`mergeGate`）、`subflow.projectRoot` | 開発ワークフローをフローとして実行（試験的） |
| V8 | 改善ループ | `improve-app` テンプレート、`builtin:improve-analyze`、video_gen の `improve.flow.yaml`、実機で 1 反復 | **MDium が video_gen を改善するループ** |
| V9 | サーバと Web フロント | `flow-server`、HTTP トランスポート、`src/web/`、ロックファイル、ブラウザでの通し確認 | **ブラウザからの利用** |
| 後続 | 並列度（旧 4b）、重ね表示と実行履歴（旧 6）、旧エンジンの同等性と退役（旧 8.3）、ワーカーの切り離し、複数利用者化 | — | 必要になった時点で |

- V6 と V7 は独立しており、並行して進められる。V8 は V6・V7 の両方に依存する。
- V9 は V4 以降のどの時点でも着手できるが、V8 の後に置く（デスクトップで目標を達成してから）。

---

## 13. テスト方針

- Rust（`cargo test`、`flow-core`）:
  - `project.yaml` の解析・検証のゴールデンファイル（`src-tauri/tests/fixtures/projects/`）。`secrets` の不足、ランタイムのパス規則。
  - `python` ノード: 偽ワーカー（Rust のテストバイナリが JSON 行を話す）で、正常・`fail`・`needs_approval` → 承認／却下・`stopped`・入力検証の失敗・未知の `entry`・ワーカーの途中終了・`cancel` 後の猶予切れ・タイムアウト・再試行で新しいワーカーが起動すること。
  - 成果物: ルート外の拒否、`mediaType` の推定、`artifacts.json` の再開後の読み直し。
  - 組込みアクション: `flow-run-latest`（完了した最新だけを選ぶ）、`metrics-compare`（`higher` / `lower` / 同等 / 欠損）、`project-setup`（失敗で `FLOW_SETUP_FAILED`）。
  - `subflow.projectRoot`: worktree 以外の拒否、子の確認内容の不一致で承認待ちになること。
  - 関数化: 宣言していない戻り値の参照が `FLOW_OUTPUT_UNKNOWN`、`lib/` のフローが入口の一覧に出ないこと、抽出の署名推定（引数・戻り値の自動検出、名前の衝突）。
  - `FlowService` の呼び出しを Tauri を介さずテストする（サーバのハンドラと共通）。
- Python（pytest、`python/mdium-worker/`）: デコレータと登録、マニフェスト、入力検証、プロトコルの往復、`cancel` と `should_stop`、例外の `fail` への写像。
- video_gen（pytest）: 段階分解後も既存の `run_video_pipeline` テストが通ること。各段階の単体テストは既存の fake provider で行う。
- フロントエンド（vitest）: トランスポートの切り替えと import 検査、エディタの保存結果（YAML の往復で意味が変わらないこと、`ui.positions` の保存）、属性パネルのマニフェスト反映、成果物の種類判定と表示、承認ダイアログの `commentRequired`、サブフローの折りたたみ表示とドリルダウンのパンくず、抽出の結果（呼び出しノードの `params` と新ファイルの署名が一致すること）、実行パネルのツリーの集約（失敗数・費用）、ja/en の i18n キー一致。
- 実機:
  - V6: video_gen の 3 フローをデスクトップで通す（承認、`revise` の後退エッジ、停止と再開を含む）。
  - V8: `improve.flow.yaml` で 1 反復（提案 → 承認 → 開発ワークフロー → 検証 → 比較 → 採用／破棄）。
  - V9: ブラウザから同じ実行を通す（WebSocket の再接続、動画のシーク）。

---

## 14. リスク

| リスク | 影響 | 対策 |
|---|---|---|
| ワーカーが切り離されない | アプリ終了で長い段階（レンダ、TTS）が中断する | 段階の冪等性で再開に耐える。切り離しは後続（`supervise` の再利用）で検討 |
| `project.yaml` のインタプリタパスが環境依存（`.venv/Scripts` と `.venv/bin`） | 他 OS で動かない | `python` に OS ごとの候補（`.venv/Scripts/python.exe`, `.venv/bin/python`）を配列で書けるようにし、最初に存在するものを使う。初版は配列を認める |
| 改善ループの検証が高価（実 API を使う） | 1 反復で数ドル | `verify` の規模を小さくする引数、`budgetUsd` による承認待ち、`flow-run-latest` で基準は再実行しない |
| worktree での `uv sync` が遅い | 1 反復に数分追加 | 許容する。将来は `.venv` の共有を検討 |
| 外側のエージェントがフロー定義や `project.yaml` 自体を変更する | 確認済み内容と変わる | 7.3 の子フローの確認差分で承認待ちにする |
| Tauri 版とサーバの同時実行 | 実行ディレクトリの二重書き込み | 11.1 のロックファイル |
| アセットプロトコルのスコープと CSP | プレビューが真っ白 | 既知の確認手順（`frame-src` / `media-src` / `img-src`）を実装計画に含める |
| video_gen 側の段階分解で既存の挙動が変わる | 動画の品質・再開が壊れる | `run_video_pipeline` を段階関数の列として書き直し、既存テストを維持。段階ごとの `_mark` を保つ |

---

## 15. 決定事項（2026-10-10）

| # | 項目 | 決定 |
|---|---|---|
| 1 | Web 化の形 | 最初は単一利用者の自己ホスト。将来は複数利用者向けサービス。API に `projects/{projectId}` を最初から置く |
| 2 | 移行範囲 | メタオーケストレーション（観測・評価・計画・承認）を含む video_gen 全体。章単位は対象外 |
| 3 | Python との結合 | Python 資産を残し、`python` ノード（常駐ワーカー＋マニフェスト）で段階を一級のノードにする。`command` ノードは残す |
| 4 | Web UI | フロー機能だけの専用 Web フロント。mdium 全体の Web 化はしない |
| 5 | サーバ | Rust の `flow-core` クレートを共有する axum サーバ。まずデスクトップで目標を達成してから着手する |
| 6 | 捉え直し | 「プロジェクトの可搬化」と「外側の改善ループ」を基盤の目的とし、video_gen と開発ワークフローをその実証にする |
| 7 | 順序 | V1〜V9（12 章）。改善ループ（V7・V8）を Web 化（V9）より先にする |
| 8 | フローの関数化 | サブフローを関数として扱い、署名の検証・部品ライブラリ・折りたたみとドリルダウン・抽出を入れる。1 フローは十数ノードまでを目安にし、超えたら部品に分ける（16 章） |

---

## 16. フローの関数化

全体のフローが大きくなると把握できなくなるため、サブフローを**関数**として扱い、分割して読む・書く・実行結果を見るための仕組みを揃える。

### 16.1 署名

- サブフロー（およびループのファイル本体）の `params` が引数、`outputs` が戻り値、`description` が説明。これらを**署名**と呼び、呼び出しノードの表示と検証に使う。
- `outputs` は宣言が必要になる。呼び出し側の `nodes.<sub>.outputs.<key>` は、呼び先の `outputs` に `<key>` が無ければ検証エラー `FLOW_OUTPUT_UNKNOWN`（既存の引数の検証 `FLOW_PARAM_MISMATCH` と対）。`nodes.<sub>.outputs`（オブジェクト全体）の参照は従来どおり可。
- `params` の型の不一致（例: `number` に真偽を渡す）は、テンプレートを含まない定数の場合のみ検証で見る（`FLOW_PARAM_TYPE`）。テンプレートを含む場合は実行時に見る（既存の `FLOW_CONDITION_TYPE` と同じ扱いでノードを `failed`）。
- 署名の変更（引数の追加・削除、戻り値の削除）は、呼び出し側の検証エラーとして現れる。エディタは部品を保存するとき、同じプロジェクト内の呼び出し元を再検証して一覧に出す。

### 16.2 ライブラリと一覧

- `.mdium/flows/lib/**/*.flow.yaml` を**部品**とする。部品は他のフローから参照されるためのもので、実行の入口には出さない（実行開始ダイアログの対象外。直接実行したい場合は入口のフローから呼ぶ）。
- フロー一覧は 3 群に分ける: **入口**（`lib/` 外のフロー。`project.yaml` の `flows` の役割名を付けて表示）、**部品**（`lib/`）、**テンプレート**（`mdium:`。コピーして使う）。
- 参照の規則は変えない: パス参照はプロジェクトルート内に限る。プロジェクト横断の部品は初版では `mdium:` テンプレートだけ。
- 部品の一覧には署名（引数と戻り値）を表示し、ドラッグでキャンバスに `subflow` ノードとして置ける。

### 16.3 エディタ

- **折りたたみ表示**: `subflow` ノードと、ファイル本体を持つ `loop` ノードは、名前・引数の対応・戻り値のキーを 1 枚のカードに表示する。中身は描かない。
- **ドリルダウン**: ダブルクリックで参照先のフローを開く。パンくず（`production-cycle › videos[3] › video › produce`）で戻る。閲覧中に実行結果があれば、その周回・反復の状態を重ねる（16.4 の実行パネルと同じデータ）。
- **抽出**: 選択したノード群を「サブフローに抽出」する。
  - 選択の外から参照している値（`params.*`、`nodes.<外>.outputs.*`、`item` など）を引数に、選択の外から参照されている出力を戻り値にして署名を自動で作る。名前は参照元のキーから付け、衝突すれば連番を付ける。
  - 選択に入るエッジが複数のノードに向かう、または選択から出るエッジが複数の出口を持つ場合は抽出できない（理由を表示する）。選択内で閉じる後退エッジは一緒に移す。
  - 新しいファイルを `lib/<name>.flow.yaml` に保存し、選択を 1 つの `subflow` ノードに置き換える。元のファイルと新しいファイルの両方を検証し、エラーがあれば操作を取り消す。
- **逆操作（インライン展開）** は対象外。
- 部品のファイルを開いたときは、署名を編集するフォーム（`params` / `outputs`）を先頭に出す。

### 16.4 実行パネル

- ノード一覧を、サブフローとループの反復を親とする**ツリー**にする（`nodeKey` のスコープがそのまま階層になる）。
- 親の行に子の状態を集約して表示する: 実行中の数、失敗の数、承認待ちの数、費用の合計、最新の進捗テキスト。
- 既定では親を折りたたみ、実行中・失敗・承認待ちを含む親だけを自動で展開する。
- 承認待ちの行をクリックすると、その承認ダイアログを開く（階層の深さに関係なく）。

### 16.5 粒度の目安とテンプレートの分割

- 1 つのフローファイルは**十数ノード**までを目安にする。超えたら 16.3 の抽出で部品に分ける。
- video_gen は入口 2 本（`production-cycle`、`improve`）と部品 4 本（`story-run`、`video`、`video-assets`、`video-review`）にする（9.1、9.3）。
- `improve-app` テンプレートも部品を持つ: `lib/improve-propose.flow.yaml`（`baseline` → `analyze` → `approve_proposal`、戻り値 `proposalPath` / `baseline`）と `lib/improve-verify.flow.yaml`（`setup` → `verify` → `compare`、戻り値 `improved` / `report` / `candidate`）。入口の `improve.flow.yaml` は提案 → 開発 → 検証 → 採用の 4〜6 ノードになる。8.2 の一覧は意味を示すための展開形で、テンプレートの実体はこの分割形とする。
- `dev-workflow` テンプレートは既存の 1 ファイルのまま（8.1 の構造はそのままで、約 20 ノード。分割は旧エンジンの同等性の確認後に検討する）。

### 16.6 ループ本体

- パレットから追加する `loop` の本体は**ファイル参照**にする（部品を選ぶか、新しい部品を作る）。インラインの `body` は YAML 側でのみ書け、キャンバスでは展開表示のみ（6 章）。
- 実行時の意味は変えない（インラインは外側のスコープを参照でき、ファイル参照は `params` だけを受け取る。2026-10-06 仕様 2.5）。

---

## 外部前提

- video_gen: Python 3.12、`uv`、`ffmpeg`、各 API キー（`GOOGLE_API_KEY` 等）、`claude` CLI または Claude Agent SDK の認証
- MDium: 既存のエージェントランナーの前提（Node.js 20 以上、各プロバイダーの CLI と認証）、git
- `mdium-worker` は video_gen の環境に path 参照でインストールする（両リポジトリが同じマシンにある前提。配布形態は対象外）

## 対象外

- 複数利用者化の実装（認可、プロジェクト一覧、課金）。前提だけ残す
- ワーカーの切り離しと再接続
- 並列度、重ね表示、旧エンジンの退役（2026-10-06 仕様の該当 PR のまま後続）
- `mdium-worker` の PyPI 公開、Python 以外のランタイム（Node など）
- 章単位のノード化、Gradio UI の置き換え
- 改善ループの自動採用（人の承認なしでのマージ）
- push、PR / MR 作成、リモートでのマージ（既存と同じ）
