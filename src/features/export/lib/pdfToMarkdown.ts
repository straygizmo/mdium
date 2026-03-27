import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { ConvertResult } from "./docxToMarkdown";

let workerConfigured = false;

/**
 * Convert a .pdf file (as Uint8Array) to Markdown.
 * Extracts text using pdfjs-dist, groups by lines, and infers headings from font size.
 * Returns the path of the generated .md file.
 */
export async function pdfToMarkdown(
  data: Uint8Array,
  pdfPath: string
): Promise<ConvertResult> {
  const pdfjsLib = await import("pdfjs-dist");

  if (!workerConfigured) {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }

  const dir = pdfPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = pdfPath.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "");
  const mdPath = `${dir}/${baseName}.md`;

  const pdf = await pdfjsLib.getDocument({ data }).promise;

  interface TextItem {
    str: string;
    x: number;
    y: number;
    fontSize: number;
  }

  const allItems: TextItem[] = [];
  const fontSizes: number[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    for (const item of textContent.items) {
      if (!("str" in item) || !item.str.trim()) continue;

      const transform = item.transform;
      const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
      const x = transform[4];
      const y = transform[5];

      allItems.push({ str: item.str, x, y, fontSize });
      fontSizes.push(fontSize);
    }
  }

  if (allItems.length === 0) {
    throw new Error(
      "No text could be extracted from this PDF. It may contain only scanned images."
    );
  }

  // Determine body font size (most common)
  const sizeCount = new Map<number, number>();
  for (const s of fontSizes) {
    const rounded = Math.round(s * 10) / 10;
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

  // Group items into lines by Y coordinate (items within 2px are same line)
  interface Line {
    y: number;
    items: TextItem[];
    fontSize: number; // max font size in line
  }

  const lines: Line[] = [];
  for (const item of allItems) {
    let found = false;
    for (const line of lines) {
      if (Math.abs(line.y - item.y) < 2) {
        line.items.push(item);
        if (item.fontSize > line.fontSize) line.fontSize = item.fontSize;
        found = true;
        break;
      }
    }
    if (!found) {
      lines.push({ y: item.y, items: [item], fontSize: item.fontSize });
    }
  }

  // Sort lines top-to-bottom (higher Y = higher on page in PDF coords)
  lines.sort((a, b) => b.y - a.y);

  // Sort items within each line left-to-right
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  // Build markdown with heading detection
  const mdLines: string[] = [];
  let prevY: number | null = null;

  for (const line of lines) {
    const text = line.items.map((it) => it.str).join(" ").trim();
    if (!text) continue;

    // Detect paragraph break by large Y gap
    if (prevY !== null) {
      const gap = Math.abs(prevY - line.y);
      const lineHeight = line.fontSize * 1.5;
      if (gap > lineHeight * 1.3) {
        mdLines.push("");
      }
    }
    prevY = line.y;

    // Heading detection based on font size ratio
    const ratio = line.fontSize / bodySize;
    if (ratio >= 1.8) {
      mdLines.push(`# ${text}`);
    } else if (ratio >= 1.4) {
      mdLines.push(`## ${text}`);
    } else if (ratio >= 1.15) {
      mdLines.push(`### ${text}`);
    } else {
      mdLines.push(text);
    }
  }

  const markdown = mdLines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  await writeTextFile(mdPath, markdown);

  return { mdPath };
}
