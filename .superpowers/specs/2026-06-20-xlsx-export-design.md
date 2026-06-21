# XLSX Export for Markdown Preview Panel — Design

- Date: 2026-06-20
- Status: Approved (design)
- Author: brainstorming session

## Summary

Add an **XLSX** export option to the markdown preview panel toolbar, alongside the
existing PDF / DOCX / HTML exports. Conversion is powered by
[`miku-md2xlsx`](https://github.com/igapyon/miku-md2xlsx) (Apache-2.0), vendored as a
single ES module — mirroring the project's existing vendoring of the sister project
`xlsx2md` (used for the reverse XLSX→Markdown direction).

The XLSX tab follows the same "generate → preview → save" flow as the other export
tabs. Preview is rendered with the project's existing SheetJS (`xlsx`) dependency.

## Goals

- Add an XLSX tab/button to the preview toolbar.
- Convert the current markdown document to a practical `.xlsx` workbook.
- Show an in-app preview before saving (consistent with PDF/DOCX/HTML tabs).
- Offer a "split sheets by top-level heading" toggle.
- Embed local relative images best-effort.
- All user-visible strings via i18n (no hardcoded UI text).

## Non-Goals

- Pixel-perfect Excel layout (md2xlsx explicitly targets practical, not pixel-perfect).
- Numeric/date/currency inference for table cells (md2xlsx writes cells as strings).
- Rendering embedded images/styles inside the in-app preview (SheetJS community
  limitation — see Constraints).

## Why miku-md2xlsx

Evaluated two engines:

1. **Existing SheetJS (`xlsx` v0.18.5)** — already a dependency, zero new code to
   vendor, but the community edition has weak styling (no rich text, limited
   hyperlinks, no images). All markdown→sheet mapping logic would be custom.
2. **miku-md2xlsx (chosen)** — purpose-built Markdown→XLSX. Handles headings
   (level-sized fonts), tables (header/border styling), nested lists (depth→column
   shift), inline styles (bold/italic/strike/underline/`<br>`→rich text runs),
   hyperlinks, code blocks, and images out of the box. Self-contained: writes XLSX
   via a hand-rolled ZIP writer (`zip-io.ts`, STORE method, `TextEncoder`/`Uint8Array`
   only — no Node-only APIs in the core). Its only runtime deps (`remark-parse`,
   `remark-gfm`, `unified`) are **already** present in this project.

Decisive precedent: the reverse direction is **already** vendored from the same
author's `xlsx2md` (`src/vendor/xlsx2md.js` + `.d.ts` + `LICENSE-xlsx2md`,
regenerated via `npm run vendor:xlsx2md`). Adding `md2xlsx` is architecturally
symmetric.

License: Apache-2.0 — requires attribution/NOTICE, satisfied by the vendored
header and a `LICENSE-md2xlsx` file (same as xlsx2md).

## md2xlsx public API (from `src/ts/core.ts`)

```ts
function md2xlsx(markdown: string, options?: Md2XlsxOptions): Uint8Array
function markdownToXlsxModel(markdown: string, options?: Md2XlsxOptions): WorkbookModel
function workbookModelToXlsx(workbook: WorkbookModel): Uint8Array

interface Md2XlsxOptions {
  sheetMode?: "single" | "heading";
  sheetHeadingDepth?: 1 | 2;
  title?: string;
  tableStyle?: "plain" | "bordered";
  headerRow?: boolean;
  imageAssets?: Md2XlsxImageAsset[];
}

interface Md2XlsxImageAsset {
  path: string;        // matches the markdown image url
  data: Uint8Array;    // caller-resolved bytes
  contentType?: string;
}
```

Key point: images are passed in via `imageAssets` — md2xlsx core does **not** read
files. The caller pre-resolves image bytes, keeping the conversion renderer-safe.

## Architecture

```
[XLSX tab click] → activeViewTab = "xlsx-preview"
  → <XlsxPreviewPanel> mounts
      → generateXlsx():
          1. Resolve relative image refs against the current MD file's dir
             (Tauri @tauri-apps/plugin-fs readFile) → imageAssets[]
          2. md2xlsx(content, { sheetMode, imageAssets }) → Uint8Array   [vendored]
          3. SheetJS: XLSX.read(bytes) → per-sheet sheet_to_html → preview
      → saveXlsx(): Tauri save() dialog + @tauri-apps/plugin-fs writeFile(bytes)
```

This matches the existing PDF/DOCX/HTML pattern: parse → generate → preview → save
with a Tauri dialog.

