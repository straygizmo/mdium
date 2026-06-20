/**
 * Type declarations for the vendored miku-md2xlsx module (src/vendor/md2xlsx.js).
 *
 * The bundle re-exports the engine's public API from core.ts. These
 * declarations cover the public surface used by mdium.
 */

export type SheetMode = "single" | "heading";

export interface Md2XlsxImageAsset {
  /** Matches the markdown image url (the path passed in the document). */
  path: string;
  data: Uint8Array;
  contentType?: string;
}

export interface Md2XlsxOptions {
  sheetMode?: SheetMode;
  sheetHeadingDepth?: 1 | 2;
  title?: string;
  tableStyle?: "plain" | "bordered";
  headerRow?: boolean;
  imageAssets?: Md2XlsxImageAsset[];
}

export interface SheetModel {
  name: string;
}

export interface WorkbookModel {
  sheets: SheetModel[];
}

export function md2xlsx(markdown: string, options?: Md2XlsxOptions): Uint8Array;
export function markdownToXlsxModel(markdown: string, options?: Md2XlsxOptions): WorkbookModel;
export function workbookModelToXlsx(workbook: WorkbookModel): Uint8Array;
