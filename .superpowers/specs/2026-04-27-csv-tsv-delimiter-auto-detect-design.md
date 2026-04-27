# CSV/TSV Delimiter Auto-Detection & Quoted-Cell Rainbow Fix — Design

Date: 2026-04-27
Status: Approved (pending implementation plan)

## Problem

Two related issues in the CSV/TSV viewer:

1. **Delimiter is decided by file extension only.** A file with `.csv`
   extension whose actual content is tab-separated renders without rainbow
   coloring — the Monaco tokenizer splits on `,` and finds none, so every
   row becomes a single column with a single color. The PapaParse-backed
   preview also picks the wrong delimiter and shows the entire row in one
   cell.
2. **Quoted headers and string cells are reportedly not rainbow-colored
   in the Monaco editor.** The current tokenizer code path *appears* to
   emit `colN` tokens for characters inside quotes (and existing tests
   pass), but the user observes the symptom in the running editor. The
   actual cause needs to be reproduced and isolated.

## Goals

- Detect the delimiter from file content at open time (one-shot), so files
  with mismatched extensions still render correctly.
- Support 5 delimiters: `,` `\t` `;` `|` `:`.
- Apply the detected delimiter consistently in both the Monaco editor and
  the PapaParse-backed preview panel.
- Reproduce and fix the quoted-cell rainbow regression in the editor.

## Non-Goals

- Manual delimiter override UI (the user explicitly chose "auto-only").
- Re-detection on edit. Detection runs once at open time.
- Detecting fixed-width or other non-delimiter formats.
- Supporting ASCII 30 / 31 or arbitrary single characters beyond the 5
  enumerated delimiters.

## Architecture Overview

Today, the delimiter is decided in two independent places:

- `CodeEditorPanel.tsx` picks the Monaco language by file extension via
  `language-map.ts` (`.csv` → `csv`, `.tsv` → `tsv`), and `csv-language.ts`
  registers two languages with hard-coded delimiters.
- `CsvPreviewPanel.tsx:32` selects the PapaParse delimiter by inspecting
  `activeTab.csvFileType`.

The new design centralizes the delimiter decision into a single tab field
`csvDelimiter`, computed once at open time. Both the editor and the
preview consume that field.

```
ファイル選択
  → read_text_file_auto_encoding
  → detectDelimiter(content)            ← new (one-shot, open-time)
  → タブ作成 { csvFileType, csvDelimiter, content, ... }
       ├── CodeEditorPanel: csvDelimiter → "csv"|"tsv"|"scsv"|"psv"|"colsv" language
       └── CsvPreviewPanel: csvDelimiter → PapaParse delimiter
```

`csvFileType` is retained as the original-extension marker (used by
existing UI such as `App.tsx:1113`); delimiter behavior moves entirely to
the new `csvDelimiter` field.

## Components

### 1. Type & Constants

In a shared module (e.g. `src/features/preview/lib/delimiter.ts`):

```ts
export type CsvDelimiter = "," | "\t" | ";" | "|" | ":";

export const DELIMITER_LANGUAGE_ID: Record<CsvDelimiter, string> = {
  ",":  "csv",
  "\t": "tsv",
  ";":  "scsv",
  "|":  "psv",
  ":":  "colsv",
};

export const ALL_DELIMITERS: readonly CsvDelimiter[] =
  [",", "\t", ";", "|", ":"];
```

### 2. Detection — `src/features/preview/lib/detect-delimiter.ts`

```ts
export function detectDelimiter(text: string): CsvDelimiter {
  // Empty or whitespace-only → fall back to ",".
  // Otherwise: PapaParse with { preview: 10 } and no delimiter, then
  // inspect result.meta.delimiter.
  // If meta.delimiter is one of ALL_DELIMITERS, return it.
  // Otherwise fall back to ",".
}
```

Behavior contract:

- Pure function, no side effects, fully unit-testable.
- `preview: 10` keeps cost bounded for large files.
- Always returns a value from `ALL_DELIMITERS`; never throws.

### 3. Tab Model — `src/stores/tab-store.ts`

Add field:

```ts
csvDelimiter?: CsvDelimiter;
```

Set when the tab is created (in `App.tsx:482` area, right after the file
content is read for a CSV-family extension). Cleared when the tab is
disposed (existing tab lifecycle is unchanged).

### 4. Tokenizer — `src/features/code-editor/lib/csv-language.ts`

- Loosen the `delimiter` parameter type from `"," | "\t"` to `string`.
  Internal logic already does single-char comparison only, so no
  algorithmic change is required.
