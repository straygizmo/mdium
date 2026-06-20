// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { md2xlsx, markdownToXlsxModel } from "@/vendor/md2xlsx";

describe("vendored md2xlsx", () => {
  it("produces a ZIP-signature .xlsx byte stream", () => {
    const bytes = md2xlsx("# Hello\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // XLSX is a ZIP container: first two bytes are "PK" (0x50 0x4B).
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("splits sheets by heading when sheetMode is 'heading'", () => {
    const md = "# First\n\ntext\n\n# Second\n\ntext\n";
    const single = markdownToXlsxModel(md, { sheetMode: "single" });
    const split = markdownToXlsxModel(md, { sheetMode: "heading" });
    expect(single.sheets.length).toBe(1);
    expect(split.sheets.length).toBeGreaterThan(1);
  });
});
