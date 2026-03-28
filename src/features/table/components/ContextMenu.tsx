import { type FC, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ContextMenuState } from "../../../shared/types";
import "./ContextMenu.css";

interface Props {
  menu: ContextMenuState;
  onClose: () => void;
  onAddRowAbove: () => void;
  onAddRowBelow: () => void;
  onDeleteRow: () => void;
  onAddColumnLeft: () => void;
  onAddColumnRight: () => void;
  onDeleteColumn: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onBold: () => void;
  onItalic: () => void;
  onStrikethrough: () => void;
  onCode: () => void;
}

const ContextMenu: FC<Props> = ({
  menu,
  onClose,
  onAddRowAbove,
  onAddRowBelow,
  onDeleteRow,
  onAddColumnLeft,
  onAddColumnRight,
  onDeleteColumn,
  onCopy,
  onCut,
  onPaste,
  onBold,
  onItalic,
  onStrikethrough,
  onCode,
}) => {
  const { t } = useTranslation("editor");
  const { t: tCommon } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (!menu.visible) return null;

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
    >
      <div className="ctx-group">
        <button onClick={onCopy}>
          <span className="ctx-label">{tCommon("copy")}</span>
          <span className="ctx-shortcut">Ctrl+C</span>
        </button>
        <button onClick={onCut}>
          <span className="ctx-label">{tCommon("cut")}</span>
          <span className="ctx-shortcut">Ctrl+X</span>
        </button>
        <button onClick={onPaste}>
          <span className="ctx-label">{tCommon("paste")}</span>
          <span className="ctx-shortcut">Ctrl+V</span>
        </button>
      </div>
      <div className="ctx-divider" />
      <div className="ctx-group">
        <button onClick={onAddRowAbove}>
          <span className="ctx-label">{t("insertRowAbove")}</span>
        </button>
        <button onClick={onAddRowBelow}>
          <span className="ctx-label">{t("insertRowBelow")}</span>
        </button>
        <button onClick={onDeleteRow} disabled={menu.row === -1}>
          <span className="ctx-label">{t("deleteRow")}</span>
        </button>
      </div>
      <div className="ctx-divider" />
      <div className="ctx-group">
        <button onClick={onAddColumnLeft}>
          <span className="ctx-label">{t("insertColLeft")}</span>
        </button>
        <button onClick={onAddColumnRight}>
          <span className="ctx-label">{t("insertColRight")}</span>
        </button>
        <button onClick={onDeleteColumn}>
          <span className="ctx-label">{t("deleteCol")}</span>
        </button>
      </div>
      <div className="ctx-divider" />
      <div className="ctx-group">
        <button onClick={onBold}>
          <span className="ctx-label">{t("bold")}</span>
          <span className="ctx-shortcut">Ctrl+B</span>
        </button>
        <button onClick={onItalic}>
          <span className="ctx-label">{t("italic")}</span>
          <span className="ctx-shortcut">Ctrl+I</span>
        </button>
        <button onClick={onStrikethrough}>
          <span className="ctx-label">{t("strikethrough")}</span>
          <span className="ctx-shortcut">Ctrl+5</span>
        </button>
        <button onClick={onCode}>
          <span className="ctx-label">{t("codeBlock")}</span>
          <span className="ctx-shortcut">Ctrl+`</span>
        </button>
      </div>
    </div>
  );
};

export default ContextMenu;
