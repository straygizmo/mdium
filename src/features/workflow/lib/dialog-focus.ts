import { type KeyboardEvent, type RefObject, useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * While `active`, focuses the dialog and, when it deactivates or unmounts,
 * returns focus to the element that had it before (if still in the page).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, active]);
}

/** Keeps Tab / Shift+Tab focus cycling inside `container`. */
export function trapTab(e: KeyboardEvent, container: HTMLElement | null): void {
  if (e.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (focusable.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeEl = document.activeElement;
  if (e.shiftKey && (activeEl === first || activeEl === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && activeEl === last) {
    e.preventDefault();
    first.focus();
  }
}
