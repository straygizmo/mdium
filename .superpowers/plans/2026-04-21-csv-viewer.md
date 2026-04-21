# CSV Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `.csv` or `.tsv` file is selected in the file tree, show Rainbow-CSV-style colored text in a Monaco editor on the left and a read-only virtualized table on the right, reusing the existing Markdown split layout (including `Ctrl+\` editor toggle).

**Architecture:** CSV becomes a first-class file category alongside Office/Mindmap/Image. On the left pane the Markdown split routes to `CodeEditorPanel` (Monaco) instead of `EditorPanel` (textarea). A stateful Monaco tokens provider assigns one of 10 cycling color tokens per column. The right pane hosts a new `CsvPreviewPanel` that parses content with Papa Parse and renders with `@tanstack/react-virtual`. The same 10-color palette is reused in preview cell CSS for visual parity.

**Tech Stack:** TypeScript, React, Monaco (`@monaco-editor/react`), Zustand, i18next, Vitest + happy-dom. New dependencies: `papaparse`, `@types/papaparse`, `@tanstack/react-virtual`.

**Spec:** `.superpowers/specs/2026-04-21-csv-viewer-design.md`

**Refinements from spec:**
- Use `monaco.languages.setTokensProvider` (stateful tokenizer) instead of Monarch. State carries across physical lines, so quoted multi-line cells are colored correctly. This strictly improves on the "per-line approximation" the spec called acceptable.
- `useScrollSync` needs no explicit disable: it takes an `HTMLTextAreaElement` ref, which remains null for CSV tabs (Monaco used instead), so the hook early-returns.

---

## File Structure

**New files:**
- `src/features/code-editor/lib/csv-language.ts` — Monaco language registration + stateful tokens provider.
- `src/features/code-editor/lib/__tests__/csv-language.test.ts`
- `src/features/preview/lib/csv-parse.ts` — Papa Parse wrapper.
- `src/features/preview/lib/__tests__/csv-parse.test.ts`
- `src/features/preview/hooks/useCsvParse.ts` — debounced parse hook.
- `src/features/preview/components/CsvPreviewPanel.tsx`
- `src/features/preview/components/CsvPreviewPanel.css`
- `src/shared/i18n/locales/ja/csv.json`
- `src/shared/i18n/locales/en/csv.json`

**Modified files:**
- `src/shared/lib/constants.ts` — CSV extension set, `getCsvExt`, `isCodeFile` exclusion.
- `src/shared/lib/__tests__/constants.test.ts` (create if absent) — tests for `getCsvExt` and `isCodeFile`.
- `src/stores/tab-store.ts` — add `csvFileType` field to `Tab`.
- `src/app/App.tsx` — handle `.csv`/`.tsv` in `handleFileSelect`; route split-layout left pane to `CodeEditorPanel` when CSV.
- `src/features/code-editor/lib/language-map.ts` — `.csv` → `csv`, `.tsv` → `tsv`.
- `src/features/code-editor/lib/monaco-setup.ts` — define `mdium-csv-light` / `mdium-csv-dark` themes.
- `src/features/code-editor/components/CodeEditorPanel.tsx` — pick CSV theme when tab is CSV.
- `src/features/preview/components/PreviewPanel.tsx` — early-return `CsvPreviewPanel` branch.
- `src/shared/i18n/index.ts` — register the new `csv` namespace.
- `package.json` — add `papaparse`, `@types/papaparse`, `@tanstack/react-virtual`.

---

## Task 1: CSV extension constants + `isCodeFile` exclusion

**Files:**
- Modify: `src/shared/lib/constants.ts`
- Test: `src/shared/lib/__tests__/constants.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/shared/lib/__tests__/constants.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { getCsvExt, isCodeFile } from "../constants";

describe("getCsvExt", () => {
  it("returns .csv for .csv", () => expect(getCsvExt("data.csv")).toBe(".csv"));
  it("returns .tsv for .tsv", () => expect(getCsvExt("data.tsv")).toBe(".tsv"));
  it("is case-insensitive", () => expect(getCsvExt("DATA.CSV")).toBe(".csv"));
  it("returns null for other", () => expect(getCsvExt("x.txt")).toBeNull());
  it("returns null for no extension", () => expect(getCsvExt("README")).toBeNull());
});

describe("isCodeFile", () => {
  it("returns false for .csv", () => expect(isCodeFile("x.csv")).toBe(false));
  it("returns false for .tsv", () => expect(isCodeFile("x.tsv")).toBe(false));
  it("returns false for .md", () => expect(isCodeFile("x.md")).toBe(false));
  it("returns true for .ts", () => expect(isCodeFile("x.ts")).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/__tests__/constants.test.ts`
