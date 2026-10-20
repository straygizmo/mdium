import { describe, expect, it } from "vitest";
import { stripMdiumContext, wrapWithMdiumContext } from "../mdium-context";

describe("wrapWithMdiumContext", () => {
  it("prefixes the active xlsm path", () => {
    expect(wrapWithMdiumContext("hi", "C:/w/Book.xlsm")).toBe(
      '<mdium_context>\nactive_file="C:/w/Book.xlsm"\n</mdium_context>\n\nhi',
    );
  });
  it("accepts .xlam regardless of case", () => {
    expect(wrapWithMdiumContext("hi", "C:/w/ADDIN.XLAM")).toContain("<mdium_context>");
  });
  it("leaves non-macro files and missing paths untouched", () => {
    expect(wrapWithMdiumContext("hi", "C:/w/notes.md")).toBe("hi");
    expect(wrapWithMdiumContext("hi", null)).toBe("hi");
    expect(wrapWithMdiumContext("hi", undefined)).toBe("hi");
  });
  it("escapes double quotes in the path", () => {
    expect(wrapWithMdiumContext("hi", 'C:/w/a"b.xlsm')).toContain('active_file="C:/w/a\\"b.xlsm"');
  });
});

describe("stripMdiumContext", () => {
  it("removes the wrapper and the blank line after it", () => {
    const wrapped = wrapWithMdiumContext("hi there", "C:/w/Book.xlsm");
    expect(stripMdiumContext(wrapped)).toBe("hi there");
  });

  it("leaves text without a wrapper untouched", () => {
    expect(stripMdiumContext("plain")).toBe("plain");
    expect(stripMdiumContext("")).toBe("");
  });

  it("only strips a leading wrapper", () => {
    const text = "see <mdium_context>x</mdium_context> later";
    expect(stripMdiumContext(text)).toBe(text);
  });
});
