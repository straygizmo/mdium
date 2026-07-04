/**
 * Maps a double-clicked node inside the rendered Markdown preview to the
 * 1-indexed source line of its nearest annotated block, using the
 * `data-source-line` attributes emitted by renderMarkdownWithSourceLines.
 */
export function resolveSourceLine(target: HTMLElement): number | null {
  // Openable images have their own dblclick action (open as tab); let it win.
  if (target.closest("img[data-filepath]")) return null;
  const el = target.closest<HTMLElement>("[data-source-line]");
  if (!el) return null;
  const line = Number(el.dataset.sourceLine);
  if (!Number.isInteger(line) || line < 1) return null;
  return line;
}
