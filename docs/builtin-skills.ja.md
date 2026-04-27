# ビルトインスキル日本語リファレンス

MDium には Opencode セッションで利用される「ビルトインスキル」が同梱されています。スキル本体（`src/features/opencode-config/lib/builtin-skills.ts`）はすべて英語で定義されていますが、本ドキュメントは日本語話者向けの参考訳です。**LLM に渡されるのは英語版のみ** で、本ファイルはあくまで人間が内容を把握するためのものです。

スキルの追加・修正を行うときは、英語の本体を正としてください。本ファイルは追従して更新します。

---

## vba-coding-conventions

**説明:**
VBA (Visual Basic for Applications) のコードを書く・編集する・生成する場面で使用するスキル。LLM が他言語の癖を持ち込んで作ってしまいがちな失敗（予約語との変数名衝突、行継続の欠落、誤った演算子、他言語の構文流用など）を防ぐ。

### 概要

VBA は他のプログラミング言語と大きく異なる言語ルールを持っています。LLM は C / JavaScript / Python の慣習をそのまま当てはめてしまい、無効な VBA を生成しがちです。

**コア原則:** VBA は大文字小文字を区別しません。VBE はすべての識別子を、宣言時またはキーワードのケースに自動的に揃えます。`aS` という変数名は気付かないうちに `As`（予約語）に変換され、原因の見えないコンパイルエラーを引き起こします。

### 使用タイミング

- `.bas`, `.cls`, `.frm` ファイルの作成・編集
- Excel / Word / Access / Outlook / PowerPoint 用の VBA コードを生成するとき
- AI が生成した VBA コードのレビュー
- Excel ファイルからの VBA モジュールのエクスポート / インポート

### 重要ルール: 予約語の回避

VBA は `aS`, `AS`, `as`, `As` をすべて同一として扱います。**予約語と一致する識別子はコンパイルエラーになります。**

#### 高リスク予約語（短く衝突しやすいもの）

| 単語 | リスク | 安全な代替 |
|------|------|-------------------|
| `As` | "as" の略として `aS`, `as` を使いがち | `asValue`, `targetAs`, `strAs` |
| `To` | "target object" の略として `tO` | `toValue`, `destTo`, `targetTo` |
| `In` | "input number" として `iN` | `inValue`, `inputVal` |
| `Is` | "is string" として `iS` | `isValid`, `flagIs` |
| `Or` | "original" として `oR` | `origVal`, `orFlag` |
| `On` | "object name" として `oN` | `objName`, `onFlag` |
| `If` | "input file" として `iF` | `inputFile`, `ifFlag` |
| `Me` | — | `self`, `thisObj` |
| `Do` | — | `doAction`, `doFlag` |
| `By` | — | `byVal`, `byKey` |

**注意:** 予約語で「始まる」複合名は問題ありません。`doNow`, `orElse`, `inRange`, `asTp` は VBA がトークン全体で解釈するため有効な識別子です。完全一致（例: `aS` = `As`, `tO` = `To`）のみがエラーになります。

#### 組み込み関数名（こちらも危険）

予約語ではありませんが、組み込み関数を隠してしまう識別子:

`Str`, `Val`, `Int`, `Fix`, `Len`, `Left`, `Right`, `Mid`, `Trim`, `Chr`, `Asc`, `Date`, `Time`, `Now`, `Year`, `Month`, `Day`, `Hour`, `Minute`, `Second`, `Format`, `Type`, `Name`, `Error`, `Input`, `Print`, `Line`, `Step`

**ルール:** これらと完全一致する名前を変数名・引数名に使わない。プレフィックス付きの形にする: `sVal`, `dtVal`, `tmVal`, `nmId`, `fmtSpec`, `lnNum`, `stpVal`, `errMsg`。

#### 禁止されたオブジェクトモデルメンバ名

Excel オブジェクトモデルのプロパティ（`Range.Row`, `Range.Column`, `Collection.Key`, `Range.Rows`, `Range.Columns`）と衝突し、`With` ブロック内で曖昧参照や静かなバグを引き起こします。**これらと完全一致する名前を変数・引数・プロパティ名にしないでください:**

