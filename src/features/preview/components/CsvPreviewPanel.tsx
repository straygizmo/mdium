import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useCsvParse } from "../hooks/useCsvParse";
import "./CsvPreviewPanel.css";

export function CsvPreviewPanel() {
  const { t } = useTranslation("csv");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const [headerMode, setHeaderMode] = useState(true);

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
    const synthetic = Array.from({ length: maxColumns }, (_, i) => `Col ${i + 1}`);
    return { headerRow: synthetic, bodyRows: rows };
  }, [rows, maxColumns, headerMode]);

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
            onChange={(e) => setHeaderMode(e.target.checked)}
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
      <div className="csv-preview__scroll">
        <div className="csv-preview__grid">
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
          {bodyRows.map((row, r) => (
            <div
              key={r}
              className="csv-preview__row"
              style={{ gridTemplateColumns: gridTemplate }}
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
          ))}
        </div>
      </div>
    </div>
  );
}
