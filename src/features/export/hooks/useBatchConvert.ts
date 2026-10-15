import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import { convertFileToMarkdown, WordUnavailableError } from "../lib/convertFileToMarkdown";
import type { PptxLabels } from "../lib/convertFileToMarkdown";

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
  const { t } = useTranslation("common");
  const [isConverting, setIsConverting] = useState(false);
  const [progress, setProgress] = useState<BatchConvertProgress | null>(null);
  const [summary, setSummary] = useState<BatchConvertSummary | null>(null);
  const abortRef = useRef(false);

  const convert = useCallback(
    async (
      files: ConvertibleFile[],
      skipExisting: boolean,
      saveToMdium: boolean,
    ) => {
      setIsConverting(true);
      setSummary(null);
      abortRef.current = false;

      const pptxLabels: PptxLabels = {
        slideFallback: (n: number) => t("pptxSlideLabel", { n }),
        notes: t("pptxNotesLabel"),
      };

      const isExisting = (f: ConvertibleFile) =>
        saveToMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling;

      const targetFiles = skipExisting
        ? files.filter((f) => !isExisting(f))
        : files;

      const results: BatchConvertFileResult[] = [];
      // Add skipped files to results
      if (skipExisting) {
        for (const f of files) {
          if (isExisting(f)) {
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
          const result = await convertFileToMarkdown(file, saveToMdium, pptxLabels);
          results.push({ file, status: "success", mdPath: result.mdPath });
        } catch (e) {
          results.push({
            file,
            status: "failed",
            error:
              e instanceof WordUnavailableError
                ? t("batchConvertWordNotAvailable")
                : e instanceof Error
                  ? e.message
                  : String(e),
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
    [t]
  );

  const reset = useCallback(() => {
    setSummary(null);
    setProgress(null);
    setIsConverting(false);
  }, []);

  return { isConverting, progress, summary, convert, reset };
}
