// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  centeredScrollTop,
  centeredScrollTopFromPixel,
  jumpEditorToLine,
  lineStartOffset,
  measureVisualLineTop,
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

describe("centeredScrollTopFromPixel", () => {
  it("centers the measured pixel top in the viewport", () => {
    // line top at 980px, lineHeight 20, clientHeight 400: 980 - 200 + 10 = 790
    expect(centeredScrollTopFromPixel(980, 20, 400)).toBe(790);
  });

  it("never returns a negative scrollTop", () => {
    expect(centeredScrollTopFromPixel(0, 20, 400)).toBe(0);
    expect(centeredScrollTopFromPixel(50, 20, 400)).toBe(0);
  });
});

describe("measureVisualLineTop", () => {
  it("returns null when the environment cannot lay out text (no layout engine)", () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo\nthree";
    document.body.appendChild(editor);

    // happy-dom has no layout engine, so measurement must report "unavailable"
    // instead of a bogus 0 so callers fall back to the line-based estimate.
    expect(measureVisualLineTop(editor, 8)).toBeNull();
    editor.remove();
  });

  it("does not leave the measurement mirror in the DOM", () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo\nthree";
    document.body.appendChild(editor);
    const before = document.body.childElementCount;

    measureVisualLineTop(editor, 8);

    expect(document.body.childElementCount).toBe(before);
    editor.remove();
  });
});

describe("jumpEditorToLine", () => {
  it("flags the jump scroll so scroll sync skips it, then clears the flag", async () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo\nthree";
    document.body.appendChild(editor);

    jumpEditorToLine(editor, 3);
    expect(editor.dataset.jumpScroll).toBe("1");

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(editor.dataset.jumpScroll).toBeUndefined();
    editor.remove();
  });

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
