# Excel to Markdown Conversion Design

## Summary

Add Excel (.xlsx/.xlsm) to Markdown conversion functionality to mdium, incorporating xlsx2md's conversion pipeline as a vendored ES module. This follows the existing pattern established by `docxToMarkdown.ts` and `pdfToMarkdown.ts`.

## Goals

- Convert Excel files to well-structured Markdown with tables, narrative text, images/charts/shapes, rich text formatting, and hyperlinks
- Vendor xlsx2md as a pre-built ES module to minimize maintenance cost while leveraging its full feature set
- Provide the same UX as DOCX/PDF conversion: a "Markdown に変換" button on the preview panel

## Approach: Vendored ES Module

xlsx2md uses a `globalThis`-based module registry pattern (IIFEs), not ES modules. To integrate it:

1. Clone the xlsx2md repository
2. Transpile TypeScript to JavaScript using its existing build script
3. Create a wrapper that loads all IIFEs in dependency order and exports the final API
4. Bundle with esbuild into a single ES module at `src/vendor/xlsx2md.js`

mdium runs in Tauri (browser environment), so `DOMParser` is natively available — no JSDOM required.

## File Structure

```
src/
  vendor/
    xlsx2md.js                ← Vendored ES module (build artifact)
  features/
    export/
      lib/
        xlsxToMarkdown.ts     ← New: thin wrapper calling xlsx2md API
    preview/
      components/
        PreviewPanel.tsx       ← Modified: add xlsx branch + button condition
```

## New File: xlsxToMarkdown.ts

Location: `src/features/export/lib/xlsxToMarkdown.ts`

### Responsibilities

1. Import xlsx2md API from `@/vendor/xlsx2md`
2. Parse workbook via `parseWorkbook(arrayBuffer, workbookName)`
3. Convert to Markdown via `convertWorkbookToMarkdownFiles(workbook, options)`
4. Combine all sheets via `createCombinedMarkdownExportFile(files)`
5. Extract and save images to `{baseName}_images/` directory (same pattern as docxToMarkdown)
6. Save `.md` file via Tauri `write_text_file`
7. Return `{ mdPath: string }`

### Conversion Options

```typescript
{
  formattingMode: "github",
  tableDetectionMode: "balanced",
  treatFirstRowAsHeader: true,
  trimText: true,
  removeEmptyRows: true,
  removeEmptyColumns: true,
}
```

## Modified File: PreviewPanel.tsx

### Changes

1. Add xlsx/xlsm detection (using existing `getOfficeExt()` from constants):
   ```typescript
   const isXlsx = activeTab?.officeFileType === ".xlsx" || activeTab?.officeFileType === ".xlsm";
   ```

2. Extend button visibility condition:
   ```typescript
   // Before: (isDocx || isPdf)
   // After:  (isDocx || isPdf || isXlsx)
   ```

3. Add xlsx branch in `handleConvertToMarkdown`:
   ```typescript
   if (isXlsx) {
     const { xlsxToMarkdown } = await import("@/features/export/lib/xlsxToMarkdown");
     ({ mdPath } = await xlsxToMarkdown(activeTab.binaryData, activeTab.filePath));
   }
   ```

## Output Format

Multiple sheets are combined with `## Sheet Name` headings. Each sheet contains a mix of narrative text, tables, and images as detected by xlsx2md's algorithms.

```markdown
## Sheet1

売上レポート 2024年度

### 第1四半期

| 商品名 | 単価 | 数量 | 合計 |
| --- | --- | --- | --- |
| ウィジェットA | 1,000 | 50 | 50,000 |
| ウィジェットB | 2,500 | 30 | 75,000 |

![chart1](report_images/chart1.png)

### 備考

- 前年比120%の成長
- 新規顧客からの注文が増加

## Sheet2
...
```

## xlsx2md Key APIs Used

| API | Purpose |
|-----|---------|
| `parseWorkbook(arrayBuffer, name)` | Parse XLSX binary into ParsedWorkbook |
| `convertWorkbookToMarkdownFiles(workbook, options)` | Convert to MarkdownFile[] (one per sheet) |
| `createCombinedMarkdownExportFile(files)` | Merge all sheets into single Markdown |
| `createExportEntries(files)` | Get image/asset entries for extraction |

## Scope

### Included

- Table detection and Markdown table output (balanced mode with BFS scoring)
- Narrative text extraction (headings, lists, paragraphs)
- Rich text formatting (bold, italic, strikethrough)
- Hyperlinks (internal anchors and external URLs)
- Image/chart/shape extraction and saving
- Multiple sheet support (combined with heading separators)

### Excluded

- xlsx2md web UI
- Formula re-evaluation (uses pre-calculated values from Excel)
- Excel decorative styles (colors, fonts, conditional formatting)

## Vendoring Process

To update the vendored xlsx2md in the future:

1. Clone/pull latest from https://github.com/igapyon/xlsx2md
2. Run the build script to transpile TS → JS
3. Bundle into ES module with the wrapper entry point
4. Replace `src/vendor/xlsx2md.js`
