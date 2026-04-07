# Table Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically convert Excel/HTML tables pasted into the markdown editor into markdown table syntax.

**Architecture:** A pure conversion function (`htmlTableToMarkdown`) handles all HTML-to-markdown logic with no side effects. A React hook (`useTablePaste`) wires this into the paste event. `EditorPanel` composes the new hook before the existing `useImagePaste` so table detection takes priority.

**Tech Stack:** React 19, TypeScript, DOMParser (browser API), Vitest

---

### Task 1: Create `htmlTableToMarkdown` pure conversion function — core parsing

**Files:**
- Create: `src/features/editor/lib/htmlTableToMarkdown.ts`
- Create: `src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts`

- [ ] **Step 1: Write the failing test for basic table conversion**

```typescript
// src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts
import { describe, it, expect } from "vitest";
import { htmlTableToMarkdown } from "../htmlTableToMarkdown";

describe("htmlTableToMarkdown", () => {
  it("returns null when HTML contains no table", () => {
    expect(htmlTableToMarkdown("<p>Hello</p>")).toBeNull();
  });

  it("returns null for a table with only 1 column", () => {
    const html = "<table><tr><th>Only</th></tr><tr><td>One</td></tr></table>";
    expect(htmlTableToMarkdown(html)).toBeNull();
  });

  it("converts a basic 2x2 table with thead", () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
      </table>`;
    expect(htmlTableToMarkdown(html)).toBe(
      "| Name  | Age |\n" +
      "| ----- | --- |\n" +
      "| Alice | 30  |"
    );
  });

  it("treats first row as header when no thead exists", () => {
    const html = `
      <table>
        <tr><td>Name</td><td>Age</td></tr>
        <tr><td>Bob</td><td>25</td></tr>
      </table>`;
    expect(htmlTableToMarkdown(html)).toBe(
      "| Name | Age |\n" +
      "| ---- | --- |\n" +
      "| Bob  | 25  |"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement basic `htmlTableToMarkdown`**

```typescript
// src/features/editor/lib/htmlTableToMarkdown.ts

/**
 * Convert an HTML string containing a <table> to a markdown table string.
 * Returns null if no valid table is found (no <table>, fewer than 2 columns, parse error).
 */
export function htmlTableToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return null;

  // Determine max column count
  const maxCols = Math.max(...rows.map((r) => r.querySelectorAll("td, th").length));
  if (maxCols < 2) return null;

  // Extract header and data rows
  const thead = table.querySelector("thead");
  let headerRow: Element;
  let dataRows: Element[];

  if (thead) {
    const theadRows = Array.from(thead.querySelectorAll("tr"));
    headerRow = theadRows[0];
    const tbody = table.querySelector("tbody");
    dataRows = tbody
      ? Array.from(tbody.querySelectorAll("tr"))
      : rows.filter((r) => !thead.contains(r));
  } else {
    headerRow = rows[0];
    dataRows = rows.slice(1);
  }

  // Extract cells from a row, padding to maxCols
  const extractCells = (row: Element): string[] => {
    const cells = Array.from(row.querySelectorAll("td, th"));
    const result = cells.map((cell) => convertCellContent(cell));
    while (result.length < maxCols) result.push("");
    return result.slice(0, maxCols);
  };

  const headers = extractCells(headerRow);
  const bodyRows = dataRows.map((r) => extractCells(r));

  // Detect alignments from header row, fallback to first data row
  const alignments = detectAlignments(headerRow, maxCols);
  if (bodyRows.length > 0) {
    const firstDataAlignments = detectAlignments(dataRows[0], maxCols);
    for (let i = 0; i < maxCols; i++) {
      if (!alignments[i] && firstDataAlignments[i]) {
        alignments[i] = firstDataAlignments[i];
      }
    }
  }

  // Calculate column widths (minimum 3 for separator)
  const colWidths = headers.map((h, i) => {
    const cellWidths = [h.length, ...bodyRows.map((r) => r[i].length)];
    return Math.max(3, ...cellWidths);
  });

  // Format rows
  const pad = (text: string, width: number) => text + " ".repeat(width - text.length);

  const headerLine = "| " + headers.map((h, i) => pad(h, colWidths[i])).join(" | ") + " |";

  const separatorLine = "| " + colWidths.map((w, i) => {
    const align = alignments[i];
    if (align === "center") return ":" + "-".repeat(w - 2) + ":";
    if (align === "right") return "-".repeat(w - 1) + ":";
    return "-".repeat(w);
  }).join(" | ") + " |";

  const dataLines = bodyRows.map(
    (row) => "| " + row.map((cell, i) => pad(cell, colWidths[i])).join(" | ") + " |"
  );

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

type Alignment = "left" | "center" | "right" | null;

function detectAlignments(row: Element, maxCols: number): Alignment[] {
  const cells = Array.from(row.querySelectorAll("td, th"));
  const result: Alignment[] = [];
  for (let i = 0; i < maxCols; i++) {
    const cell = cells[i] as HTMLElement | undefined;
    if (!cell) {
      result.push(null);
      continue;
    }
    const style = cell.style?.textAlign || cell.getAttribute("align") || "";
    const normalized = style.toLowerCase();
    if (normalized === "center") result.push("center");
    else if (normalized === "right") result.push("right");
    else if (normalized === "left") result.push("left");
    else result.push(null);
  }
  return result;
}

function convertCellContent(cell: Element): string {
  return convertNodeContent(cell).trim().replace(/\|/g, "\\|");
}

function convertNodeContent(node: Node): string {
  let result = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const inner = convertNodeContent(el);

      switch (tag) {
        case "b":
        case "strong":
          result += `**${inner}**`;
          break;
        case "i":
        case "em":
          result += `*${inner}*`;
          break;
        case "s":
        case "del":
          result += `~~${inner}~~`;
          break;
        case "code":
          result += `\`${inner}\``;
          break;
        case "a":
          result += `[${inner}](${el.getAttribute("href") ?? ""})`;
          break;
        case "br":
          result += "<br>";
          break;
        default:
          result += inner;
          break;
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts`
Expected: PASS — all 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/features/editor/lib/htmlTableToMarkdown.ts src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts
git commit -m "feat(table-paste): add htmlTableToMarkdown core conversion function with tests"
```

---

### Task 2: Add tests for rich formatting, alignment, and edge cases

**Files:**
- Modify: `src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts`

- [ ] **Step 1: Add rich formatting tests**

Append to the existing `describe` block in `src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts`:

```typescript
  it("converts bold, italic, and links in cells", () => {
    const html = `
      <table>
        <tr><th>Format</th><th>Result</th></tr>
        <tr><td><b>bold</b></td><td><a href="https://example.com">link</a></td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("| **bold** |");
    expect(result).toContain("| [link](https://example.com) |");
  });

  it("converts strikethrough, code, and italic in cells", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th><th>C</th></tr>
        <tr><td><del>removed</del></td><td><code>code</code></td><td><em>italic</em></td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("~~removed~~");
    expect(result).toContain("`code`");
    expect(result).toContain("*italic*");
  });

  it("converts line breaks in cells to <br>", () => {
    const html = `
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td>line1<br>line2</td><td>ok</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("line1<br>line2");
  });

  it("escapes pipe characters in cell content", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>a | b</td><td>c</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("a \\| b");
  });
```

- [ ] **Step 2: Add alignment detection tests**

Append to the same `describe` block:

```typescript
  it("detects text-align style for center and right", () => {
    const html = `
      <table>
        <tr>
          <th style="text-align: left">Left</th>
          <th style="text-align: center">Center</th>
          <th style="text-align: right">Right</th>
        </tr>
        <tr><td>a</td><td>b</td><td>c</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const lines = result.split("\n");
    const sep = lines[1];
    // left = ------,  center = :----:,  right = -----:
    expect(sep).toMatch(/\| -{3,} \|/);           // left column: no colons
    expect(sep).toMatch(/\| :-+: \|/);            // center column
    expect(sep).toMatch(/\| -{2,}: \|/);           // right column
  });

  it("detects align attribute", () => {
    const html = `
      <table>
        <tr><th align="right">Price</th><th>Item</th></tr>
        <tr><td align="right">100</td><td>Apple</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const sep = result.split("\n")[1];
    expect(sep).toMatch(/---:/);
  });
```

- [ ] **Step 3: Add edge case tests**

Append to the same `describe` block:

```typescript
  it("pads rows with fewer cells to max column count", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th><th>C</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const dataLine = result.split("\n")[2];
    // Should have 3 pipe-separated cells
    expect(dataLine.split("|").filter((s) => s.trim() !== "").length).toBeLessThanOrEqual(3);
    expect(dataLine).toMatch(/\|\s*\|$/);
  });

  it("ignores colspan/rowspan and extracts text", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td colspan="2">merged</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("merged");
  });

  it("ignores nested tables and extracts text only", () => {
    const html = `
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td><table><tr><td>nested</td></tr></table></td><td>ok</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("nested");
    expect(result).toContain("ok");
  });

  it("handles empty cells", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td></td><td>data</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toBeDefined();
    expect(result).toContain("data");
  });
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npx vitest run src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add src/features/editor/lib/__tests__/htmlTableToMarkdown.test.ts
git commit -m "test(table-paste): add rich formatting, alignment, and edge case tests"
```

---

### Task 3: Create `useTablePaste` hook

**Files:**
- Create: `src/features/editor/hooks/useTablePaste.ts`

- [ ] **Step 1: Write the `useTablePaste` hook**

```typescript
// src/features/editor/hooks/useTablePaste.ts
import { useCallback } from "react";
import { htmlTableToMarkdown } from "../lib/htmlTableToMarkdown";

