// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri fs plugin before importing the module under test.
const readFileMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

import JSZip from "jszip";
import {
  collectRelativeImagePaths,
  resolveImagePath,
  injectMermaidDiagrams,
  promoteStandaloneImages,
  renderWorkbookModelToHtml,
  escapeHtml,
  imageSize,
  markdownToXlsx,
  markdownToXlsxArtifacts,
} from "../markdownToXlsx";

// 1x1 red PNG, used as a stand-in rasterized asset.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("collectRelativeImagePaths", () => {
  it("returns only relative image paths, excluding remote and data URIs", () => {
    const md = [
      "![a](images/a.png)",
      "![b](https://example.com/b.png)",
      "![c](http://example.com/c.png)",
      "![d](data:image/png;base64,XXXX)",
      "![e](./sub/e.jpg)",
    ].join("\n\n");
    expect(collectRelativeImagePaths(md)).toEqual(["images/a.png", "./sub/e.jpg"]);
  });

  it("deduplicates repeated paths", () => {
    const md = "![a](x.png)\n\n![a again](x.png)";
    expect(collectRelativeImagePaths(md)).toEqual(["x.png"]);
  });
});

describe("markdownToXlsx", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("returns ZIP-signature bytes for a simple document", async () => {
    const bytes = await markdownToXlsx("# Title\n\ntext\n");
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("resolves relative images against the file's directory", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await markdownToXlsx("![a](img/a.png)", { filePath: "/docs/note.md" });
    expect(readFileMock).toHaveBeenCalledWith("/docs/img/a.png");
  });

  it("skips images that cannot be read without throwing", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const bytes = await markdownToXlsx("![a](missing.png)", { filePath: "/docs/note.md" });
    expect(bytes[0]).toBe(0x50);
  });

  it("does not read files when there is no filePath", async () => {
    await markdownToXlsx("![a](img/a.png)");
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("resolves images against current dir when filePath has no directory", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await markdownToXlsx("![a](img/a.png)", { filePath: "note.md" });
    expect(readFileMock).toHaveBeenCalledWith("img/a.png");
  });

  it("embeds rasterized mermaid diagrams into the workbook", async () => {
    const md = "# T\n\n```mermaid\ngraph TD; A-->B;\n```\n";
    const bytes = await markdownToXlsx(md, { mermaidPngs: [PNG] });
    const zip = await JSZip.loadAsync(bytes);
    const media = Object.keys(zip.files).filter((n) => n.includes("media"));
    expect(media.length).toBe(1);
  });
});

describe("resolveImagePath", () => {
  it("joins a relative path against a forward-slash directory", () => {
    expect(resolveImagePath("/docs", "img/a.png")).toBe("/docs/img/a.png");
  });

  it("normalizes Windows backslash directories to forward slashes", () => {
    expect(resolveImagePath("C:\\Users\\me", "img/a.png")).toBe("C:/Users/me/img/a.png");
  });

  it("collapses .. and . segments", () => {
    expect(resolveImagePath("/docs/sub", "../img/./a.png")).toBe("/docs/img/a.png");
  });

  it("decodes percent-encoded paths", () => {
    expect(resolveImagePath("/docs", "img%20space.png")).toBe("/docs/img space.png");
  });
});

describe("injectMermaidDiagrams", () => {
  it("replaces a mermaid block with an image ref and builds a matching asset", () => {
    const md = "# T\n\n```mermaid\ngraph TD; A-->B;\n```\n";
    const { markdown, assets } = injectMermaidDiagrams(md, [PNG]);
    expect(markdown).toContain("![](__mermaid_0__.png)");
    expect(markdown).not.toContain("```mermaid");
    expect(assets).toHaveLength(1);
    expect(assets[0].path).toBe("__mermaid_0__.png");
    expect(assets[0].data).toBe(PNG);
  });

  it("maps multiple blocks to PNGs in document order", () => {
    const md = "```mermaid\nA\n```\n\ntext\n\n```mermaid\nB\n```\n";
    const { markdown, assets } = injectMermaidDiagrams(md, [PNG, PNG]);
    expect(markdown).toContain("![](__mermaid_0__.png)");
    expect(markdown).toContain("![](__mermaid_1__.png)");
    expect(assets.map((a) => a.path)).toEqual([
      "__mermaid_0__.png",
      "__mermaid_1__.png",
    ]);
  });

  it("drops a block that has no corresponding PNG", () => {
    const md = "```mermaid\nA\n```\n";
    const { markdown, assets } = injectMermaidDiagrams(md, []);
    expect(markdown).not.toContain("```mermaid");
    expect(markdown).not.toContain("![]");
    expect(assets).toHaveLength(0);
  });
});

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });
});

