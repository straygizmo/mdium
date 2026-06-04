import type { RefObject } from "react";

/**
 * Reposition the caret/selection and restore the editor scroll position on the
 * next tick after a programmatic content change.
 *
 * The editor textarea is a controlled component. Updating its `value` collapses
 * the caret to the end of the text, and a subsequent `focus()` scrolls the
 * editor to the bottom. Programmatic edits (paste, formatting, speech, etc.) do
 * not fire a native `input` event, so the scroll-sync guard does not suppress
 * this. Callers capture `scrollTop` BEFORE changing the content and pass it here
 * so the view stays where the user was working.
 */
export function restoreEditorSelection(
  editorRef: RefObject<HTMLTextAreaElement | null>,
  selStart: number,
  selEnd: number,
  scrollTop: number,
): void {
  setTimeout(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(selStart, selEnd);
    el.scrollTop = scrollTop;
  }, 0);
}
