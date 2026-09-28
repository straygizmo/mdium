import { describe, expect, it } from "vitest";
import { CONVERTIBLE_EXTENSIONS, convertDocument, documentBaseName, documentKind } from "..";
import { prepareTablesForMarkdown } from "../docx";
import { pdfTextItemsToMarkdown, PdfNoTextError } from "../pdf";

describe("documentKind / documentBaseName", () => {
  it("maps extensions case-insensitively", () => {
    expect(documentKind("C:\\docs\\Report.DOCX")).toBe("docx");
    expect(documentKind("/a/b/book.xlsm")).toBe("xlsx");
    expect(documentKind("deck.pptx")).toBe("pptx");
    expect(documentKind("paper.pdf")).toBe("pdf");
    expect(documentKind("notes.txt")).toBeUndefined();
    expect(documentKind("no-extension")).toBeUndefined();
    expect(CONVERTIBLE_EXTENSIONS).toEqual(["docx", "xlsx", "xlsm", "pptx", "pdf"]);
  });

  it("strips directories and the extension", () => {
    expect(documentBaseName("C:\\docs\\q3.report.docx")).toBe("q3.report");
    expect(documentBaseName("/a/deck.pptx")).toBe("deck");
  });

  it("rejects unsupported files", async () => {
    const env = { loadPdfjs: async () => { throw new Error("unused"); }, pptxLabels: { slideFallback: String, notes: "" } };
    await expect(convertDocument(new Uint8Array(), "a.txt", env)).rejects.toThrow(/Unsupported/);
  });
});

describe("prepareTablesForMarkdown", () => {
  it("promotes the first row and flattens cell paragraphs", () => {
    const html = "<table><tr><td><p>A</p></td><td><p>B</p><p>C</p></td></tr><tr><td><p>1</p></td><td>2</td></tr></table>";
    expect(prepareTablesForMarkdown(html)).toBe(
      "<table><tr><th>A</th><th>B C</th></tr><tr><td>1</td><td>2</td></tr></table>",
    );
  });

  it("keeps tables that already have a header row", () => {
    const html = "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>";
    expect(prepareTablesForMarkdown(html)).toBe(html);
  });

  it("leaves non-table HTML alone", () => {
    const html = "<h1>T</h1><p>body</p>";
    expect(prepareTablesForMarkdown(html)).toBe(html);
  });
});

describe("pdfTextItemsToMarkdown", () => {
  it("keeps pages in order even when their Y coordinates overlap", () => {
    const md = pdfTextItemsToMarkdown([
      { page: 1, str: "Heading", x: 0, y: 700, fontSize: 24 },
      { page: 1, str: "first page", x: 0, y: 650, fontSize: 12 },
      { page: 2, str: "second page top", x: 0, y: 700, fontSize: 12 },
      { page: 2, str: "second page bottom", x: 0, y: 100, fontSize: 12 },
      { page: 1, str: "first page bottom", x: 0, y: 100, fontSize: 12 },
    ]);
    expect(md).toBe("# Heading\n\nfirst page\n\nfirst page bottom\n\nsecond page top\n\nsecond page bottom\n");
  });

  it("joins runs of one line left to right", () => {
    const md = pdfTextItemsToMarkdown([
      { page: 1, str: "world", x: 50, y: 500, fontSize: 12 },
      { page: 1, str: "hello", x: 0, y: 501, fontSize: 12 },
    ]);
    expect(md).toBe("hello world\n");
  });

  it("throws when there is no text", () => {
    expect(() => pdfTextItemsToMarkdown([])).toThrow(PdfNoTextError);
  });
});
