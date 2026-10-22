# VBA マクロの実行と自動検証ループ 設計仕様

- 日付: 2026-10-21
- 対象: マクロチャット(opencode)で「実装から確認までお願いします」と頼めば、AI がマクロを直し、コピー上で実行し、セル値を読んで期待どおりかを自分で判断し、ずれていれば直して再実行する、というループを人手なしで回せるようにする
- 前提: [2026-10-15 マクロチャット設計](2026-10-15-vba-macro-chat-design.md)の `vba_list` / `vba_pull` / `vba_push` と HTTP ブリッジの上に積む。前設計で対象外とした「VBA の実行、Excel COM 連携、テスト実行」を本設計で扱う

---

## 0. 背景と目的

### 現状

- `vba_push` までが AI の仕事で、動作確認は利用者が Excel を開いて目視している
- スキル `vba-mdium-flow` にも「MDium does not run macros」とあり、push 後は「Excel で確認してください」と利用者に投げる
- `vba_push` は Excel がブックを開いている間は `workbook_locked` で拒否する

### 目的

- AI がマクロを実行し、**セル値が期待どおりか**で成否を判断し、必要なら直して再実行できる
- **検証が通るまで原本に触れない。** 実行は「原本 + マクロフォルダの現ソース」から組み立てたコピーで行い、通ってから `vba_push` する
- 既存マクロの退行をコピー上で検出できる
- ダイアログ(`MsgBox` / `InputBox` / 実行時エラー)で止まらない
- 課金が暴走しない。似た関数の増殖、付け焼刃の修正、`On Error Resume Next` の蔓延を機械的に抑える

### 利用者が「嫌だ」と言った場面(アンチゴール)

| 場面 | 対策(節) |
|---|---|
| もともと動いていたマクロが動かなくなる、ファイルが壊れる | 未検証のコードは原本に書かない(3.2)。回帰チェック手順(7.2) |
| デバッグがループして課金が爆発する | 実行回数の上限をツール側で強制(5) |
| 同じような関数がモジュールごとに増える | lint `duplicate_procedure`(6)。スキルで既存ヘルパー再利用を義務化(7.3) |
| 付け焼刃的な修正が増える | スキルで「期待値ではなくコードを直す」(7.3)。回数上限で逃げ道を塞ぐ。コピーのファイル名を原本と同じにして偽の退行を作らない(3.2) |
| 関数内でエラーを無視する構文ばかりになる | lint `on_error_resume_next_added`(6) |

### 対象外

- 原本ブックに対するマクロ実行(実行は常にコピー上。検証済みマクロを本番データに適用するのは利用者が Excel で行う)
- ユーザーフォーム(`.frm`)の操作。UserForm が出たら閉じて記録するだけで、フォーム依存のマクロは自動検証の対象外(4.3)
- VBE のエラートラップ設定(レジストリ)の書き換え。設定が「クラス モジュールで中断」のままでもダイアログ監視が同じ情報を回収する(4.2)
- officecli への依存。セル値は MDium 自身が読む
- opencode 以外のチャット(Claude パネル、AGENT CHAT)からの利用。マクロチャットが opencode 専用のため
- 実行結果コピーをプレビューに表示する UI。実行結果は AI がチャットで報告する
- 回数上限などの設定 UI(定数で持つ)
- macOS / Linux(Excel COM が無い。`excel_not_available` を返す)

---

## 1. 用語

| 用語 | 識別子 | 定義 |
|---|---|---|
| 原本 | `xlsm_path` | 利用者が開いている `.xlsm` / `.xlam` |
| マクロフォルダ | `macros_dir` | `<名前>_assets/macros/`(既存) |
| 実行コピー | `run_copy` | `<名前>_assets/runs/<yyyyMMdd-HHmmss>_<マクロ名>/<原本と同じファイル名>` に組み立てたブック。マクロはここで走る |
| シム | `MdiumShim` | 実行コピーにだけ注入する標準モジュール。`MsgBox` / `InputBox` の横取りと、エラーを捕まえるラッパーを持つ |
| 実行 | `vba_run` | コピー組み立て → シム注入 → Excel COM で実行 → セル値読み取り → 保存・終了 |
| セル読み取り | `xlsx_read` | Excel を起動せずにブックの保存済みセル値を読む |
| 実行予算 | `run_budget` | 利用者の 1 回の指示に対して許される `vba_run` の回数 |
| ダイアログ監視 | `dialog_watch` | 実行中に Excel プロセスが出した窓を検出して閉じる Rust 側の監視 |

---

## 2. アーキテクチャ

```
opencode (.opencode/tools/vba_run.ts, xlsx_read.ts)
   │ POST /vba/run, /xlsx/read  (既存ブリッジ、Bearer token)
   ▼
MDium Rust  http_bridge.rs ── handle_vba_route ──▶ commands/vba_run.rs
                                                     ├─ 実行予算チェック(RunBudgetState)・同一ブック排他
                                                     ├─ 副作用スキャン(マクロフォルダの静的検査)
                                                     ├─ 実行コピー組み立て: 原本 bytes + マクロフォルダを適用(push の計画部を再利用) + シム
                                                     ├─ PowerShell 子プロセス(Excel COM、非表示)
                                                     │     Open → Run(MdiumShim.MdiumRunN)×N → Range.Value2 読み取り → Save → Quit
                                                     ├─ dialog_watch: 子プロセスを待つ間、Excel PID の可視トップレベル窓を走査(windows-sys)
                                                     └─ 結果 JSON を返す
                                                   commands/xlsx_read.rs ── calamine で保存済み値を読む
```

