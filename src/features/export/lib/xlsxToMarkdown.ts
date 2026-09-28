import { convertXlsx } from "./core/xlsx";
import { outputLocation, writeConverted, type ConvertResult } from "./docxToMarkdown";

/**
 * Convert an .xlsx / .xlsm file (as Uint8Array) to Markdown.
 * Images and shapes are extracted and saved to `{baseName}_assets/images/` next
 * to the original spreadsheet.  Returns the path of the generated .md file.
 */
export async function xlsxToMarkdown(
  data: Uint8Array,
  xlsxPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  const { sep, outputDir, baseName, mdPath } = outputLocation(xlsxPath, /\.(?:xlsx|xlsm|xls)$/i, saveToMdium);
  const { markdown, assets } = await convertXlsx(data, baseName);
  await writeConverted(outputDir, sep, mdPath, markdown, assets, saveToMdium);
  return { mdPath };
}
