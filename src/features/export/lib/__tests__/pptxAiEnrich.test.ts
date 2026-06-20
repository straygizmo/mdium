// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures the mock factory can reference these variables after hoisting.
const { callAI } = vi.hoisted(() => ({
  callAI: vi.fn(async (_s: unknown, _sys: string, user: string) => {
    // Distinguish slides by checking if the payload references the "Start" shape text.
    return (user ?? "").includes("Start") ? "INTERP-A" : "INTERP-B";
  }),
}));
vi.mock("@/shared/lib/callAI", () => ({ callAI }));
// Provide AI settings via the settings store.
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ aiSettings: { apiKey: "k", model: "m", baseUrl: "u", apiFormat: "openai" } }) },
}));

import JSZip from "jszip";
import { pptxToMarkdownPreviewEnriched } from "../pptxAiEnrich";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };
const enrich = { aiSection: "AI解釈", lang: "Japanese" };

// Two slides; slide 1 has shape "Start", slide 2 has shape "Other".
async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId r:id="rA"/><p:sldId r:id="rB"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`);
  const sld = (title: string) =>
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", sld("Start"));
  zip.file("ppt/slides/slide2.xml", sld("Other"));
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptxToMarkdownPreviewEnriched", () => {
  beforeEach(() => callAI.mockClear());

  it("appends an AI interpretation section per slide, preserving order/separators", async () => {
    const data = await buildPptx();
    const md = await pptxToMarkdownPreviewEnriched(data, labels, enrich);
    expect(md).toContain("## Start");
    expect(md).toContain("## Other");
    expect(md).toContain("### AI解釈");
    expect(md).toContain("INTERP-A");
    expect(md).toContain("INTERP-B");
    // Slide order preserved: Start (and its interp) before Other.
    expect(md.indexOf("## Start")).toBeLessThan(md.indexOf("## Other"));
    expect(md.indexOf("INTERP-A")).toBeLessThan(md.indexOf("## Other"));
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  it("keeps a slide's deterministic markdown when its AI call fails", async () => {
    callAI.mockImplementationOnce(async () => { throw new Error("rate limit"); });
    const data = await buildPptx();
    const md = await pptxToMarkdownPreviewEnriched(data, labels, enrich);
    // First slide failed -> no INTERP for it, but its title remains.
    expect(md).toContain("## Start");
    expect(md).toContain("## Other");
    // Exactly one AI section survived.
    expect(md.match(/### AI解釈/g)?.length).toBe(1);
  });
});
