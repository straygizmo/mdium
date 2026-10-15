# Excel マクロ編集の専用チャット化 設計仕様

- 日付: 2026-10-15
- 対象: `.xlsm` / `.xlam` の VBA マクロを LLM に編集させる機能を、「マクロ入りファイルを開くと専用チャットが出て、そこで指示するだけ」で動く形に作り替える
- 参考: [xlflow](https://github.com/harumiWeb/xlflow) の `pull` / `push` がファイルパス指定で完結し、スキルが CLI に同梱されてエージェントが自走する点を取り入れる。xlflow の Excel COM 連携(`run` / `test` / `lint`)は対象外

---

## 0. 背景と目的

### 現状の流れ

1. `.xlsm` を開き、プレビューの「マクロを書き出し」を押す → `<名前>_assets/macros/` に `.bas` / `.cls` を展開
2. opencode 設定 → Skills で組み込みスキル `vba-coding-conventions` と `vba-mdium-flow` を手動で追加
3. プレビューの「LLM 自動取り込みを許可」トグルを ON(アクティブタブに縛られた `mdium-vba` MCP サーバーを opencode に登録)
4. 左パネルのチャットで指示 → LLM が編集 → MCP 経由で取り込み、または「マクロを取り込み」ボタン

### 現状の問題

- 手順が多く、トグルと MCP の存在を利用者が意識する必要がある
- UI の書き出し / 取り込みは `<名前>_assets/macros/` を使うが、`list_vba_modules` と MCP サーバーは `<名前>_macros/` を見ており、LLM 経路では「展開済みなのに未展開と判定」「取り込み先フォルダが無い」となる
- MCP サーバーに渡す port / token は MDium 起動ごとに変わるため、トグル ON のままでは起動のたびに opencode 設定を書き換える必要がある
- 取り込みは既存モジュールの差し替えのみで、モジュールの追加・削除は Excel の VBE で手動対応になる
- Excel で開いたままのブックに書き戻すと OS のエラーになるだけで、事前に気付けない

### 目的

- マクロ入りファイルを開くと、そのファイル専用のチャットが現れ、利用者は変更内容を書くだけで LLM が展開 → 編集 → 書き戻しまで行う
- ツールとスキルは MDium が自動で導入し、トグルや MCP 設定、パスの入力は不要にする
- ブックが Excel で開かれていれば、閉じるよう警告する
- 標準モジュールとクラスモジュールの追加・削除を書き戻しで扱う

### 対象外

- VBA の実行、Excel COM 連携、テスト実行
- ユーザーフォーム(`.frm` / `.frx`)の追加・削除・編集
- ドキュメントモジュール(ThisWorkbook・シート)の追加・削除(編集は可)
- `.xlsx` → `.xlsm` の変換、パスワード保護の解除
- opencode 以外のチャット(Claude パネル、AGENT CHAT)からの利用
- チャット接続の複数化(現行の単一セッション構造は維持する。6.5 参照)

---

## 1. 用語

| 用語 | 識別子 | 定義 |
|---|---|---|
| ブック | `xlsm_path` | `.xlsm` または `.xlam` の絶対パス |
| マクロフォルダ | `macros_dir` | ブックと同じ階層の `<名前>_assets/macros/`。`.bas` / `.cls` / `.codepage` を置く |
| マクロチャット | `macro-chat` | ブック 1 つに紐づく専用チャット画面(タブ内の右ペイン) |
| pull | `vba_pull` | ブックからマクロフォルダへ展開する(既存ファイルは上書き) |
| push | `vba_push` | マクロフォルダの内容をブックへ反映する(更新・追加・削除) |
| 標準モジュール | `standard` | `.bas`。追加・削除可 |
| クラスモジュール | `class` | `.cls`。追加・削除可 |
| ドキュメントモジュール | `document` | `.cls`。ThisWorkbook とシート。編集のみ |

---

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│ opencode (LLM)                                              │
│  ~/.config/opencode/tools/vba_list.ts / vba_pull.ts /       │
│  vba_push.ts  ← MDium が接続時に自動インストール             │
│  ~/.config/opencode/skills/vba-coding-conventions/SKILL.md  │
│  ~/.config/opencode/skills/vba-mdium-flow/SKILL.md          │
│                      │ HTTP (127.0.0.1:port, Bearer token)   │
│                      │ port/token は ~/.config/opencode/     │
│                      │ .mdium-bridge.json(接続ごとに更新済み)│
└──────────────────────┼──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ MDium (Tauri)                                               │
│  http_bridge.rs                                             │
│    POST /vba/list  {xlsm_path}                              │
│    POST /vba/pull  {xlsm_path}                              │
│    POST /vba/push  {xlsm_path}  → 成功時 emit("vba-pushed") │
│         │                                                   │
│  commands/vba.rs                                            │
│    list_vba_modules / pull_vba_modules / push_vba_modules   │
│    check_workbook_lock                                      │
│         ▲                                                   │
│  xlsm / xlam タブ(PreviewPanel)                             │
│   ┌──────────────────────┬──────────────────────────────┐   │
│   │ 変換バー             │ マクロチャット ヘッダ        │   │
│   │ [Markdown 変換]      │  Book1.xlsm  [新しいチャット] │   │
│   │ [書き出し][取り込み] │  ⚠ Excel で開かれています     │   │
│   │                      │  Module1 / ThisWorkbook / …   │   │
│   │ シートプレビュー     ├──────────────────────────────┤   │
│   │                      │ メッセージ一覧 / 質問カード   │   │
│   │                      │ 入力欄                        │   │
│   └──────────────────────┴──────────────────────────────┘   │
│   送信文の先頭に <mdium_context active_file=ブック> を付与   │
└─────────────────────────────────────────────────────────────┘
```

廃止する構成要素:

- `resources/mcp-servers/mdium-vba/`(Node MCP サーバー)
- `builtin-mcp-servers.ts` の `mdium-vba` 項目と `resolveMdiumVbaMcpServer`
- `useOpencodeChat.ts` の `syncMdiumVbaMcpConfig`
- `commands/active_xlsm.rs` の `ActiveXlsmState`、`set_active_xlsm_path`、`get_active_xlsm_path`(`get_http_bridge_info` は残す)
- `http_bridge.rs` の `check_active_tab`、`GET /active-xlsm`、`POST /vba/extract`、`POST /vba/inject`
- `settings-store.ts` の `allowLlmVbaImport` と `setAllowLlmVbaImport`
- PreviewPanel の「LLM 自動取り込みを許可」トグル
- `module_set_changed` エラーと i18n キー `macroModuleSetChanged`、`macroImportSkipped`

---

## 3. ツール契約(opencode カスタムツール)

### 3.1 ファイルと導入

- `.opencode/tools/vba_list.ts`、`vba_pull.ts`、`vba_push.ts` をリポジトリに置き、`builtin-registry.ts` が `?raw` で取り込んで `BUILTIN_CUSTOM_TOOLS` に登録する(`rag_search` と同じ)
- 各ファイルの 1 行目に `// mdium-tool-version: N` を置く
- `useOpencodeChat.ts` の `ensureBuiltinAgents` を `ensureBuiltinFiles` に改名し、自動インストール対象を `rag_search`、`folder_glob`、`folder_grep`、`vba_list`、`vba_pull`、`vba_push` にする。導入規則は次のとおり
  - ファイルが無い → 書く
  - ファイルがあり、`mdium-tool-version` が組み込みと異なる → 上書き
  - ファイルがあり、マーカーが無い(利用者が自作したもの) → 触らない
- 既存の rag ツール 3 本にも同じマーカーを付け、同じ規則で更新する

### 3.2 共通仕様

- 引数 `xlsm_path`(文字列、必須)。LLM は `<mdium_context>` の `active_file` か利用者の指示から得る。相対パスは開いているフォルダ基準でブリッジが解決する
- ブリッジ情報は `~/.config/opencode/.mdium-bridge.json` から読む(既存の `readBridgeInfo` と同じ)
- 応答はブリッジの JSON をそのまま整形して文字列で返す。失敗時はブリッジの `message` を文章で返す
- ブリッジに届かない場合は「MDium を開いて、このフォルダで opencode に接続してください」を返す

### 3.3 各ツール

| ツール | 説明(LLM 向け、英語で記述) | ブリッジ |
|---|---|---|
| `vba_list` | ブックのモジュール一覧とマクロフォルダの状態を返す。書き込みなし | `POST /vba/list` |
| `vba_pull` | ブックのモジュールをマクロフォルダへ展開する。既存ファイルは上書き | `POST /vba/pull` |
| `vba_push` | マクロフォルダの `.bas` / `.cls` をブックへ反映する。更新・追加・削除を行い、`.bak` を作る。ブックが Excel で開かれていれば拒否 | `POST /vba/push` |

### 3.4 ブリッジのリクエストと応答

リクエストは 3 つとも `{ "xlsm_path": string }` のみ。マクロフォルダは Rust 側で導出し、呼び出し側は指定できない。

`/vba/list` 200:

```json
{
  "xlsmPath": "C:/work/Book1.xlsm",
  "macrosDir": "C:/work/Book1_assets/macros",
  "extracted": true,
  "locked": false,
  "modules": [
    { "name": "Module1", "moduleType": "standard", "path": "C:/work/Book1_assets/macros/Module1.bas" },
    { "name": "ThisWorkbook", "moduleType": "document", "path": null }
  ]
}
```

`path` はマクロフォルダに対応ファイルがあるときだけ入る。`locked` は 4.9 の判定結果。

`/vba/pull` 200: `{ xlsmPath, macrosDir, modules: [{ name, moduleType, path }] }`(`path` は常に入る)

`/vba/push` 200:

```json
{
  "xlsmPath": "C:/work/Book1.xlsm",
  "backupPath": "C:/work/Book1.xlsm.bak",
  "updated": ["Module1"],
  "unchanged": ["ThisWorkbook", "Sheet1"],
  "added": ["Helpers"],
  "removed": ["OldModule"],
  "skipped": [{ "name": "Sheet2", "reason": "document module file is missing; document modules are never removed" }]
}
```

エラー応答は `{ "error": <コード>, "message": <文章> }`。コードと HTTP 状態は 8 章。

---

## 4. Rust 側

### 4.1 コマンドの整理

| 旧 | 新 | 備考 |
|---|---|---|
| `extract_vba_modules(xlsm_path)` | `pull_vba_modules(xlsm_path)` | 戻り値に `xlsm_path` を追加 |
| `inject_vba_modules(xlsm_path, macros_dir)` | `push_vba_modules(xlsm_path)` | `macros_dir` 引数を廃止。追加・削除対応。ロック時は拒否 |
| `list_vba_modules(xlsm_path)` | 同名 | マクロフォルダを `<名前>_assets/macros/` に統一。`exists` → `extracted`。`locked` を追加 |
| (新規) | `check_workbook_lock(xlsm_path)` | 4.9 |

マクロフォルダの導出関数 `macros_dir_for(xlsm_path)` を 1 つ置き、3 コマンドとブリッジがそれを使う。

### 4.2 モジュール種別の確定

`/PROJECT` ストリーム(コードページ文字列、CRLF 区切り)の行で種別を決める。

| 行 | 種別 |
|---|---|
| `Document=<名前>/&H...` | `document` |
| `Module=<名前>` | `standard` |
| `Class=<名前>` | `class` |
| `BaseClass=<名前>` | ユーザーフォーム。pull で展開せず、push でも触らない |

`/PROJECT` に無い名前は `dir` の MODULETYPE で補う(0x0021 → `standard`、0x0022 かつ名前が `ThisWorkbook` または `Sheet` 始まり → `document`、それ以外 → `class`)。現在の「名前が Sheet で始まるか」だけの判定はこの補助用途に下げる。

### 4.3 `dir` ストリームのレコードモデル

`parse_dir_stream` を「レコード列への分解」と「モジュール情報の解釈」に分ける。

```rust
struct DirRecord { id: u16, data: Vec<u8> }          // 生のレコード
struct DirStream { records: Vec<DirRecord> }         // PROJECTVERSION の MinorVersion 2 バイトは data に含めて保持
```

- `DirStream::parse(bytes)` と `DirStream::serialize() -> Vec<u8>` を用意し、変更なしなら入力と同一バイト列を返す
- 未知のレコードはそのまま保持する
- モジュール境界は MODULENAME(0x0019)から MODULETERMINATOR(0x002B)まで。`modules()` でこの範囲を名前付きで列挙し、`remove_module(name)` / `append_module(records)` / `set_module_count(n)` を提供する
- `PROJECTMODULES`(0x000F、2 バイト)の値をモジュール数に合わせる

新規モジュールのレコード列(MS-OVBA 2.3.4.2.3.2 の順):

| レコード | id | 内容 |
|---|---|---|
| MODULENAME | 0x0019 | コードページ文字列 |
| MODULENAMEUNICODE | 0x0047 | UTF-16LE |
| MODULESTREAMNAME | 0x001A | コードページ文字列(名前と同じ) |
| MODULESTREAMNAMEUNICODE | 0x0032 | UTF-16LE |
| MODULEDOCSTRING | 0x001C | 空 |
| MODULEDOCSTRINGUNICODE | 0x0048 | 空 |
| MODULEOFFSET | 0x0031 | `0`(PerformanceCache なし) |
| MODULEHELPCONTEXT | 0x001E | `0` |
| MODULECOOKIE | 0x002C | `0xFFFF` |
| MODULETYPE | 0x0021(標準)/ 0x0022(クラス) | サイズ 0 |
| MODULETERMINATOR | 0x002B | サイズ 0 |

### 4.4 `/PROJECT` と `/PROJECTwm` の更新

- `/PROJECT`: 追加時は既存の `Document=` / `Module=` / `Class=` / `BaseClass=` 行の最後の直後に `Module=<名前>` または `Class=<名前>` を挿入する。削除時は該当行を除く。その他の行は保持し、コードページで再エンコードする
- `/PROJECTwm`: `<名前(コードページ)>\0<名前(UTF-16LE)>\0\0` の並びで、末尾は `\0\0`。追加時は末尾の終端の前に追記、削除時は該当項目を除く。ストリームが無い場合は作る

### 4.5 push のアルゴリズム

1. ブックの存在と拡張子を確認し、マクロフォルダを導出する。フォルダが無ければエラー
2. 4.9 のロック判定。開かれていれば `workbook_locked` で終了(ブック未変更)
3. `.codepage` を読む(無ければ `dir` の PROJECTCODEPAGE)
4. ZIP から `xl/vbaProject.bin` を読み、`/VBA/dir`、`/PROJECT`、`/PROJECTwm` を解釈して既存モジュール集合 M(名前、種別、ストリーム名、オフセット)を得る
5. マクロフォルダの `.bas` / `.cls` を列挙してファイル集合 F を得る(名前はファイル名の拡張子抜き)。`.bas` と `.cls` で同じ名前があればエラー
6. 計画を立てる(この時点ではブックに書かない)
   - 更新: F∩M。ファイル内容を正規化(4.6)し、ストリームの既存ソースをデコードした結果と一致すれば `unchanged`、違えば `updated`。ユーザーフォームに対応するファイルがあっても更新せず `skipped`
   - 追加: F−M。名前を検証(4.7)。`.bas` → `standard`、`.cls` → `class`。名前が ThisWorkbook またはユーザーフォーム名と一致すればエラー
   - 削除: M−F のうち `standard` と `class`。`document` とユーザーフォームは `skipped`
7. 追加・更新するソースはすべてコードページへエンコードする。変換できない文字があればモジュール名・行番号・文字を示してエラー
8. ここまで成功したら `<ブック>.bak` にコピーする(既存は上書き)
9. 書き込み
   - 更新: 現行どおり PerformanceCache(`text_offset` バイト)を残し、後続の圧縮ソースを差し替える
   - 追加: `/VBA/<名前>` に圧縮ソースのみ書き、`dir` にレコード列を追加、`/PROJECT` と `/PROJECTwm` に追記
   - 削除: `/VBA/<ストリーム名>` を除去、`dir` のレコード範囲を除去、`/PROJECT` と `/PROJECTwm` から除去
   - `PROJECTMODULES` を更新して `dir` を再直列化・圧縮して書く
10. 現行どおり `/VBA/_VBA_PROJECT` を 7 バイトヘッダのみにし、`/VBA/__SRP_*` を除去する
11. ZIP 内の `xl/vbaProject.bin` を置換してブックを上書きする
12. 結果(`updated` / `unchanged` / `added` / `removed` / `skipped`、`backupPath`)を返す

### 4.6 ソースの正規化

push 時に各ファイルへ次を適用してからエンコードする。

- 改行を CRLF に揃える
- 先頭の `VERSION 1.0 CLASS` … `END` ブロック(VBE のエクスポート形式)があれば除去する。`vbaProject.bin` 内のソースにはこのブロックは含まれないため
- `Attribute VB_Name = "<名前>"` をファイル名に合わせる(既存の `fix_vb_name`)。無ければ先頭に挿入する
- クラスモジュールで次の属性行が無ければ `VB_Name` の直後に補う: `VB_GlobalNameSpace = False`、`VB_Creatable = False`、`VB_PredeclaredId = False`、`VB_Exposed = False`

pull 時の出力は現行どおり(ストリームのソースをそのまま UTF-8 で書く)。

### 4.7 モジュール名の検証

追加するモジュール名は次を満たす。違反は push 全体のエラー。

- 1 文字目が英字、以降は英字・数字・`_`(ASCII のみ)
- 31 文字以内
- 大文字小文字を無視して既存モジュールと重複しない
- VBA の予約語と一致しない。予約語は MS-VBAL 3.3.5.2 の一覧(`If`、`Sub`、`Class`、`Attribute` など)を Rust 側に定数として持つ

### 4.8 PerformanceCache なしの新規モジュールについて

新規モジュールは `MODULEOFFSET = 0` で圧縮ソースのみを持つ。MS-OVBA 2.3.4.3 は PerformanceCache を「読み手は無視しなければならない」と定めており、プロジェクト全体のキャッシュも 4.5 の 10 で無効化するため Excel は開く際に再コンパイルする。これは仕様上の根拠であり、最終確認は 9 章の実機テストで行う。

### 4.9 ロック判定(`check_workbook_lock`)

ブックが Excel で開かれているかを 2 段で判定し、`{ locked: bool, reason: "owner_file" | "write_denied" | null }` を返す。

1. 同じ階層に Excel のオーナーファイル `~$<ファイル名>`(隠し属性)があれば `owner_file`
2. 無ければ、書き込みモード(`OpenOptions::new().write(true)`、Windows では共有モード既定)で開いてみて、失敗すれば `write_denied`(開けたら何も書かずに閉じる)

どちらにも当たらなければ `locked: false`。`list_vba_modules` の `locked` と `push_vba_modules` の事前判定、マクロチャットの警告がこれを使う。

---

## 5. スキル

### 5.1 自動導入

- 対象: `vba-coding-conventions`(内容は現行のまま)と `vba-mdium-flow`(5.2 で書き直し)
- `builtin-skills.ts` の各項目に `version: N` を追加し、SKILL.md の frontmatter に `mdium-skill-version: N` として書く
- `ensureBuiltinFiles` が接続時に `~/.config/opencode/skills/<名前>/SKILL.md` を確認する
  - 無い → 書く
  - あり、`mdium-skill-version` が異なる → 上書き
  - あり、マーカーが無い → 触らない
  - `SKILL.md.disabled` がある(利用者が無効化した) → 触らない
- SKILL.md の組み立ては `SkillsSection.tsx` の `buildSkillMd` を `builtin-registry.ts` に移して共用する
- Skills 設定画面の「組み込みを追加」は残す(導入済みなら候補に出ないだけ)

### 5.2 `vba-mdium-flow` の内容(英語で記述)

骨子:

1. 対象ブックの決め方: 直前のメッセージの `<mdium_context>` の `active_file`(`.xlsm` / `.xlam` のときだけ付く)。無ければ利用者の指示にあるパス。どちらも無ければ利用者に聞く。利用者にパスを入力させない
2. 標準フロー: `vba_list` → マクロフォルダが未展開なら `vba_pull` → Read/Edit で `.bas` / `.cls` を編集 → 編集が終わったら必ず `vba_push` → `updated` / `added` / `removed` / `skipped` と `backupPath` を報告
3. 展開済みのフォルダがある場合は、ブックの方が新しい可能性を利用者に確認してから `vba_pull` で上書きする
4. `vba_list` や `vba_push` が `locked` / `workbook_locked` を返したら、Excel でブックを閉じるよう利用者に伝え、閉じたと言われてから `vba_push` を再実行する。展開と編集はロック中でも進めてよい
5. モジュールの追加・削除: 標準(`.bas`)とクラス(`.cls`)は新規ファイルを作れば push で追加される。削除は利用者が明示したときだけファイルを消す。ThisWorkbook とシートのファイルは消さない(消しても push は無視して `skipped` に出る)
6. ファイルは UTF-8。`.cls` に `VERSION 1.0 CLASS` ヘッダは書かない(push が除去する)。`Attribute VB_Name` はファイル名と一致させる
7. 文字コード変換で失敗した文字はエラーになるので、代替表現を提案して再 push する
8. MDium は Excel を起動しない。動作確認は利用者に依頼し、`.bak` からの復元手順を伝える
9. `vba-coding-conventions` を必ず併読する

### 5.3 `<mdium_context>` の供給元

`wrapWithMdiumContext` は現在 Rust の `get_active_xlsm_path` を呼ぶ。これを `useTabStore` のアクティブタブから取るように変え、拡張子が `.xlsm` / `.xlam` のときだけ付ける(付く条件は現行と同じ)。マクロチャットから送る場合、アクティブタブはそのブックなので `active_file` が必ずブックになる。

---

## 6. UI: 専用マクロチャット

### 6.1 配置

- `.xlsm` / `.xlam` のタブを開くと、タブの中身が左右分割になる
  - 左: 既存の変換バー(Markdown 変換、マクロを書き出し、マクロを取り込み)とシートプレビュー(`OfficePreview`)
  - 右: マクロチャット(`MacroChatPane`)
- 境界は `useDividerDrag` でドラッグでき、比率は `ui-store`(永続化)の `macroChatSplitRatio` に保存する。初期値は 50
- 「LLM 自動取り込みを許可」トグルは削除する。他の Office ファイル(`.xlsx` / `.docx` / `.pdf`)の表示は変えない

### 6.2 マクロチャットのヘッダ

| 要素 | 内容 |
|---|---|
| ファイル名 | タブのファイル名 |
| ロック警告 | 6.4 |
| モジュール一覧 | `list_vba_modules` の結果。名前と種別、展開済みならその印。pull / push の後と `vba-pushed` 受信時に更新 |
| 新しいチャット | 6.3 の紐づけを解除して新規セッションにする |

### 6.3 セッションの紐づけ

- 永続化ストア `macro-chat-store` に `sessionByWorkbook: Record<ブックのパス, セッション ID>` を持つ
- タブがアクティブになったとき(マウント時とタブ切替時):
  1. `doConnect(開いているフォルダ)`
  2. 紐づくセッション ID があれば `doLoadSession(id)`。読み込みに失敗(削除済み等)したら紐づけを消して 3 へ
  3. 無ければ `doCreateNewSession()`
- 初回送信で opencode がセッションを作るので、ペインが表示されている間 `currentSessionId` の変化を監視し、紐づけに記録する
- 「新しいチャット」は紐づけを消して `doCreateNewSession()` する
- フォルダが開かれていない場合はペインに「フォルダを開いてください」を表示し、入力欄を無効にする(既存チャットと同じ前提)

### 6.4 Excel で開いている警告

- ペインの表示時、タブ切替時、送信直前に `check_workbook_lock` を呼ぶ
- `locked` なら入力欄の上にバナー「Excel で開かれています。閉じてから編集してください」と「再確認」ボタンを出し、バナー表示中は 5 秒ごとに自動で再確認する。解除されたらバナーを消す
- 送信はロック中でも許可する(LLM は展開と編集を進められ、push だけが 8 章の `workbook_locked` で止まる)
- 左ペインの「マクロを取り込み」ボタンもロック中は無効にし、同じ文言をツールチップに出す

### 6.5 チャット本体と共用部品

- `OpencodeChat.tsx` から、メッセージ一覧・ツール表示・質問カード・入力欄(補完、履歴、画像添付、Undo/Redo を含む)を `OpencodeChatView` に切り出す。`OpencodeChat` はそれに既存の toolbar(新規・履歴・エージェント選択・接続バッジ)を付けたもの、`MacroChatPane` は 6.2 のヘッダを付けたものになる
- `MacroChatPane` では toolbar を出さず、エージェントは `build` 固定(`selectedAgent` を `null` にして既定にする)
- 入力欄のプレースホルダは `macroChatPlaceholder`
- **既知の性質:** チャット接続とセッションは 1 本(`useOpencodeChat` のモジュール単位の状態)なので、マクロチャットを使っている間、左パネルの opencode チャットも同じセッションを表示する。別のタブに移っても左パネルのセッションは切り替わらず、ブックのタブに戻ると紐づくセッションに戻る。接続の複数化は対象外

### 6.6 push 後の更新

- Rust の `push_vba_modules` 成功時(ブリッジ経由でもボタン経由でも)に `app.emit("vba-pushed", { path })` する
- PreviewPanel はこのイベントを購読し、アクティブタブのパスと一致すれば `read_binary_file` で `binaryData` を読み直し、`onRefreshFileTree` を呼ぶ(`.bak` と `_assets` を反映)。`MacroChatPane` はモジュール一覧を更新する

### 6.7 i18n キーの変更(`editor` 名前空間、ja / en)

追加:

| キー | ja | en |
|---|---|---|
| `macroChatTitle` | マクロ編集 | Macro editing |
| `macroChatNewChat` | 新しいチャット | New chat |
| `macroChatModules` | モジュール | Modules |
| `macroChatExtracted` | 展開済み | Extracted |
| `macroChatPlaceholder` | このブックのマクロへの変更内容を書いてください | Describe the change you want in this workbook's macros |
| `macroChatNeedsFolder` | フォルダを開くとマクロチャットを使えます | Open a folder to use the macro chat |
| `workbookLocked` | Excel で開かれています。閉じてから編集してください | This workbook is open in Excel. Close it before editing |
| `workbookLockRecheck` | 再確認 | Check again |
| `macroPushSuccess` | 更新 {{updated}} / 追加 {{added}} / 削除 {{removed}}(バックアップ: .bak) | Updated {{updated}} / added {{added}} / removed {{removed}} (backup: .bak) |

削除: `allowLlmVbaImport`、`allowLlmVbaImportHint`、`macroModuleSetChanged`、`macroImportSkipped`、`macroImportSuccess`

### 6.8 設定ストア

`allowLlmVbaImport` と `setAllowLlmVbaImport` を削除し、`partialize` からも外す。保存済みの古い値は無視される。

### 6.9 ドキュメント

- `docs/builtin-skills.ja.md`: `vba-mdium-flow` の節を 5.2 の内容に合わせて書き直す
- `README.md` / `README.ja.md`: 機能行を「Excel VBA マクロの専用チャット編集(.xlsm / .xlam、展開・書き戻し・モジュールの追加・削除)」に更新する
- 旧 MCP サーバーの記述(`mdium-vba`、「LLM 自動取り込みを許可」)は削除する

---

## 7. データフロー例

### ブックを開いて指示する

```
[利用者] ファイルツリーで Book1.xlsm をクリック
[MDium]  タブが「シートプレビュー | マクロチャット」に分かれる。
         check_workbook_lock → locked: false。list_vba_modules → Module1 / ThisWorkbook / Sheet1(未展開)
         紐づくセッション無し → 新規セッション
[利用者] 「Module1 の Hello に名前引数を足して、Helpers モジュールを新設して」
[MDium]  <mdium_context> active_file="C:/work/Book1.xlsm" を先頭に付けて送信
[LLM]    vba_list({ xlsm_path: "C:/work/Book1.xlsm" }) → extracted: false
[LLM]    vba_pull → Module1.bas を編集 → Helpers.bas を作成 → vba_push
[ツール] { updated: ["Module1"], added: ["Helpers"], removed: [], backupPath: "...Book1.xlsm.bak" }
[MDium]  "vba-pushed" でプレビューとモジュール一覧を更新
[LLM]    「Module1 を更新し Helpers を追加しました。バックアップは Book1.xlsm.bak です。Excel で動作確認してください」
```

### Excel で開いたまま指示した

```
[利用者] Excel で Book1.xlsm を開いたまま、タブをアクティブにする
[MDium]  check_workbook_lock → locked: true (owner_file) → バナー「Excel で開かれています…」
[利用者] 「Sheet1 のイベントを直して」(送信は可)
[LLM]    vba_list → locked: true。vba_pull → 編集 → vba_push → 400 workbook_locked
[LLM]    「編集はできましたが、Excel で開かれているため書き戻せません。閉じたら教えてください」
[利用者] Excel を閉じる → バナーが自動で消える → 「閉じた」
[LLM]    vba_push → 成功
```

### 後日タブを開き直す

```
[利用者] Book1.xlsm のタブをアクティブにする
[MDium]  紐づくセッション ID あり → doLoadSession → 前回の会話が表示される
```

---

## 8. エラー処理

| 状況 | 検出箇所 | HTTP | `error` | 振る舞い |
|---|---|---|---|---|
| ブリッジ未起動・サイドカー無し | ツール | — | — | 「MDium を開いて接続してください」を返す |
| JSON 不正 | ブリッジ | 400 | `invalid_json` | |
| 相対パスでフォルダ未オープン | ブリッジ | 400 | `no_active_folder` | |
| ファイル無し / 拡張子が `.xlsm` `.xlam` 以外 | Rust | 400 | `invalid_workbook` | |
| `xl/vbaProject.bin` 無し | Rust | 400 | `no_vba_project` | 「このファイルにはマクロがありません」 |
| マクロフォルダ無し(push) | Rust | 400 | `macros_dir_not_found` | 「先に vba_pull してください」 |
| ブックが Excel で開かれている(push 前判定) | Rust | 409 | `workbook_locked` | 「Excel で閉じてから再実行」。ブックも `.bak` も未変更 |
| `.bas` と `.cls` に同名 | Rust | 400 | `duplicate_module_file` | |
| モジュール名が規則違反・重複・予約語 | Rust | 400 | `invalid_module_name` | 名前と理由を列挙。ブック未変更 |
| ドキュメント名・フォーム名の新規ファイル | Rust | 400 | `invalid_module_name` | 同上 |
| コードページに変換できない文字 | Rust | 400 | `unencodable_character` | モジュール名・行番号・文字を示す。ブック未変更 |
| 書き込み中に失敗(判定をすり抜けたロック等) | Rust | 500 | `push_failed` | `.bak` は作成済みなので残し、復元手順をメッセージに含める |
| その他の I/O・パース失敗 | Rust | 500 | `pull_failed` / `list_failed` | メッセージをそのまま返す |
| チャット: 紐づくセッションの読み込み失敗 | フロント | — | — | 紐づけを消して新規セッション |
| チャット: `check_workbook_lock` 自体の失敗 | フロント | — | — | 警告を出さず、push 側の判定に任せる |

原則: 書き込み前の検証(4.5 の 1 〜 7)で失敗した場合はブックも `.bak` も変更しない。

---

## 9. テスト

### Rust 単体(`vba.rs`)

- `DirStream::parse` → `serialize` が合成した `dir` バイト列と同一になる(PROJECTVERSION の特殊サイズを含む)
- `append_module` 後のレコード列と `PROJECTMODULES` の値
- `remove_module` が該当範囲だけを除き、他のレコードを保持する
- `/PROJECT` 行の挿入位置と削除、コードページ往復
- `/PROJECTwm` の追記・除去・終端
- モジュール名の検証(先頭数字、32 文字、重複、予約語、ドキュメント名)
- ソース正規化(VERSION ブロック除去、VB_Name 補完、クラス属性補完、CRLF)
- `check_workbook_lock`: オーナーファイルあり → `owner_file`、別ハンドルで書き込み排他中 → `write_denied`、どちらも無し → `false`
- `cfb` で合成した最小 `vbaProject.bin` を ZIP に包んだブックで、pull → 編集・追加・削除 → push → pull の往復。`unchanged` の判定も確認
- 既存の圧縮・解凍・エンコードのテストは維持

### Vitest

- xlsm タブで `MacroChatPane` が描画され、xlsx タブでは描画されない
- タブのアクティブ化で接続 → 紐づくセッションの読み込み(あり / なし / 読み込み失敗)が正しく分岐する
- 初回送信後の `currentSessionId` が `macro-chat-store` に記録される。「新しいチャット」で紐づけが消える
- ロック判定が `locked` のときバナーと再確認ボタンが出て、解除で消える。「マクロを取り込み」ボタンが無効になる
- `ensureBuiltinFiles` の版管理: 無い → 書く、版違い → 上書き、マーカー無し → 触らない、`SKILL.md.disabled` あり → 触らない
- `wrapWithMdiumContext` が `.xlsm` タブのときだけ付く
- `vba-pushed` 受信でプレビュー再読込とモジュール一覧更新が走る
- 設定ストアに `allowLlmVbaImport` が残っていても読み込める
- `PreviewPanel.test.tsx` のトグル関連テストを削除する

### 実機(利用者)

1. ブックを開くと分割表示になり、指示だけで編集 → Excel で開いて動作する
2. 標準モジュールの追加、クラスモジュールの追加 → VBE に表示され実行できる
3. モジュールの削除 → VBE から消えている
4. 日本語を含むソースと Shift_JIS ブック
5. `.xlam`
6. Excel で開いたままタブを開く → 警告が出る。閉じると消える。開いたまま push → `workbook_locked`
7. タブを閉じて開き直す → 前回の会話に戻る

---

## 10. 実装順序(粗い分割)

1. Rust: マクロフォルダ導出の統一、`/PROJECT` 解釈、`DirStream` の分解・再直列化(往復テスト)、`check_workbook_lock`
2. Rust: `push_vba_modules` の計画段階(ロック判定、集合比較、名前検証、正規化、エンコード検証)
3. Rust: 追加・削除の書き込みと `/PROJECTwm`、合成ブックでの往復テスト
4. Rust: ブリッジを `/vba/list` `/vba/pull` `/vba/push` に整理、`vba-pushed` イベント、`active_xlsm` の削除
5. フロント: カスタムツール 3 本、`ensureBuiltinFiles`(ツール・スキルの版管理)、`buildSkillMd` の移動
6. フロント: スキル書き直し、`<mdium_context>` の供給元変更
7. フロント: `OpencodeChatView` の切り出し、`macro-chat-store`、`MacroChatPane`(ヘッダ・ロック警告・セッション紐づけ)
8. フロント: PreviewPanel の分割表示、トグル削除、i18n、`vba-pushed` 購読、設定ストアと MCP 関連の削除
9. ドキュメント更新
10. 実機スモーク(利用者)

詳細なタスク分解は実装計画で行う。
