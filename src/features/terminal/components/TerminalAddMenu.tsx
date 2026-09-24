import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TERMINAL_KINDS, TERMINAL_KIND_LABEL_KEYS, type TerminalKind } from "@/features/terminal/terminal-session";
import "./TerminalAddMenu.css";

interface TerminalAddMenuProps {
  onAdd: (kind: TerminalKind) => void;
}

// Button + menu replacement for a controlled <select value="">. A closed
// <select> in Chromium/WebView2 fires `change` on ArrowUp/ArrowDown even
// without opening its popup, so a select-based control could launch a
// terminal session from a stray keypress. A session is only created here
// when a menu item is explicitly clicked or activated with Enter/Space.
export function TerminalAddMenu({ onAdd }: TerminalAddMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSelect = (kind: TerminalKind) => {
    setOpen(false);
    onAdd(kind);
  };

  return (
    <div className="terminal-add-menu" ref={rootRef}>
      <button
        type="button"
        className="app__bottom-terminal-add-select"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("terminalAdd")}
        onClick={() => setOpen((value) => !value)}
      >
        {t("terminalAdd")}
      </button>
      {open && (
        <div className="terminal-add-menu__menu" role="menu">
          {TERMINAL_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="terminal-add-menu__item"
              onClick={() => handleSelect(kind)}
            >
              {t(TERMINAL_KIND_LABEL_KEYS[kind])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