- 既存の doc→docx 変換(`doc_convert.rs`)と同じく、COM は PowerShell スクリプトを `-Command` で渡し、パスは環境変数で渡す(クォート不要)。スクリプトは単一引用符のみ使う
- PowerShell は `CREATE_NO_WINDOW` で起動。Excel は `New-Object -ComObject Excel.Application` で**新しいインスタンス**を作る(利用者が開いている Excel とは別プロセス)
- 原本は読むだけなので、**利用者が Excel で原本を開いたままでも `vba_run` は動く**。`vba_push` だけが閉じるのを待つ

### 2.1 push との関係(重要)

既存 `push_vba_modules_impl` を「計画 + 新しい vbaProject.bin の生成」と「原本への書き込み(.bak 作成含む)」に分ける。

- `plan_push(xlsm_bytes, macros_dir) -> PushPlan { new_xlsm_bytes, updated, added, removed, skipped, unchanged, warnings }`
- `vba_push` = `plan_push` + `.bak` + 原本へ書き込み(現行どおり)
- `vba_run` = `plan_push`(`source=macros_dir` のとき) + シム追加 + 実行コピーへ書き出し。原本は書かない

これにより `vba_run` の結果にも push と同じ `warnings` が付き、AI は原本に書く前に lint を見られる。

---

## 3. `vba_run`

### 3.1 入力

```jsonc
{
  "xlsm_path": "C:/.../Book.xlsm",
  "source": "macros_dir",           // macros_dir(既定): 原本にマクロフォルダの現ソースを適用して実行
                                    // workbook: 原本そのまま(編集前の基準を取るとき)
  "macros": [                       // 順に実行。状態は引き継がれる(利用者が手で順に実行するのと同じ)
    { "name": "Module1.Main" },     // "モジュール名.プロシージャ名"。モジュール名省略可
    { "name": "Module1.Fill", "args": ["Sheet1", 10] }   // 文字列・数値・真偽値のみ
  ],
  "inputs": ["42", "東京"],         // InputBox への回答を順に消費。尽きたら Default(無ければ "")を返し exhausted を記録
  "msgbox_responses": ["yes"],      // MsgBox への応答を順に消費。尽きたらボタン構成の既定ボタン(3.4)
  "read": [                         // 実行後・保存前に Range.Value2 で読む
    { "sheet": "Sheet1", "range": "A1:C10" }
  ],
  "allow_side_effects": false,      // 副作用スキャン(3.6)に引っかかっても実行する
  "timeout_ms": 120000              // 既定 120000、上限 300000(4.4)
}
```

- `macros` が空で `read` だけの呼び出しも許す(Excel で再計算した値を読みたいとき)
- パス解決は既存 `resolve_xlsm_path`(開いているフォルダ相対を許容)

### 3.2 手順

1. 実行予算を確認(5)。超過なら `run_budget_exhausted`。同じブックが実行中なら `run_in_progress`
2. `require_macro_workbook`。原本が無い・拡張子違いは `invalid_workbook`
3. `source=macros_dir` のときマクロフォルダが無ければ `macros_dir_not_found`。`source=workbook` のときは原本からモジュールソースを展開して以下の静的検査に使う
4. 静的検査(対象は実行されるソース): 副作用スキャン(3.6)→ `side_effects_detected`。`macros[].name` のプロシージャが無ければ `macro_not_found`。`MdiumShim` というモジュール、または `MsgBox` / `InputBox` という名前のプロシージャが既にあれば `shim_name_conflict`(後者は横取りがコンパイルエラーになるため)
5. 実行コピーを組み立てる: `<名前>_assets/runs/<yyyyMMdd-HHmmss>_<先頭マクロ名>/` フォルダを作り、**原本と同じファイル名**で書き出す。中身は `source` に応じて原本そのまま、または `plan_push` の結果。そこへシム(3.3)を追加する。古い実行フォルダはブックごとに**最新 5 件**だけ残して削除
6. PowerShell を起動し、`dialog_watch`(4.3)を回しながら完了を待つ
7. 結果 JSON を組み立てて返す。実行予算を 1 消費する(成功・失敗を問わず)

原本には一切書き込まない。実行コピーは呼び出し後も残す(AI や利用者が `xlsx_read` や Excel で中身を確かめられる)。

ファイル名を原本と同じにするのは、`Workbooks("Book.xlsm")` や `ThisWorkbook.Name` を使う既存マクロがコピー上で偽の退行を起こさないため。`ThisWorkbook.Path` は実行フォルダになるので、隣のファイルを相対参照するマクロはコピー上で失敗し得る。スキル(7.3)で注意する。

### 3.3 シムの内容

生成する VBA(抜粋。実際の生成はテンプレート関数 `render_shim(spec) -> String` で行い、単体テストで固定出力を確認する):

```vb
Attribute VB_Name = "MdiumShim"
Option Explicit
' Generated by MDium for a single verification run. Never pushed to the original workbook.

Private mLog As String          ' dialog records, RS(0x1E) between records, US(0x1F) between fields
Private mInputIdx As Long
Private mMsgIdx As Long

Public Function MsgBox(Prompt, Optional Buttons As VbMsgBoxStyle = vbOKOnly, _
                       Optional Title, Optional HelpFile, Optional Context) As VbMsgBoxResult
    Dim r As VbMsgBoxResult
    r = NextMsgBoxResponse(Buttons)            ' msgbox_responses を消費、尽きたら既定ボタン
    Append "msgbox", CStr(Prompt), CStr(Title & ""), CStr(r)
    MsgBox = r
End Function

Public Function InputBox(Prompt, Optional Title, Optional Default, _
                         Optional XPos, Optional YPos, Optional HelpFile, Optional Context) As String
    Dim s As String, exhausted As Boolean
    s = NextInput(Default, exhausted)          ' inputs を消費
    Append "inputbox", CStr(Prompt), CStr(Title & ""), s, IIf(exhausted, "exhausted", "")
    InputBox = s
End Function

Public Function MdiumTakeLog() As String       ' Workbook_Open 中に記録されたものを Open 直後に回収する
    MdiumTakeLog = mLog: mLog = ""
End Function

Public Function MdiumRun1() As String
    On Error GoTo Fail
    Dim t0 As Single: t0 = Timer
    Call Module1.Main                           ' macros[0] を直接呼ぶ(文字列・数値はリテラルで埋め込む)
    MdiumRun1 = "ok" & Chr(31) & CStr(Timer - t0) & Chr(31) & MdiumTakeLog()
    Exit Function
Fail:
    MdiumRun1 = "error" & Chr(31) & CStr(Err.Number) & Chr(31) & Err.Source & Chr(31) & Err.Description & Chr(31) & MdiumTakeLog()
End Function
' MdiumRun2 ... macros の数だけ生成
```

