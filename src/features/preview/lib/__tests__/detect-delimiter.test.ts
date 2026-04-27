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

  it("falls back to ',' for colon-delimited input (PapaParse does not probe ':')", () => {
    // PapaParse's auto-detection probes ',', '\t', '|', and ';' but not ':'.
    // detectDelimiter cannot detect what PapaParse does not expose; colon
    // files fall back to comma and must be set manually by the user.
    expect(detectDelimiter("a:b:c\n1:2:3")).toBe(",");
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
