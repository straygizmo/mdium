import type { KeyboardEvent } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

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
