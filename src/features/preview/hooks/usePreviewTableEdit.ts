import { useCallback, useEffect, useRef, useState } from "react";
import { parseMarkdown, rebuildDocument } from "@/shared/lib/markdown/parser";
import { useTabStore } from "@/stores/tab-store";

interface ContextMenuState {
  x: number;
  y: number;
  tableIndex: number;
  row: number;
  col: number;
}

/**
 * Get table cell info from the event target.
 * Returns null if the click is outside a table cell.
 */
function findCellInfo(
  e: Event,
  container: HTMLElement,
): { cell: HTMLElement; tableIndex: number; row: number; col: number } | null {
  const target = e.target as HTMLElement;
  // Ignore events inside an active input
  if (target.tagName === "INPUT") return null;

  const cell = target.closest("th, td") as HTMLElement | null;
  if (!cell) return null;
  const table = cell.closest("table");
  if (!table || !container.contains(table)) return null;

  const allTables = container.querySelectorAll("table");
  const tableIndex = Array.from(allTables).indexOf(table);
  if (tableIndex === -1) return null;

  const tr = cell.closest("tr")!;
  const isHeader = cell.tagName === "TH";
  const col = Array.from(tr.children).indexOf(cell);
  const row = isHeader
    ? -1
    : Array.from(tr.closest("tbody")?.children ?? []).indexOf(tr);

  return { cell, tableIndex, row, col };
}

/**
 * Hook that provides inline editing and context menu operations for preview tables.
 *
 * - Double-click a cell → edit value inline
 * - Right-click a cell → row/column insert/delete menu
 * - Tab key to move to adjacent cell
 *
 * Uses event delegation so it doesn't depend on innerHTML update timing.
 */
