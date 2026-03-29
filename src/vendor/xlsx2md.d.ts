/**
 * Type declarations for the vendored xlsx2md module (src/vendor/xlsx2md.js).
 *
 * The JS bundle registers itself via a global module registry and re-exports
 * four main helpers as named ES module exports.  These declarations cover
 * the public surface used by mdium.
 */

// ── Domain types ────────────────────────────────────────────────────────────

export interface ParsedWorkbook {
  name: string;
  sheets: ParsedSheet[];
}

export interface ParsedSheet {
  name: string;
  images: Array<{ path: string; data: Uint8Array }>;
  shapes?: Array<{ svgPath?: string; svgData?: Uint8Array }>;
}

export interface MarkdownOptions {
  formattingMode?: "plain" | "github";
  tableDetectionMode?: "balanced" | "border";
  outputMode?: "display" | "raw" | "both";
  treatFirstRowAsHeader?: boolean;
  trimText?: boolean;
  removeEmptyRows?: boolean;
  removeEmptyColumns?: boolean;
}

export interface MarkdownFile {
  fileName: string;
  content: string;
  sheetName: string;
  summary: {
    outputMode: string;
    formattingMode: string;
  };
}

export interface ExportEntry {
  /** Entry path with `output/` prefix, e.g. `"output/images/chart1.png"`. */
  name: string;
  data: Uint8Array;
}

// ── Function exports ────────────────────────────────────────────────────────

export function parseWorkbook(
  arrayBuffer: ArrayBuffer,
  workbookName?: string,
): Promise<ParsedWorkbook>;

export function convertWorkbookToMarkdownFiles(
  workbook: ParsedWorkbook,
  options?: MarkdownOptions,
): MarkdownFile[];

export function createCombinedMarkdownExportFile(
  workbook: ParsedWorkbook,
  markdownFiles: MarkdownFile[],
): { fileName: string; content: string };

export function createExportEntries(
  workbook: ParsedWorkbook,
  markdownFiles: MarkdownFile[],
): ExportEntry[];

// ── Default export (the api object) ─────────────────────────────────────────

interface Xlsx2mdApi {
  parseWorkbook: typeof parseWorkbook;
  convertWorkbookToMarkdownFiles: typeof convertWorkbookToMarkdownFiles;
  createCombinedMarkdownExportFile: typeof createCombinedMarkdownExportFile;
  createExportEntries: typeof createExportEntries;
}

declare const xlsx2md: Xlsx2mdApi;
export default xlsx2md;
