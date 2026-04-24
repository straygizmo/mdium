import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { renderAsync } from "docx-preview";
import { exportMarkdownToDocx } from "@/features/export/lib/docx/docx-exporter";
import { processSvgForStandaloneUse } from "./PreviewPanel";
import "./DocxPreviewPanel.css";

interface DocxPreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  content: string;
  filePath: string | null;
}

export function DocxPreviewPanel({ previewRef, content, filePath }: DocxPreviewPanelProps) {
  const { t } = useTranslation("editor");
  const [generating, setGenerating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const docxDataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const generateDocx = useCallback(async () => {
    if (!content) return;
    setGenerating(true);

    try {
      // Wait for all Mermaid diagrams to finish rendering
      const previewEl = previewRef.current;
      if (previewEl) {
        const waitStart = Date.now();
        while (Date.now() - waitStart < 10000) {
          const pending = previewEl.querySelectorAll(
            '.mermaid-placeholder:not([data-rendered="done"])'
          );
          if (pending.length === 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Collect pre-rendered mermaid SVGs from the preview DOM
      const mermaidSvgs: (string | null)[] = [];
      if (previewEl) {
        const placeholders = previewEl.querySelectorAll(".mermaid-placeholder");
        for (const ph of Array.from(placeholders)) {
          const svg = ph.querySelector(".mermaid-rendered svg") as SVGSVGElement | null;
          if (svg) {
            try {
              mermaidSvgs.push(processSvgForStandaloneUse(svg));
            } catch {
              mermaidSvgs.push(null);
            }
          } else {
            mermaidSvgs.push(null);
          }
        }
      }

      const fontKey = localStorage.getItem("md-preview-font") || "meiryo";
      const docxData = await exportMarkdownToDocx(content, {
        baseDir: filePath || undefined,
        mermaidSvgs,
        fontKey,
      });

      if (!mountedRef.current) return;

      docxDataRef.current = docxData;

      // Render DOCX preview using docx-preview
      const container = containerRef.current;
      if (container) {
        container.innerHTML = "";
        await renderAsync(docxData.buffer, container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
          ignoreFonts: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
      }
    } catch (error) {
      console.error("DOCX preview generation error:", error);
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }, [content, filePath, previewRef]);

  const saveDocx = useCallback(async () => {
    const data = docxDataRef.current;
    if (!data) return;

    const defaultPath = filePath
      ? filePath.replace(/\.\w+$/, ".docx")
      : "document.docx";

    const savePath = await save({
      defaultPath,
      filters: [{ name: "Word Document", extensions: ["docx"] }],
    });
    if (!savePath) return;

    await writeFile(savePath, data);
  }, [filePath]);

  // Auto-generate on mount
  useEffect(() => {
    generateDocx();
  }, []);

  return (
    <div className="docx-preview-panel">
      <div className="docx-preview-panel__toolbar">
        <span className="docx-preview-panel__label">{t("docxPreview")}</span>
        <button onClick={generateDocx} disabled={generating} title={generating ? t("generatingDocx") : t("regenerateDocxPreview")}>
          {generating ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="docx-preview-panel__spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          )}
        </button>
        <button onClick={saveDocx} disabled={generating || !docxDataRef.current} title={t("saveDocxPreview")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      <div className="docx-preview-panel__body">
        <div className="docx-preview-panel__content" ref={containerRef} />
        {generating && !docxDataRef.current && (
          <div className="docx-preview-panel__loading">
            <span>{t("generatingDocx")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
