import type { BuiltinSkill } from "@/shared/types";

export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {
  "vba-coding-conventions": {
    name: "vba-coding-conventions",
    version: 1,
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
    version: 4,
    description:
      "Use when editing VBA macros of an .xlsm/.xlam workbook opened in MDium — pull the modules with vba_pull, edit the .bas/.cls files, verify them with vba_run on a disposable copy when the user asked for verification, then write them back with vba_push.",
    content: `# MDium Macro Editing Flow

MDium exposes five tools that operate on a workbook path: \`vba_list\`, \`vba_pull\`, \`vba_push\`, \`vba_run\`, \`xlsx_read\`.
Also read the \`vba-coding-conventions\` skill before writing VBA.

## Which workbook

1. Use the \`active_file\` from the \`<mdium_context>\` block at the top of the latest user message. MDium adds it whenever the user is looking at an .xlsm/.xlam, so the user never has to type a path.
2. If there is no \`<mdium_context>\`, use a path the user wrote.
3. If neither exists, ask the user which workbook to edit. Do not guess.

Pass that path as \`xlsm_path\` to every tool call.

## Standard flow (edit only)

1. \`vba_list\` — see the modules, whether \`<stem>_assets/macros/\` is already extracted, and whether the workbook is locked.
2. If \`extracted\` is false, call \`vba_pull\`. If it is true, the folder may hold edits from an earlier session; ask the user before overwriting it with \`vba_pull\` when the workbook might be newer. \`vba_pull\` also deletes \`.bas\` / \`.cls\` files that match no module (reported as \`removedFiles\`), so push new modules before pulling again.
3. Edit the \`.bas\` / \`.cls\` files in the macros folder with Read / Edit. If the user asked to run, check, verify or test, go to **Run and verify** instead of step 4.
4. **When editing is done, you MUST call \`vba_push\`.** Nothing reaches the workbook until then.
5. Report \`updated\`, \`added\`, \`removed\`, \`skipped\`, \`warnings\` and \`backupPath\` to the user. When nothing changed, \`backupPath\` is null and the workbook was left as it was.

## Run and verify (only when asked)

Run macros only when the user's instruction includes running, checking, verifying or testing (e.g. 実行, 確認, 検証, テスト, 動くか見て, "make sure it works"). If the user asked only for an edit, stop after \`vba_push\` and report.

\`vba_run\` runs macros on a disposable copy of the workbook. It never writes the original. Loop:

1. Decide the target macro(s), the cells that show the result (\`read\` ranges), and the expected values. Derive the expectation from the user's instruction, not from the code.
2. Baseline: call \`vba_run\` with \`source: "workbook"\` (the original as-is) and the macros that exercise the behavior, with the \`read\` ranges. This records what works today.
3. Edit the \`.bas\` / \`.cls\` files. Do NOT call \`vba_push\` yet.
4. Call \`vba_run\` with the default \`source\` (\`macros_dir\`: the original plus your current sources). Put the target macro and the baseline macros in ONE call, in order, and use the same \`read\` ranges, so state carries over and results are comparable.
5. Compare the results with the expectation and with the baseline. Check \`results[].status\`, \`error\`, \`dialogs\`, \`warnings\` and \`cells\`. Handle regressions (something that worked in the baseline and fails now) first.
6. If something is wrong, fix the cause and go back to step 4. Do at most 3 fix-and-rerun cycles. After that, report what you tried and stop; the original workbook is untouched.
7. Stop immediately on \`run_budget_exhausted\` (6 \`vba_run\` calls per user instruction, whatever the number of macros in each call; the budget resets when the user sends the next message). Report the state and wait. \`runBudget\` in each result shows \`used\` / \`limit\`.
8. When the results match, call \`vba_push\`. If it fails with \`workbook_locked\`, say the code is verified and wait for the user to close Excel, then push again.
9. Final report: the changes (\`vba_push\` result), the run results, \`runCopyPath\`, and any remaining \`warnings\`.

### vba_run arguments

- \`macros\`: \`[{ name: "Module.Proc" | "Proc", args?: [...] }]\`, run in order. Supported arg types are numbers, strings and booleans; anything else gives \`invalid_request\`.
- \`inputs\`: strings consumed by \`InputBox\` calls in order. When exhausted, the \`InputBox\` default is used.
- \`msgbox_responses\`: \`"ok"\`, \`"cancel"\`, \`"yes"\`, \`"no"\`, \`"retry"\`, \`"ignore"\` or \`"abort"\`, consumed by \`MsgBox\` calls in order. When exhausted, the default button of that \`MsgBox\` style is used.
- \`read\`: \`[{ sheet, range? }]\`, returned as \`cells\`.
- \`allow_side_effects\` (default false) and \`timeout_ms\` (default 120000, max 300000).
- Result statuses: \`ok\`, \`error\`, \`dialog_interrupted\`, \`timeout\`, \`not_run\`. An \`error\` has \`number\`, \`source\`, \`description\` and \`from\` (\`handler\` or \`dialog\`).
- Other error codes: \`run_in_progress\`, \`macros_dir_not_found\`, \`macro_not_found\`, \`shim_name_conflict\` (a module named \`MdiumShim\`, or a procedure named \`MsgBox\` / \`InputBox\`, exists; rename it), \`excel_not_available\`, \`run_failed\`. With \`source: "macros_dir"\` the \`vba_push\` validation codes (such as \`invalid_module_name\`, \`unencodable_character\`) also apply.
- Only the last 5 run folders are kept.

## Rules while fixing

- Never adjust the expectation to fit the code. If the expectation looks wrong, ask the user.
- Do not add \`On Error Resume Next\` to silence errors. When \`vba_run\` or \`vba_push\` returns an \`on_error_resume_next_added\` warning, remove it and handle the error properly.
- Before adding a helper procedure, grep the macros folder for an existing one. Resolve every \`duplicate_procedure\` warning.
- Fix causes, not symptoms.
- Run copies live under \`<stem>_assets/runs/<time>_<macro>/\` with the original file name, so \`ThisWorkbook.Path\` differs from the original's folder. A failure that only happens on the copy because of paths is not a regression.
- \`side_effects_detected\`: the message lists \`module:line: text\`. Explain to the user what those lines are and what they could do, then call again with \`allow_side_effects: true\`. MDium shows the user an approval dialog.
- \`approval_denied\`: stop and ask the user how to proceed.
- \`approval_timeout\`: report and stop. Do not retry.
- Choose \`inputs\` and \`msgbox_responses\` from the user's instruction and the code. Ask when unsure.
- A \`dialogs\` entry of kind \`window\` with class \`ThunderDFrame\` means a UserForm. It cannot be verified automatically; ask the user to check it by hand.
- \`Value2\` dates are serial numbers. Compare them numerically.
- A run copy is NOT a sandbox for file, mail or process side effects. Code that writes files, sends mail or starts processes really does that.

## Reading values

- \`read\` on \`vba_run\` returns fresh, recalculated values after the macros ran.
- \`xlsx_read\` (\`{ path, ranges: [{ sheet, range? }] }\`) returns the saved values of any \`.xlsx\` / \`.xlsm\` / \`.xlam\`, including a run copy, without Excel. Values are as of the last save.
- Both return \`cells\`: numbers, strings, booleans, \`null\` for empty cells, dates as serial numbers, and error values as labels such as \`#N/A\` or \`#DIV/0!\`.

## Workbook locked by Excel

- \`vba_list\` returns \`locked: true\` and \`vba_push\` fails with \`workbook_locked\` while Excel has the file open.
- You may still pull and edit. Tell the user to close the workbook in Excel, wait for them to confirm, then call \`vba_push\` again.

## Adding and removing modules

- New standard module: create \`<Name>.bas\`. New class module: create \`<Name>.cls\`. \`vba_push\` adds them.
- Remove a standard or class module by deleting its file — but only when the user explicitly asked for the removal. \`vba_push\` reports it under \`removed\`.
- Never delete \`ThisWorkbook.cls\` or sheet \`.cls\` files. Document modules are never removed; a missing file is reported under \`skipped\` and the module keeps its old code.
- Module names: no path separators or \`..\`; start with a letter, ASCII letters/digits/underscore only, at most 31 characters, unique ignoring case, not a VBA keyword. \`vba_push\` rejects the whole push (\`invalid_module_name\`) otherwise.

## File format rules

- Files are UTF-8. Keep \`Attribute VB_Name = "<file name without extension>"\` as the first line.
- Do not write a \`VERSION 1.0 CLASS\` / \`BEGIN\` / \`END\` header in \`.cls\` files; MDium strips it on push.
- If \`vba_push\` fails with \`unencodable_character\`, the workbook's code page cannot store that character. Replace it (for example with an ASCII equivalent or \`ChrW\`) and push again.

## Recovery

\`vba_push\` writes \`<workbook>.bak\` before changing the workbook. If the user reports a broken workbook, tell them to close Excel, delete the workbook, and rename the \`.bak\` back.
`,
  },

};
