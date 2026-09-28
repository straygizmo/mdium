import type { ConvertedDocument } from "./types";
import { exactArrayBuffer } from "./docx";

/**
 * Convert an .xlsx / .xlsm file to Markdown. Images and shapes are returned
 * as assets under `{baseName}_assets/images/`.
 */
export async function convertXlsx(data: Uint8Array, baseName: string): Promise<ConvertedDocument> {
  // Relative import (not the "@/" alias) so the Node bundles resolve it too.
  const { parseWorkbook, convertWorkbookToMarkdownFiles, createCombinedMarkdownExportFile, createExportEntries } =
    await import("../../../../vendor/xlsx2md");

  const workbook = await parseWorkbook(exactArrayBuffer(data), baseName);
  const markdownFiles = convertWorkbookToMarkdownFiles(workbook, {
    formattingMode: "github",
    tableDetectionMode: "balanced",
    outputMode: "display",
    treatFirstRowAsHeader: true,
    trimText: true,
    removeEmptyRows: true,
    removeEmptyColumns: true,
  });
  const combined = createCombinedMarkdownExportFile(workbook, markdownFiles);

  // Keep only non-.md entries (images, shapes, etc.)
  const assetEntries = createExportEntries(workbook, markdownFiles).filter((e) => !e.name.endsWith(".md"));

  // xlsx2md emits paths like "assets/Sheet1/image1.png"; the assets are placed
  // under "{baseName}_assets/images/", so rewrite the references to match.
  let markdown = combined.content;
  const assets = assetEntries.map((entry) => {
    const originalPath = entry.name.replace(/^output\//, "");
    const strippedPath = originalPath.replace(/^assets\//, "");
    const rewrittenPath = `${baseName}_assets/images/${strippedPath}`;
    markdown = markdown.split(originalPath).join(rewrittenPath);
    return { path: rewrittenPath, data: entry.data };
  });

  return { markdown, assets };
}
