# CSV Preview: Row Numbers & Dark Mode

Date: 2026-04-27
Scope: `src/features/preview/components/CsvPreviewPanel.tsx` and `CsvPreviewPanel.css` only.

## Goals

1. Display physical row numbers in a fixed gutter on the left side of the CSV preview grid.
2. Make the CSV preview render correctly in dark themes (currently the surface colors fall back to hardcoded light values because the CSS references theme variables that do not exist).

## Non-Goals

- No changes to other preview panels (DOCX/PDF/HTML/Office) even if they share the same undefined-CSS-variable bug. Out of scope; track separately.
- No new theme variables added to the global theme system. Fixes are local to CSV preview.
- No row-selection / click interactions on row numbers. Display only.
- No persistent toggle for the row number column. Always shown.
- No unit tests added — change is purely rendering, with index arithmetic verified by hand.

## Row Number Behavior

**Numbering scheme: physical row number** (matches the row index reported by parser warnings; matches Excel/Google Sheets mental model).

Mapping:

| `headerMode` | Header row number | First body row number |
|---|---|---|
| `true`  | 1 | 2 |
| `false` | — (no header rendered; synthetic column labels used instead) | 1 |

When `headerMode === true`, the header row IS the CSV's first row, so the corner cell shows `1`. Body rows start at 2.

When `headerMode === false`, the header row in the UI is a synthetic column-label row, not a CSV row. The corner cell shows empty. Body rows start at 1.

Implementation:
- Corner cell text: `headerMode ? "1" : ""`.
- Body row number at virtualizer index `v.index`: `v.index + (headerMode ? 2 : 1)`.

## Layout

### Grid template

Prepend a fixed-width column to the existing template:

```ts
const ROW_NUM_WIDTH = 48; // px — accommodates up to 6 digits
const gridTemplate = `${ROW_NUM_WIDTH}px repeat(${columnCount}, minmax(80px, 1fr))`;
```

48px is sized for up to ~6 digits (≤999,999 rows). Beyond that, `text-overflow: ellipsis` is acceptable — CSV files at that scale are rare in this app's use cases.

### Cell classes

| Cell | Class | Notes |
|---|---|---|
| Body row number | `csv-preview__rownum` | No `data-col-index` (so rainbow palette does not apply). Right-aligned. |
| Header row number (corner) | `csv-preview__rownum csv-preview__rownum--corner` | Sticky in both axes. |
| Existing data cells | `csv-preview__cell` (+ optional `--empty`) | Unchanged. `data-col-index={c % 10}` unchanged. |

### Sticky behavior

- Header row: existing `position: sticky; top: 0` (unchanged).
- Row number column: `position: sticky; left: 0` on `.csv-preview__rownum`. Background must be opaque (`var(--bg-base)`) so scrolled data cells do not show through.
- Corner cell (top-left): inherits both stickies. `z-index` raised one level above the header so it remains above both the sticky header and sticky column.

z-index ladder:
- data cells: default (auto)
- `.csv-preview__rownum` (body): 1
- `.csv-preview__row--header`: 2 (existing)
- `.csv-preview__rownum--corner`: 3

## Dark Mode Fix

The CSS currently references variables that the theme system does not define. They fall back to hardcoded light values, leaving the panel white in dark themes. Fix by switching to existing theme variables and adding explicit dark-mode overrides where no theme variable exists.

### Variable substitutions

| Current | Replace with | Reason |
|---|---|---|
| `var(--bg-panel, #fff)` | `var(--bg-surface)` | `--bg-surface` is the standard panel background defined by every theme preset. |
| `var(--bg-alt, #f6f8fa)` | `var(--bg-base)` | `--bg-base` exists in every theme and is differentiated from `--bg-surface`. Used for header row and the row-number gutter. |
| `var(--text, #222)` | `var(--text)` | Already a valid theme variable; remove the hardcoded fallback. |
| `var(--text-muted, #888)` / `#bbb` | `var(--text-muted)` | Already a valid theme variable. Apply to `.csv-preview__cell--empty` (currently hardcoded `#bbb`). |
| `var(--border, ...)` | `var(--border)` | Already a valid theme variable; remove fallbacks. |

### Warning banner colors

The theme system has no warning palette. Keep the current light-mode color, add a dark override:

```css
.csv-preview__warning {
  background: #fff4e5;
  color: #995c00;
}
[data-theme-type="dark"] .csv-preview__warning {
  background: #3a2a10;
  color: #ffb454;
}
```

### Row number gutter styling

```css
.csv-preview__rownum {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-base);
  color: var(--text-muted);
  border-right: 1px solid var(--border);
  padding: 4px 8px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.csv-preview__rownum--corner {
  z-index: 3;
}
```

The header row already has `background: var(--bg-base)`, so the corner cell visually merges with the header strip.

## Component Changes (`CsvPreviewPanel.tsx`)

1. Add `ROW_NUM_WIDTH = 48` constant.
2. Update `gridTemplate` to prepend the row-number column.
3. In the header row JSX: render a leading `<div className="csv-preview__rownum csv-preview__rownum--corner">{headerMode ? "1" : ""}</div>` before the existing column header cells.
4. In each virtualized body row: render a leading row-number cell:

   ```tsx
   <div className="csv-preview__rownum">
     {v.index + (headerMode ? 2 : 1)}
   </div>
   ```

5. No changes to scroll restoration, virtualizer config, or parsing logic.

## i18n

No new strings required. The corner cell shows either `"1"` or `""` — both literal, no translation needed.

## Verification (manual, dev server)

- Light theme: panel renders with white-ish surfaces, row numbers visible in muted color, warning banner amber, rainbow column colors unchanged.
- Dark theme: panel renders with dark surfaces (no white flash), text legible, warning banner dark amber, rainbow column colors switch via existing `[data-theme-type="dark"]` rules.
- Header toggle ON: corner cell shows `1`; body rows numbered from 2.
- Header toggle OFF: corner cell is empty (synthetic column labels are not a real CSV row); body rows numbered from 1.
- Horizontal scroll on a wide CSV: row number column stays pinned to the left.
- Vertical scroll: header row stays pinned to top; corner cell stays pinned to top-left.
- Existing tab-scroll preservation continues to work (no interaction with row-number rendering).
- Existing parser warning behavior unchanged.

## Risks

- Sticky-left + sticky-top combination on the corner cell occasionally has cross-browser glitches. Tauri uses WebView2 (Edge/Chromium); behavior should be predictable. If artifacts appear, fall back to giving the corner cell only `top:0` and accepting that horizontal scroll moves it (acceptable degradation).
- 48px gutter may be tight for very large row counts. Acceptable trade-off given app's typical CSV size.
