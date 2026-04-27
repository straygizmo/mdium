// @vitest-environment node
import { describe, it, expect } from "vitest";
import { CsvTokenState, tokenizeCsvLine } from "../csv-language";

describe("tokenizeCsvLine (comma)", () => {
  it("cycles columns 0..9 then wraps", () => {
    const tokens = tokenizeCsvLine(
      "a,b,c,d,e,f,g,h,i,j,k,l",
      new CsvTokenState(0, false),
      ",",
    ).tokens;
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect(cellTokens.map((t) => t.type)).toEqual([
      "col0", "col1", "col2", "col3", "col4",
      "col5", "col6", "col7", "col8", "col9",
      "col0", "col1",
    ]);
  });

  it("does not advance columns inside quoted field", () => {
    const { tokens } = tokenizeCsvLine(
      '"a,b",c',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    const uniqueCols = [...new Set(cellTokens.map((t) => t.type))];
    expect(uniqueCols).toEqual(["col0", "col1"]);
  });

  it("treats '\"\"' inside quoted field as escaped quote (stays in field)", () => {
    const { tokens, endState } = tokenizeCsvLine(
      '"a""b",c',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    const uniqueCols = [...new Set(cellTokens.map((t) => t.type))];
    expect(uniqueCols).toEqual(["col0", "col1"]);
    expect(endState.inQuote).toBe(false);
  });

  it("carries inQuote state across lines", () => {
    const line1 = tokenizeCsvLine(
      '"multi',
      new CsvTokenState(0, false),
      ",",
    );
    expect(line1.endState.inQuote).toBe(true);
    expect(line1.endState.column).toBe(0);

    const line2 = tokenizeCsvLine(
      'line",next',
      line1.endState,
      ",",
    );
    expect(line2.endState.inQuote).toBe(false);
    expect(line2.endState.column).toBe(1);
  });

  it("resets column to 0 at start of fresh line (non-quoted)", () => {
    const state = new CsvTokenState(0, false);
    const { tokens } = tokenizeCsvLine("x,y", state, ",");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual(["col0", "col1"]);
  });

  it("first token always has startIndex 0", () => {
    const cases = ["a,b", ",a", '"x",y', "", "\t"];
    for (const line of cases) {
      const { tokens } = tokenizeCsvLine(line, new CsvTokenState(0, false), ",");
      if (tokens.length > 0) expect(tokens[0].startIndex).toBe(0);
    }
  });
});

describe("tokenizeCsvLine (tab)", () => {
  it("uses tab as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a\tb\tc", new CsvTokenState(0, false), "\t");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });
});

describe("tokenizeCsvLine (semicolon, pipe, colon)", () => {
  it("uses semicolon as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a;b;c", new CsvTokenState(0, false), ";");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });

  it("uses pipe as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a|b|c", new CsvTokenState(0, false), "|");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });

  it("uses colon as delimiter", () => {
    const { tokens } = tokenizeCsvLine("a:b:c", new CsvTokenState(0, false), ":");
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect([...new Set(cellTokens.map((t) => t.type))]).toEqual([
      "col0", "col1", "col2",
    ]);
  });
});

describe("tokenizeCsvLine — quoted header / quoted string rainbow", () => {
  it("colors quoted header cells with col0/col1/col2", () => {
    const { tokens } = tokenizeCsvLine(
      '"id","name","email"',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect(cellTokens.map((t) => t.type)).toEqual(["col0", "col1", "col2"]);
  });

  it("colors a quoted body cell with the column's color, not a default token", () => {
    // Mixed unquoted + quoted cells in the same row. Each cell should pick
    // up its column index, regardless of quoting.
    const { tokens } = tokenizeCsvLine(
      'a,"b",c',
      new CsvTokenState(0, false),
      ",",
    );
    const cellTokens = tokens.filter((t) => t.type.startsWith("col"));
    expect(cellTokens.map((t) => t.type)).toEqual(["col0", "col1", "col2"]);
  });

  it("first character of a quoted cell at column N emits colN token", () => {
    const { tokens } = tokenizeCsvLine(
      '"hello",world',
      new CsvTokenState(0, false),
      ",",
    );
    // First emitted token covers the opening quote — must be col0, not
    // a default/string token.
    expect(tokens[0]).toEqual({ startIndex: 0, type: "col0" });
  });
});
