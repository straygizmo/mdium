import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./HtmlPreviewPanel.css";

interface HtmlPreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  filePath: string | null;
}

export function HtmlPreviewPanel({ previewRef, filePath }: HtmlPreviewPanelProps) {
  const { t } = useTranslation("editor");
  const [htmlBlobUrl, setHtmlBlobUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const mountedRef = useRef(true);
  const htmlDataRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const generateHtml = useCallback(async () => {
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

    try {
      const htmlContent = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${filePath?.split(/[\\/]/).pop() ?? "document"}</title>
<style>
body { font-family: "Segoe UI", "Meiryo", sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background: #f5f5f5; }
code { padding: 2px 6px; background: #f0f0f0; border-radius: 3px; font-size: 0.9em; }
pre { background: #2d2a3e; color: #e2e8f0; padding: 16px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #ddd; margin: 0; padding: 0 16px; color: #666; }
img { max-width: 100%; }
</style>
</head>
<body>
${el.innerHTML}
</body>
</html>`;

      if (!mountedRef.current) return;

      htmlDataRef.current = htmlContent;

      setHtmlBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        const blob = new Blob([htmlContent], { type: "text/html" });
        return URL.createObjectURL(blob);
      });
    } catch (error) {
      console.error("HTML preview generation error:", error);
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }, [previewRef, filePath]);

  const saveHtml = useCallback(async () => {
    const data = htmlDataRef.current;
    if (!data) return;

    const defaultPath = filePath
      ? filePath.replace(/\.\w+$/, ".html")
      : "document.html";

    const savePath = await save({
      defaultPath,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!savePath) return;

    await invoke("write_text_file", { path: savePath, content: data });
  }, [filePath]);

  // Auto-generate on mount
  useEffect(() => {
    generateHtml();
  }, []);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      setHtmlBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      htmlDataRef.current = null;
    };
  }, []);

  return (
    <div className="html-preview-panel">
      <div className="html-preview-panel__toolbar">
        <span className="html-preview-panel__label">{t("htmlPreview")}</span>
        <button onClick={generateHtml} disabled={generating} title={generating ? t("generatingHtml") : t("regenerateHtmlPreview")}>
          {generating ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="html-preview-panel__spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          )}
        </button>
        <button onClick={saveHtml} disabled={generating || !htmlDataRef.current} title={t("saveHtmlPreview")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      {generating && !htmlBlobUrl ? (
        <div className="html-preview-panel__loading">
          <span>{t("generatingHtml")}</span>
        </div>
      ) : htmlBlobUrl ? (
        <div className="html-preview-panel__html-mode">
          <iframe src={htmlBlobUrl} title="HTML Preview" />
        </div>
      ) : null}
    </div>
  );
}
