// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { md2xlsx } from "@/vendor/md2xlsx";
import { workbookToPreviewHtml } from "../XlsxPreviewPanel";

describe("workbookToPreviewHtml", () => {
  it("renders sheet content as HTML tables", () => {
    const bytes = md2xlsx("# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");
    const html = workbookToPreviewHtml(bytes);
    expect(html).toContain("<table");
    expect(html).toContain("Title");
  });
});
