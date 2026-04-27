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
    content: `# MDium Macro Editing Flow

The MDium \`mdium-vba\` MCP server is available in this session.

## Standard Flow

1. Call \`list_vba_modules\` to check the current state of \`_macros/\`
2. If \`_macros/\` has not been exported yet, call \`extract_vba_modules\`
3. Use Read/Edit tools to modify \`.bas\` / \`.cls\` files
4. **When editing is complete, you MUST call \`import_vba_macros\`**
5. Report the \`updatedModules\` from the response back to the user

## Important Constraints

- This tool operates on the **tab that is active at the moment the tool is invoked**
- Every turn, the user message begins with a \`<mdium_context>\` tag that tells you the currently active file
- Verify that the \`activeFile\` in the tool response matches the \`active_file\` inside \`<mdium_context>\`
- If the user switches tabs during the conversation, \`active_file\` changes. Always confirm the user's intent:
  "The active tab changed from {old} to {new}. Do you want to continue?"
- If you receive \`error: "active_tab_changed"\`, that is a race condition — retry exactly once

## Do Not Change the Module Set

**Do NOT create, delete, or rename \`.bas\` / \`.cls\` files.** MDium's import only supports **replacing the contents of existing modules**.

- To add a new module → ask the user to add it manually in Excel's VBE, then call \`extract_vba_modules\` again to pick it up
- To delete a module → ask the user to delete it manually in Excel's VBE
- To rename a module → ask the user to rename it in the VBE the same way

If \`import_vba_macros\` returns \`error: "module_set_changed"\`, inspect \`newInFiles\` and \`missingInFiles\` and ask the user which side of the discrepancy should be reverted.
`,
  },
};
