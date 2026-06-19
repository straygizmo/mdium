import { useCallback, useEffect, useRef, useState } from "react";
import * as fabric from "fabric";
import { computeFitZoom } from "../lib/image-transform";

export type ImageTool = "select" | "text" | "rect" | "circle" | "arrow" | "line" | "pen" | "ocr";

export const FONT_FAMILIES = [
  "sans-serif",
  "serif",
  "monospace",
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Courier New",
  "Georgia",
  "MS Gothic",
  "MS Mincho",
  "Meiryo",
];

export const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64];

const MAX_UNDO = 50;

// A snapshot captures objects+background (via toJSON) and the natural size,
// so crop/resize (which change dimensions) can be fully undone.
type CanvasSnapshot = { json: string; w: number; h: number };

interface UseImageCanvasOptions {
  onCanvasModified?: () => void;
}

export function useImageCanvas(options?: UseImageCanvasOptions) {
  const canvasRef = useRef<fabric.Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeTool, setActiveTool] = useState<ImageTool>("select");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [strokeColor, setStrokeColor] = useState("#ff0000");
  const [fillColor, setFillColor] = useState("transparent");
  const [fontSize, setFontSize] = useState(20);
  const [fontFamily, setFontFamily] = useState("sans-serif");
  const [strokeWidth, setStrokeWidth] = useState(2);

  const undoStack = useRef<CanvasSnapshot[]>([]);
  const redoStack = useRef<CanvasSnapshot[]>([]);
  const isRestoring = useRef(false);
  const drawingObj = useRef<fabric.FabricObject | null>(null);
  const drawOrigin = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const ocrRect = useRef<fabric.Rect | null>(null);
  const onOcrRegionRef = useRef<((region: { left: number; top: number; width: number; height: number }) => void) | null>(null);
  // Scene coordinate space equals the original image's pixel size.
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);

  const onCanvasModifiedRef = useRef(options?.onCanvasModified);
  onCanvasModifiedRef.current = options?.onCanvasModified;

  const makeSnapshot = useCallback((): CanvasSnapshot | null => {
    const c = canvasRef.current;
    const nat = naturalSizeRef.current;
    if (!c || !nat) return null;
    return { json: JSON.stringify(c.toJSON()), w: nat.w, h: nat.h };
  }, []);

  const pushUndo = useCallback(() => {
    if (isRestoring.current) return;
    const snap = makeSnapshot();
    if (!snap) return;
    undoStack.current.push(snap);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, [makeSnapshot]);

  const notifyModified = useCallback(() => {
    onCanvasModifiedRef.current?.();
  }, []);

  const zoomIn = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const newZoom = Math.min(zoomLevel * 1.2, 10);
    const center = c.getCenterPoint();
    c.zoomToPoint(center, newZoom);
    setZoomLevel(newZoom);
  }, [zoomLevel]);

  const zoomOut = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const newZoom = Math.max(zoomLevel / 1.2, 0.1);
    const center = c.getCenterPoint();
    c.zoomToPoint(center, newZoom);
    setZoomLevel(newZoom);
  }, [zoomLevel]);

  // Size the canvas ELEMENT to the fit-display size and apply a viewport zoom
  // that maps the natural-size scene into that element. Scene coords stay at
  // real pixels; only the display is scaled.
  const fitToContainer = useCallback(() => {
    const c = canvasRef.current;
    const container = containerRef.current;
    const nat = naturalSizeRef.current;
    if (!c || !container || !nat) return;
    const zoom = computeFitZoom(container.clientWidth, container.clientHeight, nat.w, nat.h);
    c.setDimensions({ width: Math.round(nat.w * zoom), height: Math.round(nat.h * zoom) });
    c.setViewportTransform([zoom, 0, 0, zoom, 0, 0]);
    setZoomLevel(zoom);
  }, []);

  const restoreSnapshot = useCallback(async (snap: CanvasSnapshot) => {
    const c = canvasRef.current;
    if (!c) return;
    isRestoring.current = true;
    await c.loadFromJSON(snap.json);
    naturalSizeRef.current = { w: snap.w, h: snap.h };
    // Ensure the restored background is non-interactive.
    const bg = c.backgroundImage;
    if (bg) bg.set({ selectable: false, evented: false });
    fitToContainer();
    c.renderAll();
    isRestoring.current = false;
    notifyModified();
  }, [fitToContainer, notifyModified]);

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const current = makeSnapshot();
    if (current) redoStack.current.push(current);
    const prev = undoStack.current.pop()!;
    restoreSnapshot(prev).then(() => {
      setCanUndo(undoStack.current.length > 0);
      setCanRedo(true);
    });
  }, [makeSnapshot, restoreSnapshot]);

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const current = makeSnapshot();
    if (current) undoStack.current.push(current);
    const next = redoStack.current.pop()!;
    restoreSnapshot(next).then(() => {
      setCanUndo(true);
      setCanRedo(redoStack.current.length > 0);
    });
  }, [makeSnapshot, restoreSnapshot]);

  const refit = useCallback(() => { fitToContainer(); }, [fitToContainer]);

  const getNaturalSize = useCallback(() => naturalSizeRef.current, []);

  const resetZoom = useCallback(() => {
    fitToContainer();
  }, [fitToContainer]);

  const getCanvasDataUrl = useCallback((region?: { left: number; top: number; width: number; height: number }) => {
    const c = canvasRef.current;
    const nat = naturalSizeRef.current;
    if (!c || !nat) return null;

    // Region is in scene (real-pixel) coordinates; background is scale 1.
    if (region) {
      const bgImg = c.backgroundImage;
      if (bgImg && bgImg instanceof fabric.FabricImage) {
        const imgEl = bgImg.getElement() as HTMLImageElement;
        const tmp = document.createElement("canvas");
        tmp.width = Math.round(region.width);
        tmp.height = Math.round(region.height);
        const ctx = tmp.getContext("2d")!;
        ctx.drawImage(
          imgEl,
          region.left, region.top, region.width, region.height,
          0, 0, region.width, region.height,
        );
        return tmp.toDataURL("image/png");
      }
    }

    // Full export at natural resolution: temporarily set element to natural size
    // with an identity viewport, export, then restore the fit display.
    const vpt = c.viewportTransform;
    const dims = { width: c.getWidth(), height: c.getHeight() };
    c.setViewportTransform([1, 0, 0, 1, 0, 0]);
    c.setDimensions({ width: nat.w, height: nat.h });
    const url = c.toDataURL({ format: "png", multiplier: 1 });
    c.setDimensions(dims);
    c.setViewportTransform(vpt);
    return url;
  }, []);

  const saveImage = useCallback(async () => {
    const dataUrl = getCanvasDataUrl();
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.download = "annotated-image.png";
    link.href = dataUrl;
    link.click();
  }, [getCanvasDataUrl]);

  const initCanvas = useCallback((canvasEl: HTMLCanvasElement, container: HTMLDivElement) => {
    if (canvasRef.current) {
      canvasRef.current.dispose();
    }
    containerRef.current = container;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const c = new fabric.Canvas(canvasEl, {
      width: w,
      height: h,
      backgroundColor: "#f0f0f0",
      selection: true,
    });
    canvasRef.current = c;
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setZoomLevel(1);

    // Ctrl+wheel zoom (must register inside initCanvas, otherwise canvasRef is unset and registration is missed)
    c.on("mouse:wheel", (opt: fabric.TPointerEventInfo<WheelEvent>) => {
      const e = opt.e;
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY;
      let zoom = c.getZoom();
      zoom *= 0.999 ** delta;
      zoom = Math.max(0.1, Math.min(10, zoom));
      const point = c.getScenePoint(e);
      c.zoomToPoint(point, zoom);
      setZoomLevel(zoom);
    });

    return c;
  }, []);

  const serializeCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return null;
    // Exclude OCR selection rectangle from serialization
    const ocr = ocrRect.current;
    if (ocr) c.remove(ocr);
    // Exclude background image from serialization (it will be set separately on restore)
    const bg = c.backgroundImage;
    c.backgroundImage = undefined;
    const json = JSON.stringify(c.toJSON());
    c.backgroundImage = bg;
    if (ocr) c.add(ocr);
    return json;
  }, []);

  const loadBackgroundImage = useCallback(async (url: string, savedCanvasJson?: string) => {
    const c = canvasRef.current;
    if (!c || !containerRef.current) return;

    c.clear();
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);

    const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
    naturalSizeRef.current = { w: img.width!, h: img.height! };

    // Background occupies the scene at real-pixel scale.
    img.set({
      scaleX: 1, scaleY: 1, left: 0, top: 0,
      originX: "left", originY: "top",
      selectable: false, evented: false,
    });

    if (savedCanvasJson) {
      // Objects are stored in scene (real-pixel) coordinates; background excluded.
      try {
        await c.loadFromJSON(savedCanvasJson);
      } catch (e) {
        console.error("Failed to restore canvas state:", e);
      }
    }

    c.backgroundImage = img;
    fitToContainer();
    c.renderAll();
  }, [fitToContainer]);

  const setOcrRegionCallback = useCallback((cb: ((region: { left: number; top: number; width: number; height: number }) => void) | null) => {
    onOcrRegionRef.current = cb;
  }, []);

  const clearOcrRect = useCallback(() => {
    const c = canvasRef.current;
    if (c && ocrRect.current) {
      c.remove(ocrRect.current);
      ocrRect.current = null;
      c.renderAll();
    }
  }, []);

  const dispose = useCallback(() => {
    if (canvasRef.current) {
      canvasRef.current.dispose();
      canvasRef.current = null;
    }
  }, []);

  // Tool switching effect
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    c.isDrawingMode = false;
    c.selection = true;
    c.defaultCursor = "default";
    c.forEachObject((o) => { o.selectable = true; o.evented = true; });

    if (activeTool === "pen") {
      c.isDrawingMode = true;
      c.freeDrawingBrush = new fabric.PencilBrush(c);
      c.freeDrawingBrush.width = strokeWidth;
      c.freeDrawingBrush.color = strokeColor;
    } else if (activeTool !== "select") {
      c.selection = false;
      c.defaultCursor = "crosshair";
      c.forEachObject((o) => { o.selectable = false; o.evented = false; });
    }

    if (ocrRect.current) {
      c.remove(ocrRect.current);
      ocrRect.current = null;
      c.renderAll();
    }

    const handleMouseDown = (opt: fabric.TPointerEventInfo) => {
      if (activeTool === "select" || activeTool === "pen") return;
      const pointer = c.getScenePoint(opt.e);
      drawOrigin.current = { x: pointer.x, y: pointer.y };

      if (activeTool === "ocr") {
        if (ocrRect.current) {
          c.remove(ocrRect.current);
          ocrRect.current = null;
          c.renderAll();
        }
        const rect = new fabric.Rect({
          left: pointer.x, top: pointer.y, width: 0, height: 0,
          originX: "left", originY: "top",
          fill: "rgba(0, 120, 255, 0.15)", stroke: "#0078ff", strokeWidth: 2,
          strokeDashArray: [6, 3],
          selectable: false, evented: false,
        });
        c.add(rect);
        ocrRect.current = rect;
        drawingObj.current = rect;
        return;
      }

      if (activeTool === "text") {
        pushUndo();
        const text = new fabric.IText("Text", {
          left: pointer.x,
          top: pointer.y,
          fontSize,
          fill: strokeColor,
          fontFamily,
        });
        c.add(text);
        c.setActiveObject(text);
        text.enterEditing();
        setActiveTool("select");
        notifyModified();
        return;
      }

      let obj: fabric.FabricObject;
      if (activeTool === "rect") {
        obj = new fabric.Rect({
          left: pointer.x, top: pointer.y, width: 0, height: 0,
          originX: "left", originY: "top",
          fill: fillColor, stroke: strokeColor, strokeWidth,
        });
      } else if (activeTool === "circle") {
        obj = new fabric.Ellipse({
          left: pointer.x, top: pointer.y, rx: 0, ry: 0,
          originX: "left", originY: "top",
          fill: fillColor, stroke: strokeColor, strokeWidth,
        });
      } else if (activeTool === "line") {
        obj = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
          stroke: strokeColor, strokeWidth,
        });
      } else if (activeTool === "arrow") {
        obj = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
          stroke: strokeColor, strokeWidth,
        });
      } else {
        return;
      }
      pushUndo();
      c.add(obj);
      drawingObj.current = obj;
    };

    const handleMouseMove = (opt: fabric.TPointerEventInfo) => {
      if (!drawingObj.current) return;
      const pointer = c.getScenePoint(opt.e);
      const ox = drawOrigin.current.x;
      const oy = drawOrigin.current.y;
      const obj = drawingObj.current;

      if (obj instanceof fabric.Rect) {
        const left = Math.min(ox, pointer.x);
        const top = Math.min(oy, pointer.y);
        obj.set({ left, top, width: Math.abs(pointer.x - ox), height: Math.abs(pointer.y - oy) });
      } else if (obj instanceof fabric.Ellipse) {
        const left = Math.min(ox, pointer.x);
        const top = Math.min(oy, pointer.y);
        obj.set({ left, top, rx: Math.abs(pointer.x - ox) / 2, ry: Math.abs(pointer.y - oy) / 2 });
      } else if (obj instanceof fabric.Line) {
        obj.set({ x2: pointer.x, y2: pointer.y });
      }
      c.renderAll();
    };

    const handleMouseUp = () => {
      if (!drawingObj.current) return;
      const obj = drawingObj.current;

      if (activeTool === "ocr" && obj instanceof fabric.Rect) {
        const w = obj.width ?? 0;
        const h = obj.height ?? 0;
        if (w > 5 && h > 5 && onOcrRegionRef.current) {
          onOcrRegionRef.current({ left: obj.left!, top: obj.top!, width: w, height: h });
        }
        drawingObj.current = null;
        return;
      }

      if (activeTool === "arrow" && obj instanceof fabric.Line) {
        const x1 = obj.x1!, y1 = obj.y1!, x2 = obj.x2!, y2 = obj.y2!;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 12;
        const points = [
          { x: x2, y: y2 },
          { x: x2 - headLen * Math.cos(angle - Math.PI / 6), y: y2 - headLen * Math.sin(angle - Math.PI / 6) },
          { x: x2 - headLen * Math.cos(angle + Math.PI / 6), y: y2 - headLen * Math.sin(angle + Math.PI / 6) },
        ];
        const head = new fabric.Polygon(points.map(p => new fabric.Point(p.x, p.y)), {
          fill: strokeColor, stroke: strokeColor, strokeWidth: 1,
          selectable: false, evented: false,
        });
        c.add(head);
      }

      drawingObj.current!.setCoords();
      drawingObj.current = null;
      c.renderAll();
      notifyModified();
    };

    const handlePathCreated = () => { pushUndo(); notifyModified(); };

    c.on("mouse:down", handleMouseDown);
    c.on("mouse:move", handleMouseMove);
    c.on("mouse:up", handleMouseUp);
    c.on("path:created", handlePathCreated);

    return () => {
      c.off("mouse:down", handleMouseDown);
      c.off("mouse:move", handleMouseMove);
      c.off("mouse:up", handleMouseUp);
      c.off("path:created", handlePathCreated);
    };
  }, [activeTool, pushUndo, notifyModified, strokeColor, fillColor, fontSize, fontFamily, strokeWidth]);

  // Delete selected objects
  const deleteSelected = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const active = c.getActiveObjects();
    if (active.length === 0) return;
    pushUndo();
    active.forEach((obj) => c.remove(obj));
    c.discardActiveObject();
    c.renderAll();
    notifyModified();
  }, [pushUndo, notifyModified]);


  return {
    canvasRef,
    containerRef,
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
    refit,
    getNaturalSize,
    saveImage,
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
  };
}
