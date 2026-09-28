// File-level document -> Markdown conversion for Node (agent runner and the
// mdium-docs MCP server), built on the shared core used by the frontend.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { convertDocument, documentKind, type ConvertedDocument } from "../../src/features/export/lib/core";
import { nodeConvertEnv } from "./node-env";

/** Largest input accepted (the converters hold the whole file in memory). */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

export { documentKind };

/** Read and convert `inputPath` without writing anything. */
export async function convertFile(inputPath: string): Promise<ConvertedDocument> {
  if (!documentKind(inputPath)) {
    throw new Error(`Unsupported document type: ${path.basename(inputPath)}`);
  }
  const stat = await fs.stat(inputPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${inputPath}`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`File too large: ${stat.size} bytes`);
  const data = new Uint8Array(await fs.readFile(inputPath));
  return convertDocument(data, path.basename(inputPath), nodeConvertEnv());
}

/** True when `child` lies strictly below `root` (both absolute and normalized). */
function isStrictlyInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Convert `inputPath` and write the Markdown to `outputPath`, with its assets
 * (images) next to it. Asset paths that would leave the output directory are
 * skipped. Returns the Markdown path and the number of assets written.
 */
export async function convertFileToMarkdown(
  inputPath: string,
  outputPath: string,
): Promise<{ markdownPath: string; assetCount: number }> {
  const { markdown, assets } = await convertFile(inputPath);
  const outputDir = path.dirname(path.resolve(outputPath));
  await fs.mkdir(outputDir, { recursive: true });
  let assetCount = 0;
  for (const asset of assets) {
    const target = path.resolve(outputDir, ...asset.path.split("/"));
    if (!isStrictlyInside(target, outputDir)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, asset.data);
    assetCount++;
  }
  const markdownPath = path.resolve(outputPath);
  await fs.writeFile(markdownPath, markdown, "utf8");
  return { markdownPath, assetCount };
}