## Files

| Kind | Path | Purpose |
|------|------|---------|
| new (vendor) | `src/vendor/md2xlsx.js` | esbuild bundle, auto-generated, attribution + SPDX header |
| new (vendor) | `src/vendor/md2xlsx.d.ts` | hand-written type declarations (`md2xlsx`, `Md2XlsxOptions`, `Md2XlsxImageAsset`, …) |
| new (vendor) | `src/vendor/LICENSE-md2xlsx` | Apache-2.0 full text + attribution |
| new (script) | `scripts/vendor-md2xlsx.mjs` | clone repo → esbuild-bundle `src/ts/core.ts` to single ESM → write output |
| change | `package.json` | add `"vendor:md2xlsx"` script |
| new (lib) | `src/features/export/lib/markdownToXlsx.ts` | image resolution + md2xlsx wrapper |
| new (UI) | `src/features/preview/components/XlsxPreviewPanel.tsx` | generate / split toggle / preview / save (DocxPreviewPanel pattern) |
| change (UI) | `src/features/preview/components/PreviewPanel.tsx` | XLSX tab button + `xlsx-preview` overlay branch + import |
| change (i18n) | `src/shared/i18n/locales/en/editor.json`, `…/ja/editor.json` | add keys (below) |

## Vendoring mechanics

`xlsx2md` uses a module-registry concatenation pattern, so its vendor script
transpiles + concatenates modules with `ModuleKind.None`. `md2xlsx` instead uses
standard ESM imports (with `.ts` extension specifiers), so
`scripts/vendor-md2xlsx.mjs` will **bundle `src/ts/core.ts` into a single ESM with
esbuild** (md2xlsx ships `esbuild` as a devDependency and already has a
`build:bundle` step, so this approach is proven for the source). The output
re-exports `md2xlsx`, `markdownToXlsxModel`, `workbookModelToXlsx`, and the public
types, and is prefixed with the standard `AUTO-GENERATED — do not edit by hand.
Regenerate with: npm run vendor:md2xlsx` header plus Apache-2.0 attribution.

## Data flow details

- **Image resolution** (`markdownToXlsx.ts`): scan the markdown body for image refs
  `![alt](url)`. For each `url` that is **not** `http(s):` or `data:`, treat it as a
  relative path, resolve it against the directory of the currently open file, and
  read bytes via `@tauri-apps/plugin-fs` `readFile`. Build
  `{ path: url, data, contentType }` entries. Read failures are skipped
  (best-effort, matching md2xlsx semantics). If the document has no file path
  (unsaved buffer), skip image resolution entirely.
- **Sheet splitting**: toolbar checkbox state `splitByHeading` maps to
  `sheetMode: splitByHeading ? "heading" : "single"`.
- **Preview**: feed the generated `Uint8Array` to the existing SheetJS dependency
  (`XLSX.read`), then render each sheet with `sheet_to_html` into the preview tab.

## Error handling & constraints

- On generation failure: show an i18n message (no hardcoded text); the save button
  is disabled until data is generated (existing panel behavior).
- **Known constraint (documented in UI):** the SheetJS community edition does not
  render embedded images or cell styling in `sheet_to_html`, so the in-app preview
  is a **text/table-centric approximation**. The saved `.xlsx` does include images
  and rich-text styling. The UI shows an i18n note clarifying preview ≠ final
  appearance.

## i18n keys (en + ja)

- `xlsxPreview` — tab title / label
- `regenerateXlsxPreview` — regenerate button
- `generatingXlsx` — in-progress label
- `saveXlsxPreview` — save button
- `splitByHeading` — split-sheets toggle label
- `xlsxPreviewNote` — note that images/styles are not shown in preview

## Testing

- Unit tests for `markdownToXlsx.ts`:
  - markdown with headings/tables/lists/links → `md2xlsx` returns a non-empty
    `Uint8Array`.
  - `sheetMode` toggle changes the number of sheets.
  - image-resolution logic targets relative paths only (excludes `http(s):`/`data:`),
    and skips unreadable files.
- Smoke test of the vendored bundle: `md2xlsx("# x")` returns bytes beginning with
  the ZIP signature (`PK`, i.e. `0x50 0x4B`).

## Out of scope / future

- Rendering a faithful styled preview (would need a non-community renderer).
- Exposing `tableStyle`, `headerRow`, `sheetHeadingDepth`, `title` options in the UI
  (kept at md2xlsx defaults for v1; YAGNI).
