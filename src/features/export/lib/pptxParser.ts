// Pure PPTX → Markdown logic. No filesystem or JSZip access; operates on
// already-extracted XML strings so it can be unit-tested under happy-dom.

export type PptxBlock =
  | { kind: "bullets"; items: { text: string; level: number }[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "image"; mediaPath: string };

export interface PptxSlide {
  title: string | null;
  blocks: PptxBlock[];
  notes: string | null;
}

export interface SlideSource {
  slideXml: string;
  relsXml: string | null;
  notesXml: string | null;
}

export interface PptxLabels {
  slideFallback: (n: number) => string;
  notes: string;
}

export interface RenderedImage {
  mediaPath: string;
  fileName: string;
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

// Concatenate all <a:t> text inside a paragraph, treating <a:br> as a space.
// Uses getElementsByTagName with prefixed names because happy-dom's
// getElementsByTagNameNS compares tagName (e.g. "a:r") against the local name
// argument (e.g. "r"), so namespace-aware lookups silently return 0 results.
function paragraphText(p: Element): string {
  let out = "";
  for (const node of Array.from(p.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.localName === "r") {
      const t = el.getElementsByTagName("a:t")[0];
      if (t) out += t.textContent ?? "";
    } else if (el.localName === "br") {
      out += " ";
    }
  }
  return out.trim();
}

function paragraphLevel(p: Element): number {
  const pPr = p.getElementsByTagName("a:pPr")[0];
  const lvl = pPr?.getAttribute("lvl");
  return lvl ? parseInt(lvl, 10) || 0 : 0;
}

// True when this shape carries a title/ctrTitle placeholder.
function isTitleShape(sp: Element): boolean {
  const ph = sp.getElementsByTagName("p:ph")[0];
  const type = ph?.getAttribute("type");
  return type === "title" || type === "ctrTitle";
}

function shapeBullets(sp: Element): PptxBlock | null {
  const items: { text: string; level: number }[] = [];
  for (const p of Array.from(sp.getElementsByTagName("a:p"))) {
    const text = paragraphText(p);
    if (text) items.push({ text, level: paragraphLevel(p) });
  }
  return items.length ? { kind: "bullets", items } : null;
}

// Extract an <a:tbl> into a rows-of-cells matrix.
function parseTable(tbl: Element): PptxBlock {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagName("a:tr"))) {
    const cells: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagName("a:tc"))) {
      const texts = Array.from(tc.getElementsByTagName("a:p"))
        .map((p) => paragraphText(p))
        .filter(Boolean);
      cells.push(texts.join(" "));
    }
    rows.push(cells);
  }
  return { kind: "table", rows };
}

export function parseSlide(src: SlideSource): PptxSlide {
  const doc = parseXml(src.slideXml);
  const spTree = doc.getElementsByTagName("p:spTree")[0];
  let title: string | null = null;
  const blocks: PptxBlock[] = [];

  if (spTree) {
    for (const node of Array.from(spTree.childNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;

      if (el.localName === "sp") {
        if (title === null && isTitleShape(el)) {
          const p = el.getElementsByTagName("a:p")[0];
          title = p ? paragraphText(p) : "";
          continue;
        }
        const bullets = shapeBullets(el);
        if (bullets) blocks.push(bullets);
      } else if (el.localName === "graphicFrame") {
        const tbl = el.getElementsByTagName("a:tbl")[0];
        if (tbl) blocks.push(parseTable(tbl));
      }
    }
  }

  return { title: title || null, blocks, notes: null };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderSlides(
  slides: PptxSlide[],
  baseName: string,
  labels: PptxLabels,
): { markdown: string; images: RenderedImage[] } {
  const images: RenderedImage[] = [];
  const mediaToName = new Map<string, string>();
  const parts: string[] = [];

  slides.forEach((slide, idx) => {
    const lines: string[] = [];
    lines.push(`## ${slide.title ?? labels.slideFallback(idx + 1)}`);

    for (const block of slide.blocks) {
      if (block.kind === "bullets") {
        lines.push("");
        for (const item of block.items) {
          lines.push(`${"  ".repeat(item.level)}- ${item.text}`);
        }
      } else if (block.kind === "table") {
        lines.push("");
        lines.push(...renderTable(block.rows));
      } else if (block.kind === "image") {
        let name = mediaToName.get(block.mediaPath);
        if (!name) {
          const ext = block.mediaPath.split(".").pop() || "png";
          name = `image${mediaToName.size + 1}.${ext}`;
          mediaToName.set(block.mediaPath, name);
          images.push({ mediaPath: block.mediaPath, fileName: name });
        }
        lines.push("");
        lines.push(`![](${baseName}_images/${name})`);
      }
    }

    if (slide.notes) {
      lines.push("");
      lines.push(`> **${labels.notes}** ${slide.notes.replace(/\n/g, " ")}`);
    }

    parts.push(lines.join("\n"));
  });

  const markdown = parts.join("\n\n---\n\n") + "\n";
  return { markdown, images };
}

function renderTable(rows: string[][]): string[] {
  if (!rows.length) return [];
  const out: string[] = [];
  const header = rows[0];
  out.push(`| ${header.map(escapeCell).join(" | ")} |`);
  out.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(1)) {
    out.push(`| ${row.map(escapeCell).join(" | ")} |`);
  }
  return out;
}
