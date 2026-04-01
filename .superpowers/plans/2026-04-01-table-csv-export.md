# Table Context Menu CSV Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "CSVに書き出す" (Export to CSV) to the preview table right-click context menu, exporting the clicked table as a UTF-8 BOM CSV file.

**Architecture:** Add a `exportTableCsv` callback in `PreviewPanel.tsx` that extracts table data from the DOM, formats it as CSV, and saves via Tauri's save dialog with contextual defaults. The existing `usePreviewTableEdit` hook already provides `contextMenu.tableIndex` — no hook changes needed.

**Tech Stack:** React, Tauri (`@tauri-apps/plugin-dialog`, `invoke("write_text_file")`), DOM API

---

## File Structure

- **Modify:** `src/features/preview/components/PreviewPanel.tsx` — add CSV export function + context menu button

That's it. Single file change.

---

### Task 1: Add CSV export function and context menu button

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Add `save` import**

At the top of `PreviewPanel.tsx`, add the dialog import alongside the existing `invoke` import:

```typescript
import { save } from "@tauri-apps/plugin-dialog";
```

- [ ] **Step 2: Add `exportTableCsv` callback**

Inside the `PreviewPanel` component, after the `usePreviewTableEdit` destructuring (around line 505), add:

```typescript
const exportTableCsv = useCallback(async (tableIndex: number) => {
  const div = contentRef.current;
  if (!div || !filePath) return;

  const tables = div.querySelectorAll("table");
  const table = tables[tableIndex];
  if (!table) return;

  // Extract cell data from DOM
  const csvRows: string[] = [];
  const rows = table.querySelectorAll("tr");
  for (const tr of Array.from(rows)) {
    const cells = tr.querySelectorAll("th, td");
    const values = Array.from(cells).map((cell) => {
      const text = (cell as HTMLElement).innerText.trim();
      return `"${text.replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(","));
  }

  // Build default file name: {basename}_Table{N}.csv
  const fileName = filePath.replace(/[\\/]/g, "/").split("/").pop() ?? "document.md";
  const baseName = fileName.replace(/\.\w+$/, "");
  const defaultDir = filePath.replace(/[\\/][^\\/]+$/, "");
  const tableNum = tableIndex + 1;
  const defaultPath = `${defaultDir}/${baseName}_Table${tableNum}.csv`;

  const savePath = await save({
    defaultPath,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!savePath) return;

  // UTF-8 with BOM
  const csvContent = "\uFEFF" + csvRows.join("\n");
  await invoke("write_text_file", { path: savePath, content: csvContent });
}, [filePath]);
```

- [ ] **Step 3: Add "CSVに書き出す" button to context menu**

In the context menu JSX (around line 1178, after the delete column button's closing `</div>`), add a divider and the CSV export button:

```tsx
<div className="preview-table-ctx-divider" />
<div className="preview-table-ctx-group">
  <button
    onClick={() =>
      exportTableCsv(contextMenu.tableIndex)
    }
  >
    {t("exportTableCsv", { defaultValue: "Export to CSV" })}
  </button>
</div>
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors, build succeeds.

- [ ] **Step 5: Manual test**

1. Open an MD file containing multiple tables
2. Right-click a cell in the 2nd table
3. Verify "Export to CSV" appears in the context menu
4. Click it — verify save dialog opens with:
   - Default folder = MD file's directory
   - Default filename = `{mdname}_Table2.csv`
5. Save and open the CSV in Excel — verify no mojibake (BOM works)
6. Verify only the clicked table's data is exported

- [ ] **Step 6: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(preview): add CSV export to table context menu"
```
