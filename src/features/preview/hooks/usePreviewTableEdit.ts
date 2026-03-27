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
 * イベントターゲットから所属するテーブルセルの情報を取得する。
 * テーブルセル外のクリックの場合は null を返す。
 */
function findCellInfo(
  e: Event,
  container: HTMLElement,
): { cell: HTMLElement; tableIndex: number; row: number; col: number } | null {
  const target = e.target as HTMLElement;
  // 編集中の input 内のイベントは無視
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
 * プレビュー内テーブルのインライン編集・コンテキストメニュー操作を提供するフック。
 *
 * - セルをダブルクリック → インラインで値を編集
 * - セルを右クリック → 行/列の挿入・削除メニュー
 * - Tab キーで隣のセルへ移動
 *
 * イベントデリゲーション方式を採用し、innerHTML 更新タイミングに依存しない。
 */
export function usePreviewTableEdit(
  contentRef: React.RefObject<HTMLDivElement | null>,
  content: string,
  html: string,
) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);

  // Stable refs — イベントハンドラから最新値を安全に参照するため
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const updateTabContentRef = useRef(updateTabContent);
  updateTabContentRef.current = updateTabContent;

  /** Tab キーで次のセルに移動するための予約 */
  const pendingEditRef = useRef<{
    tableIndex: number;
    row: number;
    col: number;
  } | null>(null);

  // ── Markdown ソースに変更を適用 ──────────────────────────
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

  // ── セルのインライン編集を開始 ──────────────────────────
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
            // コンテンツ更新後に再レンダーされるため pending に予約
            pendingEditRef.current = { tableIndex, row, col: nextCol };
          } else {
            committed = true;
            cell.innerHTML = originalContent;
            // DOM が変わらないので直接隣のセルを編集開始
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

  // ── イベントデリゲーション: コンテナ div に1つずつハンドラを設置 ──
  // innerHTML の更新タイミングに関係なく、イベントバブリングで動作する
  useEffect(() => {
    const div = contentRef.current;
    if (!div) return;

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
    };
  }, []);

  // ── Tab ナビゲーション予約の処理（html 更新後に実行） ──
  useEffect(() => {
    if (!pendingEditRef.current) return;
    const div = contentRef.current;
    if (!div) return;

    const { tableIndex, row, col } = pendingEditRef.current;
    pendingEditRef.current = null;

    // PreviewPanel の innerHTML 設定より後に実行するため rAF を使う
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

  // ── コンテキストメニュー操作 ────────────────────────────
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
