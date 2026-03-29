import { writeTextFile, writeFile, mkdir } from "@tauri-apps/plugin-fs";
import type { ConvertResult } from "./docxToMarkdown";

/**
 * Convert an .xlsx / .xlsm file (as Uint8Array) to Markdown.
 * Images and shapes are extracted and saved to `{baseName}_images/` next to the
 * original spreadsheet.  Returns the path of the generated .md file.
 */
export async function xlsxToMarkdown(
  data: Uint8Array,
  xlsxPath: string,
): Promise<ConvertResult> {
  const {
    parseWorkbook,
    convertWorkbookToMarkdownFiles,
    createCombinedMarkdownExportFile,
    createExportEntries,
  } = await import("@/vendor/xlsx2md");

  // ── Derive output paths ───────────────────────────────────────────────────
  const dir = xlsxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = xlsxPath
    .replace(/^.*[\\/]/, "")
    .replace(/\.xlsx?m?$/i, "");
  const imagesDir = `${dir}/${baseName}_images`;
  const mdPath = `${dir}/${baseName}.md`;

  // ── Parse workbook ────────────────────────────────────────────────────────
  const workbook = await parseWorkbook(data.buffer as ArrayBuffer, baseName);

  // ── Convert to markdown ───────────────────────────────────────────────────
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

  // ── Collect image / shape entries ─────────────────────────────────────────
  const entries = createExportEntries(workbook, markdownFiles);

  // Keep only non-.md asset entries (images, shapes, etc.)
  const assetEntries = entries.filter(
    (e) => !e.name.endsWith(".md"),
  );

  // ── Save assets ───────────────────────────────────────────────────────────
  if (assetEntries.length > 0) {
    await mkdir(imagesDir, { recursive: true });

    for (const entry of assetEntries) {
      // Strip the "output/" prefix and extract the filename
      const fileName = entry.name
        .replace(/^output\//, "")
        .replace(/^.*[\\/]/, "");
      await writeFile(`${imagesDir}/${fileName}`, entry.data);
    }
  }

  // ── Save markdown ────────────────────────────────────────────────────────
  await writeTextFile(mdPath, combined.content);

  return { mdPath };
}
