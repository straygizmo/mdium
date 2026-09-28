// Pure document -> Markdown conversion shared by the frontend (BatchConvert,
// preview) and the Node sidecars (agent runner, mdium-docs MCP server).
// Nothing here touches the file system or depends on Tauri / Vite.
import type { PptxLabels } from "../pptxParser";
import type { PdfjsLike } from "./pdf";
import type { ConvertedDocument } from "./types";

export type { ConvertedAsset, ConvertedDocument } from "./types";
export type { PdfjsLike } from "./pdf";
export type { PptxLabels } from "../pptxParser";

export type DocumentKind = "docx" | "xlsx" | "pptx" | "pdf";

const KIND_BY_EXTENSION: Record<string, DocumentKind> = {
  docx: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  pptx: "pptx",
  pdf: "pdf",
};

/** Extensions (lowercase, without the dot) that {@link convertDocument} accepts. */
export const CONVERTIBLE_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXTENSION);

/** The document kind of a file name or path by extension; undefined if not convertible. */
export function documentKind(fileName: string): DocumentKind | undefined {
  const match = /\.([^.\\/]+)$/.exec(fileName);
  return match ? KIND_BY_EXTENSION[match[1].toLowerCase()] : undefined;
}

/** The file name without directories and extension; used to name assets. */
export function documentBaseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

export interface ConvertEnv {
  /** Loads a configured pdfjs module (the browser and Node set up its worker differently). */
  loadPdfjs: () => Promise<PdfjsLike>;
  /** Labels for slides without a title and for speaker notes. */
  pptxLabels: PptxLabels;
}

/** Convert one document, dispatching on the extension of `fileName`. */
export async function convertDocument(data: Uint8Array, fileName: string, env: ConvertEnv): Promise<ConvertedDocument> {
  const kind = documentKind(fileName);
  const baseName = documentBaseName(fileName);
  switch (kind) {
    case "docx":
      return (await import("./docx")).convertDocx(data, baseName);
    case "xlsx":
      return (await import("./xlsx")).convertXlsx(data, baseName);
    case "pptx":
      return (await import("./pptx")).convertPptx(data, baseName, env.pptxLabels);
    case "pdf":
      return (await import("./pdf")).convertPdf(data, await env.loadPdfjs());
    default:
      throw new Error(`Unsupported document type: ${fileName}`);
  }
}