- 同一プロジェクト内で `MsgBox` / `InputBox` を定義すると、修飾なしの呼び出しはプロジェクト側が優先される。`VBA.MsgBox` と修飾された呼び出しと `Application.InputBox` は横取りできない → 4.3 の監視が拾う
- 対象マクロは `Application.Run` ではなく **直接 Call** する。標準モジュール内の未処理エラーはラッパーの `On Error GoTo Fail` に届き、ダイアログは出ない。クラス/ドキュメントモジュール内のエラーは VBE 設定によりダイアログになる(4.2)
- `Erl` は使わない(行番号付きソースでないと 0)。行の特定は AI が `Err.Description` とソースから推測する
- 文字列はプロジェクトのコードページで encode する(push と同じ `encode_string`)。encode できない文字が `inputs` 等にあれば `unencodable_character`
- 戻り値は COM 経由の BSTR(Unicode)なので日本語のログも欠けない

### 3.4 MsgBox の既定応答

`msgbox_responses` が尽きたとき、`Buttons` のボタン構成に対する既定ボタンを返す。

| 構成 | 返す値 |
|---|---|
| vbOKOnly | vbOK |
| vbOKCancel | vbOK |
| vbYesNo / vbYesNoCancel | vbYes |
| vbRetryCancel | vbRetry |
| vbAbortRetryIgnore | vbAbort |

`msgbox_responses` の値は `"ok" | "cancel" | "yes" | "no" | "retry" | "ignore" | "abort"`。

### 3.5 出力

```jsonc
{
  "ok": true,                          // すべての macro が status=ok のとき true
  "runCopyPath": "C:/.../Book_assets/runs/20261021-143012_Main/Book.xlsm",
  "source": "macros_dir",
  "warnings": [ ... ],                 // source=macros_dir のとき plan_push の lint(6 章)。workbook のとき []
  "openDialogs": [ ... ],              // Workbook_Open など、Open 中に記録・検出したダイアログ(形式は dialogs と同じ)
  "results": [
    {
      "macro": "Module1.Main",
      "status": "ok",                  // ok | error | dialog_interrupted | timeout | not_run
      "durationMs": 812,
      "error": null,                   // { "number": 9, "source": "VBAProject", "description": "インデックスが有効範囲にありません。", "from": "handler" | "dialog" }
      "dialogs": [                     // シムが記録した MsgBox / InputBox と、dialog_watch が閉じた窓
        { "kind": "msgbox", "prompt": "完了しました", "title": "", "response": "ok" },
        { "kind": "inputbox", "prompt": "件数は?", "title": "", "response": "42", "exhausted": false },
        { "kind": "window", "class": "#32770", "title": "Microsoft Visual Basic for Applications", "text": "実行時エラー '1004': ...", "clicked": "終了" }
      ]
    }
  ],
  "cells": [
    { "sheet": "Sheet1", "range": "A1:C10", "values": [["名前", "数量", 12.5], ...] }
  ],
  "runBudget": { "used": 2, "limit": 6 }
}
```

- `values` は `Value2`。数値はそのまま、日付はシリアル値、空は `null`、真偽値は `true`/`false`。**エラー値は COM では `Int32` のコードで返るので、文字列 `#N/A` / `#DIV/0!` / `#VALUE!` / `#REF!` / `#NAME?` / `#NUM!` / `#NULL!` に写像する**(calamine の `Data::Error` も同じ文字列に揃える)
- ツール自体が動かなかった失敗は既存 `vba_error` 形式 `{ "error": code, "message": ... }`。コード一覧は 8 章
- 1 つの macro が `error` / `dialog_interrupted` になっても後続は実行する(回帰チェックで全件の結果が欲しい)。PowerShell は **macro ごとに try/catch** し、COM 例外も空の戻り値も `dialog_interrupted` に写す。`timeout` だけは後続を `not_run` にする

### 3.6 副作用スキャン

実行されるソース全体を正規表現で検査し、ブックの外へ影響し得る呼び出しを列挙する。検出時は `allow_side_effects=true` が無い限り実行しない。

| 分類 | パターン例 |
|---|---|
| ファイル操作 | `Kill`, `RmDir`, `MkDir`, `FileCopy`, `Name ... As`, `Open ... For Output/Append/Binary`, `FileSystemObject` |
| 外部プロセス・COM | `Shell(`, `CreateObject(`, `GetObject(`, `WScript.Shell` |
| ネットワーク・メール | `MSXML2`, `WinHttp`, `Outlook.Application`, `SendMail`, `URLDownloadToFile` |
| 他ブックの保存 | `Workbooks.Open`, `.SaveAs`, `.SaveCopyAs` |
| Win32 | `Declare ... Lib` |

結果は `side_effects_detected` の `message` に `モジュール名:行番号: 一致した文字列` の一覧で返す。実行コピーは**ブックの外の副作用を隔離しない**ことをスキルに明記する。

