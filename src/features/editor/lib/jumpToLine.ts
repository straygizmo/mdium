/**
 * Helpers to jump the Markdown editor textarea to a given 1-indexed source
 * line: caret at the line start, line vertically centered in the viewport.
 */

function clampLine(line: number, totalLines: number): number {
  return Math.min(Math.max(1, Math.floor(line)), Math.max(1, totalLines));
}

export function lineStartOffset(content: string, line: number): number {
  const lines = content.split("\n");
  const target = clampLine(line, lines.length);
  let offset = 0;
  for (let i = 0; i < target - 1; i++) {
    offset += lines[i].length + 1; // +1 for the newline
  }
  return offset;
}

export function centeredScrollTop(
  line: number,
  totalLines: number,
  lineHeight: number,
  clientHeight: number,
): number {
  const target = clampLine(line, totalLines);
  const lineTop = (target - 1) * lineHeight;
  return centeredScrollTopFromPixel(lineTop, lineHeight, clientHeight);
}

export function centeredScrollTopFromPixel(
  lineTop: number,
  lineHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, lineTop - clientHeight / 2 + lineHeight / 2);
}

// Same measurement strategy as useScrollSync: computed line-height with a
// font-size fallback when it resolves to "normal".
function measureLineHeight(editor: HTMLTextAreaElement): number {
  const computed = getComputedStyle(editor);
  const lh = parseFloat(computed.lineHeight);
  if (!Number.isNaN(lh) && lh > 0) return lh;
  const fs = parseFloat(computed.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.4 : 20;
}

/**
 * Measure the pixel offset (in textarea scroll coordinates) of the character
 * at `offset`, accounting for soft-wrapped lines. A `(line - 1) * lineHeight`
 * estimate is wrong as soon as any earlier line wraps, which is the norm for
 * prose written as one long logical line per paragraph.
 *
 * Uses a hidden mirror element replicating the textarea's text layout.
 * Returns null when the environment cannot lay out text (e.g. happy-dom in
 * tests) so callers can fall back to the line-based estimate.
 */
export function measureVisualLineTop(
  editor: HTMLTextAreaElement,
  offset: number,
): number | null {
  const cs = getComputedStyle(editor);
  const mirror = document.createElement("div");
  const style = mirror.style;
  style.position = "absolute";
  style.visibility = "hidden";
  style.left = "-9999px";
  style.top = "0";
  // A soft-wrapping textarea lays text out as pre-wrap with break-word.
  style.whiteSpace = "pre-wrap";
  style.overflowWrap = "break-word";
  style.boxSizing = "border-box";
  style.border = "0";
  // clientWidth = padding box minus any scrollbar, so with identical padding
  // the mirror's content width matches the textarea's wrapping width.
  style.width = `${editor.clientWidth}px`;
  style.paddingTop = cs.paddingTop;
  style.paddingRight = cs.paddingRight;
  style.paddingBottom = cs.paddingBottom;
  style.paddingLeft = cs.paddingLeft;
  style.fontFamily = cs.fontFamily;
  style.fontSize = cs.fontSize;
  style.fontWeight = cs.fontWeight;
  style.fontStyle = cs.fontStyle;
  style.letterSpacing = cs.letterSpacing;
  style.lineHeight = cs.lineHeight;
  style.tabSize = cs.tabSize;
  style.wordSpacing = cs.wordSpacing;

  mirror.textContent = editor.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = "\u200b"; // zero-width space: occupies a row without adding width
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    // No layout engine (tests) or zero-size layout: report "unavailable"
    // rather than a bogus 0.
    if (mirror.offsetHeight <= 0) return null;
    return marker.offsetTop;
  } finally {
    mirror.remove();
  }
}

export function jumpEditorToLine(editor: HTMLTextAreaElement, line: number): void {
  const content = editor.value;
  const offset = lineStartOffset(content, line);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(offset, offset);

  const lineHeight = measureLineHeight(editor);
  const measuredTop = measureVisualLineTop(editor, offset);
  const totalLines = content.split("\n").length;
  const scrollTop =
    measuredTop !== null
      ? centeredScrollTopFromPixel(measuredTop, lineHeight, editor.clientHeight)
      : centeredScrollTop(line, totalLines, lineHeight, editor.clientHeight);

  // Flag the programmatic scroll so useScrollSync's editor->preview sync
  // leaves the preview where the user double-clicked (same pattern as
  // preview's data-content-updating). Scroll events dispatch before the next
  // frame's rAF callbacks, so clearing on rAF covers the induced event; the
  // extra rAF-clear also covers the no-op case where no scroll event fires.
  editor.dataset.jumpScroll = "1";
  editor.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    delete editor.dataset.jumpScroll;
  });
}