export function usePreviewTableEdit(
  contentRef: React.RefObject<HTMLDivElement | null>,
  content: string,
  html: string,
) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);

  // Stable refs — safely reference latest values from event handlers
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const updateTabContentRef = useRef(updateTabContent);
  updateTabContentRef.current = updateTabContent;

  /** Pending edit reservation for Tab key cell navigation */
  const pendingEditRef = useRef<{
    tableIndex: number;
    row: number;
    col: number;
  } | null>(null);

  // ── Apply changes to Markdown source ──────────────────────────
  const applyTableChange = useCallback(
    (updater: (parsed: ReturnType<typeof parseMarkdown>) => void) => {
      const tab = activeTabRef.current;
      if (!tab) return;
      const parsed = parseMarkdown(contentValueRef.current);
      updater(parsed);
      const newContent = rebuildDocument(parsed.lines, parsed.tables);
      updateTabContentRef.current(tab.id, newContent);
    },
    [],
  );

  // ── Start inline cell editing ──────────────────────────
  const startInlineEdit = useCallback(
    (cell: HTMLElement, tableIndex: number, row: number, col: number) => {
      const parsed = parseMarkdown(contentValueRef.current);
      const table = parsed.tables[tableIndex];
      if (!table) return;

      const currentValue =
        row === -1
          ? (table.headers[col] ?? "")
          : (table.rows[row]?.[col] ?? "");

      const originalContent = cell.innerHTML;

      const input = document.createElement("input");
      input.type = "text";
      input.value = currentValue;
      input.className = "preview-table-cell-input";

      cell.innerHTML = "";
      cell.appendChild(input);
      input.focus();
      input.select();

      let committed = false;

      const commit = () => {
        if (committed) return;
        committed = true;
        const newValue = input.value;
        if (newValue !== currentValue) {
          applyTableChange((p) => {
            const t = p.tables[tableIndex];
            if (!t) return;
            if (row === -1) {
              t.headers[col] = newValue;
            } else {
              if (t.rows[row]) t.rows[row][col] = newValue;
            }
          });
        } else {
          cell.innerHTML = originalContent;
        }
      };

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed = true;
          cell.innerHTML = originalContent;
        } else if (e.key === "Tab") {
          e.preventDefault();
          const nextCol = e.shiftKey ? col - 1 : col + 1;
          const freshParsed = parseMarkdown(contentValueRef.current);
          const tbl = freshParsed.tables[tableIndex];
          if (!tbl || nextCol < 0 || nextCol >= tbl.headers.length) {
            commit();
            return;
          }

          const valueChanged = input.value !== currentValue;
          if (valueChanged) {
            commit();
            // Schedule as pending since content update triggers re-render
            pendingEditRef.current = { tableIndex, row, col: nextCol };
          } else {
            committed = true;
            cell.innerHTML = originalContent;
            // DOM doesn't change, so start editing adjacent cell directly
            const tableEl = cell.closest("table");
            if (tableEl) {
              let targetCell: HTMLElement | null = null;
              if (row === -1) {
                targetCell =
                  (tableEl.querySelectorAll("thead th")[nextCol] as HTMLElement) ??
                  null;
              } else {
                const trs = tableEl.querySelectorAll("tbody tr");
                targetCell =
                  (trs[row]?.children[nextCol] as HTMLElement) ?? null;
              }
              if (targetCell) {
                startInlineEditRef.current(targetCell, tableIndex, row, nextCol);
              }
            }
          }
        }
      };

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", handleKeyDown);
    },
    [applyTableChange],
  );

  const startInlineEditRef = useRef(startInlineEdit);
  startInlineEditRef.current = startInlineEdit;

  // ── Event delegation: attach handlers to the container div ──
  // Works via event bubbling regardless of innerHTML update timing.
  // Re-attaches when the DOM element changes (e.g. after early-return
  // paths in PreviewPanel unmount and recreate the contentRef div).
  const listenedElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const div = contentRef.current;
    if (!div) return;
    // Already listening on this exact element — skip
    if (div === listenedElRef.current) return;
    listenedElRef.current = div;

    const handleDblClick = (e: MouseEvent) => {
      const info = findCellInfo(e, div);
      if (!info) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenu(null);
      startInlineEditRef.current(info.cell, info.tableIndex, info.row, info.col);
    };

    const handleContextMenu = (e: MouseEvent) => {
      const info = findCellInfo(e, div);
      if (!info) return;
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        tableIndex: info.tableIndex,
        row: info.row,
        col: info.col,
      });
    };

    div.addEventListener("dblclick", handleDblClick);
    div.addEventListener("contextmenu", handleContextMenu);

    return () => {
      div.removeEventListener("dblclick", handleDblClick);
      div.removeEventListener("contextmenu", handleContextMenu);
      listenedElRef.current = null;
    };
  });

  // ── Process pending Tab navigation (executed after html update) ──
  useEffect(() => {
    if (!pendingEditRef.current) return;
    const div = contentRef.current;
    if (!div) return;

    const { tableIndex, row, col } = pendingEditRef.current;
    pendingEditRef.current = null;

    // Use rAF to execute after PreviewPanel's innerHTML is set
    const frameId = requestAnimationFrame(() => {
      const tables = div.querySelectorAll("table");
      const table = tables[tableIndex];
      if (!table) return;

      let targetCell: HTMLElement | null = null;
      if (row === -1) {
        targetCell =
          (table.querySelectorAll("thead th")[col] as HTMLElement) ?? null;
      } else {
        const trs = table.querySelectorAll("tbody tr");
        targetCell = (trs[row]?.children[col] as HTMLElement) ?? null;
      }
      if (targetCell) {
        startInlineEditRef.current(targetCell, tableIndex, row, col);
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [html]);

  // ── Context menu operations ────────────────────────────
  const addRow = useCallback(
    (tableIndex: number, position: "above" | "below", refRow: number) => {
      applyTableChange((parsed) => {
        const t = parsed.tables[tableIndex];
        if (!t) return;
        const newRow = Array(t.headers.length).fill("");
        const idx = position === "above" ? refRow : refRow + 1;
        t.rows.splice(idx, 0, newRow);
      });
      setContextMenu(null);
    },
    [applyTableChange],
  );

  const deleteRow = useCallback(
    (tableIndex: number, row: number) => {
      applyTableChange((parsed) => {
        const t = parsed.tables[tableIndex];
        if (!t || t.rows.length <= 1) return;
        t.rows.splice(row, 1);
      });
      setContextMenu(null);
    },
    [applyTableChange],
  );

  const addColumn = useCallback(
    (tableIndex: number, position: "left" | "right", refCol: number) => {
      applyTableChange((parsed) => {
        const t = parsed.tables[tableIndex];
        if (!t) return;
        const idx = position === "left" ? refCol : refCol + 1;
        t.headers.splice(idx, 0, "");
        t.alignments.splice(idx, 0, "none");
        for (const row of t.rows) {
          row.splice(idx, 0, "");
        }
      });
      setContextMenu(null);
    },
    [applyTableChange],
  );

  const deleteColumn = useCallback(
    (tableIndex: number, col: number) => {
      applyTableChange((parsed) => {
        const t = parsed.tables[tableIndex];
        if (!t || t.headers.length <= 1) return;
        t.headers.splice(col, 1);
        t.alignments.splice(col, 1);
        for (const row of t.rows) {
          row.splice(col, 1);
        }
      });
      setContextMenu(null);
    },
    [applyTableChange],
  );

  return {
    contextMenu,
    setContextMenu,
    addRow,
    deleteRow,
    addColumn,
    deleteColumn,
  };
}
