// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  centeredScrollTop,
  jumpEditorToLine,
  lineStartOffset,
} from "../jumpToLine";

describe("lineStartOffset", () => {
  const content = "alpha\nbravo\ncharlie\n\ndelta";

  it("returns 0 for line 1", () => {
    expect(lineStartOffset(content, 1)).toBe(0);
  });

  it("returns the offset just after the previous newline", () => {
    expect(lineStartOffset(content, 2)).toBe(6); // after "alpha\n"
    expect(lineStartOffset(content, 3)).toBe(12); // after "bravo\n"
    expect(lineStartOffset(content, 4)).toBe(20); // the empty line
    expect(lineStartOffset(content, 5)).toBe(21); // "delta"
  });

  it("clamps lines beyond the end to the last line", () => {
    expect(lineStartOffset(content, 99)).toBe(21);
  });

  it("clamps lines below 1 to the first line", () => {
    expect(lineStartOffset(content, 0)).toBe(0);
    expect(lineStartOffset(content, -5)).toBe(0);
  });

  it("handles empty content", () => {
    expect(lineStartOffset("", 3)).toBe(0);
  });
});

describe("centeredScrollTop", () => {
  it("centers the target line in the viewport", () => {
    // line 50, lineHeight 20, clientHeight 400:
    // top of line = 49*20 = 980; center it: 980 - 200 + 10 = 790
    expect(centeredScrollTop(50, 100, 20, 400)).toBe(790);
  });

  it("never returns a negative scrollTop", () => {
    expect(centeredScrollTop(1, 100, 20, 400)).toBe(0);
    expect(centeredScrollTop(5, 100, 20, 400)).toBe(0);
  });

  it("clamps the line to totalLines", () => {
    expect(centeredScrollTop(999, 100, 20, 400)).toBe(
      centeredScrollTop(100, 100, 20, 400),
    );
  });
});

describe("jumpEditorToLine", () => {
  it("focuses the editor and places the caret at the line start", () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo\nthree";
    document.body.appendChild(editor);

    jumpEditorToLine(editor, 3);

    expect(editor.selectionStart).toBe(8); // start of "three"
    expect(editor.selectionEnd).toBe(8);
    expect(editor.scrollTop).toBeGreaterThanOrEqual(0);
    editor.remove();
  });

  it("clamps out-of-range lines instead of throwing", () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo";
    document.body.appendChild(editor);

    jumpEditorToLine(editor, 42);

    expect(editor.selectionStart).toBe(4); // start of "two" (last line)
    editor.remove();
  });
});
