// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { parseSlide, renderSlides } from "../pptxParser";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

// Minimal slide XML helper: a title placeholder + body paragraphs.
function slideXml(body: string): string {
  return `<?xml version="1.0"?>
  <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
    <p:cSld><p:spTree>${body}</p:spTree></p:cSld>
  </p:sld>`;
}
const titleSp = (t: string) =>
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
   <p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
const bodySp = (paras: string) =>
  `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody>${paras}</p:txBody></p:sp>`;
const para = (text: string, lvl?: number) =>
  `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:t>${text}</a:t></a:r></a:p>`;

describe("pptxParser: tables", () => {
  const tableFrame = `
    <p:graphicFrame><a:graphic><a:graphicData>
      <a:tbl>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>a|b</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>d</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      </a:tbl>
    </a:graphicData></a:graphic></p:graphicFrame>`;

  function frameSlide(frame: string) {
    return `<?xml version="1.0"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>${frame}</p:spTree></p:cSld></p:sld>`;
  }

  it("converts a:tbl to a Markdown table with header row and escaped pipes", () => {
    const slide = parseSlide({ slideXml: frameSlide(tableFrame), relsXml: null, notesXml: null });
    const { markdown } = renderSlides([slide], "deck", { slideFallback: (n) => `S${n}`, notes: "N:" });
    expect(markdown).toContain("| H1 | H2 |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| a\\|b | d |");
  });
});

describe("pptxParser: images", () => {
  const picSlide = `<?xml version="1.0"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:cSld><p:spTree>
        <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
        <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
      </p:spTree></p:cSld></p:sld>`;
  const rels = `<?xml version="1.0"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
    </Relationships>`;

  it("resolves r:embed to media path, dedupes by media, and emits one image file", () => {
    const slide = parseSlide({ slideXml: picSlide, relsXml: rels, notesXml: null });
    const { markdown, images } = renderSlides([slide], "deck", { slideFallback: (n) => `S${n}`, notes: "N:" });
    expect(markdown).toContain("![](deck_images/image1.png)");
    expect(images).toEqual([{ mediaPath: "ppt/media/image1.png", fileName: "image1.png" }]);
  });
});

describe("pptxParser: title + bullets", () => {
  it("uses title placeholder as heading and paragraphs as nested bullets", () => {
    const slide = parseSlide({
      slideXml: slideXml(titleSp("My Title") + bodySp(para("First") + para("Child", 1))),
      relsXml: null,
      notesXml: null,
    });
    const { markdown } = renderSlides([slide], "deck", labels);
    expect(markdown).toContain("## My Title");
    expect(markdown).toContain("- First");
    expect(markdown).toContain("  - Child");
  });

  it("falls back to slideFallback label when no title placeholder", () => {
    const slide = parseSlide({
      slideXml: slideXml(bodySp(para("Only body"))),
      relsXml: null,
      notesXml: null,
    });
    const { markdown } = renderSlides([slide], "deck", labels);
    expect(markdown).toContain("## スライド 1");
  });

  it("separates multiple slides with a horizontal rule", () => {
    const s = parseSlide({ slideXml: slideXml(bodySp(para("x"))), relsXml: null, notesXml: null });
    const { markdown } = renderSlides([s, s], "deck", labels);
    expect(markdown).toContain("\n---\n");
  });
});
