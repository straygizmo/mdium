import type { FileEntry } from "@/shared/types";

export interface ConvertibleFile {
  name: string;
  path: string;
  type: "docx" | "pdf";
  hasExistingMd: boolean;
}

/**
 * Recursively collect .docx and .pdf files from a FileEntry tree.
 * Also checks whether a corresponding .md file already exists in the same directory.
 */
export function collectConvertibleFiles(tree: FileEntry[]): ConvertibleFile[] {
  const results: ConvertibleFile[] = [];
  walkTree(tree, results);
  return results;
}

function walkTree(entries: FileEntry[], results: ConvertibleFile[]): void {
  // Collect sibling names for .md existence check
  const siblingNames = new Set(
    entries.filter((e) => !e.is_dir).map((e) => e.name.toLowerCase())
  );

  for (const entry of entries) {
    if (entry.is_dir) {
      if (entry.children) {
        walkTree(entry.children, results);
      }
      continue;
    }

    const lower = entry.name.toLowerCase();
    let type: "docx" | "pdf" | null = null;
    if (lower.endsWith(".docx")) type = "docx";
    else if (lower.endsWith(".pdf")) type = "pdf";

    if (!type) continue;

    const baseName = entry.name.replace(/\.\w+$/i, "");
    const hasExistingMd = siblingNames.has(`${baseName}.md`.toLowerCase());

    results.push({
      name: entry.name,
      path: entry.path,
      type,
      hasExistingMd,
    });
  }
}
