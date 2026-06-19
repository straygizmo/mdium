import { useState, useCallback, type FC } from "react";
import { useTranslation } from "react-i18next";
import {
  validateResizeInput,
  followAspect,
  presetDimensions,
  RESIZE_MIN,
  RESIZE_MAX,
} from "../lib/image-transform";
import "./ResizeDialog.css";

interface Props {
  initialWidth: number;
  initialHeight: number;
  onApply: (width: number, height: number) => void;
  onCancel: () => void;
}

const PRESETS = [25, 50, 75, 200];

export const ResizeDialog: FC<Props> = ({ initialWidth, initialHeight, onApply, onCancel }) => {
  const { t } = useTranslation("imageEditor");
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [keepAspect, setKeepAspect] = useState(true);

  const onWidthChange = useCallback((v: number) => {
    if (keepAspect) {
      const r = followAspect("w", v, initialWidth, initialHeight);
      setWidth(r.width);
      setHeight(r.height);
    } else {
      setWidth(v);
    }
  }, [keepAspect, initialWidth, initialHeight]);

  const onHeightChange = useCallback((v: number) => {
    if (keepAspect) {
      const r = followAspect("h", v, initialWidth, initialHeight);
      setWidth(r.width);
      setHeight(r.height);
    } else {
      setHeight(v);
    }
  }, [keepAspect, initialWidth, initialHeight]);

  const applyPreset = useCallback((percent: number) => {
    const r = presetDimensions(initialWidth, initialHeight, percent);
    setWidth(r.width);
    setHeight(r.height);
  }, [initialWidth, initialHeight]);

  const valid = validateResizeInput(width, height);

  return (
    <div className="app-dialog__overlay" onMouseDown={onCancel}>
      <div className="app-dialog resize-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-dialog__title">{t("resize.title")}</div>
        <div className="resize-dialog__current">
          {t("resize.current", { width: initialWidth, height: initialHeight })}
        </div>
        <div className="resize-dialog__row">
          <label>
            {t("resize.width")}
            <input
              type="number" min={RESIZE_MIN} max={RESIZE_MAX} value={width}
              onChange={(e) => onWidthChange(Number(e.target.value))}
            />
          </label>
          <label>
            {t("resize.height")}
            <input
              type="number" min={RESIZE_MIN} max={RESIZE_MAX} value={height}
              onChange={(e) => onHeightChange(Number(e.target.value))}
            />
          </label>
        </div>
        <label className="resize-dialog__aspect">
          <input type="checkbox" checked={keepAspect} onChange={(e) => setKeepAspect(e.target.checked)} />
          {t("resize.keepAspect")}
        </label>
        <div className="resize-dialog__presets">
          <span>{t("resize.preset")}</span>
          {PRESETS.map((p) => (
            <button key={p} className="app-dialog__btn" onClick={() => applyPreset(p)}>{p}%</button>
          ))}
        </div>
        {!valid && <div className="resize-dialog__error">{t("resize.invalid")}</div>}
        <div className="app-dialog__actions">
          <button className="app-dialog__btn app-dialog__btn--primary" disabled={!valid} onClick={() => onApply(width, height)}>
            {t("resize.ok")}
          </button>
          <button className="app-dialog__btn" onClick={onCancel}>{t("resize.cancel")}</button>
        </div>
      </div>
    </div>
  );
};
