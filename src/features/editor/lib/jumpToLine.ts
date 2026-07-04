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

export function jumpEditorToLine(editor: HTMLTextAreaElement, line: number): void {
  const content = editor.value;
  const offset = lineStartOffset(content, line);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(offset, offset);
  const totalLines = content.split("\n").length;
  editor.scrollTop = centeredScrollTop(
    line,
    totalLines,
    measureLineHeight(editor),
    editor.clientHeight,
  );
}
