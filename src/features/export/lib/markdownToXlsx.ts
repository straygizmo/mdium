import { readFile } from "@tauri-apps/plugin-fs";
import JSZip from "jszip";
import type {
  CellModel,
  Md2XlsxImageAsset,
  WorkbookModel,
} from "@/vendor/md2xlsx";

/** EMU (English Metric Units) per pixel at 96 DPI. */
const EMU_PER_PX = 9525;

/** Read intrinsic pixel dimensions from PNG / GIF / JPEG bytes. */
export function imageSize(
  data: Uint8Array,
): { width: number; height: number } | undefined {
  // PNG
  if (
    data.length >= 24 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  ) {
    const u32 = (o: number) =>
      (((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0);
    return { width: u32(16), height: u32(20) };
  }
  // GIF
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return { width: data[6] | (data[7] << 8), height: data[8] | (data[9] << 8) };
  }
  // JPEG
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let o = 2;
    while (o + 9 < data.length) {
      if (data[o] !== 0xff) { o += 1; continue; }
      const marker = data[o + 1];
      const len = (data[o + 2] << 8) | data[o + 3];
      if (len < 2 || o + 2 + len > data.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: (data[o + 7] << 8) | data[o + 8], height: (data[o + 5] << 8) | data[o + 6] };
      }
      o += 2 + len;
    }
  }
  return undefined;
}

/** Escape HTML special characters for safe interpolation into innerHTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
 * Promote any line that contains only an image into a standalone, top-level
 * image paragraph: dedent it to column 0 and surround it with blank lines.
 *
 * Without this, an image written on the line directly below a list item (no
 * blank line) is absorbed into the list item as a lazy continuation, so the
 * engine never emits it as an image row and the picture is dropped.
 */
