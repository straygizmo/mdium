import { extractPptxMarkdown } from "./pptxToMarkdown";
import type { PptxLabels } from "./pptxParser";

// Fixed baseName for preview: image refs (`pptx_images/...`) are all replaced
// with data URLs below, so the value only needs to be stable, not meaningful.
const PREVIEW_BASE = "pptx";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  webp: "image/webp",
};

// Encode bytes to base64 in chunks (avoids call-stack limits on large images).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Render a pptx (binary) to a self-contained Markdown string for preview:
// images are inlined as data URLs, nothing is written to disk.
export async function pptxToMarkdownPreview(
  data: Uint8Array,
  labels: PptxLabels,
): Promise<string> {
  const { zip, markdown, images } = await extractPptxMarkdown(data, PREVIEW_BASE, labels);

  let out = markdown;
  for (const img of images) {
    const f = zip.file(img.mediaPath);
    if (!f) continue; // Media absent in the zip — leave ref out of replacement
    const bytes = await f.async("uint8array");
    const ext = img.fileName.split(".").pop()?.toLowerCase() ?? "png";
    const mime = IMAGE_MIME[ext] ?? "image/png";
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
    out = out.split(`${PREVIEW_BASE}_images/${img.fileName}`).join(dataUrl);
  }
  return out;
}
