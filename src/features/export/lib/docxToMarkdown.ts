import { writeTextFile, writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { convertDocx } from "./core/docx";
import type { ConvertedAsset } from "./core/types";

export interface ConvertResult {
  mdPath: string;
}

/**
 * Output location of a converted document. Preserves the input path
 * separator so the result matches the OS-native paths delivered by the file
 * tree — otherwise a mixed separator path creates duplicate tabs when the
 * same file is reopened.
 */
export function outputLocation(
  inputPath: string,
  extension: RegExp,
  saveToMdium: boolean,
): { sep: string; outputDir: string; baseName: string; mdPath: string } {
  const sep = inputPath.includes("\\") ? "\\" : "/";
  const dir = inputPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = inputPath.replace(/^.*[\\/]/, "").replace(extension, "");
  const outputDir = saveToMdium ? `${dir}${sep}.mdium` : dir;
  return { sep, outputDir, baseName, mdPath: `${outputDir}${sep}${baseName}.md` };
}

/** Write a converted document's assets and Markdown under `outputDir`. */
export async function writeConverted(
  outputDir: string,
  sep: string,
  mdPath: string,
  markdown: string,
  assets: ConvertedAsset[],
  saveToMdium: boolean,
): Promise<void> {
  const created = new Set<string>();
  for (const asset of assets) {
    const target = `${outputDir}${sep}${asset.path.split("/").join(sep)}`;
    const targetDir = target.slice(0, target.lastIndexOf(sep));
    if (!created.has(targetDir)) {
      await mkdir(targetDir, { recursive: true });
      created.add(targetDir);
    }
    await writeFile(target, asset.data);
  }
  // Ensure output dir exists (needed when saving into .mdium/)
  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }
  await writeTextFile(mdPath, markdown);
}

/**
 * Convert a .docx file (as Uint8Array) to Markdown.
 * Images are extracted and saved to `{docxName}_images/` next to the docx.
 * Returns the path of the generated .md file.
 */
export async function docxToMarkdown(
  data: Uint8Array,
  docxPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  const { sep, outputDir, baseName, mdPath } = outputLocation(docxPath, /\.docx$/i, saveToMdium);
  const { markdown, assets } = await convertDocx(data, baseName);
  await writeConverted(outputDir, sep, mdPath, markdown, assets, saveToMdium);
  return { mdPath };
}