export function promoteStandaloneImages(markdown: string): string {
  const imageOnly = /^\s*(!\[[^\]]*\]\([^)]*\))\s*$/;
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(imageOnly);
    if (match) {
      if (out.length && out[out.length - 1].trim() !== "") out.push("");
      out.push(match[1]);
      out.push("");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Resolve relative images (best-effort) and rewrite Mermaid blocks to image
 * refs, returning the processed markdown and the collected image assets.
 */
async function resolveXlsxInputs(
  markdown: string,
  options: MarkdownToXlsxOptions,
): Promise<{ processed: string; imageAssets: Md2XlsxImageAsset[] }> {
  const { filePath, mermaidPngs } = options;

  // Embed Mermaid diagrams by rewriting their fenced blocks to image refs.
  const { markdown: injected, assets: mermaidAssets } =
    mermaidPngs && mermaidPngs.length
      ? injectMermaidDiagrams(markdown, mermaidPngs)
      : { markdown, assets: [] as Md2XlsxImageAsset[] };

  // Lift image-only lines out of list items so the engine emits image rows.
  const processed = promoteStandaloneImages(injected);

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

  return { processed, imageAssets };
}

/** Encode bytes to a base64 string in fixed-size chunks (stack-safe). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function renderCellContent(cell: CellModel): string {
  let inner: string;
  if (cell.richTextRuns && cell.richTextRuns.length) {
    inner = cell.richTextRuns
      .map((run) => {
        let t = escapeHtml(run.text);
        if (run.bold) t = `<b>${t}</b>`;
        if (run.italic) t = `<i>${t}</i>`;
        if (run.strike) t = `<s>${t}</s>`;
        if (run.underline) t = `<u>${t}</u>`;
        return t;
      })
      .join("");
  } else {
    inner = escapeHtml(cell.value ?? "");
  }
  if (cell.hyperlink?.target) {
    inner = `<a href="${escapeHtml(cell.hyperlink.target)}">${inner}</a>`;
  }
  return inner;
}

/**
 * Render an approximate HTML preview from the workbook model. Unlike a
 * SheetJS round-trip, this renders embedded images (resolved files and
 * rasterized Mermaid diagrams) inline as data URLs.
 */
export function renderWorkbookModelToHtml(model: WorkbookModel): string {
  const assets = model.imageAssets ?? [];
  return model.sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((row) => {
          if (row.imageRefs && row.imageRefs.length) {
            const imgs = row.imageRefs
              .map((ref) => {
                const asset = assets.find((a) => a.path === ref.path);
                if (!asset) return escapeHtml(ref.alt || ref.path);
                const ct = asset.contentType || "image/png";
                return `<img src="data:${ct};base64,${bytesToBase64(asset.data)}" alt="${escapeHtml(ref.alt || "")}" />`;
              })
              .join("");
            return `<tr><td>${imgs}</td></tr>`;
          }
          const cells = row.cells
            .map((c) => {
              const tag = c.styleRole === "tableHeader" ? "th" : "td";
              return `<${tag}>${renderCellContent(c)}</${tag}>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<h4>${escapeHtml(sheet.name)}</h4><table>${rows}</table>`;
    })
    .join("\n");
}

/**
 * Clear the cell text of image rows. The engine writes the raw `![](...)`
 * markdown into the cell next to the picture; we only want the picture.
 */
function clearImageRowText(model: WorkbookModel): void {
  for (const sheet of model.sheets) {
    for (const row of sheet.rows) {
      if (row.imageRefs && row.imageRefs.length) {
        for (const cell of row.cells) cell.value = "";
      }
    }
  }
}

/**
 * Rewrite the engine's image anchors so each picture sits in column A at its
 * native size. The engine hardcodes column B and stretches images to fill a
 * fixed cell box; replace each twoCellAnchor with a oneCellAnchor anchored at
 * column 0 with an explicit EMU extent derived from the image's real
 * dimensions (preserving aspect ratio).
 */
async function rewriteImageDrawings(
  bytes: Uint8Array,
  model: WorkbookModel,
): Promise<Uint8Array> {
  const byPath = new Map((model.imageAssets ?? []).map((a) => [a.path, a]));

  // Intrinsic dimensions of every drawn image, in the engine's anchor order
  // (sheet order, then row order; refs without a matching asset are skipped).
  const dims: { width: number; height: number }[] = [];
  for (const sheet of model.sheets) {
    for (const row of sheet.rows) {
      for (const ref of row.imageRefs ?? []) {
        const asset = byPath.get(ref.path);
        if (!asset) continue;
        dims.push(imageSize(asset.data) ?? { width: 0, height: 0 });
      }
    }
  }
  if (dims.length === 0) return bytes;

  const zip = await JSZip.loadAsync(bytes);
  const drawingNames = Object.keys(zip.files)
    .filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)\.xml$/)![1]);
      const nb = Number(b.match(/(\d+)\.xml$/)![1]);
      return na - nb;
    });

  let idx = 0;
  for (const name of drawingNames) {
    const xmlText = await zip.file(name)!.async("string");
    const rewritten = xmlText.replace(
      /<xdr:twoCellAnchor[^>]*>([\s\S]*?)<\/xdr:twoCellAnchor>/g,
      (_full, inner: string) => {
        const d = dims[idx++] ?? { width: 0, height: 0 };
        const rowMatch = inner.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
        const row = rowMatch ? rowMatch[1] : "0";
        const picMatch = inner.match(/<xdr:pic>[\s\S]*?<\/xdr:pic>/);
        const pic = picMatch ? picMatch[0] : "";
        const cx = Math.max(1, Math.round(d.width * EMU_PER_PX));
        const cy = Math.max(1, Math.round(d.height * EMU_PER_PX));
        return (
          `<xdr:oneCellAnchor>` +
          `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
          `<xdr:ext cx="${cx}" cy="${cy}"/>` +
          pic +
          `<xdr:clientData/>` +
          `</xdr:oneCellAnchor>`
        );
      },
    );
    zip.file(name, rewritten);
  }

  return zip.generateAsync({ type: "uint8array" });
}

export interface XlsxArtifacts {
  /** The .xlsx file bytes, ready to save. */
  bytes: Uint8Array;
  /** An HTML approximation of the workbook, with images rendered inline. */
  previewHtml: string;
}

/**
 * Build both the .xlsx bytes and an image-aware HTML preview from markdown,
 * resolving relative images and embedding rasterized Mermaid diagrams. The
 * model is built once and reused for both outputs. Image rows are stripped of
 * their markdown text and the pictures are placed in column A at native size.
 */
export async function markdownToXlsxArtifacts(
  markdown: string,
  options: MarkdownToXlsxOptions = {},
): Promise<XlsxArtifacts> {
  const { markdownToXlsxModel, workbookModelToXlsx } = await import("@/vendor/md2xlsx");
  const { processed, imageAssets } = await resolveXlsxInputs(markdown, options);
  const model = markdownToXlsxModel(processed, {
    sheetMode: options.splitByHeading ? "heading" : "single",
    imageAssets,
  });
  // Render the preview before clearing text — image rows render the picture,
  // and other rows keep their text.
  const previewHtml = renderWorkbookModelToHtml(model);
  clearImageRowText(model);
  const bytes = await rewriteImageDrawings(workbookModelToXlsx(model), model);
  return { bytes, previewHtml };
}

/**
 * Resolve relative images (best-effort), embed rasterized Mermaid diagrams,
 * and convert markdown to .xlsx bytes using the vendored miku-md2xlsx engine.
 */
export async function markdownToXlsx(
  markdown: string,
  options: MarkdownToXlsxOptions = {},
): Promise<Uint8Array> {
  return (await markdownToXlsxArtifacts(markdown, options)).bytes;
}
