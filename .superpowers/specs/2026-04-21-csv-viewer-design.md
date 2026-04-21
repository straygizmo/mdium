# CSV Viewer: Rainbow Editor + Table Preview

**Date**: 2026-04-21
**Status**: Design approved, pending plan

## Goal

When a user selects a `.csv` or `.tsv` file in the file tree, open it in MDium's
Markdown-style split layout:

- **Left (editor pane)**: Monaco with Rainbow CSV-style column coloring.
- **Right (preview pane)**: Read-only tabular rendering of the CSV content.

Pressing `Ctrl+\` collapses the editor so the table occupies the full pane
(same behavior as Markdown today).

## Non-Goals

- **Two-way editing** from the table. The preview is read-only; all edits
  happen in the Monaco editor. Cell-level edit support can be added later by
  reusing `features/table/TableEditor.tsx` but is out of scope for v1.
- **Delimiter auto-detection**. Delimiter is determined by file extension:
  `,` for `.csv`, `\t` for `.tsv`. No UI to change it.
- **Scroll sync** between editor line and table row. RFC 4180 quoted cells
  can span multiple physical lines, so line-to-row mapping is ambiguous. The
  existing `useScrollSync` hook is disabled for CSV tabs.
- **File size cap**. Rendering uses virtual scrolling; parsing is synchronous
  and debounced. A worker-based parser is a future enhancement, not v1.
- **Other DSV variants** (`.psv`, `.scsv`, semicolon CSV). Extension set is
  frozen at `.csv` and `.tsv` for v1.

## User Decisions (from brainstorming)

| # | Decision | Chosen |
|---|----------|--------|
| 1 | Edit mode | **A**. Read-only preview table. |
| 2 | Extension / delimiter | **B**. `.csv` (`,`) and `.tsv` (`\t`) only; no detection. |
| 3 | Layout | **C**. Markdown-style split by default; `Ctrl+\` collapses editor → table full-width. |
| 4 | Header row | **B**. First row as header by default, togglable. |
| 5 | Large files | **A**. No row cap; virtual scrolling. |
| 6 | Parse semantics | **A**. RFC 4180 via Papa Parse. Monaco coloring is a per-line approximation. |

## Architecture

### New file-type category

CSV is promoted from the "code file" bucket (current behavior via `isCodeFile`)
to its own category, parallel to Office/PDF/Mindmap/Image.

**`src/shared/lib/constants.ts`**
- Add `CSV_EXTENSIONS = [".csv", ".tsv"]`.
- Add `getCsvExt(filePath: string): string | null`.
- Update `isCodeFile` to return `false` for CSV/TSV (so the Markdown-style
  split layout is used).

**`src/stores/tab-store.ts`**
- Add `csvFileType?: ".csv" | ".tsv" | null` to the tab type.

**`src/app/App.tsx`**
- `handleFileSelect`: when `getCsvExt(filePath)` is truthy, read as text and
  call `openTab({ ..., csvFileType })`. Set `editorVisible` true so the split
  layout shows.
- Dispatch in the render tree: CSV tabs satisfy the final `else` branch
  (the Markdown split) because `isCodeFile` now returns `false` and no other
  special flag is set. One small conditional is needed inside that branch to
  route the left pane to Monaco instead of the textarea-based `EditorPanel`
  (see "Left pane routing" below). The preview branch is handled separately
  inside `PreviewPanel`.
- Disable `useScrollSync` when `activeTab.csvFileType` is set.

### Left pane routing

Markdown uses the textarea-based `EditorPanel`, but CSV needs Monaco's syntax
highlighting. Two options:

1. In `App.tsx`, when `activeTab.csvFileType`, render `CodeEditorPanel`
   inside the left pane of the split instead of `EditorPanel`.
2. Add a `codeEditor: true` flag on the tab and route inside `EditorPanel`.

Choose option (1): minimal and explicit. The split-layout JSX gets a small
conditional:

```tsx
{editorVisible && (
  <div className="app__editor-pane" style={{ flex: `0 0 ${editorRatio}%` }}>
    {activeTab.csvFileType
      ? <CodeEditorPanel />
      : <EditorPanel editorRef={editorRef} />}
  </div>
)}
```

### Preview pane

`PreviewPanel.tsx` gets a new early-return branch:

```tsx
if (activeTab?.csvFileType) {
  return <CsvPreviewPanel />;
}
```

This mirrors the existing Office/Docx/PDF branches.

## Editor Side: Rainbow CSV Coloring

**New file: `src/features/code-editor/lib/csv-language.ts`**

- Registers Monaco languages `csv` and `tsv` with a Monarch tokenizer.
- Tokenizer states: `root`, `inquote`.
- Tokens emitted: `col0`, `col1`, ..., `col9` — the column index modulo 10.
- State transitions (for `,`-delimited CSV; TSV swaps `,` for `\t`):
  - `root`:
    - `"` → push `inquote`, emit current column token.
    - `,` → stay, increment column index, emit delimiter as `delimiter`.
    - any other char → emit current column token.
  - `inquote`:
    - `""` → emit `col{n}` (escaped quote).
    - `"` → pop to `root`, emit `col{n}`.
    - any other char (including `,`) → emit `col{n}`.