`Row`, `Rows`, `Column`, `Columns`, `Key`

代わりに次のようなプレフィックス形式を使用: `rowIdx`, `rowNum`, `targetRow`, `rowList`, `rowCount`, `colIdx`, `colNum`, `targetCol`, `colList`, `colCount`, `keyName`, `dictKey`, `lookupKey`。

### 構文クイックリファレンス

| 機能 | VBA 構文 | LLM が間違いやすい例 |
|---------|-----------|-------------------|
| 行継続 | `(空白)_` | `\` または無し |
| 代入 | `x = 5` | `x := 5`, `let x = 5` |
| オブジェクト代入 | `Set obj = ...` | `obj = ...` |
| 等値 | `=` | `==` |
| 不等値 | `<>` | `!=` |
| 文字列連結 | `&` | `+` |
| コメント | `'` | `//` または `/* */` |
| 配列アクセス | `arr(i)` | `arr[i]` |
| 論理 AND | `And` | `&&` |
| 論理 OR | `Or` | `\|\|` |
| 論理 NOT | `Not` | `!` |
| Null チェック | `IsNull(x)` | `x == null`, `x Is Null` |
| ブロック終端 | `End Sub` / `End Function` / `End If` | `}` または `end` |
| エラーハンドリング | `On Error GoTo label` | `Try/Catch` |

### 行継続ルール

複数行の文は、継続する各行の末尾を ` _`（半角空白 + アンダースコア）で終える必要があります。

```vb
' 正しい
Dim result As Long
result = FirstValue + _
         SecondValue + _
         ThirdValue

' 誤り — 継続文字なし、コンパイルエラー
Dim result As Long
result = FirstValue +
         SecondValue +
         ThirdValue
```

**制約:**
- 1 行の最大文字数: 1023
- 1 つの論理行の最大継続数: 25
- 文字列リテラルの内部では改行できない — 連結する:

```vb
' 正しい — 別々の文字列を連結
MsgBox "This is a very long " & _
       "message that spans lines"

' 誤り — 文字列リテラル内で改行
MsgBox "This is a very long _
       message that spans lines"
```

### 変数宣言

```vb
Option Explicit  ' モジュール先頭に必ず書く

' 各変数に As 句が必要
Dim x As Long, y As Long, z As Long

' 誤り — z だけが Long、x と y は Variant になる
Dim x, y, z As Long
```

**`Integer` より `Long` を優先:** 32bit 以上のシステムでは VBA が内部的に `Integer` を `Long` に変換するため、`Long` の方が高速です。整数変数にはすべて `Long` を使ってください。

### オブジェクト代入

すべてのオブジェクト代入には **`Set` キーワードが必須** です。

```vb
Dim ws As Worksheet
Set ws = ThisWorkbook.Sheets(1)    ' 正しい
ws = ThisWorkbook.Sheets(1)        ' 誤り — 実行時エラー

Set ws = Nothing                    ' 参照を解放
```

### Nothing と Null と Empty

| 値 | 型 | 用途 |
|-------|------|-----|
| `Nothing` | Object | 未初期化／解放されたオブジェクト |
| `Null` | Variant | データベースの NULL。式に伝播する |
| `Empty` | Variant | 未初期化の Variant |
| `""` | String | 長さ 0 の文字列 |
| `vbNullString` | String | null ポインタ文字列（`""` より高速） |

### エラーハンドリング

```vb
Sub Example()
    On Error GoTo ErrorHandler

    ' ... コード ...

    Exit Sub          ' エラーハンドラの前に必須

ErrorHandler:
    MsgBox "Error " & Err.Number & ": " & Err.Description
End Sub
```

**VBA に `Try/Catch` は存在しません。** 常に `On Error GoTo` を使用してください。

**`On Error Resume Next` は本当に必要な場合以外は禁止です。** すべてのエラーを静かに飲み込んでしまい、デバッグが極めて困難になります。使う場合は、狭い範囲・十分にコメントを書いた上（例: オブジェクトの存在確認）で利用し、直後に `On Error GoTo 0` または `On Error GoTo <label>` で通常のエラーハンドリングに戻してください。