interface UseTablePasteParams {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  onContentChange: (newContent: string) => void;
}

/**
 * Hook that intercepts paste events containing HTML tables
 * and converts them to markdown table syntax.
 *
 * Returns a handler that should be called BEFORE the image paste handler.
 * Returns true if a table was detected and inserted, false otherwise.
 */
export function useTablePaste({
  editorRef,
  content,
  onContentChange,
}: UseTablePasteParams) {
  const handleTablePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>): boolean => {
      const html = e.clipboardData?.getData("text/html");
      if (!html) return false;

      const markdown = htmlTableToMarkdown(html);
      if (!markdown) return false;

      e.preventDefault();

      const textarea = editorRef.current;
      const start = textarea?.selectionStart ?? 0;
      const end = textarea?.selectionEnd ?? 0;

      const before = content.substring(0, start);
      const after = content.substring(end);

      // Add newlines around the table if needed
      const nlBefore = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const nlAfter = after.length > 0 && !after.startsWith("\n") ? "\n" : "";

      const newContent = before + nlBefore + markdown + nlAfter + after;
      onContentChange(newContent);

      // Move cursor after inserted table
      const newPos = start + nlBefore.length + markdown.length + nlAfter.length;
      setTimeout(() => {
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(newPos, newPos);
        }
      }, 0);

      return true;
    },
    [editorRef, content, onContentChange]
  );

  return { handleTablePaste };
}
```

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `npx vitest run`
Expected: PASS — all existing tests still pass

- [ ] **Step 3: Commit**

```bash
git add src/features/editor/hooks/useTablePaste.ts
git commit -m "feat(table-paste): add useTablePaste hook"
```

---

### Task 4: Integrate into `EditorPanel`

**Files:**
- Modify: `src/features/editor/components/EditorPanel.tsx`

- [ ] **Step 1: Add import for `useTablePaste`**

Add the import after the existing `useImagePaste` import at line 7 of `EditorPanel.tsx`:

```typescript
import { useTablePaste } from "../hooks/useTablePaste";
```

- [ ] **Step 2: Initialize the `useTablePaste` hook**

Add the hook call after the `useImagePaste` call (after line 91 of `EditorPanel.tsx`):

```typescript
  const { handleTablePaste } = useTablePaste({
    editorRef,
    content,
    onContentChange: handleContentChange,
  });
