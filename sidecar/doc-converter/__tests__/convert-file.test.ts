// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertFile, convertFileToMarkdown } from "../convert-file";
import { buildDocx, buildPdf, buildPptx, buildXlsx } from "./fixtures";

let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdium-docconv-"));
  fs.writeFileSync(path.join(dir, "report.docx"), await buildDocx());
  fs.writeFileSync(path.join(dir, "stock.xlsx"), buildXlsx());
  fs.writeFileSync(path.join(dir, "deck.pptx"), await buildPptx());
  fs.writeFileSync(
    path.join(dir, "paper.pdf"),
    buildPdf([
      [
        { text: "Big Title", size: 24 },
        { text: "Body text on page one.", size: 12 },
        { text: "More body text.", size: 12 },
      ],
      [{ text: "Second page body.", size: 12 }],
    ]),
  );
  fs.writeFileSync(path.join(dir, "notes.txt"), "plain");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("convertFile (Node)", () => {
  it("converts a docx with headings, emphasis and tables", async () => {
    const { markdown } = await convertFile(path.join(dir, "report.docx"));
    expect(markdown).toContain("# Quarterly Report");
    expect(markdown).toContain("**strongly**");
    expect(markdown).toContain("| Region | Sales |");
    expect(markdown).toContain("| East | 120 |");
  });

  it("converts an xlsx sheet to a Markdown table", async () => {
    const { markdown } = await convertFile(path.join(dir, "stock.xlsx"));
    expect(markdown).toContain("Stock");
    expect(markdown).toContain("| Item | Qty |");
    expect(markdown).toContain("| Pear | 5 |");
  });

  it("converts a pptx with English fallback labels, notes and images", async () => {
    const { markdown, assets } = await convertFile(path.join(dir, "deck.pptx"));
    expect(markdown).toContain("## Roadmap");
    expect(markdown).toContain("- Ship the converter");
    expect(markdown).toContain("**Notes:** Mention the deadline");
    expect(markdown).toContain("![](deck_images/image1.png)");
    expect(assets.map((a) => a.path)).toEqual(["deck_images/image1.png"]);
  });

  it("converts a pdf keeping pages in order and inferring headings", async () => {
    const { markdown } = await convertFile(path.join(dir, "paper.pdf"));
    expect(markdown).toContain("# Big Title");
    const first = markdown.indexOf("Body text on page one.");
    const second = markdown.indexOf("Second page body.");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("rejects unsupported extensions", async () => {
    await expect(convertFile(path.join(dir, "notes.txt"))).rejects.toThrow(/Unsupported/);
  });
});

describe("convertFileToMarkdown", () => {
  it("writes the Markdown and its assets next to the output path", async () => {
    const out = path.join(dir, "out", "deck.md");
    const result = await convertFileToMarkdown(path.join(dir, "deck.pptx"), out);
    expect(result).toEqual({ markdownPath: out, assetCount: 1 });
    expect(fs.readFileSync(out, "utf8")).toContain("## Roadmap");
    expect(fs.existsSync(path.join(dir, "out", "deck_images", "image1.png"))).toBe(true);
  });
});
