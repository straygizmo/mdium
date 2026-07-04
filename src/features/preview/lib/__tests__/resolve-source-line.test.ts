// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { resolveSourceLine } from "../resolve-source-line";

function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("resolveSourceLine", () => {
  it("returns the line of the annotated element itself", () => {
    const root = render('<p data-source-line="7">hello</p>');
    const p = root.querySelector<HTMLElement>("p")!;
    expect(resolveSourceLine(p)).toBe(7);
  });

  it("resolves nested nodes to the nearest annotated ancestor", () => {
    const root = render(
      '<ul data-source-line="12"><li><strong>bold</strong></li></ul>',
    );
    const strong = root.querySelector<HTMLElement>("strong")!;
    expect(resolveSourceLine(strong)).toBe(12);
  });

  it("returns null when no ancestor is annotated", () => {
    const root = render("<p>plain</p>");
    const p = root.querySelector<HTMLElement>("p")!;
    expect(resolveSourceLine(p)).toBeNull();
  });

  it("returns null for openable images (handled by the open-as-tab action)", () => {
    const root = render(
      '<p data-source-line="3"><img data-filepath="C:/x.png"></p>',
    );
    const img = root.querySelector<HTMLElement>("img")!;
    expect(resolveSourceLine(img)).toBeNull();
  });

  it("still resolves images without data-filepath", () => {
    const root = render('<p data-source-line="3"><img src="x"></p>');
    const img = root.querySelector<HTMLElement>("img")!;
    expect(resolveSourceLine(img)).toBe(3);
  });

  it("returns null for non-positive or non-integer line values", () => {
    const zero = render('<p data-source-line="0">x</p>');
    expect(resolveSourceLine(zero.querySelector<HTMLElement>("p")!)).toBeNull();
    const nan = render('<p data-source-line="abc">x</p>');
    expect(resolveSourceLine(nan.querySelector<HTMLElement>("p")!)).toBeNull();
    const neg = render('<p data-source-line="-1">x</p>');
    expect(resolveSourceLine(neg.querySelector<HTMLElement>("p")!)).toBeNull();
  });
});
