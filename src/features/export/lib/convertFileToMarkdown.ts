import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "./collectConvertibleFiles";
import { docxToMarkdown } from "./docxToMarkdown";
import type { ConvertResult } from "./docxToMarkdown";
import { xlsxToMarkdown } from "./xlsxToMarkdown";
import { pptxToMarkdown } from "./pptxToMarkdown";
import { pdfToMarkdown } from "./pdfToMarkdown";

/** Localized labels the PowerPoint converter needs for slide headings. */
export interface PptxLabels {
  slideFallback: (n: number) => string;
  notes: string;
}

/** Error marker the desktop side prefixes when Word cannot be automated at all. */
const WORD_NOT_AVAILABLE_MARKER = "WORD_NOT_AVAILABLE";

/** Thrown when Microsoft Word is not installed (or COM automation is blocked). */
export class WordUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WordUnavailableError";
  }
}

async function readBinary(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_binary_file", { path });
  return new Uint8Array(bytes);
}

async function convertDocToDocx(docPath: string): Promise<string> {
  try {
    return await invoke<string>("convert_doc_to_docx", { path: docPath });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith(WORD_NOT_AVAILABLE_MARKER)) {
      throw new WordUnavailableError(message);
    }
    throw e instanceof Error ? e : new Error(message);
  }
}

/**
 * Convert one collected file to Markdown and return where the .md was written.
 *
 * Legacy `.doc` files are first turned into a sibling `.docx` by the desktop
 * side (Word automation), and that `.docx` then goes through the regular docx
 * path, so the Markdown lands next to the `.docx` exactly as a native one would.
 */
export async function convertFileToMarkdown(
  file: ConvertibleFile,
  saveToMdium: boolean,
  pptxLabels: PptxLabels,
): Promise<ConvertResult> {
  if (file.type === "doc") {
    const docxPath = await convertDocToDocx(file.path);
    return docxToMarkdown(await readBinary(docxPath), docxPath, saveToMdium);
  }

  const data = await readBinary(file.path);
  switch (file.type) {
    case "docx":
      return docxToMarkdown(data, file.path, saveToMdium);
    case "xlsx":
      return xlsxToMarkdown(data, file.path, saveToMdium);
    case "pptx":
      return pptxToMarkdown(data, file.path, saveToMdium, pptxLabels);
    case "pdf":
      return pdfToMarkdown(data, file.path, saveToMdium);
  }
}
