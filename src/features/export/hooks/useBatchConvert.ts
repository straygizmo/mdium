import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";

export interface BatchConvertProgress {
  current: number;
  total: number;
  currentFile: string;
}

export interface BatchConvertFileResult {
  file: ConvertibleFile;
  status: "success" | "failed" | "skipped";
  error?: string;
  mdPath?: string;
}

export interface BatchConvertSummary {
  success: number;
  failed: number;
  skipped: number;
  results: BatchConvertFileResult[];
}

export function useBatchConvert() {
  const [isConverting, setIsConverting] = useState(false);
  const [progress, setProgress] = useState<BatchConvertProgress | null>(null);
  const [summary, setSummary] = useState<BatchConvertSummary | null>(null);
  const abortRef = useRef(false);

  const convert = useCallback(
    async (files: ConvertibleFile[], skipExisting: boolean) => {
      setIsConverting(true);
      setSummary(null);
      abortRef.current = false;

      const targetFiles = skipExisting
        ? files.filter((f) => !f.hasExistingMd)
        : files;

      const results: BatchConvertFileResult[] = [];
      // Add skipped files to results
      if (skipExisting) {
        for (const f of files) {
          if (f.hasExistingMd) {
            results.push({ file: f, status: "skipped" });
          }
        }
      }

      for (let i = 0; i < targetFiles.length; i++) {
        if (abortRef.current) break;

        const file = targetFiles[i];
        setProgress({
          current: i + 1,
          total: targetFiles.length,
          currentFile: file.name,
        });

        try {
          const bytes = await invoke<number[]>("read_binary_file", {
            path: file.path,
          });
          const data = new Uint8Array(bytes);

          if (file.type === "docx") {
            const { docxToMarkdown } = await import("../lib/docxToMarkdown");
            const result = await docxToMarkdown(data, file.path);
            results.push({ file, status: "success", mdPath: result.mdPath });
          } else if (file.type === "xlsx") {
            const { xlsxToMarkdown } = await import("../lib/xlsxToMarkdown");
            const result = await xlsxToMarkdown(data, file.path);
            results.push({ file, status: "success", mdPath: result.mdPath });
          } else {
            const { pdfToMarkdown } = await import("../lib/pdfToMarkdown");
            const result = await pdfToMarkdown(data, file.path);
            results.push({ file, status: "success", mdPath: result.mdPath });
          }
        } catch (e) {
          results.push({
            file,
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const s: BatchConvertSummary = {
        success: results.filter((r) => r.status === "success").length,
        failed: results.filter((r) => r.status === "failed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        results,
      };
      setSummary(s);
      setIsConverting(false);
      setProgress(null);
      return s;
    },
    []
  );

  const reset = useCallback(() => {
    setSummary(null);
    setProgress(null);
    setIsConverting(false);
  }, []);

  return { isConverting, progress, summary, convert, reset };
}