describe("renderWorkbookModelToHtml", () => {
  it("renders a table with the sheet name and cell values", () => {
    const html = renderWorkbookModelToHtml({
      sheets: [
        {
          name: "Sheet1",
          rows: [
            { kind: "table", cells: [{ value: "A", styleRole: "tableHeader" }] },
            { kind: "table", cells: [{ value: "1" }] },
          ],
        },
      ],
    });
    expect(html).toContain("<h4>Sheet1</h4>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders image rows inline as data URLs from the matching asset", () => {
    const html = renderWorkbookModelToHtml({
      sheets: [
        {
          name: "S",
          rows: [
            { kind: "image", cells: [{ value: "![a](pic.png)" }], imageRefs: [{ alt: "a", path: "pic.png" }] },
          ],
        },
      ],
      imageAssets: [{ path: "pic.png", data: PNG, contentType: "image/png" }],
    });
    expect(html).toContain('<img src="data:image/png;base64,');
  });

  it("escapes the sheet name", () => {
    const html = renderWorkbookModelToHtml({
      sheets: [{ name: "<x>", rows: [] }],
    });
    expect(html).toContain("<h4>&lt;x&gt;</h4>");
  });
});

describe("promoteStandaloneImages", () => {
  it("separates an image that lazily continues a list item", () => {
    const md = "1. choose the agent\n![alt](images/a.png)\n";
    const out = promoteStandaloneImages(md);
    expect(out).toBe("1. choose the agent\n\n![alt](images/a.png)\n\n");
  });

  it("leaves inline images within text untouched", () => {
    const md = "see ![a](x.png) here";
    expect(promoteStandaloneImages(md)).toBe("see ![a](x.png) here");
  });
});

describe("markdownToXlsxArtifacts", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("returns xlsx bytes and an image-aware preview for a mermaid diagram", async () => {
    const md = "# T\n\n```mermaid\ngraph TD; A-->B;\n```\n";
    const { bytes, previewHtml } = await markdownToXlsxArtifacts(md, { mermaidPngs: [PNG] });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(previewHtml).toContain('<img src="data:image/png;base64,');
  });

  it("embeds an image that lazily follows a list item (no blank line)", async () => {
    readFileMock.mockResolvedValue(PNG);
    const md = "1. choose the agent\n![alt](images/a.png)\n";
    const { bytes, previewHtml } = await markdownToXlsxArtifacts(md, {
      filePath: "/docs/note.md",
    });
    // Image renders inline in the preview...
    expect(previewHtml).toContain('<img src="data:image/png;base64,');
    // ...and is embedded as media in the workbook.
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((n) => n.includes("media"))).toBe(true);
  });

  it("anchors images in column A at native size and drops the markdown text", async () => {
    readFileMock.mockResolvedValue(PNG); // 1x1 px → 9525 EMU
    const md = "# T\n\n![a](pic.png)\n";
    const { bytes } = await markdownToXlsxArtifacts(md, { filePath: "/docs/note.md" });
    const zip = await JSZip.loadAsync(bytes);
    const drawing = await zip.file("xl/drawings/drawing1.xml")!.async("string");
    expect(drawing).toContain("<xdr:oneCellAnchor>");
    expect(drawing).toContain("<xdr:col>0</xdr:col>");
    expect(drawing).toContain('cx="9525"');
    expect(drawing).toContain('cy="9525"');
    expect(drawing).not.toContain("twoCellAnchor");
    // The raw markdown text must not appear anywhere in the workbook.
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".xml")) {
        expect(await zip.file(name)!.async("string")).not.toContain("pic.png");
      }
    }
  });

  it("sizes the image row to the image height and collapses reserved rows", async () => {
    readFileMock.mockResolvedValue(PNG); // 1x1 px → 0.75 pt
    const md = "# T\n\n![a](pic.png)\n\nafter\n";
    const { bytes } = await markdownToXlsxArtifacts(md, { filePath: "/docs/note.md" });
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    // Image lands on row 2 (after the title); its height matches the image.
    expect(sheet).toContain('<row r="2" ht="0.75" customHeight="1">');
    // The first reserved blank row below it is collapsed.
    expect(sheet).toContain('<row r="3" ht="0" customHeight="1">');
  });
});

describe("imageSize", () => {
  it("reads PNG dimensions", () => {
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1 });
  });

  it("returns undefined for non-image bytes", () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});
