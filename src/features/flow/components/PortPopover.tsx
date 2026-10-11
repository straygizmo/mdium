import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

interface PortPopoverProps {
  ports: string[];
  /** Drop point, in the coordinates of the positioned ancestor. */
  anchor: { x: number; y: number };
  onChoose: (port: string) => void;
  onCancel: () => void;
}

/** A small listbox asking which exit (port) a new edge leaves from. */
export function PortPopover({ ports, anchor, onChoose, onCancel }: PortPopoverProps) {
  const { t } = useTranslation("flow");
  const ref = useRef<HTMLDivElement>(null);
  // `success` is preselected whenever it is offered.
  const [active, setActive] = useState(() => Math.max(0, ports.indexOf("success")));

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(ports.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (ports[active] !== undefined) onChoose(ports[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      ref={ref}
      className="flow-port-popover"
      role="listbox"
      tabIndex={0}
      aria-label={t("editor.choosePort")}
      style={{ position: "absolute", left: anchor.x, top: anchor.y }}
      onKeyDown={onKeyDown}
    >
      {ports.map((port, i) => (
        <div
          key={port}
          role="option"
          aria-selected={i === active}
          className={`flow-port-popover__option${i === active ? " flow-port-popover__option--active" : ""}`}
          onMouseEnter={() => setActive(i)}
          onClick={() => onChoose(port)}
        >
          {port}
        </div>
      ))}
    </div>
  );
}
