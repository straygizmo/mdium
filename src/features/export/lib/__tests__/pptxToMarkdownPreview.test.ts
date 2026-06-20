// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { pptxToMarkdownPreview } from "../pptxToMarkdownPreview";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

// One slide with a title, a picture (rId2 -> media/image1.png), and notes.
async function buildPptxWithImage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldIdLst><p:sldId r:id="rA"/></p:sldIdLst>
     </p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?>
     <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Deck</a:t></a:r></a:p></p:txBody></p:sp>
         <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
       </p:spTree></p:cSld></p:sld>`,
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
       <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0"?>
     <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Talk slowly</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:notes>`,
  );
  // 1x1 PNG bytes
  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return zip.generateAsync({ type: "uint8array" });
}

// Two slides that both embed the same media/image1.png, so renderSlides emits
// the `pptx_images/image1.png` ref twice — exercises all-occurrence replacement.
async function buildPptxWithSharedImage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldIdLst><p:sldId r:id="rA"/><p:sldId r:id="rB"/></p:sldIdLst>
     </p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
       <Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
     </Relationships>`,
  );
  const slideXml = (title: string) =>
    `<?xml version="1.0"?>
     <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
         <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
       </p:spTree></p:cSld></p:sld>`;
  const slideRels = `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
     </Relationships>`;
  zip.file("ppt/slides/slide1.xml", slideXml("One"));
  zip.file("ppt/slides/slide2.xml", slideXml("Two"));
  zip.file("ppt/slides/_rels/slide1.xml.rels", slideRels);
  zip.file("ppt/slides/_rels/slide2.xml.rels", slideRels);
  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptxToMarkdownPreview", () => {
  it("inlines images as data URLs and leaves no relative image refs", async () => {
    const data = await buildPptxWithImage();
    const md = await pptxToMarkdownPreview(data, labels);
    expect(md).toContain("## Deck");
    expect(md).toContain("data:image/png;base64,");
    expect(md).not.toContain("pptx_images/");
    expect(md).toContain("> **ノート:** Talk slowly");
  });

  it("replaces every occurrence when one image is shared across slides", async () => {
    const data = await buildPptxWithSharedImage();
    const md = await pptxToMarkdownPreview(data, labels);
    expect(md).not.toContain("pptx_images/");
    // Both slides reference the same media, so the data URL appears twice.
    const occurrences = md.split("data:image/png;base64,").length - 1;
    expect(occurrences).toBe(2);
  });

  it("rejects an invalid pptx missing presentation.xml", async () => {
    const empty = await new JSZip().generateAsync({ type: "uint8array" });
    await expect(pptxToMarkdownPreview(empty, labels)).rejects.toThrow();
  });
});
