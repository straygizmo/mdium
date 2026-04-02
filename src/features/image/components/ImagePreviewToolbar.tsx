import type { FC } from "react";
import { useTranslation } from "react-i18next";
import type { ImageTool } from "../hooks/useImageCanvas";
import { FONT_FAMILIES, FONT_SIZES } from "../hooks/useImageCanvas";
import "./ImagePreviewToolbar.css";

interface Props {
  activeTool: ImageTool;
  onToolChange: (tool: ImageTool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onOcr: () => void;
  ocrLoading: boolean;
  strokeColor: string;
  onStrokeColorChange: (color: string) => void;
  fillColor: string;
  onFillColorChange: (color: string) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  fontFamily: string;
  onFontFamilyChange: (family: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
  isSvg?: boolean;
}

const TOOL_IDS: ImageTool[] = [
  "select", "text", "rect", "circle", "arrow", "line", "pen", "ocr",
];

const PRESET_COLORS = [
  "#ff0000", "#ff6600", "#ffcc00", "#00cc00", "#0066ff",
  "#9933ff", "#ff00ff", "#000000", "#666666", "#ffffff",
];

const ImagePreviewToolbar: FC<Props> = ({
  activeTool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  zoomLevel,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onOcr: _onOcr,
  ocrLoading: _ocrLoading,
  strokeColor,
  onStrokeColorChange,
  fillColor,
  onFillColorChange,
  fontSize,
  onFontSizeChange,
  fontFamily,
  onFontFamilyChange,
  strokeWidth,
  onStrokeWidthChange,
  isSvg,
}) => {
  const { t } = useTranslation("imageEditor");

  const DRAWING_TOOLS: ImageTool[] = ["text", "rect", "circle", "arrow", "line", "pen"];
  const visibleTools = isSvg ? TOOL_IDS.filter((id) => !DRAWING_TOOLS.includes(id)) : TOOL_IDS;

  const showTextOptions = !isSvg && activeTool === "text";
  const showShapeOptions = !isSvg && ["rect", "circle"].includes(activeTool);
  const showStrokeOptions = !isSvg && ["rect", "circle", "arrow", "line", "pen", "text"].includes(activeTool);

  return (
    <div className="image-preview-toolbar">
      {visibleTools.map((id) => {
        const label = t(`tools.${id}`);
        return (
          <button
            key={id}
            className={`im-tb-btn${activeTool === id ? " im-tb-btn--active" : ""}`}
            onClick={() => onToolChange(id)}
            title={label}
          >
            {label}
          </button>
        );
      })}

      <span className="im-tb-sep" />

      {showStrokeOptions && (
        <>
          <label className="im-tb-color-label" title={t("strokeColor")}>
            <span className="im-tb-color-swatch" style={{ background: strokeColor }} />
            <input
              type="color"
              className="im-tb-color-input"
              value={strokeColor === "transparent" ? "#000000" : strokeColor}
              onChange={(e) => onStrokeColorChange(e.target.value)}
            />
            {t("color")}
          </label>
          <select
            className="im-tb-select"
            value={strokeWidth}
            onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
            title={t("strokeWidth")}
          >
            {[1, 2, 3, 4, 5, 6, 8, 10].map((w) => (
              <option key={w} value={w}>{w}px</option>
            ))}
          </select>
          <div className="im-tb-preset-colors">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className={`im-tb-preset-swatch${strokeColor === c ? " im-tb-preset-swatch--active" : ""}`}
                style={{ background: c }}
                onClick={() => onStrokeColorChange(c)}
                title={c}
              />
            ))}
          </div>
          <span className="im-tb-sep" />
        </>
      )}

      {showShapeOptions && (
        <>
          <label className="im-tb-color-label" title={t("fill")}>
            <span
              className="im-tb-color-swatch im-tb-color-swatch--fill"
              style={{ background: fillColor === "transparent" ? "transparent" : fillColor }}
            />
            <input
              type="color"
              className="im-tb-color-input"
              value={fillColor === "transparent" ? "#ffffff" : fillColor}
              onChange={(e) => onFillColorChange(e.target.value)}
            />
            {t("fillLabel")}
          </label>
          <button
            className={`im-tb-btn im-tb-btn--small${fillColor === "transparent" ? " im-tb-btn--active" : ""}`}
            onClick={() => onFillColorChange("transparent")}
            title={t("noFillTitle")}
          >
            {t("noFill")}
          </button>
          <span className="im-tb-sep" />
        </>
      )}

      {showTextOptions && (
        <>
          <select
            className="im-tb-select"
            value={fontFamily}
            onChange={(e) => onFontFamilyChange(e.target.value)}
            title={t("font")}
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <select
            className="im-tb-select"
            value={fontSize}
            onChange={(e) => onFontSizeChange(Number(e.target.value))}
            title={t("fontSize")}
          >
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>{s}px</option>
            ))}
          </select>
          <span className="im-tb-sep" />
        </>
      )}

      <button className="im-tb-btn" onClick={onZoomOut} title={t("zoomOut")}>
        -
      </button>
      <span className="im-tb-label" onClick={onResetZoom} style={{ cursor: "pointer" }} title={t("zoomReset")}>
        {Math.round(zoomLevel * 100)}%
      </span>
      <button className="im-tb-btn" onClick={onZoomIn} title={t("zoomIn")}>
        +
      </button>

      {!isSvg && (
        <>
          <span className="im-tb-sep" />

          <button className="im-tb-btn" onClick={onUndo} disabled={!canUndo} title={t("undo")}>
            {t("undoLabel")}
          </button>
          <button className="im-tb-btn" onClick={onRedo} disabled={!canRedo} title={t("redo")}>
            {t("redoLabel")}
          </button>
        </>
      )}

    </div>
  );
};

export { ImagePreviewToolbar };