### 3.7 副作用の承認(利用者決定: MDium のダイアログで許可)

`allow_side_effects: true` で呼ばれても、スキルの文章に強制力は無いので、**実行は利用者が MDium 上で許可したときだけ**通す。RAG の承認リレー(`rag-bridge-request` → webview の `showConfirm` → 返信)と同じ仕組みを使う。

1. 副作用スキャンに一致し `allow_side_effects` が無い → `side_effects_detected`(ダイアログは出さない。AI はまず一覧をチャットで説明する)
2. 一致し `allow_side_effects: true` → Rust が `vba-run-approval-request` イベント(`id`, `xlsmPath`, `macros`, `matches[]`)を webview に投げ、`VbaApprovalPending`(RAG と同じ `mpsc` の待ち受け表)で返事を待つ
3. webview はアプリ共通の確認ダイアログ(`dialog-store` の `showConfirm`、`kind: "warning"`)で、ブック名・実行するマクロ・一致箇所の一覧(最大 20 行、超過は「他 N 件」)を見せる。文言は i18n(`editor.json` の ja / en)
4. 利用者の返事を Tauri コマンド `vba_run_approval_reply(id, granted)` で返す。許可で実行に進む。拒否は `approval_denied`(403)、**120 秒**無応答は `approval_timeout`(408)。どちらも実行予算は消費しない
5. 許可は **(ブック, 一致一覧のハッシュ)ごとに記憶**し、実行予算と一緒にリセットする(5 章)。同じ指示の中で AI が 3 回まわしても聞くのは 1 回。一致箇所が変われば(新しい副作用が増えれば)もう一度聞く

承認の待ち時間はツール側の `fetch` タイムアウトにも入る。`vba_run.ts` の `AbortSignal.timeout` は `120000 + timeout_ms + 15000` とし、4.4 の実測はこの最悪値で行う。届かなければ承認の待ち時間を 60 秒に下げる。

---

## 4. Excel COM 実行と監視

### 4.1 PowerShell スクリプト

```powershell
$ErrorActionPreference = 'Stop'
try { $xl = New-Object -ComObject Excel.Application } catch { [Console]::Error.WriteLine('EXCEL_NOT_AVAILABLE: ' + $_.Exception.Message); exit 2 }
$code = 0
try {
  $xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
  $xl.Interactive = $false
  $xl.AutomationSecurity = 1                       # msoAutomationSecurityLow: マクロ有効で開く
  [Console]::Out.WriteLine('HWND ' + $xl.Hwnd)     # dialog_watch が PID を特定するため最初に出す
  $wb = $xl.Workbooks.Open($env:MDIUM_RUN_COPY, 0, $false)
  try {
    [Console]::Out.WriteLine('OPENLOG ' + (B64 $xl.Run('MdiumShim.MdiumTakeLog')))
    foreach ($i in 1..$env:MDIUM_RUN_COUNT) {
      try {
        $r = $xl.Run('MdiumShim.MdiumRun' + $i)
        [Console]::Out.WriteLine('RESULT ' + $i + ' ' + (B64 ([string]$r)))     # 空文字なら dialog_interrupted
      } catch {
        [Console]::Out.WriteLine('RUNEXC ' + $i + ' ' + (B64 $_.Exception.Message))  # 「終了」後の COM 例外も dialog_interrupted
      }
    }
    # read: MDIUM_RUN_READ は JSON。Value2 を 2 次元配列にし、Int32 のエラーコードは文字列に写像して CELLS 行で出す
    ...
    $wb.Save()
  } finally { $wb.Close($false) }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message); $code = 1
} finally {
  $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
exit $code
```

- 標準出力は行単位のプロトコル(`HWND`, `OPENLOG`, `RESULT`, `RUNEXC`, `CELLS`)。本文は base64 にして改行・文字コードの問題を避ける
- `EnableEvents` は既定(True)のまま。`Workbook_Open` などのイベントは利用者が開いたときと同じく走る。`Auto_Open` は自動化で開くと走らない(Excel の仕様)

### 4.2 Excel と VBE の前提

- Windows + Excel(デスクトップ版)。無ければ `excel_not_available`
- VBE の「エラートラップ」の既定は**「クラス モジュールで中断」**。この設定では、クラスモジュールやドキュメントモジュール(Sheet1 / ThisWorkbook)の中で起きた未処理エラーは、ラッパーにハンドラがあっても VBE のエラーダイアログになる。MDium はこの設定(レジストリ `HKCU\Software\Microsoft\VBA\<ver>\Common\BreakOnAllErrors`)を**書き換えない**。代わりにダイアログ監視(4.3)が本文から `実行時エラー 'N': 説明` を正規表現で取り出し、`error.from = "dialog"` として同じ形で返す。ラッパー経由(`from = "handler"`)との違いは `Err.Source` が取れないことと、マクロがその場で強制終了することだけ
- `AccessVBOM`(VBProject へのアクセス)は不要。シムは vbaProject.bin に直接書き込む

### 4.3 ダイアログ監視(`dialog_watch`)

Rust 側で PowerShell 子プロセスを待つ間、250ms ごとに:

1. 最初の `HWND` 行から Excel ウィンドウの PID を得る(`GetWindowThreadProcessId`)
2. `EnumWindows` で**同じ PID の可視トップレベル窓**を走査する。`XLMAIN`(Excel 本体、非表示)は除く
3. 窓クラスごとに処理する:

