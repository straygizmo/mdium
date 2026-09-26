// @vitest-environment happy-dom
import DOMPurify from "dompurify";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { renderMarkdownSafe } from "../render-markdown-safe";

// Parses into an inert template so happy-dom does not try to load resources.
function toDom(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

describe("renderMarkdownSafe", () => {
  it("renders Markdown formatting", () => {
    expect(renderMarkdownSafe("**b**")).toContain("<strong>b</strong>");
  });

  it("strips event handler attributes from raw HTML", () => {
    const html = renderMarkdownSafe("<img src=x onerror=alert(1)>");
    const img = toDom(html).querySelector("img");
    expect(img?.hasAttribute("onerror") ?? false).toBe(false);
    expect(html).not.toContain("onerror");
  });

  it("removes script elements", () => {
    const html = renderMarkdownSafe("before\n\n<script>alert(1)</script>\n\nafter");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("after");
  });

  it("drops javascript: link targets", () => {
    const html = renderMarkdownSafe("[x](javascript:alert(1))");
    for (const link of Array.from(toDom(html).querySelectorAll("a"))) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    }
    expect(html).not.toMatch(/javascript:/i);
  });

  it("opens external links in a new context without an opener", () => {
    const link = toDom(renderMarkdownSafe("[site](https://example.com)")).querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("removes forbidden tags and inline styles", () => {
    const html = renderMarkdownSafe('<p style="color:red">t</p><iframe></iframe><form><input><button>b</button></form><style>p{}</style>');
    expect(html).not.toMatch(/<(iframe|form|input|button|style)\b/);
    expect(html).not.toContain("style=");
    expect(html).toContain("t");
  });

  it("returns an empty string for non-string input", () => {
    expect(renderMarkdownSafe(undefined as unknown as string)).toBe("");
    expect(renderMarkdownSafe(42 as unknown as string)).toBe("");
  });

  it("ignores global marked configuration", () => {
    const before = renderMarkdownSafe("# Title");
    marked.use({ renderer: { heading: () => "<h6>hijacked</h6>" } });
    expect(marked.parse("# Title", { async: false })).toContain("hijacked");
    const after = renderMarkdownSafe("# Title");
    expect(after).toBe(before);
    expect(after).not.toContain("hijacked");
  });

  it("does not add its link hook to the global DOMPurify instance", () => {
    renderMarkdownSafe("[site](https://example.com)");
    const link = toDom(DOMPurify.sanitize('<a href="https://example.com">x</a>')).querySelector("a");
    expect(link?.hasAttribute("target")).toBe(false);
    expect(link?.hasAttribute("rel")).toBe(false);
  });
});
