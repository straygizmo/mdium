import { convertPptx } from "./core/pptx";
import { outputLocation, writeConverted } from "./docxToMarkdown";
import type { PptxLabels } from "./pptxParser";

export interface ConvertResult {
  mdPath: string;
}
export type { PptxLabels } from "./pptxParser";
// The pure pptx logic lives in ./core/pptx; re-exported for existing importers.
export { resolveSlideOrder, extractPptxMarkdown, type ExtractedPptx } from "./core/pptx";

export async function pptxToMarkdown(
  data: Uint8Array,
  pptxPath: string,
  saveToMdium: boolean,
  labels: PptxLabels,
): Promise<ConvertResult> {
  const { sep, outputDir, baseName, mdPath } = outputLocation(pptxPath, /\.pptx$/i, saveToMdium);
  const { markdown, assets } = await convertPptx(data, baseName, labels);
  await writeConverted(outputDir, sep, mdPath, markdown, assets, saveToMdium);
  return { mdPath };
}