- **Per-line approximation**: Monarch tokenizer state doesn't carry across
  physical lines. Quoted cells with embedded newlines may produce wrong
  coloring on continuation lines. Acceptable tradeoff; the preview table
  (Papa Parse) displays such rows correctly.

**`src/features/code-editor/lib/monaco-setup.ts`**

- Define two themes, `mdium-csv-light` and `mdium-csv-dark`, inheriting from
  `vs` / `vs-dark`, overriding `col0..col9` with a 10-color palette:

  | Token | Light | Dark |
  |-------|-------|------|
  | col0  | `#d73a49` | `#ff7b72` |
  | col1  | `#e36209` | `#ffa657` |
  | col2  | `#b08800` | `#d2a8ff` |
  | col3  | `#22863a` | `#7ee787` |
  | col4  | `#005cc5` | `#79c0ff` |
  | col5  | `#6f42c1` | `#bc8cff` |
  | col6  | `#d03592` | `#f778ba` |
  | col7  | `#795e26` | `#e3b341` |
  | col8  | `#1f7a7a` | `#39c5cf` |
  | col9  | `#6e7781` | `#8b949e` |

  (Initial palette proposal. Exact values to be adjusted during the
  implementation review pass to match MDium's existing theme tokens.)

- `CodeEditorPanel.tsx` selects `mdium-csv-{light|dark}` when the active tab
  is CSV; falls back to `vs`/`vs-dark` otherwise.

**`src/features/code-editor/lib/language-map.ts`**

- `.csv` → `"csv"`, `.tsv` → `"tsv"` (currently both map to `plaintext`).

## Preview Side: Table

**New files**
- `src/features/preview/components/CsvPreviewPanel.tsx`
- `src/features/preview/components/CsvPreviewPanel.css`
- `src/features/preview/lib/csv-parse.ts`
- `src/features/preview/hooks/useCsvParse.ts`

**Dependencies (add to `package.json`)**
- `papaparse` + `@types/papaparse` — RFC 4180 parser, ~45 KB minified.
- `@tanstack/react-virtual` — virtual row rendering.

**`csv-parse.ts`**

```ts
export interface CsvParseResult {
  rows: string[][];
  errors: Papa.ParseError[];
}

export function parseCsv(text: string, delimiter: "," | "\t"): CsvParseResult;
```

Wraps `Papa.parse(text, { delimiter, skipEmptyLines: false })`. Returns raw
rows — the caller decides whether to treat row 0 as header.

**`useCsvParse.ts`**

- `useCsvParse(content: string, delimiter): CsvParseResult`
- 150 ms debounce on `content` to avoid re-parsing on every keystroke.
- `useMemo` keyed on `(debouncedContent, delimiter)`.

**`CsvPreviewPanel.tsx`**

Layout:

```
┌─────────────────────────────────────────────────────┐
│ [☑ Treat first row as header]  120 rows × 8 cols   │ ← toolbar
├─────────────────────────────────────────────────────┤
│ ⚠ 2 parse warnings                                  │ ← optional banner
├─────────────────────────────────────────────────────┤
│ ┌──────┬──────┬──────┬─────────────────────────┐   │
│ │ id   │ name │ age  │ email                   │   │ ← thead (if header on)
│ ├──────┼──────┼──────┼─────────────────────────┤   │
│ │ 1    │ Ada  │ 36   │ ada@example.com         │   │ ← virtualized tbody
│ │ 2    │ Bob  │ 24   │ bob@example.com         │   │
│ │ ...  │ ...  │ ...  │ ...                     │   │
│ └──────┴──────┴──────┴─────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

- Toolbar:
  - Header toggle (`type="checkbox"`), default on. Persisted per-tab in a
    simple `useState` (does not need to survive tab close for v1).
  - Row/column counts (i18n via `t("csv.rows")`, `t("csv.columns")`).
- Warning banner: collapses to a one-liner with count; click to expand full
  list of Papa errors.
- Table:
  - `thead` shows row 0 when header-mode on; otherwise auto-generated
    `Col 1, Col 2, ...`.
  - `tbody` rendered via `@tanstack/react-virtual`'s `useVirtualizer` with a
    fixed row height (~28 px; measured once on first render).
  - Columns: CSS grid, `grid-template-columns: repeat(N, minmax(80px, 1fr))`.
    Horizontal scroll allowed.
  - Each `<td>` carries `data-col-index={i % 10}`; CSS applies the same
    10-color palette as the editor (visual parity). Color applies to text
    only, not background.
  - Empty cells render `—` in a muted tone.
  - Ragged rows (unequal column counts) pad with empty cells up to max column
    count of the dataset.

## Data Flow

```
┌──────────┐     updateTabContent()     ┌──────────┐
│  Monaco  │ ─────────────────────────▶ │ TabStore │
│ (left)   │                            └────┬─────┘
└──────────┘                                 │
                                       content│ (subscribed)
                                             ▼
                                    ┌──────────────────┐
                                    │ useCsvParse (hook)│ ← 150 ms debounce
                                    └────┬─────────────┘
                                         │ rows, errors
                                         ▼
                                    ┌──────────────────┐
                                    │ CsvPreviewPanel  │ (read-only)
                                    └──────────────────┘
```

- Monaco is the single source of truth.
- Save path: the existing `handleSave` writes `activeTab.content` verbatim.
  No CSV-specific save logic.
- External file changes (from `useFileWatcher`) flow through the existing
  `ExternalChangeDialog`, same as Markdown.

## i18n

Add keys to every locale file under `src/i18n/locales/`:

- `csv.treatFirstRowAsHeader`
- `csv.rows`
- `csv.columns`
- `csv.parseWarning` (with count interpolation)
- `csv.parseWarningsTitle`
- `csv.empty`

## Error Handling

- **Parse errors (Papa)**: non-fatal. The table still renders whatever rows
  Papa produced; the warning banner surfaces the count.
- **Empty file**: show `t("csv.empty")` placeholder in the preview pane;
  editor is empty as usual.
- **Binary / non-UTF-8 file**: out of scope. `read_text_file` already enforces
  UTF-8 upstream; if it fails, the existing `handleFileSelect` catch-path
  logs and aborts.

## Testing

**Unit (`csv-parse.ts`)**
- RFC 4180 fixtures: quoted commas, `""` escape, multi-line cells.
- TSV fixture.
- Empty string, single line, trailing newline, unequal column counts.

**Unit (`csv-language.ts`)**
- Tokenize `a,b,c` → `col0, delimiter, col1, delimiter, col2`.
- Tokenize `"a,b",c` → `col0, delimiter, col1` (commas inside quotes don't
  advance column).
- 12-column row → columns 10 and 11 map back to `col0, col1`.

**Manual smoke**
- Open a small `.csv` and `.tsv`; confirm both panes render.
- `Ctrl+\` collapses editor; table fills the pane.
- Toggle header row checkbox; thead/auto-column-names flip correctly.
- Dark and light themes: colors are readable, no clipping.
- ~50,000-row file: scroll in the preview stays smooth; editor stays
  responsive during typing.

## Files Touched

New:
- `src/features/code-editor/lib/csv-language.ts`
- `src/features/preview/components/CsvPreviewPanel.tsx`
- `src/features/preview/components/CsvPreviewPanel.css`
- `src/features/preview/lib/csv-parse.ts`
- `src/features/preview/hooks/useCsvParse.ts`

Modified:
- `src/shared/lib/constants.ts` — add CSV extension set, `isCodeFile` exclusion.
- `src/stores/tab-store.ts` — `csvFileType` field.
- `src/app/App.tsx` — `handleFileSelect` CSV branch, split-pane conditional
  rendering of `CodeEditorPanel` vs `EditorPanel`, disable `useScrollSync`
  for CSV.
- `src/features/code-editor/lib/language-map.ts` — `.csv`/`.tsv` → `csv`/`tsv`.
- `src/features/code-editor/lib/monaco-setup.ts` — register CSV themes.
- `src/features/code-editor/components/CodeEditorPanel.tsx` — select CSV
  theme when tab is CSV.
- `src/features/preview/components/PreviewPanel.tsx` — early-return CSV
  branch.
- `src/i18n/locales/*.json` — new `csv.*` keys.
- `package.json` — add `papaparse`, `@types/papaparse`, `@tanstack/react-virtual`.
