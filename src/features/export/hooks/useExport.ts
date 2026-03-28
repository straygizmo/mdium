import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { processSvgForStandaloneUse } from "@/features/preview/components/PreviewPanel";

interface UseExportParams {
  previewRef: React.RefObject<HTMLDivElement | null>;
  content: string;
  filePath: string | null;
  onExportSuccess?: () => void;
}

export function useExport({ previewRef, content, filePath, onExportSuccess }: UseExportParams) {
  const exportPdf = useCallback(async () => {
    const el = previewRef.current;
    if (!el) return;

    try {
      const savePath = await save({
        defaultPath: filePath?.replace(/\.\w+$/, ".pdf") ?? "document.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!savePath) return;

      // Reset scroll to top before PDF export
      const prevScrollTop = el.scrollTop;
      el.scrollTop = 0;

      // Hide page break marker decorations during PDF export
      const hideStyle = document.createElement("style");
      hideStyle.textContent = ".pagebreak-marker { border: none !important; margin: 0 !important; } .pagebreak-marker::after { display: none !important; }";
      document.head.appendChild(hideStyle);

      const html2pdf = (await import("html2pdf.js")).default;
      const opt = {
        margin: 10,
        image: { type: "jpeg" as const, quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm" as const, format: "a4" as const, orientation: "portrait" as const },
        pagebreak: { before: ".pagebreak-marker" },
      };

      const arrayBuffer: ArrayBuffer = await html2pdf().set(opt).from(el).outputPdf("arraybuffer");
      document.head.removeChild(hideStyle);
      await writeFile(savePath, new Uint8Array(arrayBuffer));

      // Restore scroll position
      el.scrollTop = prevScrollTop;

      onExportSuccess?.();
    } catch (error) {
      console.error("PDF export error:", error);
    }
  }, [previewRef, filePath, onExportSuccess]);

  const exportHtml = useCallback(async () => {
    const el = previewRef.current;
    if (!el) return;

    const html = `<!DOCTYPE html>
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

    const path = await save({
      filters: [{ name: "HTML", extensions: ["html"] }],
      defaultPath: filePath?.replace(/\.\w+$/, ".html"),
    });
    if (path) {
      await invoke("write_text_file", { path, content: html });
      onExportSuccess?.();
    }
  }, [previewRef, filePath, onExportSuccess]);

  const exportCsv = useCallback(async () => {
    // Extract tables from content
    const lines = content.split("\n");
    const csvLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.includes("|") && i + 1 < lines.length && /^\|?\s*:?-+:?\s*\|/.test(lines[i + 1].trim())) {
        // Header
        const headers = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        csvLines.push(headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(","));
        i += 2; // skip separator
        while (i < lines.length && lines[i].trim().includes("|") && !/^\|?\s*:?-+:?\s*\|/.test(lines[i].trim())) {
          const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
          csvLines.push(cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(","));
          i++;
        }
        csvLines.push(""); // blank line between tables
      } else {
        i++;
      }
    }

    if (csvLines.length === 0) return;

    const path = await save({
      filters: [{ name: "CSV", extensions: ["csv"] }],
      defaultPath: filePath?.replace(/\.\w+$/, ".csv"),
    });
    if (path) {
      await invoke("write_text_file", { path, content: csvLines.join("\n") });
      onExportSuccess?.();
    }
  }, [content, filePath, onExportSuccess]);

  const exportDocx = useCallback(async () => {
    if (!content) return;
    try {
      const { exportMarkdownToDocx } = await import("../lib/docx/docx-exporter");
      const path = await save({
        filters: [{ name: "Word Document", extensions: ["docx"] }],
        defaultPath: filePath
          ? `${filePath.replace(/\.\w+$/, "")}_fromMD.docx`
          : "document_fromMD.docx",
      });
      if (path) {
        // Collect pre-rendered mermaid SVGs from the preview DOM
        const mermaidSvgs: (string | null)[] = [];
        const previewEl = previewRef.current;
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
        await writeFile(path, docxData);
        onExportSuccess?.();
      }
    } catch (error) {
      console.error("DOCX export error:", error);
    }
  }, [content, filePath, previewRef, onExportSuccess]);

  return { exportPdf, exportHtml, exportCsv, exportDocx } as const;
}
