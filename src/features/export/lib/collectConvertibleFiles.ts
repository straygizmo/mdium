import type { FileEntry } from "@/shared/types";

export interface ConvertibleFile {
  name: string;
  path: string;
  type: "docx" | "pdf" | "xlsx";
  hasExistingMdSibling: boolean;
  hasExistingMdInMdium: boolean;
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
    let type: "docx" | "pdf" | "xlsx" | null = null;
    if (lower.endsWith(".docx")) type = "docx";
    else if (lower.endsWith(".pdf")) type = "pdf";
    else if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) type = "xlsx";

    if (!type) continue;

    const baseName = entry.name.replace(/\.\w+$/i, "");
    const hasExistingMdSibling = siblingNames.has(`${baseName}.md`.toLowerCase());

    results.push({
      name: entry.name,
      path: entry.path,
      type,
      hasExistingMdSibling,
      hasExistingMdInMdium: false,
    });
  }
}

export interface ConvertibleTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ConvertibleTreeNode[] | null;
  fileType?: "docx" | "pdf" | "xlsx";
  hasExistingMdSibling?: boolean;
  hasExistingMdInMdium?: boolean;
}

/**
 * Build a tree of convertible files, preserving folder hierarchy.
 * Folders that contain no convertible files (recursively) are pruned.
 */
export function buildConvertibleTree(tree: FileEntry[]): ConvertibleTreeNode[] {
  const result: ConvertibleTreeNode[] = [];
  const siblingNames = new Set(
    tree.filter((e) => !e.is_dir).map((e) => e.name.toLowerCase())
  );

  for (const entry of tree) {
    if (entry.is_dir) {
      const children = entry.children
        ? buildConvertibleTree(entry.children)
        : [];
      if (children.length > 0) {
        result.push({
          name: entry.name,
          path: entry.path,
          isDir: true,
          children,
        });
      }
      continue;
    }

    const lower = entry.name.toLowerCase();
    let fileType: "docx" | "pdf" | "xlsx" | null = null;
    if (lower.endsWith(".docx")) fileType = "docx";
    else if (lower.endsWith(".pdf")) fileType = "pdf";
    else if (
      lower.endsWith(".xlsx") ||
      lower.endsWith(".xlsm") ||
      lower.endsWith(".xls")
    )
      fileType = "xlsx";

    if (!fileType) continue;

    const baseName = entry.name.replace(/\.\w+$/i, "");
    const hasExistingMdSibling = siblingNames.has(`${baseName}.md`.toLowerCase());

    result.push({
      name: entry.name,
      path: entry.path,
      isDir: false,
      children: null,
      fileType,
      hasExistingMdSibling,
      hasExistingMdInMdium: false,
    });
  }

  return result;
}

/**
 * Prune the convertible tree to only include files matching the given filter.
 * Folders with no matching descendants are removed.
 */
export function pruneTreeByFilter(
  tree: ConvertibleTreeNode[],
  filter: "all" | "docx" | "pdf" | "xlsx"
): ConvertibleTreeNode[] {
  if (filter === "all") return tree;
  const result: ConvertibleTreeNode[] = [];
  for (const node of tree) {
    if (node.isDir) {
      const children = pruneTreeByFilter(node.children ?? [], filter);
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else if (node.fileType === filter) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Recursively collect all file paths from a ConvertibleTreeNode tree.
 */
export function collectFilePaths(tree: ConvertibleTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of tree) {
    if (node.isDir) {
      paths.push(...collectFilePaths(node.children ?? []));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

/**
 * Recursively collect all file paths from a single node's descendants.
 */
export function collectDescendantPaths(node: ConvertibleTreeNode): string[] {
  if (!node.isDir) return [node.path];
  const paths: string[] = [];
  for (const child of node.children ?? []) {
    paths.push(...collectDescendantPaths(child));
  }
  return paths;
}
