import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import type {
  BatchConvertSummary,
  BatchConvertFileResult,
} from "./useBatchConvert";

interface DeleteMdResult {
  source_path: string;
  md_path: string;
  status: "deleted" | "notfound" | "failed";
  error?: string;
}

export function useBatchDeleteMd() {
  const [isDeleting, setIsDeleting] = useState(false);
  const [summary, setSummary] = useState<BatchConvertSummary | null>(null);

  const deleteMd = useCallback(
    async (files: ConvertibleFile[], inMdium: boolean) => {
      setIsDeleting(true);
      setSummary(null);

      const paths = files.map((f) => f.path);
      let results: DeleteMdResult[];
      try {
        results = await invoke<DeleteMdResult[]>("delete_generated_md", {
          paths,
          inMdium,
        });
      } catch (e) {
        // Whole-call failure: mark every requested file as failed.
        results = files.map((f) => ({
          source_path: f.path,
          md_path: "",
          status: "failed" as const,
          error: e instanceof Error ? e.message : String(e),
        }));
      }

      const byPath = new Map(files.map((f) => [f.path, f]));
      const fileResults: BatchConvertFileResult[] = results.map((r) => {
        const file: ConvertibleFile =
          byPath.get(r.source_path) ?? {
            name: r.md_path || r.source_path,
            path: r.source_path,
            type: "docx",
            hasExistingMdSibling: false,
            hasExistingMdInMdium: false,
          };
        const status: BatchConvertFileResult["status"] =
          r.status === "deleted"
            ? "success"
            : r.status === "notfound"
              ? "skipped"
              : "failed";
        return { file, status, error: r.error, mdPath: r.md_path };
      });

      const s: BatchConvertSummary = {
        success: fileResults.filter((r) => r.status === "success").length,
        failed: fileResults.filter((r) => r.status === "failed").length,
        skipped: fileResults.filter((r) => r.status === "skipped").length,
        results: fileResults,
      };
      setSummary(s);
      setIsDeleting(false);
      return s;
    },
    []
  );

  const reset = useCallback(() => {
    setSummary(null);
    setIsDeleting(false);
  }, []);

  return { isDeleting, summary, deleteMd, reset };
}
