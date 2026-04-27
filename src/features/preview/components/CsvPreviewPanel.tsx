import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useCsvParse } from "../hooks/useCsvParse";
import "./CsvPreviewPanel.css";

const HEADER_HEIGHT = 30;
const SCROLL_THROTTLE_MS = 200;

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

  const delimiter: "," | "\t" = activeTab?.csvFileType === ".tsv" ? "\t" : ",";
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
  const rowVirtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  // Restore scroll position after the virtualizer has measured rows for this tab.
  // Re-runs whenever the active tab id changes.
  const tabId = activeTab?.id;
  useEffect(() => {
    if (!tabId || !parentRef.current) return;
    const target = useTabStore.getState().tabs.find((t) => t.id === tabId)?.csvPreviewScrollTop ?? 0;
    const el = parentRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [tabId]);

  // Throttled scroll writeback. Re-create when the active tab changes so the closure
  // captures the correct tabId.
  const onScroll = useMemo(() => {
    if (!tabId) return undefined;
    const save = makeThrottle((scrollTop: number) => {
      useTabStore.getState().updateTabCsvPreview(tabId, { scrollTop });
    }, SCROLL_THROTTLE_MS);
    return (e: React.UIEvent<HTMLDivElement>) => save(e.currentTarget.scrollTop);
  }, [tabId]);

  if (!activeTab) return null;

  if (rows.length === 0) {
    return <div className="csv-preview csv-preview--empty">{t("empty")}</div>;
  }

  const columnCount = maxColumns;
  const gridTemplate = `repeat(${columnCount}, minmax(80px, 1fr))`;

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
          title={errors.map((e) => `row ${e.row}: ${e.message}`).join("\n")}
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