```

- [ ] **Step 3: Create a unified paste handler and wire it to the textarea**

Add the unified handler after the `handleTablePaste` initialization:

```typescript
  const handleUnifiedPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (handleTablePaste(e)) return;
      handlePaste(e);
    },
    [handleTablePaste, handlePaste]
  );
```

Then change the textarea's `onPaste` prop (line 412) from:

```typescript
onPaste={handlePaste}
```

to:

```typescript
onPaste={handleUnifiedPaste}
```

- [ ] **Step 4: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/editor/components/EditorPanel.tsx
git commit -m "feat(table-paste): integrate table paste into EditorPanel"
```

---

### Task 5: Manual testing and final verification

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test Excel paste**

1. Open Excel (or Google Sheets), create a small table with headers, a few data rows, and some formatting (bold, links)
2. Select the table cells and copy (Ctrl+C)
3. In the mdium editor, paste (Ctrl+V)
4. Verify: a properly formatted markdown table appears at the cursor position

- [ ] **Step 3: Test HTML table paste**

1. Open a browser, navigate to a Wikipedia page with a table
2. Select and copy a table
3. Paste into the mdium editor
4. Verify: markdown table with content extracted correctly

- [ ] **Step 4: Test that plain text paste still works**

1. Copy plain text (not from a table) from any source
2. Paste into the editor
3. Verify: text is pasted as-is, no table conversion

- [ ] **Step 5: Test that image paste still works**

1. Copy an image to clipboard (e.g., screenshot)
2. Paste into the editor
3. Verify: the ImagePasteDialog appears as before

- [ ] **Step 6: Run final test suite**

Run: `npx vitest run`
Expected: PASS — all tests

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(table-paste): complete table paste feature"
```
