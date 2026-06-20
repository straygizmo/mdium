import JSZip from "jszip";
import { resolveSlideOrder } from "./pptxToMarkdown";

export interface LayoutShape {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LayoutConnector {
  from: string | null;
  to: string | null;
}
export interface SlideLayout {
  shapes: LayoutShape[];
  connectors: LayoutConnector[];
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

// Slide size in EMU from presentation.xml; defaults to standard 16:9 if absent.
function slideSize(presentationXml: string): { cx: number; cy: number } {
  const sz = parseXml(presentationXml).getElementsByTagName("p:sldSz")[0];
  const cx = parseInt(sz?.getAttribute("cx") ?? "", 10) || 9144000;
  const cy = parseInt(sz?.getAttribute("cy") ?? "", 10) || 6858000;
  return { cx, cy };
}

// Concatenate a shape's txBody paragraph text (newline-joined).
function shapeText(sp: Element): string {
  const txBody = sp.getElementsByTagName("p:txBody")[0];
  if (!txBody) return "";
  const lines: string[] = [];
  for (const p of Array.from(txBody.getElementsByTagName("a:p"))) {
    let line = "";
    for (const t of Array.from(p.getElementsByTagName("a:t"))) line += t.textContent ?? "";
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

// Normalized bounding box (0-100) from a shape's a:xfrm, or zeros if absent.
function shapeBox(sp: Element, size: { cx: number; cy: number }): { x: number; y: number; w: number; h: number } {
  const xfrm = sp.getElementsByTagName("a:xfrm")[0];
  const off = xfrm?.getElementsByTagName("a:off")[0];
  const ext = xfrm?.getElementsByTagName("a:ext")[0];
  const ox = parseInt(off?.getAttribute("x") ?? "", 10) || 0;
  const oy = parseInt(off?.getAttribute("y") ?? "", 10) || 0;
  const ex = parseInt(ext?.getAttribute("cx") ?? "", 10) || 0;
  const ey = parseInt(ext?.getAttribute("cy") ?? "", 10) || 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    x: round((ox / size.cx) * 100),
    y: round((oy / size.cy) * 100),
    w: round((ex / size.cx) * 100),
    h: round((ey / size.cy) * 100),
  };
}

function shapeId(sp: Element): string {
  const cNvPr = sp.getElementsByTagName("p:cNvPr")[0];
  return cNvPr?.getAttribute("id") ?? "";
}

// Recursively collect p:sp shapes (descending into p:grpSp groups).
function collectShapes(parent: Element, size: { cx: number; cy: number }, out: LayoutShape[]): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.localName === "sp") {
      const text = shapeText(el);
      const box = shapeBox(el, size);
      out.push({ id: shapeId(el), text, ...box });
    } else if (el.localName === "grpSp") {
      collectShapes(el, size, out);
    }
  }
}

function collectConnectors(spTree: Element): LayoutConnector[] {
  const connectors: LayoutConnector[] = [];
  for (const cxn of Array.from(spTree.getElementsByTagName("p:cxnSp"))) {
    const st = cxn.getElementsByTagName("a:stCxn")[0];
    const end = cxn.getElementsByTagName("a:endCxn")[0];
    connectors.push({ from: st?.getAttribute("id") ?? null, to: end?.getAttribute("id") ?? null });
  }
  return connectors;
}

export async function extractPptxLayout(data: Uint8Array): Promise<SlideLayout[]> {
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

  const size = slideSize(presentationXml);
  const slideOrder = resolveSlideOrder(presentationXml, presRels);
  const layouts: SlideLayout[] = [];
  for (const slidePath of slideOrder) {
    const slideXml = await readText(slidePath);
    if (!slideXml) continue;
    const spTree = parseXml(slideXml).getElementsByTagName("p:spTree")[0];
    if (!spTree) {
      layouts.push({ shapes: [], connectors: [] });
      continue;
    }
    const shapes: LayoutShape[] = [];
    collectShapes(spTree, size, shapes);
    layouts.push({ shapes, connectors: collectConnectors(spTree) });
  }
  return layouts;
}
