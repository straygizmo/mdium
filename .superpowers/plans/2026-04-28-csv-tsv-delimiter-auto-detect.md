# CSV/TSV Delimiter Auto-Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect the column delimiter (`,` `\t` `;` `|` `:`) from file content at open time, so files with mismatched extensions render with correct rainbow coloring in both the Monaco editor and the preview panel.

**Architecture:** Centralize the delimiter decision into a single `csvDelimiter` field on the tab model, computed once when the file is opened by running PapaParse with auto-detect on the first 10 lines. The Monaco tokenizer is generalized to accept any single-char delimiter, and 5 language IDs (`csv`, `tsv`, `scsv`, `psv`, `colsv`) are pre-registered. Both `CodeEditorPanel` and `CsvPreviewPanel` read `csvDelimiter` rather than re-deriving from the file extension. A separate reproduction test is added for the user-reported "quoted-cell rainbow" symptom; the fix branch depends on its outcome and is handled in a follow-up.

**Tech Stack:** TypeScript, React, Zustand (tab store), Monaco Editor, PapaParse, Vitest.

**Spec:** `.superpowers/specs/2026-04-27-csv-tsv-delimiter-auto-detect-design.md`

---

## File Structure

**Create:**
- `src/features/preview/lib/delimiter.ts` — `CsvDelimiter` type, `ALL_DELIMITERS`, `DELIMITER_LANGUAGE_ID` map.
- `src/features/preview/lib/detect-delimiter.ts` — `detectDelimiter(text)` function.
- `src/features/preview/lib/__tests__/detect-delimiter.test.ts` — unit tests for detection.

**Modify:**
- `src/features/preview/lib/csv-parse.ts` — broaden delimiter type to `CsvDelimiter`.
- `src/features/preview/lib/csv-parse.worker.ts` — broaden delimiter type to `CsvDelimiter`.
- `src/features/preview/hooks/useCsvParse.ts` — broaden delimiter type to `CsvDelimiter`.
- `src/features/preview/components/CsvPreviewPanel.tsx` — read `csvDelimiter` from tab.
- `src/features/code-editor/lib/csv-language.ts` — accept `string` delimiter, register 5 language IDs.
- `src/features/code-editor/lib/__tests__/csv-language.test.ts` — extend with `;` `|` `:` cases and the quoted-cell reproduction test.
- `src/features/code-editor/components/CodeEditorPanel.tsx` — pick language from `csvDelimiter`.
- `src/stores/tab-store.ts` — add `csvDelimiter?: CsvDelimiter` field.
- `src/app/App.tsx` — call `detectDelimiter` when opening a CSV-family file.

---

## Task 1: Type & Constants Module

**Files:**
- Create: `src/features/preview/lib/delimiter.ts`

- [ ] **Step 1: Create the module**

Create `src/features/preview/lib/delimiter.ts`:

```ts
/**
 * Set of column delimiters the CSV viewer auto-detects and renders with
 * rainbow column coloring. Limited to a small enumerated set so that we
 * can pre-register a Monaco language id per delimiter (rainbow tokens are
 * scoped per-language).
 */
export type CsvDelimiter = "," | "\t" | ";" | "|" | ":";

export const ALL_DELIMITERS: readonly CsvDelimiter[] = [
  ",",
  "\t",
  ";",
  "|",
  ":",
];

/**
 * Maps each supported delimiter to the Monaco language id that will tokenize
 * it. The tokenizer is the same in all five — only the delimiter character
 * differs — but Monaco scopes token providers per language id.
 */
export const DELIMITER_LANGUAGE_ID: Record<CsvDelimiter, string> = {
  ",": "csv",
  "\t": "tsv",
  ";": "scsv",
  "|": "psv",
  ":": "colsv",
};
```

- [ ] **Step 2: Type-check the new file**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/features/preview/lib/delimiter.ts
git commit -m "feat(csv): add CsvDelimiter type and language id map"
```

---

## Task 2: Delimiter Detection (TDD)

**Files:**
- Test: `src/features/preview/lib/__tests__/detect-delimiter.test.ts`
- Create: `src/features/preview/lib/detect-delimiter.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/features/preview/lib/__tests__/detect-delimiter.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { detectDelimiter } from "../detect-delimiter";

