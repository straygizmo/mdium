import { describe, it, expect } from "vitest";
import type { ReplacementRule } from "@/shared/types";
import { parseRulesCsv, mergeRules, exportRulesCsv } from "../rules-csv";

const HEADER = "置換前文字列,置換後文字列,有効";

describe("parseRulesCsv", () => {
  it("parses a simple 3-column CSV, skipping the header", () => {
    const csv = `${HEADER}\r\n株式会社A社,会社X,true\r\n田中太郎,担当P,false\r\n`;
    const result = parseRulesCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { from: "株式会社A社", to: "会社X", enabled: true },
      { from: "田中太郎", to: "担当P", enabled: false },
    ]);
  });

  it("accepts LF line endings and a leading BOM", () => {
    const csv = "\uFEFF" + `${HEADER}\na,b,1\nc,d,0\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toEqual([
      { from: "a", to: "b", enabled: true },
      { from: "c", to: "d", enabled: false },
    ]);
  });

  it("parses quoted fields containing commas, quotes, and newlines", () => {
    const csv = `${HEADER}\r\n"a,b","c""d",TRUE\r\n"line1\nline2",x,false\r\n`;
    const result = parseRulesCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toEqual({ from: "a,b", to: 'c"d', enabled: true });
    expect(result.rows[1]).toEqual({ from: "line1\nline2", to: "x", enabled: false });
  });

  it("reports rows with wrong column count (with 1-based line numbers)", () => {
    const csv = `${HEADER}\na,b,true\nonly-two,cols\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([{ line: 3, reason: "columnCount" }]);
  });

  it("reports rows with unparseable bool", () => {
    const csv = `${HEADER}\na,b,yes\nc,d,true\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toEqual([{ from: "c", to: "d", enabled: true }]);
    expect(result.errors).toEqual([{ line: 2, reason: "boolValue" }]);
  });

  it("skips blank lines without errors", () => {
    const csv = `${HEADER}\n\na,b,true\n\n`;
    const result = parseRulesCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });
});

describe("mergeRules", () => {
  const existing: ReplacementRule[] = [
    { id: "1", from: "a", to: "OLD", enabled: false },
    { id: "2", from: "keep", to: "K", enabled: true },
  ];

  it("overwrites by from-match and appends new rows", () => {
    const { rules, added, updated } = mergeRules(existing, [
      { from: "a", to: "NEW", enabled: true },
      { from: "b", to: "B", enabled: true },
    ]);
    expect(added).toBe(1);
    expect(updated).toBe(1);
    expect(rules).toHaveLength(3);
    const a = rules.find((r) => r.from === "a")!;
    expect(a).toMatchObject({ id: "1", to: "NEW", enabled: true });
    expect(rules.find((r) => r.from === "b")).toBeTruthy();
  });

  it("is idempotent: re-importing the same rows reports 0 added / 0 updated", () => {
    const rows = [{ from: "a", to: "NEW", enabled: true }];
    const first = mergeRules(existing, rows);
    const second = mergeRules(first.rules, rows);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.rules).toEqual(first.rules);
  });

  it("does not mutate the input array", () => {
    mergeRules(existing, [{ from: "a", to: "NEW", enabled: true }]);
    expect(existing[0].to).toBe("OLD");
  });
});

describe("exportRulesCsv", () => {
  it("writes header + rows with CRLF and quotes fields when needed", () => {
    const rules: ReplacementRule[] = [
      { id: "1", from: "a,b", to: 'c"d', enabled: true },
      { id: "2", from: "plain", to: "x", enabled: false },
    ];
    expect(exportRulesCsv(rules)).toBe(
      `${HEADER}\r\n"a,b","c""d",true\r\nplain,x,false\r\n`,
    );
  });

  it("round-trips through parseRulesCsv", () => {
    const rules: ReplacementRule[] = [
      { id: "1", from: "株式会社A社", to: "会社X", enabled: true },
      { id: "2", from: "multi\nline", to: "a,b", enabled: false },
    ];
    const parsed = parseRulesCsv(exportRulesCsv(rules));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(
      rules.map(({ from, to, enabled }) => ({ from, to, enabled })),
    );
  });
});
