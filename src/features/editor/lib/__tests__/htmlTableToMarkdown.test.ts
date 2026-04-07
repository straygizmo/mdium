// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { htmlTableToMarkdown } from "../htmlTableToMarkdown";

describe("htmlTableToMarkdown", () => {
  it("returns null when HTML contains no table", () => {
    expect(htmlTableToMarkdown("<p>Hello</p>")).toBeNull();
  });

  it("returns null for a table with only 1 column", () => {
    const html = "<table><tr><th>Only</th></tr><tr><td>One</td></tr></table>";
    expect(htmlTableToMarkdown(html)).toBeNull();
  });

  it("converts a basic 2x2 table with thead", () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
      </table>`;
    expect(htmlTableToMarkdown(html)).toBe(
      "| Name  | Age |\n" +
      "| ----- | --- |\n" +
      "| Alice | 30  |"
    );
  });

  it("treats first row as header when no thead exists", () => {
    const html = `
      <table>
        <tr><td>Name</td><td>Age</td></tr>
        <tr><td>Bob</td><td>25</td></tr>
      </table>`;
    expect(htmlTableToMarkdown(html)).toBe(
      "| Name | Age |\n" +
      "| ---- | --- |\n" +
      "| Bob  | 25  |"
    );
  });

  it("converts bold, italic, and links in cells", () => {
    const html = `
      <table>
        <tr><th>Format</th><th>Result</th></tr>
        <tr><td><b>bold</b></td><td><a href="https://example.com">link</a></td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("| **bold** ");
    expect(result).toContain("| [link](https://example.com) |");
  });

  it("converts strikethrough, code, and italic in cells", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th><th>C</th></tr>
        <tr><td><del>removed</del></td><td><code>code</code></td><td><em>italic</em></td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("~~removed~~");
    expect(result).toContain("`code`");
    expect(result).toContain("*italic*");
  });

  it("converts line breaks in cells to <br>", () => {
    const html = `
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td>line1<br>line2</td><td>ok</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("line1<br>line2");
  });

  it("escapes pipe characters in cell content", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td>a | b</td><td>c</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("a \\| b");
  });

  it("detects text-align style for center and right", () => {
    const html = `
      <table>
        <tr>
          <th style="text-align: left">Left</th>
          <th style="text-align: center">Center</th>
          <th style="text-align: right">Right</th>
        </tr>
        <tr><td>a</td><td>b</td><td>c</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const lines = result.split("\n");
    const sep = lines[1];
    // left = ------,  center = :----:,  right = -----:
    expect(sep).toMatch(/\| -{3,} \|/);           // left column: no colons
    expect(sep).toMatch(/\| :-+: \|/);            // center column
    expect(sep).toMatch(/\| -{2,}: \|/);           // right column
  });

  it("detects align attribute", () => {
    const html = `
      <table>
        <tr><th align="right">Price</th><th>Item</th></tr>
        <tr><td align="right">100</td><td>Apple</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const sep = result.split("\n")[1];
    expect(sep).toMatch(/---:/);
  });

  it("pads rows with fewer cells to max column count", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th><th>C</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const dataLine = result.split("\n")[2];
    // Should have 3 pipe-separated cells
    expect(dataLine.split("|").filter((s) => s.trim() !== "").length).toBeLessThanOrEqual(3);
    expect(dataLine).toMatch(/\|\s*\|$/);
  });

  it("ignores colspan/rowspan and extracts text", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td colspan="2">merged</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("merged");
  });

  it("ignores nested tables and extracts text only", () => {
    const html = `
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td><table><tr><td>nested</td></tr></table></td><td>ok</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toContain("nested");
    expect(result).toContain("ok");
  });

  it("handles empty cells", () => {
    const html = `
      <table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td></td><td>data</td></tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    expect(result).toBeDefined();
    expect(result).toContain("data");
  });

  it("ignores nested 2x2 table and extracts text only", () => {
    const html = `
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr>
          <td>
            <table><tr><td>n1</td><td>n2</td></tr><tr><td>n3</td><td>n4</td></tr></table>
          </td>
          <td>ok</td>
        </tr>
      </table>`;
    const result = htmlTableToMarkdown(html)!;
    const lines = result.split("\n");
    // Should only have 3 lines: header, separator, 1 data row
    expect(lines).toHaveLength(3);
    expect(result).toContain("ok");
  });
});
