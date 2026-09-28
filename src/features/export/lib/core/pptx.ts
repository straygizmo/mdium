import JSZip from "jszip";
import { parseSlide, renderSlides, type PptxLabels, type PptxSlide, type SlideSource, type RenderedImage } from "../pptxParser";
import type { ConvertedDocument } from "./types";

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

// Ordered list of slide zip paths, following presentation.xml sldIdLst.
// Uses getAttribute("r:id") (qualified-name form) because happy-dom 20.8.9's
// getAttributeNS is broken and silently returns null.
export function resolveSlideOrder(presentationXml: string, presRels: string): string[] {
  const relMap = new Map<string, string>();
  for (const rel of Array.from(parseXml(presRels).getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) relMap.set(id, target.replace(/^\//, ""));
  }
  const order: string[] = [];
  const doc = parseXml(presentationXml);
  for (const sldId of Array.from(doc.getElementsByTagName("p:sldId"))) {
    const rId = sldId.getAttribute("r:id");
    const target = rId ? relMap.get(rId) : undefined;
    if (target) order.push(target.startsWith("ppt/") ? target : `ppt/${target}`);
  }
  return order;
}

// Find the notesSlide target inside a slide's rels, normalized to a zip path.
function findNotesTarget(slideRels: string | null): string | null {
  if (!slideRels) return null;
  for (const rel of Array.from(parseXml(slideRels).getElementsByTagName("Relationship"))) {
    if ((rel.getAttribute("Type") ?? "").endsWith("/notesSlide")) {
      const target = rel.getAttribute("Target") ?? "";
      const cleaned = target.replace(/^\.\//, "");
      if (cleaned.startsWith("../")) return `ppt/${cleaned.slice(3)}`;
      if (cleaned.startsWith("/")) return cleaned.slice(1);
      return `ppt/slides/${cleaned}`;
    }
  }
  return null;
}

export interface ExtractedPptx {
  zip: JSZip;
  markdown: string;
  images: RenderedImage[];
}

// Load a pptx and render it to Markdown + image list, without any I/O.
// Returns the loaded zip so callers can pull image bytes (write to disk vs. inline).
export async function extractPptxMarkdown(
  data: Uint8Array,
  baseName: string,
  labels: PptxLabels,
): Promise<ExtractedPptx> {
  const zip = await JSZip.loadAsync(data);
  const readText = async (p: string): Promise<string | null> => {
    const f = zip.file(p);
    return f ? f.async("text") : null;
  };

  const presentationXml = await readText("ppt/presentation.xml");
  const presRels = await readText("ppt/_rels/presentation.xml.rels");
  if (!presentationXml || !presRels) {
    throw new Error("Invalid PPTX: missing presentation.xml");
  }

  const slideOrder = resolveSlideOrder(presentationXml, presRels);
  const slides: PptxSlide[] = [];
  for (const slidePath of slideOrder) {
    const slideXml = await readText(slidePath);
    if (!slideXml) continue; // Skip slides whose XML is missing rather than crash
    const relsPath = slidePath.replace(/slides\/([^/]+)$/, "slides/_rels/$1.rels");
    const relsXml = await readText(relsPath);
    const notesPath = findNotesTarget(relsXml);
    const notesXml = notesPath ? await readText(notesPath) : null;
    const src: SlideSource = { slideXml, relsXml, notesXml };
    slides.push(parseSlide(src));
  }

  const { markdown, images } = renderSlides(slides, baseName, labels);
  return { zip, markdown, images };
}

/**
 * Convert a .pptx file to Markdown. Slide images are returned as assets
 * under `{baseName}_images/`; media missing from the zip is skipped.
 */
export async function convertPptx(data: Uint8Array, baseName: string, labels: PptxLabels): Promise<ConvertedDocument> {
  const { zip, markdown, images } = await extractPptxMarkdown(data, baseName, labels);
  const assets = [];
  for (const img of images) {
    const f = zip.file(img.mediaPath);
    if (!f) continue;
    assets.push({ path: `${baseName}_images/${img.fileName}`, data: await f.async("uint8array") });
  }
  return { markdown, assets };
}
