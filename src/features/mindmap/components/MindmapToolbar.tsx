import { type FC } from "react";
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
  { id: "right", label: "右展開" },
  { id: "mind", label: "左右展開" },
  { id: "bottom", label: "下展開" },
  { id: "filetree", label: "ファイルツリー" },
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
  return (
    <div className="mindmap-toolbar">
      {readOnly && (
        <span className="mm-tb-readonly" title="XMindファイルは読み取り専用です">読み取り専用</span>
      )}
      {/* Undo / Redo */}
      {!readOnly && (
        <>
          <button className="mm-tb-btn" onClick={onUndo} disabled={!canUndo} title="元に戻す (Ctrl+Z)">
            ↩ 戻す
          </button>
          <button className="mm-tb-btn" onClick={onRedo} disabled={!canRedo} title="やり直し (Ctrl+Y)">
            ↪ やり直し
          </button>
          <span className="mm-tb-sep" />
        </>
      )}


      {/* Theme */}
      <span className="mm-tb-label">テーマ:</span>
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
      <span className="mm-tb-label">レイアウト:</span>
      <select
        className="mm-tb-select"
        value={currentLayout}
        onChange={(e) => onChangeLayout(e.target.value)}
      >
        {LAYOUTS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export default MindmapToolbar;