describe("detectDelimiter", () => {
  it("returns ',' for empty input", () => {
    expect(detectDelimiter("")).toBe(",");
  });

  it("returns ',' for whitespace-only input", () => {
    expect(detectDelimiter("   \n  \n")).toBe(",");
  });

  it("detects comma", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("detects tab", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("detects semicolon", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("detects pipe", () => {
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("detects colon via the fallback heuristic", () => {
    // PapaParse's auto-detector does not probe ':'. The fallback kicks in
    // when comma-based parse yields single-column rows.
    expect(detectDelimiter("a:b:c\n1:2:3")).toBe(":");
  });

  it("does not misclassify comma CSV containing timestamp colons", () => {
    // Each line has 2 colons in the timestamp, but comma is the real
    // delimiter — must return ',' not ':'.
    const csv = "1,2026-04-28 10:30:00,event_a\n2,2026-04-28 11:45:00,event_b";
    expect(detectDelimiter(csv)).toBe(",");
  });

  it("detects tab even when extension would suggest csv", () => {
    // .csv content that is actually TSV — the case that motivated this
    // feature.
    const tsv = "id\tname\temail\n1\tfoo\tfoo@example.com";
    expect(detectDelimiter(tsv)).toBe("\t");
  });

  it("ignores delimiters inside quoted fields", () => {
    // The semicolon inside the quoted cell must not throw the detection.
    const text = '"a;b","c","d"\n"1;2","3","4"';
    expect(detectDelimiter(text)).toBe(",");
  });

  it("falls back to ',' on single-line input with no candidate delimiter", () => {
    expect(detectDelimiter("hello")).toBe(",");
  });

  it("falls back to ',' when PapaParse picks an unsupported delimiter", () => {
    // ASCII 30 (record separator) — PapaParse may detect it but we don't
    // ship a tokenizer for it, so we fall back.
    const rs = "abc\n123";
    expect(detectDelimiter(rs)).toBe(",");
  });

  it("only inspects the first lines (preview)", () => {
    // 10000 comma rows then a tab. The tail must not flip the result.
    const head = Array.from({ length: 10000 }, () => "a,b,c").join("\n");
    const tail = "\nx\ty\tz";
    expect(detectDelimiter(head + tail)).toBe(",");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/preview/lib/__tests__/detect-delimiter.test.ts`
Expected: FAIL — `Cannot find module '../detect-delimiter'`.

- [ ] **Step 3: Implement detectDelimiter**

Create `src/features/preview/lib/detect-delimiter.ts`:

```ts
import Papa from "papaparse";
import { type CsvDelimiter } from "./delimiter";

/**
 * PapaParse's auto-detector probes ',', '\t', '|', and ';' (not ':'). When
 * none of those is a clear winner it returns ',' by default. To still pick
 * up colon-delimited files, run a focused colon fallback only when the
 * comma-based parse produced single-column rows (i.e. the comma is not
 * actually splitting anything) — this avoids misclassifying a comma CSV
 * that happens to contain timestamps with colons.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  if (text.trim() === "") return ",";
  const result = Papa.parse<string[]>(text, {
    preview: 10,
    skipEmptyLines: false,
  });
  const detected = result.meta.delimiter;

  // Trust PapaParse for the four delimiters it actually probes (other than
  // comma, which is its default fallback and may not reflect real intent).
  if (detected === "\t" || detected === ";" || detected === "|") {
    return detected;
  }

  // PapaParse said comma (or something we don't ship a tokenizer for).
  // If the comma-parse produced multi-column rows, comma is real.
  const rows = result.data;
  if (rows.some((r) => r.length > 1)) return ",";

  // Otherwise check whether colon is the actual delimiter.
  if (looksLikeColonDelimited(text)) return ":";

  return ",";
}

/**
 * Returns true when the first 10 non-empty lines all contain the same
 * non-zero number of colons outside double-quoted regions. Conservative on
 * purpose — we'd rather fall back to comma than misclassify a comma file
 * with stray colons.
 */
function looksLikeColonDelimited(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 10);
  if (lines.length === 0) return false;
  const counts = lines.map(countColonsOutsideQuotes);
  if (counts[0] < 1) return false;
  return counts.every((c) => c === counts[0]);
}

function countColonsOutsideQuotes(line: string): number {
  let count = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // RFC 4180 escaped quote inside a quoted field stays in-quote.
      if (inQuote && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === ":") count += 1;
  }
  return count;
}
```

The two helpers are kept as private functions in the same file (they are
detection-only, no other module needs them).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/preview/lib/__tests__/detect-delimiter.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/features/preview/lib/detect-delimiter.ts src/features/preview/lib/__tests__/detect-delimiter.test.ts
git commit -m "feat(csv): add detectDelimiter for open-time auto-detection"
```

---

## Task 3: Generalize Tokenizer Delimiter Type

**Files:**
- Modify: `src/features/code-editor/lib/csv-language.ts`
- Test: `src/features/code-editor/lib/__tests__/csv-language.test.ts`

- [ ] **Step 1: Add failing tests for new delimiters**

Append to `src/features/code-editor/lib/__tests__/csv-language.test.ts` (after the existing `describe("tokenizeCsvLine (tab)")` block):

```ts
describe("tokenizeCsvLine (semicolon, pipe, colon)", () => {
  it("uses semicolon as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a;b;c", new CsvTokenState(0, false), ";");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });

  it("uses pipe as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a|b|c", new CsvTokenState(0, false), "|");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });

  it("uses colon as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a:b:c", new CsvTokenState(0, false), ":");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/features/code-editor/lib/__tests__/csv-language.test.ts`
Expected: FAIL — TypeScript will reject `";"`, `"|"`, `":"` because the current `delimiter` parameter is typed `"," | "\t"`.

- [ ] **Step 3: Loosen the delimiter parameter type**

Edit `src/features/code-editor/lib/csv-language.ts`:

Change the `tokenizeCsvLine` signature from:

```ts
export function tokenizeCsvLine(
  line: string,
  startState: CsvTokenState,
  delimiter: "," | "\t",
): CsvLineResult {
```

to:

```ts
export function tokenizeCsvLine(
  line: string,
  startState: CsvTokenState,
  delimiter: string,
): CsvLineResult {
```

The function body is unchanged — it already does single-char comparison only, so any 1-character `delimiter` works.

Also change the inner `register` helper signature from:

```ts
const register = (id: string, delimiter: "," | "\t") => {
```

to:

```ts
const register = (id: string, delimiter: string) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/code-editor/lib/__tests__/csv-language.test.ts`
Expected: PASS — all original tests plus the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/features/code-editor/lib/csv-language.ts src/features/code-editor/lib/__tests__/csv-language.test.ts
git commit -m "feat(csv): tokenize any single-char delimiter, add ;|: tests"
```

---

## Task 4: Register Five Language IDs in Monaco

**Files:**
- Modify: `src/features/code-editor/lib/csv-language.ts`

- [ ] **Step 1: Replace the hard-coded register calls**

In `src/features/code-editor/lib/csv-language.ts`, replace the last two lines of `registerCsvLanguages` (the two `register(...)` calls for `"csv"` and `"tsv"`):

```ts
  register("csv", ",");
  register("tsv", "\t");
}
```

with:

```ts
  register("csv", ",");
  register("tsv", "\t");
  register("scsv", ";");
  register("psv", "|");
  register("colsv", ":");
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the full test suite to ensure no regressions**

Run: `npx vitest run`
Expected: PASS (all existing tests still green).

- [ ] **Step 4: Commit**

```bash
git add src/features/code-editor/lib/csv-language.ts
git commit -m "feat(csv): register scsv/psv/colsv Monaco languages"
```

---

## Task 5: Quoted-Cell Rainbow Reproduction Test

**Files:**
- Test: `src/features/code-editor/lib/__tests__/csv-language.test.ts`

This task adds the regression test the user requested for the "quoted
header / quoted string is not rainbow-colored" symptom. The point is to
codify the expected behavior at the tokenizer layer; if it passes, the
real bug is downstream of the tokenizer and a follow-up plan handles
the actual fix once we can inspect the running editor.

- [ ] **Step 1: Add the reproduction tests**

Append to `src/features/code-editor/lib/__tests__/csv-language.test.ts`:

```ts
describe("tokenizeCsvLine — quoted header / quoted string rainbow", () => {
  it("colors quoted header cells with col0/col1/col2", () => {
    const { tokens } = tokenizeCsvLine(
      '"id","name","email"',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect(cellTokens.map((t) => t.type)).toEqual(["col0", "col1", "col2"]);
  });

  it("colors a quoted body cell with the column's color, not a default token", () => {
    // Mixed unquoted + quoted cells in the same row. Each cell should pick
    // up its column index, regardless of quoting.
    const { tokens } = tokenizeCsvLine(
      'a,"b",c',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect(cellTokens.map((t) => t.type)).toEqual(["col0", "col1", "col2"]);
  });

  it("first character of a quoted cell at column N emits colN token", () => {
    const { tokens } = tokenizeCsvLine(
      '"hello",world',
      new CsvTokenState(0, false),
      ",",
    );
    // First emitted token covers the opening quote — must be col0, not
    // a default/string token.
    expect(tokens[0]).toEqual({ startIndex: 0, type: "col0" });
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run src/features/code-editor/lib/__tests__/csv-language.test.ts`
Expected: outcome determines next steps.

- If **PASS** (likely, based on code-trace): the tokenizer is correct.
  The visible bug lives downstream — Monaco theme application, language
  loader timing, or model integration. Capture this finding in the
  commit message and stop. A follow-up plan will be created in a fresh
  session that reproduces the bug in the running editor (Monaco token
  inspector / `editor.getModel().getLineTokens(...)`).
- If **FAIL**: the tokenizer is the bug. Stop and report — the design
  spec section "Quoted-Cell Rainbow" calls for fixing the tokenizer in
  that branch, which requires re-reading the failing assertion and is
  outside the bounded scope of this plan.

- [ ] **Step 3: Commit (PASS branch)**

If the tests passed:

```bash
git add src/features/code-editor/lib/__tests__/csv-language.test.ts
git commit -m "test(csv): regression tests for quoted-cell rainbow tokens"
```

After committing, surface this fact in the final report so the next
session can investigate the downstream layer with the regression test
already in place.

---

## Task 6: Add `csvDelimiter` to Tab Model

**Files:**
- Modify: `src/stores/tab-store.ts`

- [ ] **Step 1: Add the import**

Edit `src/stores/tab-store.ts`. Add this import near the top with the other imports:

```ts
import type { CsvDelimiter } from "@/features/preview/lib/delimiter";
```

(The `@/` alias is already used by `tab-store.ts` consumers; verify the alias resolves by running a `tsc --noEmit` after the edit.)

- [ ] **Step 2: Add the field to the `Tab` interface**

In `src/stores/tab-store.ts`, locate the `csvFileType` field (line 26):

```ts
  /** CSV/TSV file extension (e.g., ".csv") */
  csvFileType?: ".csv" | ".tsv";
```

Add immediately after it:

```ts
  /** Detected column delimiter for CSV-family files. Set once at open time. */
  csvDelimiter?: CsvDelimiter;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the test suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/tab-store.ts
git commit -m "feat(csv): add csvDelimiter field to tab model"
```

---

## Task 7: Detect Delimiter When a CSV File Opens

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Add the import**

Edit `src/app/App.tsx`. Add this import near the other feature imports (e.g. next to where `getCsvExt` is imported on line 10):

```ts
import { detectDelimiter } from "@/features/preview/lib/detect-delimiter";
```

- [ ] **Step 2: Call `detectDelimiter` and pass the result into the tab**

In the CSV/text branch around `App.tsx:471-484`, replace this block:

```tsx
        } else {
          // CSV/TSV files may be Shift-JIS (e.g. Excel exports in Japan);
          // use the encoding-detecting reader so they open cleanly.
          const readCmd = csvExt ? "read_text_file_auto_encoding" : "read_text_file";
          const content = await invoke<string>(readCmd, { path: filePath });
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content,
            isCodeFile: isCodeFile(filePath),
            csvFileType: (csvExt as ".csv" | ".tsv" | null) ?? undefined,
          });
        }
```

with:

```tsx
        } else {
          // CSV/TSV files may be Shift-JIS (e.g. Excel exports in Japan);
          // use the encoding-detecting reader so they open cleanly.
          const readCmd = csvExt ? "read_text_file_auto_encoding" : "read_text_file";
          const content = await invoke<string>(readCmd, { path: filePath });
          // Detect the actual column delimiter from content so a .csv file
          // containing TSV (or vice-versa) still gets correct rainbow
          // coloring and column splitting.
          const csvDelimiter = csvExt ? detectDelimiter(content) : undefined;
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content,
            isCodeFile: isCodeFile(filePath),
            csvFileType: (csvExt as ".csv" | ".tsv" | null) ?? undefined,
            csvDelimiter,
          });
        }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(csv): detect delimiter when opening CSV-family files"
```

---

## Task 8: Broaden Delimiter Type in PapaParse Adapters

**Files:**
- Modify: `src/features/preview/lib/csv-parse.ts`
- Modify: `src/features/preview/lib/csv-parse.worker.ts`
- Modify: `src/features/preview/hooks/useCsvParse.ts`

- [ ] **Step 1: Update `csv-parse.ts`**

Edit `src/features/preview/lib/csv-parse.ts`. Add this import near the top:

```ts
import type { CsvDelimiter } from "./delimiter";
```

Change the two function signatures:

```ts
export function parseCsv(text: string, delimiter: "," | "\t"): CsvParseResult {
```

to:

```ts
export function parseCsv(text: string, delimiter: CsvDelimiter): CsvParseResult {
```

and:

```ts
export function parseCsvAsync(
  text: string,
  delimiter: "," | "\t",
): Promise<CsvParseResult> {
```

to:

```ts
export function parseCsvAsync(
  text: string,
  delimiter: CsvDelimiter,
): Promise<CsvParseResult> {
```

- [ ] **Step 2: Update the worker**

Edit `src/features/preview/lib/csv-parse.worker.ts`. Add this import at the top after the Papa import:

```ts
import type { CsvDelimiter } from "./delimiter";
```

Change:

```ts
export interface CsvWorkerRequest {
  id: number;
  text: string;
  delimiter: "," | "\t";
}
```

to:

```ts
export interface CsvWorkerRequest {
  id: number;
  text: string;
  delimiter: CsvDelimiter;
}
```

- [ ] **Step 3: Update `useCsvParse`**

Edit `src/features/preview/hooks/useCsvParse.ts`. Add this import at the top:

```ts
import type { CsvDelimiter } from "../lib/delimiter";
```

Change:

```ts
export function useCsvParse(
  content: string,
  delimiter: "," | "\t",
  debounceMs = 150,
): CsvParseResult {
```

to:

```ts
export function useCsvParse(
  content: string,
  delimiter: CsvDelimiter,
  debounceMs = 150,
): CsvParseResult {
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run the test suite**

Run: `npx vitest run`
Expected: PASS — the existing `csv-parse.test.ts` cases all use `","` or `"\t"` literals, which are still members of `CsvDelimiter`.

- [ ] **Step 6: Commit**

```bash
git add src/features/preview/lib/csv-parse.ts src/features/preview/lib/csv-parse.worker.ts src/features/preview/hooks/useCsvParse.ts
git commit -m "feat(csv): widen PapaParse adapters to CsvDelimiter"
```

---

## Task 9: Use `csvDelimiter` in `CsvPreviewPanel`

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx`

- [ ] **Step 1: Add the import**

Edit `src/features/preview/components/CsvPreviewPanel.tsx`. Add this import alongside the existing imports near the top:

```ts
import type { CsvDelimiter } from "../lib/delimiter";
```

- [ ] **Step 2: Read `csvDelimiter` from the active tab**

Replace line 32:

```ts
  const delimiter: "," | "\t" = activeTab?.csvFileType === ".tsv" ? "\t" : ",";
```

with:

```ts
  const delimiter: CsvDelimiter = activeTab?.csvDelimiter ?? ",";
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx
git commit -m "feat(csv-preview): read delimiter from tab, drop ext-based logic"
```

---

## Task 10: Use `csvDelimiter` to Pick Monaco Language

**Files:**
- Modify: `src/features/code-editor/components/CodeEditorPanel.tsx`

- [ ] **Step 1: Add the import**

Edit `src/features/code-editor/components/CodeEditorPanel.tsx`. Add this import alongside the existing imports near the top:

```ts
import { DELIMITER_LANGUAGE_ID } from "@/features/preview/lib/delimiter";
```

- [ ] **Step 2: Replace the language resolution**

Replace lines 35–37:

```tsx
  const language = activeTab?.filePath
    ? getMonacoLanguage(activeTab.filePath)
    : "plaintext";
```

with:

```tsx
  const language = activeTab?.csvDelimiter
    ? DELIMITER_LANGUAGE_ID[activeTab.csvDelimiter]
    : activeTab?.filePath
      ? getMonacoLanguage(activeTab.filePath)
      : "plaintext";
```

The `isCsv` check on the next line (`!!activeTab?.csvFileType`) is left
unchanged — theme selection still keys on the file-type marker.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/code-editor/components/CodeEditorPanel.tsx
git commit -m "feat(code-editor): pick CSV language by detected delimiter"
```

---

## Task 11: End-to-End Manual Verification

**Files:** None modified — verification only.

- [ ] **Step 1: Build the dev server**

Run: `npm run tauri dev` (or the project's dev command).
Expected: app launches without errors.

- [ ] **Step 2: Verify each delimiter renders rainbow**

Prepare five small files with the same logical content but different delimiters, all saved with the `.csv` extension:

```
id,name,email
1,foo,foo@example.com
2,bar,bar@example.com
```

```
id<TAB>name<TAB>email
1<TAB>foo<TAB>foo@example.com
```

```
id;name;email
1;foo;foo@example.com
```

```
id|name|email
1|foo|foo@example.com
```

```
id:name:email
1:foo:foo@example.com
```

For each, open the file and verify:
- Editor (left pane): each column has a distinct rainbow color.
- Preview (right pane): cells are split into the correct number of columns and colored per column.

Expected: all five render with rainbow coloring.

- [ ] **Step 3: Verify quoted cells**

Open a file containing:

```
"id","name","email"
1,"foo, jr.","foo@example.com"
```

Expected (per the regression tests committed in Task 5):
- Each header cell `"id"` / `"name"` / `"email"` is colored as col0/col1/col2.
- The body cell `"foo, jr."` is colored as col1 in its entirety (the
  internal comma does not split the cell).

If the visible behavior in the editor disagrees with the regression
tests committed in Task 5 (e.g. the test passed but the editor still
renders the quoted text in the default foreground color), record the
exact reproduction and stop. The downstream investigation belongs to a
follow-up plan as documented in the spec.

- [ ] **Step 4: Verify the original `.tsv` extension still works**

Open a file with `.tsv` extension and tab content. Expected: rainbow
coloring as before.

- [ ] **Step 5: Verify a non-CSV file is unaffected**

Open a `.md` or `.json` file. Expected: editor uses its normal language
and theme; no CSV-specific behavior.

- [ ] **Step 6: If any verification fails**

Stop and report the exact file content + observed vs expected. Do not
add ad-hoc fixes — the failure mode determines whether it's a tokenizer
issue, a detection issue, or a wiring issue, and each requires its own
targeted fix.

- [ ] **Step 7: Final commit (only if all checks pass)**

There is nothing to commit at this step — Task 11 is verification only.
Confirm `git status` is clean.

```bash
git status
```

Expected: `nothing to commit, working tree clean` (all task commits from
Tasks 1–10 already in place).

---

## Summary of Commits

After completing this plan you should have these commits, in order:

1. `feat(csv): add CsvDelimiter type and language id map`
2. `feat(csv): add detectDelimiter for open-time auto-detection`
3. `feat(csv): tokenize any single-char delimiter, add ;|: tests`
4. `feat(csv): register scsv/psv/colsv Monaco languages`
5. `test(csv): regression tests for quoted-cell rainbow tokens`
6. `feat(csv): add csvDelimiter field to tab model`
7. `feat(csv): detect delimiter when opening CSV-family files`
8. `feat(csv): widen PapaParse adapters to CsvDelimiter`
9. `feat(csv-preview): read delimiter from tab, drop ext-based logic`
10. `feat(code-editor): pick CSV language by detected delimiter`
