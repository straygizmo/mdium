import { type FC } from "react";
import { useTranslation } from "react-i18next";
import "./MindmapToolbar.css";

const THEMES = [
  { id: "fresh-blue", label: "Fresh Blue" },
  { id: "fresh-green", label: "Fresh Green" },
  { id: "fresh-red", label: "Fresh Red" },
  { id: "fresh-purple", label: "Fresh Purple" },
  { id: "fresh-pink", label: "Fresh Pink" },
  { id: "fresh-soil", label: "Fresh Soil" },
  { id: "snow", label: "Snow" },
  { id: "fish", label: "Fish" },
  { id: "wire", label: "Wire" },
];

const LAYOUTS = [
  { id: "right", labelKey: "mindmap.layoutRight" },
  { id: "mind", labelKey: "mindmap.layoutMind" },
  { id: "bottom", labelKey: "mindmap.layoutBottom" },
  { id: "filetree", labelKey: "mindmap.layoutFiletree" },
];

interface Props {
  currentTheme: string;
  currentLayout: string;
  canUndo: boolean;
  canRedo: boolean;
  readOnly?: boolean;
  onChangeTheme: (theme: string) => void;
  onChangeLayout: (layout: string) => void;
  onUndo: () => void;
  onRedo: () => void;
}

const MindmapToolbar: FC<Props> = ({
  currentTheme,
  currentLayout,
  canUndo,
  canRedo,
  readOnly,
  onChangeTheme,
  onChangeLayout,
  onUndo,
  onRedo,
}) => {
  const { t } = useTranslation("editor");
  return (
    <div className="mindmap-toolbar">
      {readOnly && (
        <span className="mm-tb-readonly" title={t("mindmap.xmindReadOnly")}>{t("mindmap.readOnly")}</span>
      )}
      {/* Undo / Redo */}
      {!readOnly && (
        <>
          <button className="mm-tb-btn" onClick={onUndo} disabled={!canUndo} title={t("common:undo") + " (Ctrl+Z)"}>
            ↩ {t("common:undo")}
          </button>
          <button className="mm-tb-btn" onClick={onRedo} disabled={!canRedo} title={t("common:redo") + " (Ctrl+Y)"}>
            ↪ {t("common:redo")}
          </button>
          <span className="mm-tb-sep" />
        </>
      )}


      {/* Theme */}
      <span className="mm-tb-label">{t("mindmap.theme")}</span>
      <select
        className="mm-tb-select"
        value={currentTheme}
        onChange={(e) => onChangeTheme(e.target.value)}
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>

      {/* Layout */}
      <span className="mm-tb-label">{t("mindmap.layout")}</span>
      <select
        className="mm-tb-select"
        value={currentLayout}
        onChange={(e) => onChangeLayout(e.target.value)}
      >
        {LAYOUTS.map((l) => (
          <option key={l.id} value={l.id}>
            {t(l.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default MindmapToolbar;
