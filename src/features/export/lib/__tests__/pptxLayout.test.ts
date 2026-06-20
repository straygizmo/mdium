// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractPptxLayout } from "../pptxLayout";

// Slide size 9144000 x 6858000 EMU. Two shapes + one connector A->B.
async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldSz cx="9144000" cy="6858000"/>
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
         <p:sp>
           <p:nvSpPr><p:cNvPr id="2" name="A"/></p:nvSpPr>
           <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="3429000"/></a:xfrm></p:spPr>
           <p:txBody><a:p><a:r><a:t>Start</a:t></a:r></a:p></p:txBody>
         </p:sp>
         <p:sp>
           <p:nvSpPr><p:cNvPr id="3" name="B"/></p:nvSpPr>
           <p:spPr><a:xfrm><a:off x="4572000" y="3429000"/><a:ext cx="4572000" cy="3429000"/></a:xfrm></p:spPr>
           <p:txBody><a:p><a:r><a:t>End</a:t></a:r></a:p></p:txBody>
         </p:sp>
         <p:cxnSp>
           <p:nvCxnSpPr><p:cNvPr id="4" name="c"/><p:cNvCxnSpPr>
             <a:stCxn id="2" idx="0"/><a:endCxn id="3" idx="0"/>
           </p:cNvCxnSpPr></p:nvCxnSpPr>
           <p:spPr/>
         </p:cxnSp>
       </p:spTree></p:cSld></p:sld>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("extractPptxLayout", () => {
  it("extracts shapes with normalized positions and resolves connectors", async () => {
    const data = await buildPptx();
    const layouts = await extractPptxLayout(data);
    expect(layouts).toHaveLength(1);
    const { shapes, connectors } = layouts[0];
    expect(shapes.map((s) => s.text)).toEqual(["Start", "End"]);
    // Shape A at origin, half width/height -> 0,0,50,50
    expect(shapes[0]).toMatchObject({ id: "2", text: "Start", x: 0, y: 0, w: 50, h: 50 });
    // Shape B offset by half -> 50,50,50,50
    expect(shapes[1]).toMatchObject({ id: "3", x: 50, y: 50, w: 50, h: 50 });
    expect(connectors).toEqual([{ from: "2", to: "3" }]);
  });
});