```vb
' 許容範囲 — 狭いスコープと即時の復元
On Error Resume Next
Set ws = ThisWorkbook.Sheets("Optional")
On Error GoTo 0
If ws Is Nothing Then
    ' シートがない場合の処理
End If

' 禁止 — 広範囲ですべてのエラーを握り潰す
On Error Resume Next
' ... 数十行 ...
' バグが静かに無視される
```

### 引数のデフォルトの渡し方

VBA のデフォルトは `ByRef` です — 多くの言語と逆になっています。

```vb
' paramA は ByRef（デフォルト）、paramB は明示的に ByVal
Sub Example(paramA As Long, ByVal paramB As String)
End Sub
```

### 出力前チェックリスト

VBA コードを出力する前に確認:

1. 識別子が予約語と一致していないか（特に: `as`, `to`, `in`, `is`, `or`, `on`, `if`, `do`, `by`, `me`）
2. 識別子が組み込み関数を隠していないか（`Str`, `Val`, `Int`, `Date`, `Time`, `Name`, `Type`, `Line`, `Input`, `Error`）
3. 識別子がオブジェクトモデルメンバと一致していないか（`Row`, `Rows`, `Column`, `Columns`, `Key`）
4. 複数行の文がすべて ` _`（半角空白 + アンダースコア）で継続されているか
5. オブジェクト代入のすべてに `Set` を使っているか
6. 文字列連結に `&` を使っているか（`+` ではなく）
7. 配列アクセスが `()` か（`[]` ではなく）
8. `//` コメント・`==`・`!=`・`&&`・`||`・`Try/Catch` がないか
9. モジュール先頭に `Option Explicit` があるか
10. 各 `Dim` 変数に独自の `As` 句があるか
11. `Exit Sub` / `Exit Function` がエラーハンドララベルの前に置かれているか
12. 整数変数に `Integer` ではなく `Long` を使っているか
13. `On Error Resume Next` の直後に `On Error GoTo 0` で復元しているか

---

## vba-mdium-flow

**説明:**
MDium の `mdium-vba` MCP サーバーが利用可能なときに使用するスキル。エクスポート → 編集 → インポートというワークフローを LLM に案内し、モジュール構成に関する制約を明示する。

### 概要

このセッションでは MDium の `mdium-vba` MCP サーバーが利用可能です。

### 標準フロー

1. `list_vba_modules` で既存の `_macros/` の状態を確認
2. `_macros/` が未エクスポートなら `extract_vba_modules` を呼ぶ
3. Read / Edit ツールで `.bas` / `.cls` を編集
4. **編集が完了したら必ず `import_vba_macros` を呼ぶ**
5. レスポンスの `updatedModules` をユーザーに報告

### 重要な制約

- このツールは **ツール呼び出しの瞬間のアクティブタブ** に対して動作します
- 毎ターン、ユーザーメッセージ先頭の `<mdium_context>` タグで現在のアクティブファイルが分かります
- ツール応答の `activeFile` と `<mdium_context>` の `active_file` が一致しているか必ず確認してください
- 会話の途中でユーザーがタブを切り替えると `active_file` が変わります。ユーザーの意図を必ず確認してください:
  「アクティブタブが {old} から {new} に変わりましたが、このまま続けますか？」
- `error: "active_tab_changed"` が返ってきた場合は race condition です。**1 回だけ** retry してください

### モジュール構成を変えてはいけない

**`.bas` / `.cls` ファイルの新規作成・削除・リネームをしないでください。** MDium のインポートは **既存モジュールの内容差し替えのみ** をサポートします。

- 新規モジュールを作りたい → ユーザーに Excel の VBE で手動追加してもらい、再度 `extract_vba_modules` を呼んで取得する
- モジュールを削除したい → ユーザーに Excel の VBE で手動削除してもらう
- リネームしたい → 同様に VBE で行ってもらう

`import_vba_macros` が `error: "module_set_changed"` を返した場合は、`newInFiles` と `missingInFiles` の内容を確認し、どちらの差分を戻すべきかをユーザーに確認してください。
