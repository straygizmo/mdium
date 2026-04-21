// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseCsv } from "../csv-parse";

describe("parseCsv", () => {
  it("parses a simple CSV", () => {
    const { rows } = parseCsv("a,b,c\n1,2,3", ",");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("parses a TSV", () => {
    const { rows } = parseCsv("a\tb\n1\t2", "\t");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("respects RFC 4180 quoted commas", () => {
    const { rows } = parseCsv('"a,b","c"\n1,2', ",");
    expect(rows).toEqual([["a,b", "c"], ["1", "2"]]);
  });

  it("respects RFC 4180 embedded newlines", () => {
    const { rows } = parseCsv('"a\nb",c', ",");
    expect(rows).toEqual([["a\nb", "c"]]);
  });

  it("respects RFC 4180 escaped quotes", () => {
    const { rows } = parseCsv('"he said ""hi""",ok', ",");
    expect(rows).toEqual([['he said "hi"', "ok"]]);
  });

  it("returns empty rows for empty input", () => {
    expect(parseCsv("", ",").rows).toEqual([]);
  });

  it("handles ragged rows", () => {
    const { rows } = parseCsv("a,b,c\n1,2\n3,4,5,6", ",");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2"], ["3", "4", "5", "6"]]);
  });

  it("preserves trailing empty cells", () => {
    const { rows } = parseCsv("a,b,\n1,,3", ",");
    expect(rows).toEqual([["a", "b", ""], ["1", "", "3"]]);
  });
});
