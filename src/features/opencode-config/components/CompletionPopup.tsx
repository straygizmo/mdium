import { useEffect, useRef } from "react";
import type { CompletionItem } from "../hooks/useCompletion";

interface CompletionPopupProps {
  items: CompletionItem[];
  selectedIndex: number;
  visible: boolean;
  onItemClick: (index: number) => void;
}

export function CompletionPopup({ items, selectedIndex, visible, onItemClick }: CompletionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to keep the selected item visible
  useEffect(() => {
    if (selectedRef.current && listRef.current) {
      const list = listRef.current;
      const item = selectedRef.current;
      const listRect = list.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();

      if (itemRect.bottom > listRect.bottom) {
        item.scrollIntoView({ block: "nearest" });
      } else if (itemRect.top < listRect.top) {
        item.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  if (!visible || items.length === 0) return null;

  return (
    <div className="oc-chat__completion" ref={listRef}>
      {items.map((item, i) => (
        <div
          key={`${item.type}-${item.value}`}
          ref={i === selectedIndex ? selectedRef : undefined}
          className={`oc-chat__completion-item${i === selectedIndex ? " oc-chat__completion-item--selected" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent textarea blur
            onItemClick(i);
          }}
        >
          <span className="oc-chat__completion-icon">
            {item.type === "command" ? "/" : item.type === "agent" ? "@" : "\u{1F4C4}"}
          </span>
          <span className="oc-chat__completion-label">{item.label}</span>
          {item.description && (
            <span className="oc-chat__completion-desc">{item.description}</span>
          )}
        </div>
      ))}
    </div>
  );
}