Expected: FAIL — `getCsvExt` is not exported.

- [ ] **Step 3: Implement**

Modify `src/shared/lib/constants.ts`:

```ts
export const CSV_EXTENSIONS = [".csv", ".tsv"];

export function getCsvExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return CSV_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}
```

Update `isCodeFile` in the same file to exclude CSV (add one line, preserving existing checks):

```ts
export function isCodeFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md")) return false;
  if (lower.endsWith(".video.json")) return false;
  if (getOfficeExt(lower)) return false;
  if (getPdfExt(lower)) return false;
  if (getMindmapExt(lower)) return false;
  if (getImageExt(lower)) return false;
  if (getCsvExt(lower)) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/lib/__tests__/constants.test.ts`
Expected: PASS — 9 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/constants.ts src/shared/lib/__tests__/constants.test.ts
git commit -m "feat(csv): add CSV/TSV extension detection helpers"
```

---

## Task 2: CSV parser wrapper + tests

**Files:**
- Create: `src/features/preview/lib/csv-parse.ts`
- Test: `src/features/preview/lib/__tests__/csv-parse.test.ts`
- Modify: `package.json` (add papaparse)

- [ ] **Step 1: Install papaparse**

Run: `npm install papaparse && npm install -D @types/papaparse`
Expected: `package.json` and `package-lock.json` updated.

- [ ] **Step 2: Write the failing test**

Create `src/features/preview/lib/__tests__/csv-parse.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseCsv } from "../csv-parse";

