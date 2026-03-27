import { type FC, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./TableGridSelector.css";

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  onSelect: (rows: number, cols: number) => void;
  onClose: () => void;
}

const MAX_ROWS = 8;
const MAX_COLS = 8;

const TableGridSelector: FC<Props> = ({ anchorRef, onSelect, onClose }) => {
  const [hoverRow, setHoverRow] = useState(0);
  const [hoverCol, setHoverCol] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);

  // Position relative to anchor button
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ top: rect.bottom + 2, left: rect.left });
  }, [anchorRef]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current && !ref.current.contains(target) &&
        anchorRef.current && !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, anchorRef]);

  const handleCellClick = useCallback(() => {
    if (hoverRow > 0 && hoverCol > 0) {
      onSelect(hoverRow, hoverCol);
    }
  }, [hoverRow, hoverCol, onSelect]);

  return createPortal(
    <div
      className="table-grid-selector"
      ref={ref}
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="table-grid-label">
        {hoverRow > 0 && hoverCol > 0
          ? `${hoverCol} x ${hoverRow}`
          : "表のサイズを選択"}
      </div>
      <div className="table-grid">
        {Array.from({ length: MAX_ROWS }, (_, r) => (
          <div className="table-grid-row" key={r}>
            {Array.from({ length: MAX_COLS }, (_, c) => (
              <div
                key={c}
                className={`table-grid-cell ${
                  r < hoverRow && c < hoverCol ? "active" : ""
                }`}
                onMouseEnter={() => {
                  setHoverRow(r + 1);
                  setHoverCol(c + 1);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleCellClick();
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
};

export default TableGridSelector;
