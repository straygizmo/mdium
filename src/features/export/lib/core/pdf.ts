import type { ConvertedDocument } from "./types";

/** The part of the pdfjs-dist API the converter uses (browser and legacy Node builds both fit). */
export interface PdfjsLike {
  getDocument(src: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
      destroy?(): Promise<void>;
    }>;
  };
}

/** A positioned text run extracted from a PDF page. */
export interface PdfTextItem {
  /** 1-based page number. */
  page: number;
  str: string;
  x: number;
  y: number;
  fontSize: number;
}

/** Thrown when a PDF has no extractable text (e.g. a scanned document). */
export class PdfNoTextError extends Error {
  constructor() {
    super("No text could be extracted from this PDF. It may contain only scanned images.");
    this.name = "PdfNoTextError";
  }
}

/**
 * Turn the text runs of a PDF into Markdown: runs are grouped into lines by
 * page and Y coordinate, pages are kept in order, paragraphs are split on large
 * vertical gaps, and headings are inferred from the font size ratio to the
 * most common (body) size.
 */
export function pdfTextItemsToMarkdown(allItems: PdfTextItem[]): string {
  if (allItems.length === 0) throw new PdfNoTextError();

  // Determine body font size (most common)
  const sizeCount = new Map<number, number>();
  for (const item of allItems) {
    const rounded = Math.round(item.fontSize * 10) / 10;
    sizeCount.set(rounded, (sizeCount.get(rounded) || 0) + 1);
  }
  let bodySize = 12;
  let maxCount = 0;
  for (const [size, count] of sizeCount) {
    if (count > maxCount) {
      maxCount = count;
      bodySize = size;
    }
  }

  // Group items into lines by page and Y coordinate (items of one page
  // within 2px are the same line)
  interface Line {
    page: number;
    y: number;
    items: PdfTextItem[];
    fontSize: number; // max font size in line
  }
  const lines: Line[] = [];
  const linesByPage = new Map<number, Line[]>();
  for (const item of allItems) {
    let pageLines = linesByPage.get(item.page);
    if (!pageLines) {
      pageLines = [];
      linesByPage.set(item.page, pageLines);
    }
    const line = pageLines.find((l) => Math.abs(l.y - item.y) < 2);
    if (line) {
      line.items.push(item);
      if (item.fontSize > line.fontSize) line.fontSize = item.fontSize;
    } else {
      const created = { page: item.page, y: item.y, items: [item], fontSize: item.fontSize };
      pageLines.push(created);
      lines.push(created);
    }
  }

  // Sort lines by page, then top-to-bottom (higher Y = higher on page in PDF coords)
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  // Sort items within each line left-to-right
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  const mdLines: string[] = [];
  let prevY: number | null = null;
  let prevPage: number | null = null;
  for (const line of lines) {
    const text = line.items.map((it) => it.str).join(" ").trim();
    if (!text) continue;

    // A new page always starts a new paragraph; otherwise detect a
    // paragraph break by a large Y gap.
    if (prevPage !== null && line.page !== prevPage) {
      mdLines.push("");
    } else if (prevY !== null) {
      const gap = Math.abs(prevY - line.y);
      if (gap > line.fontSize * 1.5 * 1.3) mdLines.push("");
    }
    prevY = line.y;
    prevPage = line.page;

    // Heading detection based on font size ratio
    const ratio = line.fontSize / bodySize;
    if (ratio >= 1.8) mdLines.push(`# ${text}`);
    else if (ratio >= 1.4) mdLines.push(`## ${text}`);
    else if (ratio >= 1.15) mdLines.push(`### ${text}`);
    else mdLines.push(text);
  }

  return mdLines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Extract the text runs of every page of a PDF. */
export async function extractPdfTextItems(data: Uint8Array, pdfjs: PdfjsLike): Promise<PdfTextItem[]> {
  // pdfjs may transfer (detach) the buffer it is given, so hand it a copy.
  const pdf = await pdfjs.getDocument({ data: data.slice() }).promise;
  try {
    const items: PdfTextItem[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      for (const raw of textContent.items) {
        const item = raw as { str?: unknown; transform?: number[] };
        if (typeof item.str !== "string" || !item.str.trim() || !item.transform) continue;
        const t = item.transform;
        const fontSize = Math.abs(t[0]) || Math.abs(t[3]) || 12;
        items.push({ page: i, str: item.str, x: t[4], y: t[5], fontSize });
      }
    }
    return items;
  } finally {
    await pdf.destroy?.();
  }
}

/** Convert a .pdf file to Markdown (text only; PDFs produce no assets). */
export async function convertPdf(data: Uint8Array, pdfjs: PdfjsLike): Promise<ConvertedDocument> {
  const items = await extractPdfTextItems(data, pdfjs);
  return { markdown: pdfTextItemsToMarkdown(items), assets: [] };
}
