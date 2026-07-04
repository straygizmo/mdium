import { invoke } from "@tauri-apps/api/core";
import type { FileEntry, ReplacementSettings } from "@/shared/types";
import { applyForwardWithCount, applyReverseWithCount } from "@/shared/lib/replacement";

/**
 * Collect all .md file paths from a FileEntry tree. Dot-directories
 * (including .mdium) and node_modules are skipped so index/database files
 * are never rewritten.
 */
export function collectMdPaths(tree: FileEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of tree) {
    if (entry.is_dir) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.children) paths.push(...collectMdPaths(entry.children));
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      paths.push(entry.path);
    }
  }
  return paths;
}

export interface BulkReplaceSummary {
  changedPaths: string[];
  totalReplacements: number;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Rewrite files on disk applying the replacement rules in the given
 * direction. Files without matches are left untouched. Per-file failures
 * are collected and do not abort the run.
 */
export async function runBulkReplace(
  paths: string[],
  settings: ReplacementSettings,
  direction: "forward" | "reverse",
): Promise<BulkReplaceSummary> {
  const apply = direction === "forward" ? applyForwardWithCount : applyReverseWithCount;
  const summary: BulkReplaceSummary = { changedPaths: [], totalReplacements: 0, failed: [] };
  for (const path of paths) {
    try {
      const content = await invoke<string>("read_text_file", { path });
      const { text, count } = apply(content, settings);
      if (count === 0 || text === content) continue;
      await invoke("write_text_file", { path, content: text });
      summary.changedPaths.push(path);
      summary.totalReplacements += count;
    } catch (e) {
      summary.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}