- Extend `registerCsvLanguages` to register all five language IDs:
  `csv`, `tsv`, `scsv`, `psv`, `colsv`.

### 5. Theme — `src/features/code-editor/lib/monaco-setup.ts`

No change. The `mdium-csv-light` / `mdium-csv-dark` themes match `colN`
token rules, which are emitted by the tokenizer regardless of which of
the five language IDs is active.

### 6. Editor — `src/features/code-editor/components/CodeEditorPanel.tsx`

Replace the language resolution at lines 35–37:

```ts
const language = activeTab?.csvDelimiter
  ? DELIMITER_LANGUAGE_ID[activeTab.csvDelimiter]
  : (activeTab?.filePath ? getMonacoLanguage(activeTab.filePath) : "plaintext");
```

`isCsv = !!activeTab?.csvFileType` (theme/option selection) is unchanged.

### 7. Preview — `src/features/preview/components/CsvPreviewPanel.tsx`

Replace `delimiter = activeTab?.csvFileType === ".tsv" ? "\t" : ","` (line
32) with:

```ts
const delimiter: CsvDelimiter = activeTab?.csvDelimiter ?? ",";
```

`useCsvParse` and `parseCsv*` accept `string` already in spirit; broaden
their parameter type from `"," | "\t"` to `CsvDelimiter`.

### 8. Open-Time Hook — `src/app/App.tsx`

In the existing CSV branch around line 482, after `read_text_file_auto_encoding`
returns content:

```ts
const csvDelimiter = detectDelimiter(content);
// ... existing tab creation ...
csvDelimiter,
```

## Quoted-Cell Rainbow (Issue B)

The cause is unconfirmed. Approach:

1. **Reproduce in tests first.** Add a test in `csv-language.test.ts`
   that mirrors the user-reported scenario — e.g. a header line
   `"id","name","email"` and a body line with quoted cells — and assert
   that each cell's first character emits the expected `colN` token.
2. **If the unit test passes,** the tokenizer is correct and the symptom
   lives downstream — most likely in theme application or Monaco
   integration. Investigate by inspecting tokens in the running editor
   (Monaco's developer tools / `editor.getModel().getLineTokens(...)`)
   and the resolved theme rules. Fix in `monaco-setup.ts` or the relevant
   integration point.
3. **If the unit test fails,** fix the tokenizer.

Either way, the fix ships with a regression test that captures the
exact scenario the user reported.

## Testing

- **`detect-delimiter.test.ts`** (new): files with each of the 5
  delimiters, empty input, single-line input, content with the target
  delimiter appearing inside a quoted field, mixed/noisy content where
  the dominant delimiter should still be detected.
- **`csv-language.test.ts`** (extend): tokenization with `;`, `|`, `:`
  delimiters; quoted-header reproduction test for Issue B.
- **`csv-parse.test.ts`** (extend if needed): parsing a TSV-content file
  via the new `CsvDelimiter` type.

## Risks

- **Misdetection on tiny files.** Single-line / single-column inputs
  often resolve to `,`. This matches today's default and is acceptable.
- **No manual override.** If detection is wrong, the user has no way to
  correct it. Accepted per scoping decision; revisit if reports surface.
- **New language IDs.** `scsv`, `psv`, `colsv` will appear in
  `monaco.languages.getLanguages()`. No code in this app enumerates that
  list for UI, so there is no expected side effect — verified by grep
  during implementation.
- **Quoted-rainbow root cause unknown.** The fix scope cannot be
  pinpointed before reproduction. Mitigated by ordering: write the
  reproduction test before implementing the fix.

## Files Touched (Anticipated)

- `src/features/preview/lib/delimiter.ts` (new) — type, constants
- `src/features/preview/lib/detect-delimiter.ts` (new)
- `src/features/preview/lib/__tests__/detect-delimiter.test.ts` (new)
- `src/features/preview/lib/csv-parse.ts` — broaden delimiter type
- `src/features/preview/lib/csv-parse.worker.ts` — broaden delimiter type
- `src/features/preview/hooks/useCsvParse.ts` — broaden delimiter type
- `src/features/preview/components/CsvPreviewPanel.tsx` — read csvDelimiter
- `src/features/code-editor/lib/csv-language.ts` — string delimiter, register 5
- `src/features/code-editor/lib/__tests__/csv-language.test.ts` — extend
- `src/features/code-editor/components/CodeEditorPanel.tsx` — language selection
- `src/stores/tab-store.ts` — add csvDelimiter field
- `src/app/App.tsx` — call detectDelimiter at open time
