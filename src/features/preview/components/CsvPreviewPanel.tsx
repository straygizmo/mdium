import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import type { CsvDelimiter } from "../lib/delimiter";
import { useCsvParse } from "../hooks/useCsvParse";
import "./CsvPreviewPanel.css";

const HEADER_HEIGHT = 30;
const SCROLL_THROTTLE_MS = 200;
const ROW_NUM_WIDTH = 48;

function makeThrottle<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  return (...args: Parameters<T>) => {
    lastArgs = args;
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
}

export function CsvPreviewPanel() {
  const { t } = useTranslation("csv");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabCsvPreview = useTabStore((s) => s.updateTabCsvPreview);

  const headerMode = activeTab?.csvHeaderMode ?? true;

  const delimiter: CsvDelimiter = activeTab?.csvDelimiter ?? ",";
  const { rows, errors, maxColumns } = useCsvParse(
    activeTab?.content ?? "",
    delimiter,
  );

  const { headerRow, bodyRows } = useMemo(() => {
    if (rows.length === 0) return { headerRow: null, bodyRows: [] as string[][] };
    if (headerMode) {
      return { headerRow: rows[0], bodyRows: rows.slice(1) };
    }
    const synthetic = Array.from({ length: maxColumns }, (_, i) => t("columnLabel", { index: i + 1 }));
    return { headerRow: synthetic, bodyRows: rows };
  }, [rows, maxColumns, headerMode, t]);

  const parentRef = useRef<HTMLDivElement>(null);
  const restoredForTabRef = useRef<string | null>(null);
  const restoringRef = useRef(false);
  const rowVirtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  const tabId = activeTab?.id;
  const totalSize = rowVirtualizer.getTotalSize();

  // Reset restoration tracking when the active tab changes.
  useEffect(() => {
    restoredForTabRef.current = null;
  }, [tabId]);

  // Restore scroll position once the virtualizer has measured rows.
  // We re-run whenever totalSize changes so a late-arriving measurement triggers
  // the restore. The restoringRef suppresses the echo scroll event from the
  // programmatic assignment, which would otherwise persist a clamped value back
  // to the store and corrupt the saved scrollTop.
  useEffect(() => {
    if (!tabId || !parentRef.current) return;
    if (restoredForTabRef.current === tabId) return;
    if (totalSize === 0) return;

    const saved = useTabStore.getState().tabs.find((t) => t.id === tabId)?.csvPreviewScrollTop ?? 0;
    const el = parentRef.current;

    const raf = requestAnimationFrame(() => {
      restoringRef.current = true;
      el.scrollTop = saved;
      restoredForTabRef.current = tabId;
      // Browsers guarantee scroll events from a programmatic scrollTop=
      // assignment are dispatched before the next rAF callback, so clearing
      // the suppression flag here filters out the echo event.
      requestAnimationFrame(() => {
        restoringRef.current = false;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [tabId, totalSize]);

  // Throttled scroll writeback. Re-create when the active tab changes so the closure
  // captures the correct tabId.
  const onScroll = useMemo(() => {
    if (!tabId) return undefined;
    const save = makeThrottle((scrollTop: number) => {
      useTabStore.getState().updateTabCsvPreview(tabId, { scrollTop });
    }, SCROLL_THROTTLE_MS);
    return (e: React.UIEvent<HTMLDivElement>) => {
      if (restoringRef.current) return;
      save(e.currentTarget.scrollTop);
    };
  }, [tabId]);

  if (!activeTab) return null;

  if (rows.length === 0) {
    return <div className="csv-preview csv-preview--empty">{t("empty")}</div>;
  }

  const columnCount = maxColumns;
  const gridTemplate = `${ROW_NUM_WIDTH}px repeat(${columnCount}, minmax(80px, 1fr))`;

  return (
    <div className="csv-preview">
      <div className="csv-preview__toolbar">
        <label className="csv-preview__toggle">
          <input
            type="checkbox"
            checked={headerMode}
            onChange={(e) => updateTabCsvPreview(activeTab.id, { headerMode: e.target.checked })}
          />
          {t("treatFirstRowAsHeader")}
        </label>
        <span className="csv-preview__count">
          {t("rows", { count: bodyRows.length })} ×{" "}
          {t("columns", { count: columnCount })}
        </span>
      </div>
      {errors.length > 0 && (
        <div
          className="csv-preview__warning"
          title={errors.map((e) => `row ${e.row + 1}: ${e.message}`).join("\n")}
        >
          ⚠ {t("parseWarning", { count: errors.length })}
        </div>
      )}
      <div className="csv-preview__scroll" ref={parentRef} onScroll={onScroll}>
        <div
          className="csv-preview__grid"
          style={{ height: rowVirtualizer.getTotalSize() + HEADER_HEIGHT }}
        >
          {headerRow && (
            <div
              className="csv-preview__row csv-preview__row--header"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div className="csv-preview__rownum csv-preview__rownum--corner">
                {headerMode ? "1" : ""}
              </div>
              {Array.from({ length: columnCount }, (_, i) => (
                <div
                  key={i}
                  className="csv-preview__cell"
                  data-col-index={i % 10}
                >
                  {headerRow[i] ?? ""}
                </div>
              ))}
            </div>
          )}
          {rowVirtualizer.getVirtualItems().map((v) => {
            const row = bodyRows[v.index];
            const physicalRowNumber = v.index + (headerMode ? 2 : 1);
            return (
              <div
                key={v.key}
                className="csv-preview__row csv-preview__row--virtual"
                style={{
                  gridTemplateColumns: gridTemplate,
                  transform: `translateY(${v.start + HEADER_HEIGHT}px)`,
                }}
                ref={rowVirtualizer.measureElement}
                data-index={v.index}
              >
                <div className="csv-preview__rownum">{physicalRowNumber}</div>
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = row[c];
                  return (
                    <div
                      key={c}
                      className={
                        cell === undefined || cell === ""
                          ? "csv-preview__cell csv-preview__cell--empty"
                          : "csv-preview__cell"
                      }
                      data-col-index={c % 10}
                    >
                      {cell === undefined || cell === "" ? "—" : cell}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
