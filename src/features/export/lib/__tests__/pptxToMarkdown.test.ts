// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeTextFile, writeFile, mkdir } = vi.hoisted(() => ({
  writeTextFile: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile, writeFile, mkdir }));

import JSZip from "jszip";
import { pptxToMarkdown } from "../pptxToMarkdown";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

// Build a minimal two-slide pptx where presentation order is slide2 then slide1.
async function buildPptx(): Promise<Uint8Array> {
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
       <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
       <Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
     </Relationships>`,
  );
  const sld = (t: string) =>
    `<?xml version="1.0"?>
     <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", sld("First"));
  zip.file("ppt/slides/slide2.xml", sld("Second"));
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptxToMarkdown orchestrator", () => {
  beforeEach(() => { writeTextFile.mockClear(); writeFile.mockClear(); mkdir.mockClear(); });

  it("writes a .md honoring presentation slide order", async () => {
    const data = await buildPptx();
    const res = await pptxToMarkdown(data, "/decks/talk.pptx", false, labels);
    expect(res.mdPath).toBe("/decks/talk.md");
    const md = (writeTextFile.mock.calls as unknown as [string, string][][])[0][1];
    expect(md.indexOf("## Second")).toBeLessThan(md.indexOf("## First"));
  });
});