| クラス | 正体 | 処理 |
|---|---|---|
| `#32770` | VBA の `MsgBox` / `InputBox`(`VBA.` 修飾)、VBE 実行時エラー | `Static` の本文と `Button` のラベルを集めて記録。`終了`/`End` → `キャンセル`/`Cancel` → `いいえ`/`No` → `OK` の順でボタンを `BM_CLICK`(`PostMessage`)。無ければ `WM_CLOSE` |
| `bosa_sdm_XL9` | `Application.InputBox` など Excel 組み込みダイアログ | タイトルを記録して `キャンセル`/`Cancel` を押す。無ければ `WM_CLOSE` |
| `ThunderDFrame` | UserForm | タイトルを記録して `WM_CLOSE`。マクロは `.Show` の次行から続行する |
| その他 | 不明 | タイトルとクラスを記録して `WM_CLOSE` |

4. 記録は、実行中の `MdiumRunN` の `dialogs` に `kind: "window"` で付ける(Open 中なら `openDialogs`)
5. macro の `status` は次で決める: ラッパーが文字列を返せば `ok` / `error`(窓の記録は `dialogs` に残る)。戻り値が空、または `Application.Run` が COM 例外になれば `dialog_interrupted`。`#32770` の本文に実行時エラーが含まれていれば `error` を `from: "dialog"` で埋める

実装は `windows-sys` クレート(`Win32_Foundation`, `Win32_UI_WindowsAndMessaging`, `Win32_System_Threading`)を `[target.'cfg(windows)'.dependencies]` に追加する。UIA は使わない(非表示 Excel の窓でも Win32 メッセージで押せる)。

### 4.4 タイムアウト

- `timeout_ms`(既定 120 秒、**上限 300 秒**)を超えたら Excel PID を `TerminateProcess`、PowerShell も kill。結果は、実行中だった macro を `timeout`、後続を `not_run`、`cells` は空
- 上限を 300 秒にするのは opencode(Bun)側 `fetch` のアイドルタイムアウトを超えないため。`vba_run.ts` は `signal: AbortSignal.timeout(120000 + timeout_ms + 15000)`(承認待ち + 実行 + 余裕)を明示する。実装時にこの最悪値で実測し、届かなければ上限または承認待ちを下げる
- `HWND` 行が来る前に Excel が固まった場合は PID が分からないので、**PowerShell だけ kill** し、`message` に「Excel プロセスが残った可能性がある」と書く(利用者の Excel を誤って kill しない)
- 実行コピーは保存されていない状態で残る(その旨を `message` に書く)

### 4.5 排他

同じブックに対する `vba_run` は同時に 1 つだけ(`Mutex<HashSet<workbook_key>>`)。2 つ目は `run_in_progress`。

---

## 5. 実行予算(`run_budget`)

- ブリッジに `RunBudgetState: Mutex<HashMap<workbook_key, u32>>` を持つ。`vba_run` が 1 回終わるごとに +1
- 上限は定数 `VBA_RUN_BUDGET = 6`。到達後の呼び出しは `run_budget_exhausted` を返し、`message` に「結果と行き詰まりの内容を利用者に報告して止まること。利用者が次の指示を送ると予算は戻る」と書く
- リセットは利用者の操作だけで起きる。Tauri コマンド `reset_vba_run_budget(xlsm_path)` を次の場所から呼ぶ:
  - **共有の送信経路**(`useOpencodeChat` の利用者メッセージ送信)。現在のセッション ID がどのブックに紐づくかは `macro-chat-store.sessionByWorkbook` の逆引きで決める。マクロチャット右ペインからでも左パネルの opencode チャットからでも、同じセッションへの送信なら戻る
  - opencode の `question.asked` への返答(`/question/{id}/reply`)も利用者の操作なので同じく戻す
  - マクロチャットの「新しいチャット」
- リセット時に副作用承認の記憶(3.7)も一緒に消す
- `vba_run` の結果に `runBudget: { used, limit }` を毎回含め、AI が残りを把握できるようにする
- 数え方は「1 回の指示につき 6 回」であり、1 回の `vba_run` で複数 macro を走らせても 1 と数える(回帰チェックをまとめて 1 回で済ませる動機付け)

---

## 6. lint(`plan_push` の `warnings`)

`plan_push` は新旧ソースを両方持つので、そこで検査して `warnings` に積む。`vba_push` と `vba_run`(`source=macros_dir`)の両方の結果に付く。**警告であり push も run も止めない**(止めると AI が回避策を探し始める。止める判断はスキルと利用者に委ねる)。

```jsonc
"warnings": [
  { "code": "on_error_resume_next_added", "module": "Module1", "before": 0, "after": 2 },
  { "code": "duplicate_procedure", "name": "TrimAll", "modules": ["Module1", "Utils"] }
]
```

- `on_error_resume_next_added`: モジュールごとに `^\s*On Error Resume Next\b`(大文字小文字無視)の数を新旧で比べ、増えていれば出す。新規モジュールは before=0
- `duplicate_procedure`: 適用後の**標準モジュール**全体で、`Private` でない `Sub` / `Function` / `Property` の名前が 2 モジュール以上にあり、かつそのうち少なくとも 1 つが今回 `updated` / `added` されたモジュールのときに出す。クラスモジュールは対象外(`Class_Initialize` などの同名が正常)
- 既存の `PushResult` に `warnings: Vec<PushWarning>` を追加(空配列を既定にし、既存テストは壊さない)

---

## 7. スキル `vba-mdium-flow` の改訂(version 4)

### 7.1 ツール一覧の更新

`vba_list` / `vba_pull` / `vba_push` / `vba_run` / `xlsx_read` の 5 つ。「MDium does not run macros」を削除し、代わりに次を書く。

### 7.2 実行と検証のループ

実行してよいのは、利用者の指示に「実行」「確認」「検証」「テスト」「動くか見て」など、動かして確かめる意図が含まれているときだけ。編集だけを頼まれたら push で止めて報告する(現行どおり)。

手順:

