import { useCallback, useEffect, useRef, useState, useImperativeHandle, forwardRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Tesseract from "tesseract.js";
import { useImageCanvas } from "../hooks/useImageCanvas";
import { ImagePreviewToolbar } from "./ImagePreviewToolbar";
import "./ImageCanvas.css";

export interface ImageCanvasHandle {
  getCanvasDataUrl: (region?: { left: number; top: number; width: number; height: number }) => string | null;
  serializeCanvas: () => string | null;
}

interface ImageCanvasProps {
  imageSrc: string;
  canvasJson?: string;
  onCanvasModified?: () => void;
}

export const ImageCanvas = forwardRef<ImageCanvasHandle, ImageCanvasProps>(function ImageCanvas(
  { imageSrc, canvasJson, onCanvasModified },
  ref
) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const {
    activeTool,
    setActiveTool,
    canUndo,
    canRedo,
    undo,
    redo,
    zoomLevel,
    zoomIn,
    zoomOut,
    resetZoom,
    getCanvasDataUrl,
    serializeCanvas,
    initCanvas,
    loadBackgroundImage,
    dispose,
    setOcrRegionCallback,
    clearOcrRect,
    deleteSelected,
    strokeColor,
    setStrokeColor,
    fillColor,
    setFillColor,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    strokeWidth,
    setStrokeWidth,
  } = useImageCanvas({ onCanvasModified });

  const { t, i18n } = useTranslation("imageEditor");
  const ocrLang = useMemo(() => (i18n.language === "ja" ? "jpn+eng" : "eng"), [i18n.language]);

  useImperativeHandle(ref, () => ({
    getCanvasDataUrl,
    serializeCanvas,
  }), [getCanvasDataUrl, serializeCanvas]);

  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);
  const initialLoadDone = useRef(false);

  // Init canvas on mount
  useEffect(() => {
    const canvasEl = canvasElRef.current;
    const container = containerElRef.current;
    if (!canvasEl || !container) return;
    initCanvas(canvasEl, container);
    return () => { dispose(); };
  }, []);

  // Load background image when URL changes
  useEffect(() => {
    if (imageSrc && imageSrc !== prevUrlRef.current) {
      prevUrlRef.current = imageSrc;
      initialLoadDone.current = false;
      loadBackgroundImage(imageSrc, canvasJson).then(() => {
        initialLoadDone.current = true;
      });
    }
    return () => {
      prevUrlRef.current = null;
    };
  }, [imageSrc, loadBackgroundImage]);

  // Resize observer — preserve canvas objects on resize
  useEffect(() => {
    const container = containerElRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (imageSrc && initialLoadDone.current) {
        const currentJson = serializeCanvas();
        loadBackgroundImage(imageSrc, currentJson ?? undefined);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [imageSrc, loadBackgroundImage, serializeCanvas]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey && e.key === "y") || (e.ctrlKey && e.shiftKey && e.key === "z")) {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
        deleteSelected();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [undo, redo, deleteSelected]);

  const runOcr = useCallback(async (dataUrl: string) => {
    setOcrLoading(true);
    try {
      const result = await Tesseract.recognize(dataUrl, ocrLang);
      const text = result.data.text.trim();
      setOcrResult(text || t("ocrNoText"));
    } catch (err) {
      console.error("OCR error:", err);
      setOcrResult(t("ocrError"));
    } finally {
      setOcrLoading(false);
    }
  }, [ocrLang, t]);

  // Register OCR region callback
  useEffect(() => {
    setOcrRegionCallback((region) => {
      const dataUrl = getCanvasDataUrl(region);
      if (dataUrl) runOcr(dataUrl);
    });
    return () => setOcrRegionCallback(null);
  }, [setOcrRegionCallback, getCanvasDataUrl, runOcr]);

  const handleOcr = useCallback(() => {
    setActiveTool("ocr");
  }, [setActiveTool]);

  const handleCopyOcr = useCallback(async () => {
    if (ocrResult) {
      await navigator.clipboard.writeText(ocrResult);
    }
  }, [ocrResult]);

  const handleCloseOcr = useCallback(() => {
    setOcrResult(null);
    clearOcrRect();
  }, [clearOcrRect]);

  return (
    <>
      <ImagePreviewToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        zoomLevel={zoomLevel}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        onOcr={handleOcr}
        ocrLoading={ocrLoading}
        strokeColor={strokeColor}
        onStrokeColorChange={setStrokeColor}
        fillColor={fillColor}
        onFillColorChange={setFillColor}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        fontFamily={fontFamily}
        onFontFamilyChange={setFontFamily}
        strokeWidth={strokeWidth}
        onStrokeWidthChange={setStrokeWidth}
      />
      <div className="image-canvas-container" ref={containerElRef}>
        <div className="image-canvas-wrapper">
          <canvas ref={canvasElRef} />
        </div>
      </div>
      {ocrResult !== null && (
        <div className="ocr-result-panel">
          <div className="ocr-result-header">
            <span className="ocr-result-title">{t("ocrResult")}</span>
            <div className="ocr-result-actions">
              <button className="im-tb-btn" onClick={handleCopyOcr} title={t("ocrCopy")}>{t("ocrCopy")}</button>
              <button className="im-tb-btn" onClick={handleCloseOcr} title={t("ocrClose")}>{t("ocrClose")}</button>
            </div>
          </div>
          <textarea
            className="ocr-result-text"
            value={ocrResult}
            onChange={(e) => setOcrResult(e.target.value)}
            readOnly={false}
          />
        </div>
      )}
      {ocrLoading && (
        <div className="ocr-loading-overlay">
          <span>{t("ocrProcessing")}</span>
        </div>
      )}
    </>
  );
});
