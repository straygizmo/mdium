import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() }));

import { outputLocation } from "../docxToMarkdown";

describe("outputLocation", () => {
  it("keeps Windows separators and supports saving into .mdium", () => {
    expect(outputLocation("C:\\docs\\Report.docx", /\.docx$/i, true)).toEqual({
      sep: "\\",
      outputDir: "C:\\docs\\.mdium",
      baseName: "Report",
      mdPath: "C:\\docs\\.mdium\\Report.md",
    });
  });

  it("writes next to a posix input", () => {
    expect(outputLocation("/decks/talk.pptx", /\.pptx$/i, false)).toEqual({
      sep: "/",
      outputDir: "/decks",
      baseName: "talk",
      mdPath: "/decks/talk.md",
    });
  });
});
