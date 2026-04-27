// @vitest-environment node
import { describe, it, expect } from "vitest";
import { detectDelimiter } from "../detect-delimiter";

describe("detectDelimiter", () => {
  it("returns ',' for empty input", () => {
    expect(detectDelimiter("")).toBe(",");
  });

  it("returns ',' for whitespace-only input", () => {
    expect(detectDelimiter("   \n  \n")).toBe(",");
  });

  it("detects comma", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("detects tab", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("detects semicolon", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("detects pipe", () => {
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("detects colon via the fallback heuristic", () => {
    // PapaParse's auto-detector does not probe ':'. The fallback kicks in
    // when comma-based parse yields single-column rows.
    expect(detectDelimiter("a:b:c\n1:2:3")).toBe(":");
  });

  it("does not misclassify comma CSV containing timestamp colons", () => {
    // Each line has 2 colons in the timestamp, but comma is the real
    // delimiter — must return ',' not ':'.
    const csv = "1,2026-04-28 10:30:00,event_a\n2,2026-04-28 11:45:00,event_b";
    expect(detectDelimiter(csv)).toBe(",");
  });

  it("detects tab even when extension would suggest csv", () => {
    // .csv content that is actually TSV — the case that motivated this
    // feature.
    const tsv = "id\tname\temail\n1\tfoo\tfoo@example.com";
    expect(detectDelimiter(tsv)).toBe("\t");
  });

  it("ignores delimiters inside quoted fields", () => {
    // The semicolon inside the quoted cell must not throw the detection.
    const text = '"a;b","c","d"\n"1;2","3","4"';
    expect(detectDelimiter(text)).toBe(",");
  });

  it("falls back to ',' on single-line input with no candidate delimiter", () => {
    expect(detectDelimiter("hello")).toBe(",");
  });

  it("falls back to ',' when PapaParse picks an unsupported delimiter", () => {
    // ASCII 30 (record separator) — PapaParse may detect it but we don't
    // ship a tokenizer for it, so we fall back.
    const rs = "abc\n123";
    expect(detectDelimiter(rs)).toBe(",");
  });

  it("only inspects the first lines (preview)", () => {
    // 10000 comma rows then a tab. The tail must not flip the result.
    const head = Array.from({ length: 10000 }, () => "a,b,c").join("\n");
    const tail = "\nx\ty\tz";
    expect(detectDelimiter(head + tail)).toBe(",");
  });
});
