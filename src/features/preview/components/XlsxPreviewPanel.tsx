import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import * as XLSX from "xlsx";
import { markdownToXlsx } from "@/features/export/lib/markdownToXlsx";
import "./XlsxPreviewPanel.css";

interface XlsxPreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  content: string;
  filePath: string | null;
}

/**
 * Render the generated .xlsx bytes into an HTML approximation using SheetJS.
 * The community edition does not render embedded images or styling — this is a
 * text/table preview only. Exported as a pure helper for testing.
 */
export function workbookToPreviewHtml(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: "array" });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return `<h4>${name}</h4>` + XLSX.utils.sheet_to_html(sheet);
  }).join("\n");
}

export function XlsxPreviewPanel({ content, filePath }: XlsxPreviewPanelProps) {
  const { t } = useTranslation("editor");
  const [generating, setGenerating] = useState(false);
  const [splitByHeading, setSplitByHeading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const xlsxDataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const generateXlsx = useCallback(async () => {
    if (!content) return;
    setGenerating(true);
    try {
      const bytes = await markdownToXlsx(content, { filePath, splitByHeading });
      if (!mountedRef.current) return;
      xlsxDataRef.current = bytes;
      const container = containerRef.current;
      if (container) {
        container.innerHTML = workbookToPreviewHtml(bytes);
      }
    } catch (error) {
      console.error("XLSX preview generation error:", error);
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }, [content, filePath, splitByHeading]);

  const saveXlsx = useCallback(async () => {
    const data = xlsxDataRef.current;
    if (!data) return;
    const defaultPath = filePath
      ? filePath.replace(/\.\w+$/, ".xlsx")
      : "document.xlsx";
    const savePath = await save({
      defaultPath,
      filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
    });
    if (!savePath) return;
    await writeFile(savePath, data);
  }, [filePath]);

  // Auto-generate on mount and whenever the split option changes.
  useEffect(() => {
    generateXlsx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitByHeading]);

  return (
    <div className="xlsx-preview-panel">
      <div className="xlsx-preview-panel__toolbar">
        <span className="xlsx-preview-panel__label">{t("xlsxPreview")}</span>
        <label className="xlsx-preview-panel__toggle">
          <input
            type="checkbox"
            checked={splitByHeading}
            onChange={(e) => setSplitByHeading(e.target.checked)}
          />
          {t("splitByHeading")}
        </label>
        <button
          onClick={generateXlsx}
          disabled={generating}
          title={generating ? t("generatingXlsx") : t("regenerateXlsxPreview")}
        >
          {generating ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="xlsx-preview-panel__spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          )}
        </button>
        <button
          onClick={saveXlsx}
          disabled={generating || !xlsxDataRef.current}
          title={t("saveXlsxPreview")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
      <div className="xlsx-preview-panel__note">{t("xlsxPreviewNote")}</div>
      <div className="xlsx-preview-panel__body">
        <div className="xlsx-preview-panel__content" ref={containerRef} />
        {generating && !xlsxDataRef.current && (
          <div className="xlsx-preview-panel__loading">
            <span>{t("generatingXlsx")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
