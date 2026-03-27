import { useCallback, useRef } from "react";
import type { MarkdownTable } from "@/shared/types";

type TablesSnapshot = MarkdownTable[];

interface UseTableEditorParams {
  tables: MarkdownTable[];
  onTablesChange: (tables: MarkdownTable[]) => void;
}

export function useTableEditor({ tables, onTablesChange }: UseTableEditorParams) {
  const undoStack = useRef<TablesSnapshot[]>([]);
  const redoStack = useRef<TablesSnapshot[]>([]);

  const pushUndo = useCallback(() => {
    undoStack.current.push(structuredClone(tables));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
  }, [tables]);

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    redoStack.current.push(structuredClone(tables));
    const prev = undoStack.current.pop()!;
    onTablesChange(prev);
  }, [tables, onTablesChange]);

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    undoStack.current.push(structuredClone(tables));
    const next = redoStack.current.pop()!;
    onTablesChange(next);
  }, [tables, onTablesChange]);

  const updateCell = useCallback(
    (tableIndex: number, row: number, col: number, value: string) => {
      pushUndo();
      const next = structuredClone(tables);
      const t = next[tableIndex];
      if (row === -1) {
        t.headers[col] = value;
      } else {
        t.rows[row][col] = value;
      }
      onTablesChange(next);
    },
    [tables, onTablesChange, pushUndo]
  );

  const addRow = useCallback(
    (tableIndex: number, position: "above" | "below", refRow: number) => {
      pushUndo();
      const next = structuredClone(tables);
      const t = next[tableIndex];
      const newRow = Array(t.headers.length).fill("");
      const idx = position === "above" ? refRow : refRow + 1;
      t.rows.splice(idx, 0, newRow);
      onTablesChange(next);
    },
    [tables, onTablesChange, pushUndo]
  );

  const deleteRow = useCallback(
    (tableIndex: number, row: number) => {
      pushUndo();
      const next = structuredClone(tables);
      next[tableIndex].rows.splice(row, 1);
      onTablesChange(next);
    },
    [tables, onTablesChange, pushUndo]
  );

  const addColumn = useCallback(
    (tableIndex: number, position: "left" | "right", refCol: number) => {
      pushUndo();
      const next = structuredClone(tables);
      const t = next[tableIndex];
      const idx = position === "left" ? refCol : refCol + 1;
      t.headers.splice(idx, 0, "");
      t.alignments.splice(idx, 0, "none");
      for (const row of t.rows) {
        row.splice(idx, 0, "");
      }
      onTablesChange(next);
    },
    [tables, onTablesChange, pushUndo]
  );

  const deleteColumn = useCallback(
    (tableIndex: number, col: number) => {
      pushUndo();
      const next = structuredClone(tables);
      const t = next[tableIndex];
      t.headers.splice(col, 1);
      t.alignments.splice(col, 1);
      for (const row of t.rows) {
        row.splice(col, 1);
      }
      onTablesChange(next);
    },
    [tables, onTablesChange, pushUndo]
  );

  return {
    updateCell,
    addRow,
    deleteRow,
    addColumn,
    deleteColumn,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}
