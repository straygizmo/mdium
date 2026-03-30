import { writeTextFile, writeFile, mkdir } from "@tauri-apps/plugin-fs";
import type { ConvertResult } from "./docxToMarkdown";

/**
 * Convert an .xlsx / .xlsm file (as Uint8Array) to Markdown.
 * Images and shapes are extracted and saved to `{baseName}_assets/images/` next
 * to the original spreadsheet.  Returns the path of the generated .md file.
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
    .replace(/\.(?:xlsx|xlsm)$/i, "");
  const assetsDir = `${dir}/${baseName}_assets`;
  const imagesDir = `${assetsDir}/images`;
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
      // Strip "output/" prefix and "assets/" prefix (now represented by imagesDir)
      const relativePath = entry.name.replace(/^output\//, "").replace(/^assets\//, "");
      const targetPath = `${imagesDir}/${relativePath}`;

      // Create subdirectories if needed (e.g. images/, shapes/)
      const targetDir = targetPath.replace(/[\\/][^\\/]*$/, "");
      if (targetDir !== imagesDir) {
        await mkdir(targetDir, { recursive: true });
      }

      await writeFile(targetPath, entry.data);
    }
  }

  // ── Rewrite image paths in markdown ────────────────────────────────────
  // xlsx2md emits relative paths like "assets/Sheet1/image1.png" in the
  // markdown, but we save assets under "{baseName}_assets/images/". Rewrite so
  // the references resolve relative to the .md file.
  let markdown = combined.content;
  for (const entry of assetEntries) {
    const originalPath = entry.name.replace(/^output\//, "");
    const strippedPath = originalPath.replace(/^assets\//, "");
    const rewrittenPath = `${baseName}_assets/images/${strippedPath}`;
    markdown = markdown.split(originalPath).join(rewrittenPath);
  }

  // ── Save markdown ────────────────────────────────────────────────────────
  await writeTextFile(mdPath, markdown);

  return { mdPath };
}