1. **基準を取る。** 編集前に `vba_run`(`source: "workbook"`)で既存マクロ(利用者が触れたもの、または影響しそうなもの)を走らせ、関係するセル範囲を `read` で読む。結果を基準として覚える
2. マクロフォルダの `.bas` / `.cls` を編集する。**まだ push しない**
3. `vba_run`(既定の `source: "macros_dir"`)で対象マクロと基準で走らせたマクロを**1 回の呼び出しで**実行し、同じ範囲を読む。`warnings` があれば 7.3 に従う
4. 期待値(利用者の指示から導く)と基準を比べる。対象マクロの結果がずれていれば原因を特定して 2 へ。既存マクロの結果が基準から変わっていれば退行として扱い、まず退行を直す
5. 修正と再実行の繰り返しは **3 回まで**。3 回で合わなければ、何を試して何が合わないかを利用者に報告して止まる(原本は無傷のまま)。`run_budget_exhausted` が返ったら即座に止まって報告する
6. 合ったら `vba_push` で原本に書く。Excel が原本を開いていて `workbook_locked` なら、検証済みであることを伝えて閉じるのを待つ
7. 最後に、変更内容・実行結果・`runCopyPath`・残った警告を報告する

### 7.3 守ること

- 期待値をコードに合わせない。合わないのはコードの方
- `On Error Resume Next` でエラーを握りつぶして通さない。`warnings` に `on_error_resume_next_added` が出たら、`On Error GoTo 0` で戻しているか・本当に必要かを見直し、残すなら理由を利用者に説明する
- ヘルパー関数を足す前にマクロフォルダ内を grep し、同じ役割の関数があれば再利用する。`duplicate_procedure` が出たら片方に寄せる
- 修正は原因に対して行う。症状だけを消す分岐(特定の値のときだけ別処理、など)を足さない
- 実行コピーは `runs/<時刻>_<マクロ名>/` の下にある。`ThisWorkbook.Path` で隣のファイルを参照するマクロはコピー上で失敗し得る。その失敗は退行ではないので、コピー特有かを見分けてから直す
- `side_effects_detected` が出たら、一致箇所と「何が起きうるか」をチャットで説明してから `allow_side_effects: true` で呼び直す。MDium が利用者に許可ダイアログを出すので、`approval_denied` なら実行を諦めて利用者に次の指示を仰ぐ。`approval_timeout` なら利用者が席を外している可能性があるので、再試行せずに報告して止まる。実行コピーはブックの外の副作用(ファイル削除、メール送信など)を隔離しない
- `inputs` / `msgbox_responses` は利用者の指示や既存コードから妥当な値を決める。決められないときは利用者に聞く
- `dialogs` に `kind: "window"` で `ThunderDFrame`(UserForm)が出たマクロは自動検証できない。利用者に手動確認を頼む
- 日付は `Value2` ではシリアル値になる。比較は数値で行う

### 7.4 `vba-coding-conventions` との関係

変更なし。ルール 13(`On Error Resume Next` の直後に `On Error GoTo 0`)は既にある。

---

## 8. エラーコード

既存の `vba_error(code, message)` 形式。

| code | 意味 |
|---|---|
| `invalid_workbook` | 原本が無い、拡張子が `.xlsm` / `.xlam` でない(既存) |
| `macros_dir_not_found` | `source=macros_dir` なのにマクロフォルダが無い(= pull 前) |
| `excel_not_available` | Excel COM を作れない(未インストール、非 Windows) |
| `run_budget_exhausted` | 実行予算の上限 |
| `run_in_progress` | 同じブックの `vba_run` が実行中 |
| `side_effects_detected` | 副作用スキャンに一致し、`allow_side_effects` が無い |
| `approval_denied` | 利用者が MDium の許可ダイアログで拒否した(HTTP 403) |
| `approval_timeout` | 許可ダイアログに 120 秒応答が無かった(HTTP 408) |
| `shim_name_conflict` | `MdiumShim` モジュール、または `MsgBox` / `InputBox` という名前のプロシージャが既にある |
| `macro_not_found` | `macros[].name` に対応する `Sub` / `Function` が実行されるソースに無い |
| `invalid_module_name` 等 | `plan_push` が返す既存の push エラー(`source=macros_dir` のとき) |
| `unencodable_character` | `inputs` / `args` / マクロ名がコードページで表せない |
| `run_failed` | PowerShell が 1 で終了した(Open 失敗、保存失敗など)。stderr の先頭行を `message` に |
| `invalid_range` | `read` / `xlsx_read` のシート名・範囲が解釈できない、または存在しない |

---

## 9. `xlsx_read`

- `POST /xlsx/read` `{ "path": "...", "ranges": [{ "sheet": "Sheet1", "range": "A1:C10" }] }`
- `calamine` でブックを開き、保存済みのセル値を返す。出力は `vba_run` の `cells` と同じ形(エラー値の文字列表記も同じ)
- Excel を起動しないので速いが、値は**最後に保存されたときの計算結果**。`vba_run` 直後の実行コピーなら最新、原本は利用者が最後に Excel で保存した値
- パスは開いているフォルダ配下の `.xlsx` / `.xlsm` / `.xlam` を許す(実行コピーも読める)
- 範囲省略時はシートの使用範囲全体。1 回の読み取り上限はセル 20,000 個(超えたら `invalid_range` に「範囲を狭めよ」)

---

## 10. フロントエンド