describe("parseCsv", () => {
  it("parses a simple CSV", () => {
    const { rows } = parseCsv("a,b,c\n1,2,3", ",");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("parses a TSV", () => {
    const { rows } = parseCsv("a\tb\n1\t2", "\t");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("respects RFC 4180 quoted commas", () => {
    const { rows } = parseCsv('"a,b","c"\n1,2', ",");
    expect(rows).toEqual([["a,b", "c"], ["1", "2"]]);
  });

  it("respects RFC 4180 embedded newlines", () => {
    const { rows } = parseCsv('"a\nb",c', ",");
    expect(rows).toEqual([["a\nb", "c"]]);
  });

  it("respects RFC 4180 escaped quotes", () => {
    const { rows } = parseCsv('"he said ""hi""",ok', ",");
    expect(rows).toEqual([['he said "hi"', "ok"]]);
  });

  it("returns empty rows for empty input", () => {
    expect(parseCsv("", ",").rows).toEqual([]);
  });

  it("handles ragged rows", () => {
    const { rows } = parseCsv("a,b,c\n1,2\n3,4,5,6", ",");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2"], ["3", "4", "5", "6"]]);
  });

  it("preserves trailing empty cells", () => {
    const { rows } = parseCsv("a,b,\n1,,3", ",");
    expect(rows).toEqual([["a", "b", ""], ["1", "", "3"]]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/preview/lib/__tests__/csv-parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser wrapper**

Create `src/features/preview/lib/csv-parse.ts`:

```ts
import Papa from "papaparse";

export interface CsvParseError {
  row: number;
  message: string;
}

export interface CsvParseResult {
  rows: string[][];
  errors: CsvParseError[];
  maxColumns: number;
}

export function parseCsv(text: string, delimiter: "," | "\t"): CsvParseResult {
  if (text === "") {
    return { rows: [], errors: [], maxColumns: 0 };
  }
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: false,
  });
  const rows = result.data;
  let maxColumns = 0;
  for (const row of rows) {
    if (row.length > maxColumns) maxColumns = row.length;
  }
  const errors: CsvParseError[] = result.errors.map((e) => ({
    row: e.row ?? -1,
    message: e.message,
  }));
  return { rows, errors, maxColumns };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/preview/lib/__tests__/csv-parse.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/features/preview/lib/csv-parse.ts src/features/preview/lib/__tests__/csv-parse.test.ts
git commit -m "feat(csv): add Papa Parse wrapper with RFC 4180 support"
```

---

## Task 3: Monaco stateful CSV tokens provider + tests

**Files:**
- Create: `src/features/code-editor/lib/csv-language.ts`
- Test: `src/features/code-editor/lib/__tests__/csv-language.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/code-editor/lib/__tests__/csv-language.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { CsvTokenState, tokenizeCsvLine } from "../csv-language";

describe("tokenizeCsvLine (comma)", () => {
  it("cycles columns 0..9 then wraps", () => {
    const tokens = tokenizeCsvLine(
      "a,b,c,d,e,f,g,h,i,j,k,l",
      new CsvTokenState(0, false),
      ",",
    ).tokens;
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect(cellTokens.map((t) => t.type)).toEqual([
      "col0", "col1", "col2", "col3", "col4",
      "col5", "col6", "col7", "col8", "col9",
      "col0", "col1",
    ]);
  });

  it("does not advance columns inside quoted field", () => {
    const { tokens } = tokenizeCsvLine(
      '"a,b",c',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    // All chars of "a,b" are col0; "c" is col1.
    const uniqueCols = [...new Set(cellTokens.map((t) => t.type))];
    expect(uniqueCols).toEqual(["col0", "col1"]);
  });

  it("treats '\"\"' inside quoted field as escaped quote (stays in field)", () => {
    const { tokens, endState } = tokenizeCsvLine(
      '"a""b",c',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    const uniqueCols = [...new Set(cellTokens.map((t) => t.type))];
    expect(uniqueCols).toEqual(["col0", "col1"]);
    expect(endState.inQuote).toBe(false);
  });

  it("carries inQuote state across lines", () => {
    // First line opens quote, does not close it.
    const line1 = tokenizeCsvLine(
      '"multi',
      new CsvTokenState(0, false),
      ",",
    );
    expect(line1.endState.inQuote).toBe(true);
    expect(line1.endState.column).toBe(0);

    // Second line closes quote, then advances to column 1.
    const line2 = tokenizeCsvLine(
      'line",next',
      line1.endState,
      ",",
    );
    expect(line2.endState.inQuote).toBe(false);
    expect(line2.endState.column).toBe(1);
  });

  it("resets column to 0 at start of fresh line (non-quoted)", () => {
    const state = new CsvTokenState(0, false);
    // After a full CSV row, the line-end resets column index via newline.
    // In the tokenizer, newlines are line boundaries, so tokenizeCsvLine is
    // called per-line by Monaco. A fresh line begins with state.column === 0
    // unless mid-quote. Verified by: giving a fresh state to line 2.
    const { tokens } = tokenizeCsvLine("x,y", state, ",");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual(["col0", "col1"]);
  });
});

describe("tokenizeCsvLine (tab)", () => {
  it("uses tab as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a\tb\tc", new CsvTokenState(0, false), "\t");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/code-editor/lib/__tests__/csv-language.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tokenizer**

Create `src/features/code-editor/lib/csv-language.ts`:

```ts
import * as monaco from "monaco-editor";

export class CsvTokenState implements monaco.languages.IState {
  constructor(
    public readonly column: number,
    public readonly inQuote: boolean,
  ) {}

  clone(): monaco.languages.IState {
    return new CsvTokenState(this.column, this.inQuote);
  }

  equals(other: monaco.languages.IState): boolean {
    if (!(other instanceof CsvTokenState)) return false;
    return other.column === this.column && other.inQuote === this.inQuote;
  }
}

interface CsvToken {
  startIndex: number;
  type: string;
}

export interface CsvLineResult {
  tokens: CsvToken[];
  endState: CsvTokenState;
}

function colToken(column: number): string {
  return `col${column % 10}`;
}

/**
 * Tokenize a single physical line. State carries column index and quote flag
 * across lines, so quoted multi-line cells are colored correctly.
 *
 * End-of-line behavior: if we are NOT in a quote, the next line resets the
 * column to 0 (a CSV logical row ended). If we ARE in a quote, column is
 * preserved (the same logical cell continues).
 */
export function tokenizeCsvLine(
  line: string,
  startState: CsvTokenState,
  delimiter: "," | "\t",
): CsvLineResult {
  const tokens: CsvToken[] = [];
  // If the previous line ended outside a quote, this line is a new CSV row —
  // reset the column counter to 0. If it ended inside a quote, carry the
  // column forward so the same logical cell keeps its color.
  let column = startState.inQuote ? startState.column : 0;
  let inQuote = startState.inQuote;
  let i = 0;
  let pendingStart = 0;
  let pendingType: string | null = null;

  const emit = (start: number, type: string) => {
    if (pendingType === type) return;
    if (pendingType !== null) {
      tokens.push({ startIndex: pendingStart, type: pendingType });
    }
    pendingStart = start;
    pendingType = type;
  };

  while (i < line.length) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          emit(i, colToken(column));
          i += 2;
          continue;
        }
        emit(i, colToken(column));
        inQuote = false;
        i += 1;
        continue;
      }
      emit(i, colToken(column));
      i += 1;
      continue;
    }
    // not in quote
    if (ch === '"') {
      emit(i, colToken(column));
      inQuote = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      emit(i, "delimiter");
      column += 1;
      i += 1;
      continue;
    }
    emit(i, colToken(column));
    i += 1;
  }

  if (pendingType !== null) {
    tokens.push({ startIndex: pendingStart, type: pendingType });
  }

  // Preserve the actual column reached so callers can inspect progress.
  // The column-reset for fresh rows happens at the START of the next call
  // (when startState.inQuote is false) rather than here.
  const endState = new CsvTokenState(column, inQuote);
  return { tokens, endState };
}

export function registerCsvLanguages(monacoInstance: typeof monaco): void {
  const register = (id: string, delimiter: "," | "\t") => {
    if (monacoInstance.languages.getLanguages().some((l) => l.id === id)) return;
    monacoInstance.languages.register({ id });
    monacoInstance.languages.setTokensProvider(id, {
      getInitialState: () => new CsvTokenState(0, false),
      tokenize: (line, state) => {
        const result = tokenizeCsvLine(
          line,
          state as CsvTokenState,
          delimiter,
        );
        return {
          tokens: result.tokens.map((t) => ({
            startIndex: t.startIndex,
            scopes: t.type,
          })),
          endState: result.endState,
        };
      },
    });
  };
  register("csv", ",");
  register("tsv", "\t");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/code-editor/lib/__tests__/csv-language.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/features/code-editor/lib/csv-language.ts src/features/code-editor/lib/__tests__/csv-language.test.ts
git commit -m "feat(csv): add Monaco stateful tokens provider for Rainbow coloring"
```

---

## Task 4: Add `csvFileType` to Tab, wire language-map, register Monaco themes

**Files:**
- Modify: `src/stores/tab-store.ts`
- Modify: `src/features/code-editor/lib/language-map.ts`
- Modify: `src/features/code-editor/lib/monaco-setup.ts`

- [ ] **Step 1: Add `csvFileType` field**

In `src/stores/tab-store.ts`, inside the `Tab` interface (after `imageFileType`, before `imageBlobUrl`):

```ts
  /** CSV/TSV file extension (e.g., ".csv") */
  csvFileType?: ".csv" | ".tsv";
```

- [ ] **Step 2: Map CSV/TSV to their Monaco language ids**

In `src/features/code-editor/lib/language-map.ts`, replace the two entries:

```ts
  ".csv": "csv",
  ".tsv": "tsv",
```

(the current file has only `.csv` → `plaintext`; add `.tsv` alongside in the `// Data` section.)

- [ ] **Step 3: Register languages and themes in monaco-setup**

In `src/features/code-editor/lib/monaco-setup.ts`, at the bottom of the file after `loader.config`:

```ts
import { registerCsvLanguages } from "./csv-language";

registerCsvLanguages(monaco);

const CSV_COLORS_LIGHT = [
  "D73A49", "E36209", "B08800", "22863A", "005CC5",
  "6F42C1", "D03592", "795E26", "1F7A7A", "6E7781",
];
const CSV_COLORS_DARK = [
  "FF7B72", "FFA657", "D2A8FF", "7EE787", "79C0FF",
  "BC8CFF", "F778BA", "E3B341", "39C5CF", "8B949E",
];

monaco.editor.defineTheme("mdium-csv-light", {
  base: "vs",
  inherit: true,
  rules: CSV_COLORS_LIGHT.map((color, i) => ({
    token: `col${i}`,
    foreground: color,
  })),
  colors: {},
});

monaco.editor.defineTheme("mdium-csv-dark", {
  base: "vs-dark",
  inherit: true,
  rules: CSV_COLORS_DARK.map((color, i) => ({
    token: `col${i}`,
    foreground: color,
  })),
  colors: {},
});
```

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/stores/tab-store.ts src/features/code-editor/lib/language-map.ts src/features/code-editor/lib/monaco-setup.ts
git commit -m "feat(csv): wire CSV/TSV into tab store, language map, and Monaco themes"
```

---

## Task 5: `CodeEditorPanel` picks CSV theme when tab is CSV

**Files:**
- Modify: `src/features/code-editor/components/CodeEditorPanel.tsx`

- [ ] **Step 1: Update the theme selection**

Replace the `theme={themeType === "dark" ? "vs-dark" : "vs"}` prop with logic that switches to the CSV theme when the tab is CSV:

```tsx
  const isCsv = !!activeTab?.csvFileType;
  const theme = themeType === "dark"
    ? (isCsv ? "mdium-csv-dark" : "vs-dark")
    : (isCsv ? "mdium-csv-light" : "vs");
```

And in the `<Editor ...>` JSX, pass `theme={theme}`.

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

Note: `monaco-setup` is already imported once at `src/main.tsx:1` for its side-effects (Monaco environment + language/theme registration). No further import is needed here.

- [ ] **Step 3: Commit**

```bash
git add src/features/code-editor/components/CodeEditorPanel.tsx
git commit -m "feat(csv): select CSV Monaco theme for CSV/TSV tabs"
```

---

## Task 6: Route `.csv`/`.tsv` into a tab from `handleFileSelect`

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Import `getCsvExt`**

In the `constants` import line in `src/app/App.tsx:10`, add `getCsvExt`:

```tsx
import { getOfficeExt, getMindmapExt, getImageExt, getPdfExt, getCsvExt, isCodeFile } from "@/shared/lib/constants";
```

- [ ] **Step 2: Branch on CSV inside `handleFileSelect`**

In `handleFileSelect` (around `src/app/App.tsx:353`), detect CSV before the generic text-file fallthrough. Add these lines after the existing `imageExt` detection and before the `else` (generic text) branch:

```tsx
        const csvExt = getCsvExt(filePath);
```

Inside the `else` branch (the text-file path that currently calls `read_text_file`), after `openTab({...})`, extend the tab props with `csvFileType`:

```tsx
        } else {
          const content = await invoke<string>("read_text_file", { path: filePath });
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content,
            isCodeFile: isCodeFile(filePath),
            csvFileType: csvExt ?? undefined,
          });
        }
```

- [ ] **Step 3: Show editor+preview split for CSV**

At the end of `handleFileSelect`, the line that sets editor visibility currently reads:

```tsx
        useUiStore.getState().setEditorVisible(isMd && !imageExt && !isVideoJson && !isCode);
```

Change it so CSV is also allowed to show the split:

```tsx
        useUiStore.getState().setEditorVisible((isMd || !!csvExt) && !imageExt && !isVideoJson);
```

Note: we removed `!isCode` because `isCodeFile` will now return `false` for CSV (from Task 1), so `isCode` is already false for CSV. For other code files (.ts etc.), the render-tree dispatch still picks `CodeEditorPanel` directly via the `activeTab.isCodeFile` branch, so editor visibility doesn't affect them.

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(csv): open CSV/TSV files with the split editor+preview layout"
```

---

## Task 7: Route left pane to `CodeEditorPanel` for CSV in the split layout

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Update the split-layout render**

In `src/app/App.tsx` inside the final `else` branch (the Markdown split, around line 1052), the left pane currently renders:

```tsx
                    <div className="app__editor-pane" style={{ flex: `0 0 ${editorRatio}%` }}>
                      <EditorPanel editorRef={editorRef} />
                    </div>
```

Change it to conditionally render `CodeEditorPanel` when the tab is CSV:

```tsx
                    <div className="app__editor-pane" style={{ flex: `0 0 ${editorRatio}%` }}>
                      {activeTab.csvFileType
                        ? <CodeEditorPanel />
                        : <EditorPanel editorRef={editorRef} />}
                    </div>
```

(`CodeEditorPanel` is already imported at `src/app/App.tsx:31`.)

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(csv): route CSV split-layout left pane to Monaco editor"
```

---

## Task 8: i18n keys for CSV preview

**Files:**
- Create: `src/shared/i18n/locales/ja/csv.json`
- Create: `src/shared/i18n/locales/en/csv.json`
- Modify: `src/shared/i18n/index.ts`

- [ ] **Step 1: Write Japanese locale**

Create `src/shared/i18n/locales/ja/csv.json`:

```json
{
  "treatFirstRowAsHeader": "1行目をヘッダとして扱う",
  "rows": "{{count}} 行",
  "columns": "{{count}} 列",
  "parseWarning": "{{count}} 件のパース警告",
  "parseWarningsTitle": "パース警告",
  "empty": "（空のファイル）"
}
```

- [ ] **Step 2: Write English locale**

Create `src/shared/i18n/locales/en/csv.json`:

```json
{
  "treatFirstRowAsHeader": "Treat first row as header",
  "rows": "{{count}} rows",
  "columns": "{{count}} columns",
  "parseWarning": "{{count}} parse warnings",
  "parseWarningsTitle": "Parse warnings",
  "empty": "(empty file)"
}
```

- [ ] **Step 3: Register namespace in `index.ts`**

In `src/shared/i18n/index.ts`, add imports at the top (alongside existing ones):

```ts
import jaCsv from "./locales/ja/csv.json";
import enCsv from "./locales/en/csv.json";
```

And inside both `ja:` and `en:` resource blocks, add:

```ts
      csv: jaCsv,
```

and

```ts
      csv: enCsv,
```

respectively.

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/csv.json src/shared/i18n/locales/en/csv.json src/shared/i18n/index.ts
git commit -m "feat(csv): add i18n strings for CSV preview panel"
```

---

## Task 9: `useCsvParse` hook

**Files:**
- Create: `src/features/preview/hooks/useCsvParse.ts`

- [ ] **Step 1: Implement the hook**

Create `src/features/preview/hooks/useCsvParse.ts`:

```ts
import { useEffect, useMemo, useState } from "react";
import { parseCsv, type CsvParseResult } from "../lib/csv-parse";

export function useCsvParse(
  content: string,
  delimiter: "," | "\t",
  debounceMs = 150,
): CsvParseResult {
  const [debounced, setDebounced] = useState(content);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  return useMemo(
    () => parseCsv(debounced, delimiter),
    [debounced, delimiter],
  );
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/preview/hooks/useCsvParse.ts
git commit -m "feat(csv): add debounced useCsvParse hook"
```

---

## Task 10: Install `@tanstack/react-virtual`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run: `npm install @tanstack/react-virtual`
Expected: `package.json` updated, no errors.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(csv): add @tanstack/react-virtual dependency"
```

---

## Task 11: `CsvPreviewPanel` — basic render (no virtualization yet)

**Files:**
- Create: `src/features/preview/components/CsvPreviewPanel.tsx`
- Create: `src/features/preview/components/CsvPreviewPanel.css`

- [ ] **Step 1: Write the component**

Create `src/features/preview/components/CsvPreviewPanel.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useCsvParse } from "../hooks/useCsvParse";
import "./CsvPreviewPanel.css";

export function CsvPreviewPanel() {
  const { t } = useTranslation("csv");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const [headerMode, setHeaderMode] = useState(true);

  const delimiter: "," | "\t" = activeTab?.csvFileType === ".tsv" ? "\t" : ",";
  const { rows, errors, maxColumns } = useCsvParse(
    activeTab?.content ?? "",
    delimiter,
  );

  const { headerRow, bodyRows } = useMemo(() => {
    if (rows.length === 0) return { headerRow: null, bodyRows: [] as string[][] };
    if (headerMode) {
      return { headerRow: rows[0], bodyRows: rows.slice(1) };
    }
    const synthetic = Array.from({ length: maxColumns }, (_, i) => `Col ${i + 1}`);
    return { headerRow: synthetic, bodyRows: rows };
  }, [rows, maxColumns, headerMode]);

  if (!activeTab) return null;

  if (rows.length === 0) {
    return <div className="csv-preview csv-preview--empty">{t("empty")}</div>;
  }

  const columnCount = maxColumns;
  const gridTemplate = `repeat(${columnCount}, minmax(80px, 1fr))`;

  return (
    <div className="csv-preview">
      <div className="csv-preview__toolbar">
        <label className="csv-preview__toggle">
          <input
            type="checkbox"
            checked={headerMode}
            onChange={(e) => setHeaderMode(e.target.checked)}
          />
          {t("treatFirstRowAsHeader")}
        </label>
        <span className="csv-preview__count">
          {t("rows", { count: bodyRows.length })} ×{" "}
          {t("columns", { count: columnCount })}
        </span>
      </div>
      {errors.length > 0 && (
        <div
          className="csv-preview__warning"
          title={errors.map((e) => `row ${e.row}: ${e.message}`).join("\n")}
        >
          ⚠ {t("parseWarning", { count: errors.length })}
        </div>
      )}
      <div className="csv-preview__scroll">
        <div className="csv-preview__grid">
          {headerRow && (
            <div
              className="csv-preview__row csv-preview__row--header"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {Array.from({ length: columnCount }, (_, i) => (
                <div
                  key={i}
                  className="csv-preview__cell"
                  data-col-index={i % 10}
                >
                  {headerRow[i] ?? ""}
                </div>
              ))}
            </div>
          )}
          {bodyRows.map((row, r) => (
            <div
              key={r}
              className="csv-preview__row"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {Array.from({ length: columnCount }, (_, c) => {
                const cell = row[c];
                return (
                  <div
                    key={c}
                    className={
                      cell === undefined || cell === ""
                        ? "csv-preview__cell csv-preview__cell--empty"
                        : "csv-preview__cell"
                    }
                    data-col-index={c % 10}
                  >
                    {cell === undefined || cell === "" ? "—" : cell}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the CSS with the matching palette**

Create `src/features/preview/components/CsvPreviewPanel.css`:

```css
.csv-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
  background: var(--bg-panel, #fff);
  color: var(--text, #222);
}

.csv-preview--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #888);
  padding: 24px;
}

.csv-preview__toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  flex-shrink: 0;
}

.csv-preview__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.csv-preview__count {
  color: var(--text-muted, #888);
}

.csv-preview__warning {
  padding: 6px 10px;
  background: var(--warn-bg, #fff4e5);
  color: var(--warn-fg, #995c00);
  border-bottom: 1px solid var(--border, #e5e5e5);
  cursor: help;
  flex-shrink: 0;
}

.csv-preview__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.csv-preview__grid {
  display: flex;
  flex-direction: column;
  min-width: max-content;
}

.csv-preview__row {
  display: grid;
  border-bottom: 1px solid var(--border, #eee);
}

.csv-preview__row--header {
  font-weight: 700;
  background: var(--bg-alt, #f6f8fa);
  position: sticky;
  top: 0;
  z-index: 1;
}

.csv-preview__cell {
  padding: 4px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-right: 1px solid var(--border, #eee);
}

.csv-preview__cell--empty {
  color: var(--text-muted, #bbb);
}

/* Rainbow palette — matches Monaco theme tokens col0..col9 (light) */
.csv-preview__cell[data-col-index="0"] { color: #d73a49; }
.csv-preview__cell[data-col-index="1"] { color: #e36209; }
.csv-preview__cell[data-col-index="2"] { color: #b08800; }
.csv-preview__cell[data-col-index="3"] { color: #22863a; }
.csv-preview__cell[data-col-index="4"] { color: #005cc5; }
.csv-preview__cell[data-col-index="5"] { color: #6f42c1; }
.csv-preview__cell[data-col-index="6"] { color: #d03592; }
.csv-preview__cell[data-col-index="7"] { color: #795e26; }
.csv-preview__cell[data-col-index="8"] { color: #1f7a7a; }
.csv-preview__cell[data-col-index="9"] { color: #6e7781; }

@media (prefers-color-scheme: dark) {
  .csv-preview__cell[data-col-index="0"] { color: #ff7b72; }
  .csv-preview__cell[data-col-index="1"] { color: #ffa657; }
  .csv-preview__cell[data-col-index="2"] { color: #d2a8ff; }
  .csv-preview__cell[data-col-index="3"] { color: #7ee787; }
  .csv-preview__cell[data-col-index="4"] { color: #79c0ff; }
  .csv-preview__cell[data-col-index="5"] { color: #bc8cff; }
  .csv-preview__cell[data-col-index="6"] { color: #f778ba; }
  .csv-preview__cell[data-col-index="7"] { color: #e3b341; }
  .csv-preview__cell[data-col-index="8"] { color: #39c5cf; }
  .csv-preview__cell[data-col-index="9"] { color: #8b949e; }
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx src/features/preview/components/CsvPreviewPanel.css
git commit -m "feat(csv): add CsvPreviewPanel with rainbow-tinted table"
```

---

## Task 12: Wire `CsvPreviewPanel` into `PreviewPanel`

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Import `CsvPreviewPanel`**

At the top of `src/features/preview/components/PreviewPanel.tsx`, add:

```tsx
import { CsvPreviewPanel } from "./CsvPreviewPanel";
```

- [ ] **Step 2: Add early-return branch**

Near the top of the `PreviewPanel` component's return logic (before any other preview-type branch), add:

```tsx
  if (activeTab?.csvFileType) {
    return (
      <div className="preview-panel" ref={previewRef}>
        <CsvPreviewPanel />
      </div>
    );
  }
```

Place this branch immediately after the guard that handles `!activeTab` and before the Office/Docx/PDF branches. (Scan the existing file for `isOfficeFile` — insert the CSV branch just before that.)

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(csv): dispatch CSV tabs to CsvPreviewPanel"
```

---

## Task 13: Virtualize `CsvPreviewPanel` rows

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx`
- Modify: `src/features/preview/components/CsvPreviewPanel.css`

- [ ] **Step 1: Replace the body map with `useVirtualizer`**

In `src/features/preview/components/CsvPreviewPanel.tsx`, add a `useRef` for the scroll container and wrap body rendering with `@tanstack/react-virtual`. Update imports:

```tsx
import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
```

Inside the component, after computing `bodyRows`:

```tsx
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });
```

Change the scroll container to attach the ref:

```tsx
      <div className="csv-preview__scroll" ref={parentRef}>
        <div
          className="csv-preview__grid"
          style={{ height: rowVirtualizer.getTotalSize() + HEADER_HEIGHT }}
        >
          {headerRow && (
            <div
              className="csv-preview__row csv-preview__row--header"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {Array.from({ length: columnCount }, (_, i) => (
                <div
                  key={i}
                  className="csv-preview__cell"
                  data-col-index={i % 10}
                >
                  {headerRow[i] ?? ""}
                </div>
              ))}
            </div>
          )}
          {rowVirtualizer.getVirtualItems().map((v) => {
            const row = bodyRows[v.index];
            return (
              <div
                key={v.key}
                className="csv-preview__row csv-preview__row--virtual"
                style={{
                  gridTemplateColumns: gridTemplate,
                  transform: `translateY(${v.start + HEADER_HEIGHT}px)`,
                }}
                ref={rowVirtualizer.measureElement}
                data-index={v.index}
              >
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = row[c];
                  return (
                    <div
                      key={c}
                      className={
                        cell === undefined || cell === ""
                          ? "csv-preview__cell csv-preview__cell--empty"
                          : "csv-preview__cell"
                      }
                      data-col-index={c % 10}
                    >
                      {cell === undefined || cell === "" ? "—" : cell}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
```

Add the constant at the top of the file, outside the component:

```tsx
const HEADER_HEIGHT = 30;
```

- [ ] **Step 2: Update CSS for absolute-positioned virtual rows**

In `CsvPreviewPanel.css`, add:

```css
.csv-preview__grid {
  position: relative;
}

.csv-preview__row--virtual {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}
```

And change `.csv-preview__row--header` to stay on top:

```css
.csv-preview__row--header {
  position: sticky;
  top: 0;
  z-index: 2;
  font-weight: 700;
  background: var(--bg-alt, #f6f8fa);
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx src/features/preview/components/CsvPreviewPanel.css
git commit -m "feat(csv): virtualize preview rows for large files"
```

---

## Task 14: Manual smoke test checklist

Not code — a human QA pass before declaring done. Record results in the PR description.

- [ ] **Step 1: Start the dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: Open a small CSV and verify the split layout**

- Create `test.csv` at project root with sample rows (at least 12 columns to exercise color wrap).
- Click in file tree → both panes appear. Left shows Rainbow colors cycling through 10 colors. Right shows a table with header row bolded.

- [ ] **Step 3: Open a TSV**

- Create `test.tsv` with tab-separated content. Verify same behavior.

- [ ] **Step 4: Toggle header row**

- In the preview toolbar, uncheck "Treat first row as header". Table should now show `Col 1, Col 2, ...` in thead and include the old header row among data rows.

- [ ] **Step 5: `Ctrl+\` collapses the editor**

- Press `Ctrl+\`. Editor pane disappears; preview table stretches across the full width. Press again to restore.

- [ ] **Step 6: Theme switching**

- Switch to dark theme via settings. Both editor colors and preview cell colors should update to the dark palette.

- [ ] **Step 7: Large file (~50k rows)**

- Generate a ~50k-row CSV (e.g., a short script). Scroll smoothly through the preview. Edits to the content in Monaco should re-render the table with ~150ms debounce, no UI freeze.

- [ ] **Step 8: RFC 4180 quoted content**

- Edit the CSV to include `"a,b","c\nd"` style content. Preview table cells should show `a,b` and a multi-line `c\nd` correctly. Editor may show quoted cells on multiple physical lines with continuous coloring (thanks to stateful tokenizer).

- [ ] **Step 9: Parse warnings**

- Introduce malformed quoting (e.g., an unclosed quote). Warning banner should appear in the preview; table still renders.

- [ ] **Step 10: Run the test suite once more**

Run: `npm test`
Expected: all tests pass, including the three new test files.

---

## Self-Review Results

**Spec coverage:**
- Extension detection → Task 1.
- Tab store field → Task 4.
- Routing `.csv`/`.tsv` via `handleFileSelect` → Task 6.
- Split-layout left-pane Monaco routing → Task 7.
- Monaco CSV language + Rainbow coloring → Tasks 3, 4, 5.
- Papa Parse wrapper → Task 2.
- `useCsvParse` debounced hook → Task 9.
- `CsvPreviewPanel` (basic + virtualized) → Tasks 11, 13.
- `PreviewPanel` dispatch branch → Task 12.
- i18n strings → Task 8.
- 10-color palette parity (Monaco + CSS) → Tasks 4 (Monaco) + 11 (CSS).
- Header toggle → Task 11.
- No row cap / virtualization → Task 13.
- Tests: parser (Task 2), tokenizer (Task 3), extension helpers (Task 1).
- Manual QA → Task 14.

**Scroll sync**: Explicitly out of scope per spec. No task needed — the existing `useScrollSync` hook takes an `HTMLTextAreaElement` ref which stays null for CSV tabs (they use Monaco), so the hook early-returns naturally.

**Save path**: No special handling needed. The existing `handleSave` writes `activeTab.content` verbatim for any non-special tab; CSV satisfies that.

**External file watcher**: Already covered by `useFileWatcher` + `ExternalChangeDialog`, no changes needed.
