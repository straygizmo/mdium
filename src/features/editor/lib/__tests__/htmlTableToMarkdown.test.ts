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
});
