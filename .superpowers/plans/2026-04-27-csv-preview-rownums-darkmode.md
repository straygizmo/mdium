# CSV Preview: Row Numbers & Dark Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sticky-left physical row-number gutter to the CSV preview and fix its dark-mode rendering by switching undefined CSS variables to actual theme variables.

**Architecture:** Edit `CsvPreviewPanel.tsx` and `CsvPreviewPanel.css` only. Prepend a 48px column to the existing CSS Grid layout for row numbers; reuse existing theme variables (`--bg-base`, `--bg-surface`, `--text`, `--text-muted`, `--border`); add a `[data-theme-type="dark"]` override only for the warning banner (no warning palette in the theme system).

**Tech Stack:** React, `@tanstack/react-virtual`, CSS Grid, existing theme system in `src/shared/themes/`.

**Spec:** `.superpowers/specs/2026-04-27-csv-preview-rownums-darkmode-design.md`

**Note on TDD:** The spec explicitly opts out of unit tests for this change — it's a pure rendering update where logic is `index + offset`. Verification is manual via the dev server. The plan reflects this: tasks edit production code directly and a final manual verification task gates completion.

---

## File Structure

- Modify: `src/features/preview/components/CsvPreviewPanel.css` — replace undefined theme variables, add row-number cell styles, add dark warning override.
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx` — add `ROW_NUM_WIDTH` constant, prepend row-number column to `gridTemplate`, render corner cell in the header row, render row-number cell in each virtualized body row.

No new files. No tab-store schema changes. No i18n key additions.

---

### Task 1: Replace undefined CSS variables with theme variables

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.css`

The current CSS uses `--bg-panel`, `--bg-alt`, plus theme-defined vars (`--text`, `--text-muted`, `--border`) with hardcoded light fallbacks. The first two do not exist in the theme system — they always fall back to white-ish colors. Switch the panel to `--bg-surface` and the header strip to `--bg-base`. Remove the now-misleading hardcoded fallbacks for the theme-defined vars.

Also fix the empty-cell color (currently hardcoded `#bbb`) to use `--text-muted` so it's legible in dark themes.

- [ ] **Step 1: Update `.csv-preview` background and color**

