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

/**
 * Resolve a relative image URL against a directory into a filesystem path,
 * mirroring the markdown preview's resolution (PreviewPanel.tsx): decode
 * percent-encoding, normalize separators to "/", and collapse "." / ".."
 * segments. This keeps XLSX image resolution in parity with what the preview
 * can display.
 */
export function resolveImagePath(dir: string, relPath: string): string {
  const src = decodeURIComponent(relPath);
  const combined = dir.replace(/\\/g, "/") + "/" + src;
  const resolved: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join("/");
}

/**
 * Replace fenced ```mermaid blocks with standalone image references so the
 * vendored engine embeds them as pictures, and build the matching image
 * assets from the pre-rasterized PNGs. The Nth mermaid block maps to the Nth
 * PNG (document order matches the preview's placeholder order). A block with
 * no corresponding PNG is dropped from the output.
 */
export function injectMermaidDiagrams(
  markdown: string,
  mermaidPngs: (Uint8Array | null)[],
): { markdown: string; assets: Md2XlsxImageAsset[] } {
  const assets: Md2XlsxImageAsset[] = [];
  let index = 0;
  const out = markdown.replace(
    /```mermaid[^\n]*\n[\s\S]*?\n```/g,
    () => {
      const png = mermaidPngs[index];
      const path = `__mermaid_${index}__.png`;
      index += 1;
      if (!png) return ""; // No raster available — drop the diagram block.
      assets.push({ path, data: png, contentType: "image/png" });
      return `![](${path})`;
    },
  );
  return { markdown: out, assets };
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
  /**
   * PNG rasterizations of the document's Mermaid diagrams, in document order.
   * A null entry (failed rasterization) drops that diagram. When provided,
   * ```mermaid blocks are embedded as pictures.
   */
  mermaidPngs?: (Uint8Array | null)[];
}

/**
 * Resolve relative images (best-effort), embed rasterized Mermaid diagrams,
 * and convert markdown to .xlsx bytes using the vendored miku-md2xlsx engine.
 */
export async function markdownToXlsx(
  markdown: string,
  options: MarkdownToXlsxOptions = {},
): Promise<Uint8Array> {
  const { md2xlsx } = await import("@/vendor/md2xlsx");
  const { filePath, mermaidPngs } = options;

  // Embed Mermaid diagrams by rewriting their fenced blocks to image refs.
  const { markdown: processed, assets: mermaidAssets } =
    mermaidPngs && mermaidPngs.length
      ? injectMermaidDiagrams(markdown, mermaidPngs)
      : { markdown, assets: [] as Md2XlsxImageAsset[] };

  const imageAssets: Md2XlsxImageAsset[] = [...mermaidAssets];

  // Resolve relative image files from the original markdown (best-effort).
  if (filePath) {
    let dir = filePath.replace(/[\\/][^\\/]+$/, "");
    if (dir === filePath) dir = "."; // bare filename: no directory component → current dir
    for (const relPath of collectRelativeImagePaths(markdown)) {
      try {
        const data = await readFile(resolveImagePath(dir, relPath));
        imageAssets.push({ path: relPath, data, contentType: contentTypeFor(relPath) });
      } catch {
        // Best-effort: skip images that cannot be read.
      }
    }
  }

  return md2xlsx(processed, {
    sheetMode: options.splitByHeading ? "heading" : "single",
    imageAssets,
  });
}