- `useOpencodeChat` の利用者メッセージ送信と `question.asked` 返答、`MacroChatPane.handleNewChat` で `invoke("reset_vba_run_budget", { xlsmPath })` を呼ぶ(5 章)
- 副作用の許可ダイアログ(3.7): `useRagBridge` に倣った `useVbaRunApproval` フックをアプリ起動時に 1 つマウントし、`vba-run-approval-request` を受けて `showConfirm` を出し、`vba_run_approval_reply` で返す。新しい UI 文字列はこのダイアログの見出し・本文・「他 N 件」だけ(`editor.json` の ja / en)
- `.opencode/tools/vba_run.ts` と `xlsx_read.ts` を追加し、`builtin-registry.ts` の `SRC_TOOLS` に登録。既存の `vba_push.ts` と同じブリッジ読み取り・エラー整形を使う。`mdium-tool-version` は新規なので 1
- `builtin-skills.ts` の `vba-mdium-flow` を version 4 に上げる(既存の自動更新経路で opencode 側へ配られる)

---

## 11. ファイル配置(見込み)

| 役割 | 場所 |
|---|---|
| 実行本体・シム生成・副作用スキャン・結果整形 | `src-tauri/src/commands/vba_run.rs`(新規) |
| Win32 ダイアログ監視 | `src-tauri/src/commands/vba_dialog_watch.rs`(新規、`cfg(windows)`) |
| セル読み取り | `src-tauri/src/commands/xlsx_read.rs`(新規) |
| `plan_push` への分割と lint | `src-tauri/src/commands/vba.rs` |
| ブリッジのルート・予算状態・排他・承認待ち受け | `src-tauri/src/http_bridge.rs` |
| 副作用許可ダイアログ | `src/features/preview/hooks/useVbaRunApproval.ts`(新規)、`src/shared/i18n/locales/{ja,en}/editor.json` |
| opencode ツール | `.opencode/tools/vba_run.ts`, `.opencode/tools/xlsx_read.ts` |
| 登録・スキル | `src/features/opencode-config/lib/builtin-registry.ts`, `builtin-skills.ts` |
| 予算リセット | `src/features/opencode-config/hooks/useOpencodeChat.ts`, `src/features/preview/components/MacroChatPane.tsx` |

---

## 12. テスト

- Rust 単体: シム生成の固定出力、MsgBox 既定応答表、副作用スキャンの一致・非一致、`shim_name_conflict`(モジュール名・プロシージャ名)、lint 2 種、予算のカウントとリセット、PowerShell 標準出力プロトコルの解析(`RESULT` 空・`RUNEXC`・`OPENLOG`)、エラー値コードの文字列写像、実行コピーの配置(同名ファイル・フォルダ 5 件保持)、`plan_push` 分割後も既存 push テストが全部通ること
- Rust 統合(`#[ignore]`、Excel がある PC でのみ手動実行): MsgBox / InputBox 入りマクロがダイアログなしで完走する、標準モジュールの未処理エラーが `from: "handler"` で返る、Sheet モジュール内の未処理エラーが `from: "dialog"` で返る、`VBA.MsgBox` と修飾した呼び出しが監視で閉じられて `ok` のまま `dialogs` に残る、タイムアウトで Excel が残らない、300 秒の `timeout_ms` が opencode 経由で届く
- Rust 単体(承認): `allow_side_effects` 無しはダイアログを出さず `side_effects_detected`、許可で実行に進む、拒否で `approval_denied`、無応答で `approval_timeout`、拒否・タイムアウトは予算を消費しない、同じ一致一覧なら 2 回目は聞かない、リセットで記憶が消える
- Vitest: 送信経路と新規チャットで予算リセットを呼ぶ(セッション→ブックの逆引き含む)、`useVbaRunApproval` がイベントを受けて `showConfirm` を出し返信する(`useRagBridge` のテストの流儀)、ツール登録とスキル version の整合(既存 `builtin-skills.test.ts` の流儀)
- 実機スモーク(winuse): マクロチャットで「A 列の合計を B1 に書くマクロを作って動作確認まで」と頼み、AI が基準取得 → 編集 → run → push → 報告まで自走すること。原本が検証前に変わっていないこと。実行後に `Get-Process excel` が空であること

---

## 13. 判断の記録

利用者が決めたこと:

- 検証は「セル値が期待どおりか」で行う
- 最初の指示に実行・確認が含まれていれば、実行のたびの確認は不要
- アンチゴール 5 項目(0 章の表)
- 副作用スキャンに一致したマクロの実行は、**MDium のダイアログで利用者が許可したときだけ**通す(案 B、2026-10-21)

私(設計者)の判断(レビュー反映後):

- **検証は原本に書く前に行う。** `vba_run` は「原本 + マクロフォルダの現ソース」からコピーを組み立てて実行し、通ってから `vba_push` する。これにより未検証コードが原本に入らず、Excel で原本を開いたままでも検証ループが回る
- 実行コピーは原本と同じファイル名で `runs/<時刻>_<マクロ名>/` に置く(偽の退行を避ける)
- VBE のエラートラップ設定(レジストリ)は触らない。ダイアログ監視が同じ情報を回収する
- ダイアログ監視は Excel PID の可視トップレベル窓すべてを対象にし、クラス別に処理する。UserForm は閉じて記録するだけ
- officecli ではなく MDium 自身が値を読む(`vba_run` の `read` と `xlsx_read`)。エラー値は文字列表記に統一
- 実行予算 6 回 / 指示、リセットは共有送信経路と質問返答と新規チャット。スキル上の修正ループ 3 回。実行コピー保持 5 件。タイムアウト既定 120 秒、上限 300 秒。`xlsx_read` 上限 20,000 セル
- lint は警告止まりで push も run も通す
- ダイアログ監視は UIA ではなく Win32 メッセージ(`windows-sys`)
- セル値は `Value2`(日付はシリアル値)

- 副作用の許可は(ブック, 一致一覧)ごとに記憶し、実行予算と一緒にリセットする。承認待ちは 120 秒で、拒否・無応答は予算を消費しない

未決事項: なし。

実装者に委ねること:

