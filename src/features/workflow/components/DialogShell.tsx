import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { useDialogStore } from "@/stores/dialog-store";
import { trapTab } from "../lib/dialog-focus";

/** Dialog elements of the mounted shells, in mount order. */
const openDialogs: HTMLElement[] = [];

/**
 * The innermost open dialog: the latest one that contains no other open
 * dialog (a nested dialog mounted together with its parent still wins).
 */
function topDialog(): HTMLElement | undefined {
  const leaves = openDialogs.filter((el) => !openDialogs.some((other) => other !== el && el.contains(other)));
  return leaves[leaves.length - 1];
}

interface DialogShellProps {
  /** Class of the full-screen overlay. */
  overlayClassName: string;
  /** Class of the dialog element. */
  className: string;
  /** Id of the element that names the dialog. */
  labelledBy: string;
  /** Requests closing: Escape (unless `onEscape` is given) and a full press on the overlay. */
  onClose(): void;
  /** Replaces the Escape handling; the key never reaches the page. */
  onEscape?(e: KeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement | null): void;
  /** Keeps every key, press and click from reaching the dialog underneath. */
  nested?: boolean;
  children: ReactNode;
}

/**
 * Shared modal behavior of the workflow dialogs: focus moves into the dialog
 * on mount and back to the previous element on unmount, Tab stays inside,
 * Escape closes without reaching the page, and the overlay closes only when
 * a press both starts and ends on it (a text selection dragged out of the
 * dialog keeps it open). After an app dialog (confirm/message) closes and
 * leaves the focus on the page body, the topmost workflow dialog takes it back.
 */
export function DialogShell({
  overlayClassName,
  className,
  labelledBy,
  onClose,
  onEscape,
  nested = false,
  children,
}: DialogShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Whether the current pointer press started on the overlay. */
  const pressOnOverlayRef = useRef(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialogs.push(el);
    if (topDialog() === el) el.focus();
    return () => {
      openDialogs.splice(openDialogs.indexOf(el), 1);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useDialogStore.subscribe((state, prev) => {
      if (prev.dialogs.length === 0 || state.dialogs.length > 0) return;
      clearTimeout(timer);
      // Wait until the app dialog has left the page before checking the focus.
      timer = setTimeout(() => {
        const el = dialogRef.current;
        if (!el || topDialog() !== el) return;
        const active = document.activeElement;
        if (!active || active === document.body) el.focus();
      }, 0);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (nested) e.stopPropagation();
    if (e.key === "Escape") {
      e.stopPropagation();
      if (onEscape) onEscape(e, dialogRef.current);
      else onClose();
    } else {
      trapTab(e, dialogRef.current);
    }
  };

  return (
    <div
      className={overlayClassName}
      onMouseDown={(e: MouseEvent) => {
        if (nested) e.stopPropagation();
        pressOnOverlayRef.current = e.target === e.currentTarget;
      }}
      onClick={(e: MouseEvent) => {
        if (nested) e.stopPropagation();
        const pressed = pressOnOverlayRef.current;
        pressOnOverlayRef.current = false;
        if (pressed && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
