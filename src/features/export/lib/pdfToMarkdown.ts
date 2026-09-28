import { convertPdf, type PdfjsLike } from "./core/pdf";
import { outputLocation, writeConverted, type ConvertResult } from "./docxToMarkdown";

let workerConfigured = false;

/** pdfjs-dist configured with its bundled worker (Vite `?url` import). */
async function loadBrowserPdfjs(): Promise<PdfjsLike> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!workerConfigured) {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }
  return pdfjsLib as unknown as PdfjsLike;
}

/**
 * Convert a .pdf file (as Uint8Array) to Markdown.
 * Extracts text using pdfjs-dist, groups by lines, and infers headings from font size.
 * Returns the path of the generated .md file.
 */
export async function pdfToMarkdown(
  data: Uint8Array,
  pdfPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  const { sep, outputDir, mdPath } = outputLocation(pdfPath, /\.pdf$/i, saveToMdium);
  const { markdown, assets } = await convertPdf(data, await loadBrowserPdfjs());
  await writeConverted(outputDir, sep, mdPath, markdown, assets, saveToMdium);
  return { mdPath };
}