- PowerShell 標準出力プロトコルの細部、base64 と JSON の詰め方
- `windows-sys` の feature 選定とエラー処理
- `calamine` のバージョンと範囲文字列(`A1:C10`)の解析方法
- `plan_push` 分割の具体的な切り方
- 副作用スキャンの正規表現の正確な一覧(3.6 の表を最低限とする)
- セッション ID からブックを逆引きする実装場所

### 実装時の判明事項 (2026-10-22)

実装と実機確認で分かったこと、設計から変えたことを記録する。

- **シムのラッパーは `Sub MdiumRunN` + `MdiumTakeResult`。** 当初の「`Function` が結果を返す」形は、`Application.Run` 経由で呼んだ `Function` の中で対象マクロが `End` を実行すると Excel ごと落ちるため採らなかった。`Sub MdiumRunN`(N = 1, 2, ...)が結果をモジュール変数に置き、ランナーは続けて `MdiumTakeResult` を呼んで取り出す
- **タイムアウトまわりの待ち時間。** タイムアウト後も HWND 行を最大 20 秒待つ(Excel の起動に数秒かかり、短いタイムアウトだと HWND が届く前に期限が切れるため。PID が分からないと Excel を終わらせられない)。正常終了後は `Quit` した Excel の終了を最大 10 秒待ち、残っていれば終了させる
- **Excel のプロセスハンドルは 1 回の実行につき 1 つを保持する(C1)。** HWND 行から PID を得た時点で `OpenProcess`(`SYNCHRONIZE | TERMINATE | QUERY_LIMITED_INFORMATION`)を 1 度だけ開き、実行の終わりまで持つ。終了待ち(`WaitForSingleObject`)と強制終了(`TerminateProcess`)はこのハンドル経由で行い、最後に 1 度だけ閉じる。ハンドルを開いている間は PID が再利用されないので、無関係なプロセスを待ったり終わらせたりすることはない。終了させる前にイメージ名が `EXCEL.EXE` であることを `QueryFullProcessImageNameW` で確かめ、違えば終了させない。HWND が来なかったときの注記は従来どおり、HWND は来たが終了できなかったときは `Excel (pid N) could not be terminated; it may still be running.` を `notes` に入れる
- **VBE のエラートラップ設定。** この PC の既定値は「処理されていないエラーで中断」だった。設定によって未処理エラーの出方が変わるため、シムのハンドラ経由(`from: "handler"`)とダイアログ回収(`from: "dialog"`)の両方を実装した。`from: "dialog"` は `Worksheet_Change` イベント内のエラー(シムのハンドラが届かない)で試験している
- **依存のバージョン。** `calamine` 0.37、`windows-sys` 0.61
- **ツール側のタイムアウト。** `vba_run.ts` の `AbortSignal.timeout` は 3.7 の `120000 + timeout_ms + 15000` ではなく `120000 + timeout_ms + 45000`(承認待ち + 実行 + HWND 猶予 20 秒 + 終了待ち 10 秒 + 余裕)。期限切れ(`TimeoutError`)のときは「mdium 側でまだ実行中かもしれない。すぐに再実行せず、待ってから `run_in_progress` / `runCopyPath` を確かめる」旨を返す
- **追加したエラーコード。** 8 章の一覧に加えて `invalid_request`(引数の型が不正など、400)、`no_vba_project`(`source: "workbook"` で VBA プロジェクトが無い)、`read_failed`(`xlsx_read` の読み取り失敗)。`prepare_run` の検査順は ソース → シム名の衝突 → `macro_not_found` → `invalid_request` → 副作用
- **3.5 の出力に `notes` を追加。** タイムアウト、Excel が残った可能性、マクロ実行後のランナー失敗、古い実行コピーを消せなかったことなど、AI 向けの英語の注記を入れる
- **副作用スキャンの追加パターン。** `Shell` は関数形だけでなく文形式(`Shell "cmd /c ...", vbHide`)も拾うよう `\bShell\b` にした(`Dim shell As Object` のように同名の識別子も拾う保守的な判定)。`Workbooks.OpenText` / `OpenXML` など `Workbooks.Open*`、`SetAttr`、`SendKeys`、`ExecuteExcel4Macro` を追加
- **承認ダイアログは改行を保つ。** `showConfirm` に `preformatted` を追加し、承認ダイアログだけ一致箇所を 1 行ずつ表示する(長い場合はスクロール)。他のダイアログの表示は変えない
- **停滞監視の自動返信は予算をリセットしない。** 「続けてください」の自動送信は利用者の新しい指示ではないため、送信経路のリセットを飛ばす
- **予算のキーは正規化する(I1)。** 実行予算・承認の記憶・実行中フラグは、絶対パス化して `.` / `..` を解決したパス(存在するファイルは `fs::canonicalize`、`\\?\` 接頭辞は除く)から作る。`dir/./Book.xlsm` や `dir/sub/../Book.xlsm` のように綴りを変えても同じ予算を使う
- **実行コピーの整理はベストエフォート(I5)。** 古い実行コピーを Excel で開いているなどで消せないフォルダは飛ばし、`Could not remove old run copy {path}: {error}` を `notes` に入れて実行は続ける
- **未確認。** 300 秒の `timeout_ms` が opencode 経由で届くことの実機確認(計画 Task 8 step 5)はまだ行っていない

利用者向けメモ:

- `vba_run` と `xlsx_read` は opencode のツールとして自動でインストールされる
- スキル `vba-mdium-flow` は version 4 になる(実行と検証のループを含む)
- 実行コピーは `<stem>_assets/runs/` に置かれ、最新 5 件を残す
- 最初の `vba_run` で非表示の EXCEL.EXE が起動する(実行が終われば終了する)
- 副作用のあるマクロを実行するときは MDium に承認ダイアログが出る。120 秒応答が無ければ自動で閉じ、そのマクロは実行されない
