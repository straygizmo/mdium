import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { MarkdownTable, CellPosition } from "@/shared/types";
import { useTableEditor } from "../hooks/useTableEditor";
import "./TableEditor.css";

interface TableEditorProps {
  tables: MarkdownTable[];
  onTablesChange: (tables: MarkdownTable[]) => void;
}

export function TableEditor({ tables, onTablesChange }: TableEditorProps) {
  const { t } = useTranslation("editor");
  const {
    updateCell, addRow, deleteRow, addColumn, deleteColumn, undo, redo,
  } = useTableEditor({ tables, onTablesChange });

  const [selected, setSelected] = useState<CellPosition | null>(null);
  const [editing, setEditing] = useState<CellPosition | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; pos: CellPosition;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const getCellValue = useCallback(
    (ti: number, row: number, col: number) => {
      const table = tables[ti];
      if (!table) return "";
      return row === -1 ? table.headers[col] ?? "" : table.rows[row]?.[col] ?? "";
    },
    [tables]
  );

  const startEditing = useCallback(
    (pos: CellPosition) => {
      setEditing(pos);
      setEditValue(getCellValue(pos.tableIndex, pos.row, pos.col));
    },
    [getCellValue]
  );

  const commitEdit = useCallback(() => {
    if (!editing) return;
    updateCell(editing.tableIndex, editing.row, editing.col, editValue);
    setEditing(null);
  }, [editing, editValue, updateCell]);

  const handleCellClick = useCallback((pos: CellPosition) => {
    setSelected(pos);
    setContextMenu(null);
  }, []);

  const handleCellDoubleClick = useCallback(
    (pos: CellPosition) => startEditing(pos),
    [startEditing]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, pos: CellPosition) => {
      e.preventDefault();
      setSelected(pos);
      setContextMenu({ x: e.clientX, y: e.clientY, pos });
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selected) return;
      const table = tables[selected.tableIndex];
      if (!table) return;

      if (editing) {
        if (e.key === "Escape") {
          setEditing(null);
        } else if (e.key === "Enter") {
          commitEdit();
        } else if (e.key === "Tab") {
          e.preventDefault();
          commitEdit();
          const nextCol = e.shiftKey ? selected.col - 1 : selected.col + 1;
          if (nextCol >= 0 && nextCol < table.headers.length) {
            const next = { ...selected, col: nextCol };
            setSelected(next);
            startEditing(next);
          }
        }
        return;
      }

      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        startEditing(selected);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextRow = selected.row + 1;
        if (nextRow < table.rows.length) setSelected({ ...selected, row: nextRow });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const nextRow = selected.row - 1;
        if (nextRow >= -1) setSelected({ ...selected, row: nextRow });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (selected.col + 1 < table.headers.length) setSelected({ ...selected, col: selected.col + 1 });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (selected.col - 1 >= 0) setSelected({ ...selected, col: selected.col - 1 });
      } else if (e.key === "Tab") {
        e.preventDefault();
        const nextCol = e.shiftKey ? selected.col - 1 : selected.col + 1;
        if (nextCol >= 0 && nextCol < table.headers.length) {
          setSelected({ ...selected, col: nextCol });
        }
      } else if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete") {
        updateCell(selected.tableIndex, selected.row, selected.col, "");
      }
    },
    [selected, editing, tables, commitEdit, startEditing, undo, redo, updateCell]
  );

  const isSelected = (ti: number, row: number, col: number) =>
    selected?.tableIndex === ti && selected?.row === row && selected?.col === col;
  const isEditing = (ti: number, row: number, col: number) =>
    editing?.tableIndex === ti && editing?.row === row && editing?.col === col;

  if (tables.length === 0) {
    return <div className="table-editor__empty">{t("table")}</div>;
  }

  return (
    <div className="table-editor" tabIndex={0} onKeyDown={handleKeyDown} onClick={() => setContextMenu(null)}>
      <div className="table-editor__format-bar">
        <button className="fmt-btn" onClick={() => selected && addRow(selected.tableIndex, "above", Math.max(selected.row, 0))} title={t("insertRowAbove", { defaultValue: "Insert row above" })}>↑+</button>
        <button className="fmt-btn" onClick={() => selected && addRow(selected.tableIndex, "below", Math.max(selected.row, 0))} title={t("insertRowBelow", { defaultValue: "Insert row below" })}>↓+</button>
        <button className="fmt-btn" onClick={() => selected && selected.row >= 0 && deleteRow(selected.tableIndex, selected.row)} title={t("deleteRow", { defaultValue: "Delete row" })}>↓−</button>
        <span className="fmt-sep" />
        <button className="fmt-btn" onClick={() => selected && addColumn(selected.tableIndex, "left", selected.col)} title={t("insertColLeft", { defaultValue: "Insert column left" })}>←+</button>
        <button className="fmt-btn" onClick={() => selected && addColumn(selected.tableIndex, "right", selected.col)} title={t("insertColRight", { defaultValue: "Insert column right" })}>→+</button>
        <button className="fmt-btn" onClick={() => selected && deleteColumn(selected.tableIndex, selected.col)} title={t("deleteCol", { defaultValue: "Delete column" })}>→−</button>
      </div>

      {tables.map((table, ti) => (
        <div key={ti} className="table-editor__wrapper">
          {table.heading && <h3 className="table-editor__heading">{table.heading}</h3>}
          <table className="md-table">
            <thead>
              <tr>
                {table.headers.map((header, ci) => (
                  <th
                    key={ci}
                    className={`table-cell ${isSelected(ti, -1, ci) ? "cell-selected" : ""} ${isEditing(ti, -1, ci) ? "cell-editing" : ""}`}
                    onClick={() => handleCellClick({ tableIndex: ti, row: -1, col: ci })}
                    onDoubleClick={() => handleCellDoubleClick({ tableIndex: ti, row: -1, col: ci })}
                    onContextMenu={(e) => handleContextMenu(e, { tableIndex: ti, row: -1, col: ci })}
                  >
                    {isEditing(ti, -1, ci) ? (
                      <input
                        ref={inputRef}
                        className="cell-input"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEdit}
                      />
                    ) : (
                      <span className="cell-text" dangerouslySetInnerHTML={{ __html: formatCell(header) }} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`table-cell ${isSelected(ti, ri, ci) ? "cell-selected" : ""} ${isEditing(ti, ri, ci) ? "cell-editing" : ""}`}
                      onClick={() => handleCellClick({ tableIndex: ti, row: ri, col: ci })}
                      onDoubleClick={() => handleCellDoubleClick({ tableIndex: ti, row: ri, col: ci })}
                      onContextMenu={(e) => handleContextMenu(e, { tableIndex: ti, row: ri, col: ci })}
                    >
                      {isEditing(ti, ri, ci) ? (
                        <input
                          ref={inputRef}
                          className="cell-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={commitEdit}
                        />
                      ) : (
                        <span className="cell-text" dangerouslySetInnerHTML={{ __html: formatCell(cell) }} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <div className="ctx-group">
            <button onClick={() => { addRow(contextMenu.pos.tableIndex, "above", Math.max(contextMenu.pos.row, 0)); }}>
              {t("insertRowAbove", { defaultValue: "Insert row above" })}
            </button>
            <button onClick={() => { addRow(contextMenu.pos.tableIndex, "below", Math.max(contextMenu.pos.row, 0)); }}>
              {t("insertRowBelow", { defaultValue: "Insert row below" })}
            </button>
            {contextMenu.pos.row >= 0 && (
              <button onClick={() => { deleteRow(contextMenu.pos.tableIndex, contextMenu.pos.row); }}>
                {t("deleteRow", { defaultValue: "Delete row" })}
              </button>
            )}
          </div>
          <div className="ctx-divider" />
          <div className="ctx-group">
            <button onClick={() => { addColumn(contextMenu.pos.tableIndex, "left", contextMenu.pos.col); }}>
              {t("insertColLeft", { defaultValue: "Insert column left" })}
            </button>
            <button onClick={() => { addColumn(contextMenu.pos.tableIndex, "right", contextMenu.pos.col); }}>
              {t("insertColRight", { defaultValue: "Insert column right" })}
            </button>
            <button onClick={() => { deleteColumn(contextMenu.pos.tableIndex, contextMenu.pos.col); }}>
              {t("deleteCol", { defaultValue: "Delete column" })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCell(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}
