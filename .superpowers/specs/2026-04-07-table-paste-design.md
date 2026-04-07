# Table Paste Design Spec

Excel/HTML tables pasted into the markdown editor are automatically converted to markdown table syntax.

## Requirements

- Detect HTML table data in clipboard on paste
- Automatically convert to markdown table without user confirmation
- Preserve basic rich formatting (bold, italic, links, code, strikethrough)
- Detect and preserve column alignment from source
- Handle cell line breaks as `<br>` tags
- Prioritize HTML table detection over plain text paste

## Architecture

### Processing Pipeline

```
Clipboard (text/html)
  → DOMParser parses HTML
  → Detect <table> element
  → Separate header row (<thead>/<tr[0]>) and data rows (<tbody>/<tr[1..]>)
  → Process each cell:
      - <b>, <strong> → **text**
      - <i>, <em> → *text*
      - <a href="url">text</a> → [text](url)
      - <code> → `text`
      - <s>, <del> → ~~text~~
      - <br>, line breaks → <br>
      - Pipe character | → \|
      - Other HTML elements → extract text content only
      - Detect text-align style/attribute → alignment info
  → Generate formatted markdown table string
```

### Paste Event Flow

```
textarea.onPaste event
  │
  ├─ ① Does text/html contain a table?
  │    → YES: e.preventDefault()
  │           Parse HTML → generate markdown table
  │           Insert at cursor position
  │           return (done)
  │
  ├─ ② Does text/plain exist? (existing logic)
  │    → YES: Let default paste handle it
  │           return
  │
  └─ ③ Does image data exist? (existing logic)
       → YES: Show ImagePasteDialog
```

### Alignment Detection

| Source | Markdown |
|--------|----------|
| `style="text-align: left"` | `:---` |
| `style="text-align: center"` | `:---:` |
| `style="text-align: right"` | `---:` |
| `align="left"` attribute | `:---` |
| Not detected | `---` (default left-align) |

Header row alignment takes priority. If no header alignment, use first data row.

### Column Width Formatting

- Pad each column to the max cell width in that column
- Minimum width: 3 characters (for `---`)
- Empty cells output as empty (`| |`)

## Edge Cases and Fallback

### Table Detection Criteria

The HTML must contain a `<table>` element with at least 1 `<tr>` containing 2 or more cells (`<td>`/`<th>`). If criteria not met, skip and delegate to existing paste handling.

### Fallback Rules

| Case | Behavior |
|------|----------|
| No table in HTML | Skip (delegate to existing handler) |
| Table has only 1 column | Skip (likely a list) |
| No header row (no `<thead>`, all `<td>`) | Treat first row as header |
| Rows have unequal cell counts | Pad to max column count with empty cells |
| `colspan`/`rowspan` cells | Ignore merge, put content in first cell, rest empty |
| Nested tables | Ignore inner table, extract text content only |
| HTML parse error | Skip (delegate to existing handler) |

**Principle:** When in doubt, skip and delegate to existing processing to avoid unintended conversions.

## File Structure

### New Files

| File | Role |
|------|------|
| `src/features/editor/hooks/useTablePaste.ts` | Hook: detect table in paste event, convert, insert |
| `src/features/editor/lib/htmlTableToMarkdown.ts` | Pure function: HTML table → markdown conversion |

### Modified Files

| File | Change |
|------|--------|
| `src/features/editor/components/EditorPanel.tsx` | Integrate unified paste handler |

### i18n

No new i18n keys required — this is an automatic conversion with no UI dialogs. Keys will be added if error notifications are needed in the future.

## Integration with Existing Code

- `useImagePaste` remains unchanged
- `htmlTableToMarkdown.ts` is a pure function with no side effects, easy to unit test
- `useTablePaste.ts` handles React event processing and cursor management
- `EditorPanel.tsx` composes: `useTablePaste` → `useImagePaste` → browser default
