// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractPptxMarkdown } from "../pptxToMarkdown";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

async function buildPptx(): Promise<Uint8Array> {
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
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:sld>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("extractPptxMarkdown", () => {
  it("returns markdown and the loaded zip without writing files", async () => {
    const data = await buildPptx();
    const result = await extractPptxMarkdown(data, "pptx", labels);
    expect(result.markdown).toContain("## Hello");
    expect(result.zip.file("ppt/slides/slide1.xml")).not.toBeNull();
    expect(result.images).toEqual([]);
  });

  it("throws on a pptx missing presentation.xml", async () => {
    const empty = await new JSZip().generateAsync({ type: "uint8array" });
    await expect(extractPptxMarkdown(empty, "pptx", labels)).rejects.toThrow();
  });
});
