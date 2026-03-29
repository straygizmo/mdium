import { type FC, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MERMAID_TEMPLATES } from "@/shared/lib/constants";
import "@/features/table/components/TableGridSelector.css";
import "./EditorContextMenu.css";

interface Props {
  x: number;
  y: number;
  visible: boolean;
  hasSelection: boolean;
  onClose: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onInsertMermaid: (code: string) => void;
  onInsertTable: (rows: number, cols: number) => void;
  onInsertPageBreak: () => void;
  onInsertCodeBlock: () => void;
  onInsertDetails: () => void;
  onInsertImageFromClipboard: () => void;
  onInsertImageFromFile: () => void;
  onGenerateImage: () => void;
  onGenerateMcpImage: () => void;
}

const EditorContextMenu: FC<Props> = ({
  x,
  y,
  visible,
  hasSelection,
  onClose,
  onCopy,
  onCut,
  onPaste,
  onSelectAll,
  onInsertMermaid,
  onInsertTable,
  onInsertPageBreak,
  onInsertCodeBlock,
  onInsertDetails,
  onInsertImageFromClipboard,
  onInsertImageFromFile,
  onGenerateImage,
  onGenerateMcpImage,
}) => {
  const { t, i18n } = useTranslation("editor");
  const tc = useTranslation("common").t;
  const ref = useRef<HTMLDivElement>(null);
  const [gridHover, setGridHover] = useState({ row: 0, col: 0 });

  useEffect(() => {
    if (!visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose]);

  // Adjust position to avoid overflow
  useEffect(() => {
    if (!visible || !ref.current) return;
    const menu = ref.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menu.style.left = `${Math.max(0, x - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      menu.style.top = `${Math.max(0, vh - rect.height - 8)}px`;
    }
    // Flip submenus to the left if not enough horizontal space
    const finalRect = menu.getBoundingClientRect();
    const subMenuWidth = 200; // min-width of each submenu level
    if (finalRect.right + subMenuWidth * 2 > vw) {
      menu.classList.add("editor-ctx--flip-x");
    } else {
      menu.classList.remove("editor-ctx--flip-x");
    }
    // Flip submenus upward if not enough vertical space
    if (finalRect.bottom > vh * 0.7) {
      menu.classList.add("editor-ctx--flip-y");
    } else {
      menu.classList.remove("editor-ctx--flip-y");
    }
  }, [visible, x, y]);

  if (!visible) return null;

  const lang = i18n.language;

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="editor-ctx"
      style={{ left: x, top: y }}
    >
      <div className="editor-ctx__group">
        <button className="editor-ctx__item" disabled={!hasSelection} onClick={() => handleAction(onCopy)}>
          <span className="editor-ctx__label">{tc("copy")}</span>
          <span className="editor-ctx__shortcut">Ctrl+C</span>
        </button>
        <button className="editor-ctx__item" disabled={!hasSelection} onClick={() => handleAction(onCut)}>
          <span className="editor-ctx__label">{tc("cut")}</span>
          <span className="editor-ctx__shortcut">Ctrl+X</span>
        </button>
        <button className="editor-ctx__item" onClick={() => handleAction(onPaste)}>
          <span className="editor-ctx__label">{tc("paste")}</span>
          <span className="editor-ctx__shortcut">Ctrl+V</span>
        </button>
      </div>
      <div className="editor-ctx__divider" />
      <div className="editor-ctx__group">
        <button className="editor-ctx__item" onClick={() => handleAction(onSelectAll)}>
          <span className="editor-ctx__label">{t("contextMenu.selectAll")}</span>
          <span className="editor-ctx__shortcut">Ctrl+A</span>
        </button>
      </div>
      <div className="editor-ctx__divider" />
      <div className="editor-ctx__group">
        <div className="editor-ctx__item editor-ctx__has-sub">
          <span className="editor-ctx__label">{t("contextMenu.insert")}</span>
          <span className="editor-ctx__arrow">&#9656;</span>
          <div className="editor-ctx__sub">
            <div className="editor-ctx__item editor-ctx__has-sub">
              <span className="editor-ctx__label">{t("contextMenu.insertTable")}</span>
              <span className="editor-ctx__arrow">&#9656;</span>
              <div className="editor-ctx__sub editor-ctx__table-grid-sub">
                <div className="table-grid-label">
                  {gridHover.row > 0 && gridHover.col > 0
                    ? `${gridHover.col} x ${gridHover.row}`
                    : t("contextMenu.selectTableSize")}
                </div>
                <div className="table-grid">
                  {Array.from({ length: 8 }, (_, r) => (
                    <div className="table-grid-row" key={r}>
                      {Array.from({ length: 8 }, (_, c) => (
                        <div
                          key={c}
                          className={`table-grid-cell ${
                            r < gridHover.row && c < gridHover.col ? "active" : ""
                          }`}
                          onMouseEnter={() => setGridHover({ row: r + 1, col: c + 1 })}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            onInsertTable(r + 1, c + 1);
                            onClose();
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <button className="editor-ctx__item" onClick={() => handleAction(onInsertPageBreak)}>
              <span className="editor-ctx__label">{t("contextMenu.insertPageBreak")}</span>
            </button>
            <button className="editor-ctx__item" onClick={() => handleAction(onInsertCodeBlock)}>
              <span className="editor-ctx__label">{t("contextMenu.insertCodeBlock")}</span>
            </button>
            <button className="editor-ctx__item" onClick={() => handleAction(onInsertDetails)}>
              <span className="editor-ctx__label">{t("contextMenu.insertDetails")}</span>
            </button>
            <div className="editor-ctx__item editor-ctx__has-sub">
              <span className="editor-ctx__label">{t("contextMenu.mermaidTemplate")}</span>
              <span className="editor-ctx__arrow">&#9656;</span>
              <div className="editor-ctx__sub editor-ctx__sub--scroll">
                {MERMAID_TEMPLATES.map((tmpl) => (
                  <button
                    key={tmpl.labelKey}
                    className="editor-ctx__item"
                    onClick={() => {
                      onInsertMermaid(tmpl.code[lang] ?? tmpl.code.ja);
                      onClose();
                    }}
                  >
                    <span className="editor-ctx__label">{t(tmpl.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="editor-ctx__item editor-ctx__has-sub">
              <span className="editor-ctx__label">{t("contextMenu.insertImage")}</span>
              <span className="editor-ctx__arrow">&#9656;</span>
              <div className="editor-ctx__sub">
                <button className="editor-ctx__item" onClick={() => handleAction(onInsertImageFromClipboard)}>
                  <span className="editor-ctx__label">{t("contextMenu.imageFromClipboard")}</span>
                </button>
                <button className="editor-ctx__item" onClick={() => handleAction(onInsertImageFromFile)}>
                  <span className="editor-ctx__label">{t("contextMenu.imageFromFile")}</span>
                </button>
                <button className="editor-ctx__item" onClick={() => handleAction(onGenerateImage)}>
                  <span className="editor-ctx__label">{t("contextMenu.imageFromNanoBanana")}</span>
                </button>
                <button className="editor-ctx__item" onClick={() => handleAction(onGenerateMcpImage)}>
                  <span className="editor-ctx__label">{t("contextMenu.imageFromMcp")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EditorContextMenu;
