import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import * as XLSX from "xlsx";
import { markdownToXlsx } from "@/features/export/lib/markdownToXlsx";
import { processSvgForStandaloneUse } from "./PreviewPanel";
import "./XlsxPreviewPanel.css";

interface XlsxPreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  content: string;
  filePath: string | null;
}

/** Rasterize an SVG string to PNG bytes via an offscreen canvas. */
function svgToPngBuffer(svgString: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("SVG to PNG timed out")), 10000);
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d")!;
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          clearTimeout(timeoutId);
          if (!blob) {
            reject(new Error("Canvas toBlob failed"));
            return;
          }
          blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
        }, "image/png");
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load SVG for Mermaid rendering"));
    };
    img.src = url;
  });
}

/**
 * Wait for Mermaid diagrams in the preview DOM to finish rendering, then
 * rasterize each to PNG bytes in document order. A diagram that is missing or
 * fails to rasterize yields a null entry so index alignment with the markdown's
 * ```mermaid blocks is preserved.
 */
async function collectMermaidPngs(
  previewEl: HTMLDivElement | null,
): Promise<(Uint8Array | null)[]> {
  if (!previewEl) return [];
  const waitStart = Date.now();
  while (Date.now() - waitStart < 10000) {
    const pending = previewEl.querySelectorAll(
      '.mermaid-placeholder:not([data-rendered="done"])',
    );
    if (pending.length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const placeholders = Array.from(previewEl.querySelectorAll(".mermaid-placeholder"));
  const pngs: (Uint8Array | null)[] = [];
  for (const ph of placeholders) {
    const svg = ph.querySelector(".mermaid-rendered svg") as SVGSVGElement | null;
    if (!svg) {
      pngs.push(null);
      continue;
    }
    try {
      pngs.push(await svgToPngBuffer(processSvgForStandaloneUse(svg)));
    } catch {
      pngs.push(null);
    }
  }
  return pngs;
}

/** Escape HTML special characters for safe interpolation into innerHTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    return `<h4>${escapeHtml(name)}</h4>` + XLSX.utils.sheet_to_html(sheet);
  }).join("\n");
}

export function XlsxPreviewPanel({ previewRef, content, filePath }: XlsxPreviewPanelProps) {
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
      const mermaidPngs = await collectMermaidPngs(previewRef.current);
      const bytes = await markdownToXlsx(content, { filePath, splitByHeading, mermaidPngs });
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
  }, [content, filePath, splitByHeading, previewRef]);

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
