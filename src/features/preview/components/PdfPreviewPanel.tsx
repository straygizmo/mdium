import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import "./PdfPreviewPanel.css";

interface PdfPreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  filePath: string | null;
}

export function PdfPreviewPanel({ previewRef, filePath }: PdfPreviewPanelProps) {
  const { t } = useTranslation("editor");
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const mountedRef = useRef(true);
  const pdfDataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const generatePdf = useCallback(async () => {
    const el = previewRef.current;
    if (!el) return;

    setGenerating(true);

    // Wait for all Mermaid diagrams to finish rendering
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10000) {
      const pending = el.querySelectorAll(
        '.mermaid-placeholder:not([data-rendered="done"])'
      );
      if (pending.length === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Inject a temporary style to hide pagebreak marker labels during capture
    const hideStyle = document.createElement("style");
    hideStyle.textContent = ".pagebreak-marker { border: none !important; margin: 0 !important; } .pagebreak-marker::after { display: none !important; }";
    document.head.appendChild(hideStyle);

    try {
      const prevScrollTop = el.scrollTop;
      el.scrollTop = 0;

      const html2pdf = (await import("html2pdf.js")).default;
      const opt = {
        margin: 10,
        image: { type: "jpeg" as const, quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm" as const, format: "a4" as const, orientation: "portrait" as const },
        pagebreak: { before: ".pagebreak-marker" },
      };

      const arrayBuffer: ArrayBuffer = await html2pdf()
        .set(opt)
        .from(el)
        .outputPdf("arraybuffer");

      el.scrollTop = prevScrollTop;

      if (!mountedRef.current) return;

      pdfDataRef.current = new Uint8Array(arrayBuffer);

      setPdfBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        const blob = new Blob([new Uint8Array(arrayBuffer)], { type: "application/pdf" });
        return URL.createObjectURL(blob);
      });
    } catch (error) {
      console.error("PDF preview generation error:", error);
    } finally {
      document.head.removeChild(hideStyle);
      if (mountedRef.current) setGenerating(false);
    }
  }, [previewRef]);

  const savePdf = useCallback(async () => {
    const data = pdfDataRef.current;
    if (!data) return;

    const defaultPath = filePath
      ? filePath.replace(/\.\w+$/, ".pdf")
      : "document.pdf";

    const savePath = await save({
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!savePath) return;

    await writeFile(savePath, data);
  }, [filePath]);

  // Auto-generate on mount
  useEffect(() => {
    generatePdf();
  }, []);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      setPdfBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      pdfDataRef.current = null;
    };
  }, []);

  return (
    <div className="pdf-preview-panel">
      <div className="pdf-preview-panel__toolbar">
        <span className="pdf-preview-panel__label">{t("pdfPreview")}</span>
        <button onClick={generatePdf} disabled={generating} title={generating ? t("generatingPdf") : t("regeneratePdfPreview")}>
          {generating ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pdf-preview-panel__spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          )}
        </button>
        <button onClick={savePdf} disabled={generating || !pdfDataRef.current} title={t("savePdfPreview")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      {generating && !pdfBlobUrl ? (
        <div className="pdf-preview-panel__loading">
          <span>{t("generatingPdf")}</span>
        </div>
      ) : pdfBlobUrl ? (
        <div className="pdf-preview-panel__pdf-mode">
          <iframe src={pdfBlobUrl} title="PDF Preview" />
        </div>
      ) : null}
    </div>
  );
}
