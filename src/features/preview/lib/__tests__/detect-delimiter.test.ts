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

  it("does not misclassify a list of URLs as colon-delimited (single colon per line)", () => {
    // Each line has exactly one colon (`http:`). With only one colon per
    // line the fallback must NOT fire — the file should be treated as
    // single-column comma CSV.
    const urls = "http://example.com\nhttp://other.com\nhttp://third.com";
    expect(detectDelimiter(urls)).toBe(",");
  });

  it("counts colons correctly through RFC 4180 escaped quotes in colon-fallback", () => {
    // `""` inside a quoted region must NOT toggle the in-quote state. Both
    // lines have 2 colons outside quotes, so the fallback returns ":".
    const text = '"a""b":c:d\n"e""f":g:h';
    expect(detectDelimiter(text)).toBe(":");
  });

  it("returns ',' when colons appear alongside a real comma delimiter", () => {
    // `a:1,b` and `c:2,d`: PapaParse splits on comma → 2-column rows, the
    // multi-column gate rejects the colon heuristic.
    const text = "a:1,b\nc:2,d";
    expect(detectDelimiter(text)).toBe(",");
  });
});
