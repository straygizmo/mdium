import type { BuiltinSkill } from "@/shared/types";

export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {
  "vba-coding-conventions": {
    name: "vba-coding-conventions",
    description:
      "Use when writing, editing, or generating VBA (Visual Basic for Applications) code — prevents common LLM mistakes including reserved-word variable collisions, missing line continuation, incorrect operators, and syntax from other languages",
    content: `# VBA Coding Conventions

## Overview

VBA has language rules that differ significantly from other programming languages. LLMs frequently generate invalid VBA by applying conventions from C, JavaScript, or Python.

**Core principle:** VBA is case-insensitive. The VBE normalizes all identifiers to match their declaration or keyword casing. A variable named \`aS\` silently becomes \`As\` — a reserved keyword — causing a compile error with no obvious explanation.

## When to Use

- Writing or editing \`.bas\`, \`.cls\`, \`.frm\` files
- Generating VBA code for Excel, Word, Access, Outlook, or PowerPoint
- Reviewing AI-generated VBA code
- Exporting/importing VBA modules from Excel files

## Critical Rule: Reserved Word Avoidance

VBA treats \`aS\`, \`AS\`, \`as\`, \`As\` as identical. **Any identifier matching a reserved word causes a compile error.**

### High-Risk Reserved Words (Short, Easy to Collide)

| Word | Risk | Safe Alternatives |
|------|------|-------------------|
| \`As\` | \`aS\`, \`as\` used as abbreviation | \`asValue\`, \`targetAs\`, \`strAs\` |
| \`To\` | \`tO\` for "target object" | \`toValue\`, \`destTo\`, \`targetTo\` |
| \`In\` | \`iN\` for "input number" | \`inValue\`, \`inputVal\` |
| \`Is\` | \`iS\` for "is string" | \`isValid\`, \`flagIs\` |
| \`Or\` | \`oR\` for "original" | \`origVal\`, \`orFlag\` |
| \`On\` | \`oN\` for "object name" | \`objName\`, \`onFlag\` |
| \`If\` | \`iF\` for "input file" | \`inputFile\`, \`ifFlag\` |
| \`Me\` | — | \`self\`, \`thisObj\` |
| \`Do\` | — | \`doAction\`, \`doFlag\` |
| \`By\` | — | \`byVal\`, \`byKey\` |

**Note:** Compound names that START with a reserved word are safe. \`doNow\`, \`orElse\`, \`inRange\`, \`asTp\` are valid identifiers because VBA parses whole tokens. Only exact matches (e.g., \`aS\` = \`As\`, \`tO\` = \`To\`) cause errors.

### Built-in Function Names (Also Risky)

These are not reserved words but will shadow built-in functions:

\`Str\`, \`Val\`, \`Int\`, \`Fix\`, \`Len\`, \`Left\`, \`Right\`, \`Mid\`, \`Trim\`, \`Chr\`, \`Asc\`, \`Date\`, \`Time\`, \`Now\`, \`Year\`, \`Month\`, \`Day\`, \`Hour\`, \`Minute\`, \`Second\`, \`Format\`, \`Type\`, \`Name\`, \`Error\`, \`Input\`, \`Print\`, \`Line\`, \`Step\`

**Rule:** Never use these exact names as variable or parameter names. Use prefixed forms: \`sVal\`, \`dtVal\`, \`tmVal\`, \`nmId\`, \`fmtSpec\`, \`lnNum\`, \`stpVal\`, \`errMsg\`.

### Forbidden Object-Model Member Names

These collide with Excel object-model properties (\`Range.Row\`, \`Range.Column\`, \`Collection.Key\`, \`Range.Rows\`, \`Range.Columns\`) and cause ambiguous references or silent bugs inside \`With\` blocks. **Never use these exact names as variable, parameter, or property names:**

\`Row\`, \`Rows\`, \`Column\`, \`Columns\`, \`Key\`

Use prefixed forms instead: \`rowIdx\`, \`rowNum\`, \`targetRow\`, \`rowList\`, \`rowCount\`, \`colIdx\`, \`colNum\`, \`targetCol\`, \`colList\`, \`colCount\`, \`keyName\`, \`dictKey\`, \`lookupKey\`.

## Syntax Quick Reference

| Feature | VBA Syntax | Common LLM Mistake |
|---------|-----------|-------------------|
| Line continuation | \`(space)_\` | \`\\\\\` or none |
| Assignment | \`x = 5\` | \`x := 5\`, \`let x = 5\` |
| Object assignment | \`Set obj = ...\` | \`obj = ...\` |
| Equality | \`=\` | \`==\` |
| Inequality | \`<>\` | \`!=\` |
| String concatenation | \`&\` | \`+\` |
| Comment | \`'\` | \`//\` or \`/* */\` |
| Array access | \`arr(i)\` | \`arr[i]\` |
| Logical AND | \`And\` | \`&&\` |
| Logical OR | \`Or\` | \`\\|\\|\` |
| Logical NOT | \`Not\` | \`!\` |
| Null check | \`IsNull(x)\` | \`x == null\`, \`x Is Null\` |
| End block | \`End Sub\`/\`End Function\`/\`End If\` | \`}\` or \`end\` |
| Error handling | \`On Error GoTo label\` | \`Try/Catch\` |

## Line Continuation Rules

Multi-line statements MUST end each continued line with \` _\` (space + underscore).

\`\`\`vb
' Correct
Dim result As Long
result = FirstValue + _
         SecondValue + _
         ThirdValue

' Wrong — no continuation character, causes compile error
Dim result As Long
result = FirstValue +
         SecondValue +
         ThirdValue
\`\`\`

**Constraints:**
- Max line length: 1023 characters
- Max 25 continuations per logical line
- Cannot break inside a string literal — concatenate instead:

\`\`\`vb
' Correct — concatenate separate strings
MsgBox "This is a very long " & _
       "message that spans lines"

' Wrong — line break inside string literal
MsgBox "This is a very long _
       message that spans lines"
\`\`\`

## Variable Declaration

\`\`\`vb
Option Explicit  ' ALWAYS include at module top

' Each variable needs its own As clause
Dim x As Long, y As Long, z As Long

' WRONG — only z is Long; x and y become Variant
Dim x, y, z As Long
\`\`\`

**Prefer \`Long\` over \`Integer\`:** On 32-bit+ systems, \`Long\` is faster than \`Integer\` because VBA internally converts \`Integer\` to \`Long\`. Use \`Long\` for all integer variables.

## Object Assignment

The \`Set\` keyword is **required** for all object assignments.

\`\`\`vb
Dim ws As Worksheet
Set ws = ThisWorkbook.Sheets(1)    ' Correct
ws = ThisWorkbook.Sheets(1)        ' WRONG — Runtime Error

Set ws = Nothing                    ' Release reference
\`\`\`

## Nothing vs Null vs Empty

| Value | Type | Use |
|-------|------|-----|
| \`Nothing\` | Object | Uninitialized/released object |
| \`Null\` | Variant | Database NULL; propagates in expressions |
| \`Empty\` | Variant | Uninitialized Variant |
| \`""\` | String | Zero-length string |
| \`vbNullString\` | String | Null pointer string (faster than \`""\`) |

## Error Handling

\`\`\`vb
Sub Example()
    On Error GoTo ErrorHandler

    ' ... code ...

    Exit Sub          ' REQUIRED before error handler

ErrorHandler:
    MsgBox "Error " & Err.Number & ": " & Err.Description
End Sub
\`\`\`

**\`Try/Catch\` does NOT exist in VBA.** Always use \`On Error GoTo\`.

**\`On Error Resume Next\` is PROHIBITED unless absolutely necessary.** It silently swallows all errors, making debugging extremely difficult. Only use it in narrow, well-documented scopes (e.g., checking if an object exists) and immediately restore normal error handling with \`On Error GoTo 0\` or \`On Error GoTo <label>\`.

\`\`\`vb
' Acceptable — narrow scope with immediate restore
On Error Resume Next
Set ws = ThisWorkbook.Sheets("Optional")
On Error GoTo 0
If ws Is Nothing Then
    ' handle missing sheet
End If

' PROHIBITED — broad scope silencing all errors
On Error Resume Next
' ... dozens of lines ...
' bugs silently ignored here
\`\`\`

## Default Parameter Passing

\`ByRef\` is the default — opposite of most languages.

\`\`\`vb
' paramA is ByRef (default), paramB is explicitly ByVal
Sub Example(paramA As Long, ByVal paramB As String)
End Sub
\`\`\`

## Pre-Output Checklist

Before outputting VBA code, verify:

1. No identifiers match reserved words (especially: \`as\`, \`to\`, \`in\`, \`is\`, \`or\`, \`on\`, \`if\`, \`do\`, \`by\`, \`me\`)
2. No identifiers shadow built-in functions (\`Str\`, \`Val\`, \`Int\`, \`Date\`, \`Time\`, \`Name\`, \`Type\`, \`Line\`, \`Input\`, \`Error\`)
3. No identifiers match object-model members (\`Row\`, \`Rows\`, \`Column\`, \`Columns\`, \`Key\`)
4. All multi-line statements use \` _\` (space + underscore) continuation
5. \`Set\` used for every object assignment
6. \`&\` used for string concatenation (not \`+\`)
7. Arrays use \`()\` not \`[]\`
8. No \`//\` comments, \`==\`, \`!=\`, \`&&\`, \`||\`, \`Try/Catch\`
9. \`Option Explicit\` at module top
10. Each \`Dim\` variable has its own \`As\` clause
11. \`Exit Sub\`/\`Exit Function\` placed before error handler label
12. \`Long\` used instead of \`Integer\` for integer variables
13. No \`On Error Resume Next\` without immediate \`On Error GoTo 0\` restore
`,
  },
  "vba-mdium-flow": {
    name: "vba-mdium-flow",
    description:
      "Use when the MDium mdium-vba MCP server is available — guides the LLM through the extract / edit / import workflow and warns about module-set constraints.",
    content: `# MDium マクロ編集フロー

このセッションでは MDium の \`mdium-vba\` MCP サーバーが利用可能です。

## 標準フロー

1. \`list_vba_modules\` で既存の \`_macros/\` 状態を確認
2. \`_macros/\` が未エクスポートなら \`extract_vba_modules\` を呼ぶ
3. Read/Edit ツールで \`.bas\` / \`.cls\` を編集
4. **編集が完了したら必ず \`import_vba_macros\` を呼ぶ**
5. 応答の \`updatedModules\` をユーザーに報告

## 重要な制約

- このツールは **ツール呼び出しの瞬間のアクティブタブ** に対して動作します
- 毎ターン、ユーザーメッセージ先頭の \`<mdium_context>\` タグで現在のアクティブファイルが分かります
- ツール応答の \`activeFile\` と \`<mdium_context>\` の \`active_file\` が一致することを確認してください
- 会話中にユーザーがタブを切り替えたら \`active_file\` が変わります。ユーザーの意図を必ず確認してください:
  「アクティブタブが {old} から {new} に変わりましたが、このまま続けますか？」
- \`error: "active_tab_changed"\` が返った場合は race condition です。1 回だけ retry してください

## モジュール構成を変えてはいけない

**\`.bas\` / \`.cls\` ファイルの新規作成・削除・リネームはしないでください。** MDium の取り込みは**既存モジュールの中身差し替えのみ**サポートします。

- 新規モジュールを作りたい → ユーザーに Excel の VBE で手動追加してもらい、再度 \`extract_vba_modules\` を呼んで取得
- モジュールを削除したい → ユーザーに Excel の VBE で手動削除してもらう
- リネームしたい → 同様にユーザーに VBE で行ってもらう

\`import_vba_macros\` が \`error: "module_set_changed"\` を返した場合、\`newInFiles\` と \`missingInFiles\` の内容を見て、どちらの変更を戻すべきかをユーザーに確認してください。
`,
  },
};