Replace this block:

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
```

With:

```css
.csv-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
  background: var(--bg-surface);
  color: var(--text);
}
```

- [ ] **Step 2: Update `.csv-preview--empty` muted color**

Replace:

```css
.csv-preview--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #888);
  padding: 24px;
}
```

With:

```css
.csv-preview--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  padding: 24px;
}
```

- [ ] **Step 3: Update `.csv-preview__toolbar` border**

Replace:

```css
.csv-preview__toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  flex-shrink: 0;
}
```

With:

```css
.csv-preview__toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
```

- [ ] **Step 4: Update `.csv-preview__count` muted color**

Replace:

```css
.csv-preview__count {
  color: var(--text-muted, #888);
}
```

With:

```css
.csv-preview__count {
  color: var(--text-muted);
}
```

- [ ] **Step 5: Update `.csv-preview__row` and `.csv-preview__row--header`**

Replace:

```css
.csv-preview__row {
  display: grid;
  border-bottom: 1px solid var(--border, #eee);
}

.csv-preview__row--header {
  position: sticky;
  top: 0;
  z-index: 2;
  font-weight: 700;
  background: var(--bg-alt, #f6f8fa);
}
```

With:

```css
.csv-preview__row {
  display: grid;
  border-bottom: 1px solid var(--border);
}

.csv-preview__row--header {
  position: sticky;
  top: 0;
  z-index: 2;
  font-weight: 700;
  background: var(--bg-base);
}
```

- [ ] **Step 6: Update `.csv-preview__cell` border and `.csv-preview__cell--empty` color**

Replace:

```css
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
```

With:

```css
.csv-preview__cell {
  padding: 4px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-right: 1px solid var(--border);
}

.csv-preview__cell--empty {
  color: var(--text-muted);
}
```

- [ ] **Step 7: Verify the file still compiles by running the build's CSS step (no separate command — handled by Vite). Visually skim the diff.**

```bash
git diff src/features/preview/components/CsvPreviewPanel.css
```

Expected: Six small variable substitutions, no functional change yet.

- [ ] **Step 8: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.css
git commit -m "fix(csv-preview): use real theme variables for surface/border/text"
```

---

### Task 2: Add dark-mode override for the warning banner

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.css`

The theme system has no warning palette. Keep the existing light colors and add a dark override scoped via `[data-theme-type="dark"]`.

- [ ] **Step 1: Update `.csv-preview__warning`**

Replace:

```css
.csv-preview__warning {
  padding: 6px 10px;
  background: var(--warn-bg, #fff4e5);
  color: var(--warn-fg, #995c00);
  border-bottom: 1px solid var(--border, #e5e5e5);
  cursor: help;
  flex-shrink: 0;
}
```

With:

```css
.csv-preview__warning {
  padding: 6px 10px;
  background: #fff4e5;
  color: #995c00;
  border-bottom: 1px solid var(--border);
  cursor: help;
  flex-shrink: 0;
}

[data-theme-type="dark"] .csv-preview__warning {
  background: #3a2a10;
  color: #ffb454;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.css
git commit -m "fix(csv-preview): add dark-mode override for parse warning banner"
```

---

### Task 3: Add row-number gutter CSS

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.css`

Add styles for the new `.csv-preview__rownum` class (sticky-left body cell) and the `.csv-preview__rownum--corner` modifier (top-left, both sticky).

- [ ] **Step 1: Append the row-number rules near the existing cell rules**

Insert this block immediately after the `.csv-preview__cell--empty` rule and before the rainbow palette comment:

```css
.csv-preview__rownum {
  position: sticky;
  left: 0;
  z-index: 1;
  padding: 4px 8px;
  background: var(--bg-base);
  color: var(--text-muted);
  border-right: 1px solid var(--border);
  text-align: right;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.csv-preview__rownum--corner {
  z-index: 3;
}
```

After this edit, the CSS section order around the change should read:

```css
/* ... .csv-preview__cell { ... } */
/* ... .csv-preview__cell--empty { ... } */

.csv-preview__rownum { ... }
.csv-preview__rownum--corner { ... }

/* Rainbow palette — matches Monaco theme tokens col0..col9 (light) */
.csv-preview__cell[data-col-index="0"] { color: #d73a49; }
/* ... */
```

z-index ladder reminder:
- data cells: auto (no z-index)
- `.csv-preview__rownum` (body): 1
- `.csv-preview__row--header`: 2 (existing)
- `.csv-preview__rownum--corner`: 3 (this rule, lifts the corner above the sticky header)

- [ ] **Step 2: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.css
git commit -m "feat(csv-preview): add sticky row-number gutter styles"
```

---

### Task 4: Add `ROW_NUM_WIDTH` constant and update grid template

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx`

Introduce the gutter-width constant and prepend a fixed-width column to the grid template. No JSX changes yet — the grid will simply have an empty leading column until Tasks 5 and 6 fill it.

- [ ] **Step 1: Add the constant near the existing `HEADER_HEIGHT` constant**

In `src/features/preview/components/CsvPreviewPanel.tsx`, find:

```ts
const HEADER_HEIGHT = 30;
const SCROLL_THROTTLE_MS = 200;
```

Replace with:

```ts
const HEADER_HEIGHT = 30;
const SCROLL_THROTTLE_MS = 200;
const ROW_NUM_WIDTH = 48;
```

- [ ] **Step 2: Update `gridTemplate` to prepend the row-number column**

Find:

```ts
  const columnCount = maxColumns;
  const gridTemplate = `repeat(${columnCount}, minmax(80px, 1fr))`;
```

Replace with:

```ts
  const columnCount = maxColumns;
  const gridTemplate = `${ROW_NUM_WIDTH}px repeat(${columnCount}, minmax(80px, 1fr))`;
```

- [ ] **Step 3: Verify TypeScript still compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx
git commit -m "refactor(csv-preview): reserve grid column for row-number gutter"
```

---

### Task 5: Render the corner cell in the header row

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx`

Add a leading sticky-corner cell to the header row. Content depends on `headerMode`: `"1"` when the first CSV row IS the header, `""` when it's a synthetic column-label row.

- [ ] **Step 1: Insert the corner cell as the first child of the header row**

Find:

```tsx
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
```

Replace with:

```tsx
          {headerRow && (
            <div
              className="csv-preview__row csv-preview__row--header"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div className="csv-preview__rownum csv-preview__rownum--corner">
                {headerMode ? "1" : ""}
              </div>
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
```

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx
git commit -m "feat(csv-preview): render corner cell with row-1 label in header"
```

---

### Task 6: Render row number cell in each virtualized body row

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx`

Inside the `rowVirtualizer.getVirtualItems().map(...)` callback, prepend a `csv-preview__rownum` cell whose content is the physical CSV row number.

- [ ] **Step 1: Add the row-number cell before the data cells**

Find:

```tsx
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
```

Replace with:

```tsx
          {rowVirtualizer.getVirtualItems().map((v) => {
            const row = bodyRows[v.index];
            const physicalRowNumber = v.index + (headerMode ? 2 : 1);
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
                <div className="csv-preview__rownum">{physicalRowNumber}</div>
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
```

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run unit tests**

```bash
npm test -- csv-parse
```

Expected: existing CSV parse tests still pass (this change does not touch parsing).

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx
git commit -m "feat(csv-preview): show physical row numbers in body rows"
```

---

### Task 7: Manual verification in the dev server

**Files:**
- None (manual testing).

This is the spec's gating verification. Mark each item only after observing the behavior in the running app.

- [ ] **Step 1: Start the dev server**

```bash
npm run tauri:dev
```

Or, if a faster web-only check is preferred:

```bash
npm run dev
```

- [ ] **Step 2: Open a CSV file with at least 50 rows and 8+ wide columns**

Any sample CSV in the repo or a freshly-pasted one. Need enough rows to exercise virtualization and enough column width to require horizontal scrolling.

- [ ] **Step 3: Light theme verification**

In Settings, select a light theme preset. Verify:
- Panel background is light, text is dark.
- Toolbar, header row, and row-number gutter all use the theme's surface/base colors.
- Warning banner (if parse errors are present) shows amber `#fff4e5` background.
- Rainbow column colors render as before.

- [ ] **Step 4: Dark theme verification**

Switch to a dark theme preset. Verify:
- No white flash; panel background is dark.
- Text and muted text are legible.
- Warning banner shows dark amber (`#3a2a10` / `#ffb454`).
- Rainbow column colors switch to the dark palette (already-existing `[data-theme-type="dark"]` rules).

- [ ] **Step 5: Header toggle ON — row numbering**

Ensure "1行目をヘッダとして扱う" is checked. Verify:
- Corner (top-left) cell shows `1`.
- First body row's number cell shows `2`.
- Second body row shows `3`, etc.
- Numbers match the row indices in any parse-warning tooltip.

- [ ] **Step 6: Header toggle OFF — row numbering**

Uncheck the toggle. Verify:
- Corner cell is empty.
- Synthetic column labels still render to the right of the corner.
- First body row's number is `1`, second is `2`, etc.

- [ ] **Step 7: Horizontal scroll behavior**

Scroll horizontally to the right. Verify:
- Row-number column stays pinned to the left edge.
- Data cells scroll behind it (the gutter background `--bg-base` masks the data).
- Border-right on the gutter remains visible.

- [ ] **Step 8: Vertical scroll behavior**

Scroll down. Verify:
- Header row stays pinned to the top.
- Corner cell stays pinned at top-left and renders above both the sticky header and sticky column.
- Row numbers in body rows update as you scroll (virtualization works).

- [ ] **Step 9: Tab switching preserves scroll**

Open a second CSV tab, scroll, switch back. Verify:
- Existing scroll-restore behavior still works (no regression from the row-number change).

- [ ] **Step 10: Commit any final touch-ups (if observation reveals an issue)**

If any verification step fails, return to the offending task, fix, retest, and commit. If everything passes, no additional commit needed.

---

## Self-Review Notes

- Spec coverage: row-number numbering scheme (Tasks 5, 6), corner cell content (Task 5), gutter styling and stickiness (Task 3), grid template (Task 4), CSS variable migration (Task 1), warning dark override (Task 2), empty-cell color migration (Task 1 step 6), manual verification (Task 7). All spec sections covered.
- Type consistency: `ROW_NUM_WIDTH` (Task 4) is referenced in the same file in `gridTemplate`. Class names `csv-preview__rownum` / `csv-preview__rownum--corner` are defined in CSS (Task 3) and used in TSX (Tasks 5, 6) with identical spelling.
- No placeholders: every code step shows the exact replacement text. Manual verification steps describe specific observable outcomes.
