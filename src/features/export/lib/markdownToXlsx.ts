import { readFile } from "@tauri-apps/plugin-fs";
import type { Md2XlsxImageAsset } from "@/vendor/md2xlsx";

/**
 * Extract image paths referenced by `![alt](url)` that point at local
 * relative files. Remote (http/https) and inline (data:) URIs are excluded,
 * as are absolute paths. The returned list is de-duplicated, preserving order.
 */
export function collectRelativeImagePaths(markdown: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const re = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const url = match[1];
    if (/^[a-z]+:/i.test(url)) continue; // http:, https:, data:, file:, etc.
    if (url.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(url)) continue; // absolute
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function contentTypeFor(path: string): string | undefined {
  const ext = path.toLowerCase().replace(/^.*\./, "");
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return undefined;
}

export interface MarkdownToXlsxOptions {
  /** Path of the currently open markdown file; used to resolve relative images. */
  filePath?: string | null;
  /** When true, split sheets by top-level heading. */
  splitByHeading?: boolean;
}

/**
 * Resolve relative images (best-effort) and convert markdown to .xlsx bytes
 * using the vendored miku-md2xlsx engine.
 */
export async function markdownToXlsx(
  markdown: string,
  options: MarkdownToXlsxOptions = {},
): Promise<Uint8Array> {
  const { md2xlsx } = await import("@/vendor/md2xlsx");

  const imageAssets: Md2XlsxImageAsset[] = [];
  const { filePath } = options;
  if (filePath) {
    const sep = filePath.includes("\\") ? "\\" : "/";
    let dir = filePath.replace(/[\\/][^\\/]*$/, "");
    if (dir === filePath) dir = "."; // bare filename: no directory component → current dir
    for (const relPath of collectRelativeImagePaths(markdown)) {
      const fsPath = `${dir}${sep}${relPath.replace(/\//g, sep)}`;
      try {
        const data = await readFile(fsPath);
        imageAssets.push({ path: relPath, data, contentType: contentTypeFor(relPath) });
      } catch {
        // Best-effort: skip images that cannot be read.
      }
    }
  }

  return md2xlsx(markdown, {
    sheetMode: options.splitByHeading ? "heading" : "single",
    imageAssets,
  });
}
