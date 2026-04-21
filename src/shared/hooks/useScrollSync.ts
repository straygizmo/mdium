import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/stores/settings-store";

interface Marker {
  line: number;
  top: number;
}

export function useScrollSync(
  editorRef: React.RefObject<HTMLTextAreaElement | null>,
  previewRef: React.RefObject<HTMLDivElement | null>,
  editorVisible: boolean,
  activeTabId: string,
) {
  const scrollSync = useSettingsStore((s) => s.scrollSync);
  const isSyncingRef = useRef(false);
  const editorEditingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorEditingRef = useRef(false);

  useEffect(() => {
    isSyncingRef.current = false;
    if (!scrollSync || !editorVisible) return;
    const editor = editorRef.current;
    const preview = previewRef.current;
    if (!editor || !preview) return;

    let markers: Marker[] = [];
    let lineHeight = 0;
    let rebuildScheduled = false;

    const measureLineHeight = () => {
      const computed = getComputedStyle(editor);
      const lh = parseFloat(computed.lineHeight);
      if (!Number.isNaN(lh) && lh > 0) {
        lineHeight = lh;
        return;
      }
      const fs = parseFloat(computed.fontSize);
      lineHeight = Number.isFinite(fs) && fs > 0 ? fs * 1.4 : 20;
    };

    const rebuildMarkers = () => {
      rebuildScheduled = false;
      const elements = preview.querySelectorAll<HTMLElement>("[data-source-line]");
      if (elements.length === 0) {
        markers = [];
        return;
      }
      const previewTop = preview.getBoundingClientRect().top - preview.scrollTop;
      const result: Marker[] = [];
      let lastLine = -Infinity;
      for (const el of elements) {
        const lineAttr = el.getAttribute("data-source-line");
        if (lineAttr === null) continue;
        const line = Number(lineAttr);
        if (!Number.isFinite(line)) continue;
        if (line <= lastLine) continue; // keep first occurrence for a given line
        const top = el.getBoundingClientRect().top - previewTop;
        result.push({ line, top });
        lastLine = line;
      }
      markers = result;
    };

    const scheduleRebuild = () => {
      if (rebuildScheduled) return;
      rebuildScheduled = true;
      requestAnimationFrame(rebuildMarkers);
    };

    const bracketedByLine = (line: number): [Marker, Marker] | null => {
      if (markers.length === 0) return null;
      if (markers.length === 1) return [markers[0], markers[0]];
      if (line <= markers[0].line) return [markers[0], markers[0]];
      if (line >= markers[markers.length - 1].line) {
        const last = markers[markers.length - 1];
        return [last, last];
      }
      let lo = 0;
      let hi = markers.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (markers[mid].line <= line) lo = mid;
        else hi = mid;
      }
      return [markers[lo], markers[hi]];
    };

    const bracketedByTop = (top: number): [Marker, Marker] | null => {
      if (markers.length === 0) return null;
      if (markers.length === 1) return [markers[0], markers[0]];
      if (top <= markers[0].top) return [markers[0], markers[0]];
      if (top >= markers[markers.length - 1].top) {
        const last = markers[markers.length - 1];
        return [last, last];
      }
      let lo = 0;
      let hi = markers.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (markers[mid].top <= top) lo = mid;
        else hi = mid;
      }
      return [markers[lo], markers[hi]];
    };

    const editorLineToPreviewTop = (line: number): number => {
      const bracket = bracketedByLine(line);
      if (!bracket) return 0;
      const [a, b] = bracket;
      if (a === b) return a.top;
      const t = (line - a.line) / (b.line - a.line);
      return a.top + t * (b.top - a.top);
    };

    const previewTopToEditorLine = (top: number): number => {
      const bracket = bracketedByTop(top);
      if (!bracket) return 0;
      const [a, b] = bracket;
      if (a === b) return a.line;
      const delta = b.top - a.top;
      const t = delta > 0 ? (top - a.top) / delta : 0;
      return a.line + t * (b.line - a.line);
    };

    const onEditorInput = () => {
      editorEditingRef.current = true;
      if (editorEditingTimerRef.current) clearTimeout(editorEditingTimerRef.current);
      editorEditingTimerRef.current = setTimeout(() => {
        editorEditingRef.current = false;
      }, 1000);
    };

    const syncFromEditor = () => {
      if (isSyncingRef.current) return;
      if (markers.length === 0) return;
      if (lineHeight <= 0) measureLineHeight();
      isSyncingRef.current = true;
      const topLine = editor.scrollTop / lineHeight + 1; // 1-indexed
      const target = editorLineToPreviewTop(topLine);
      preview.scrollTop = target;
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    };

    const syncFromPreview = () => {
      if (isSyncingRef.current) return;
      if (preview.dataset.contentUpdating) return;
      if (editorEditingRef.current) return;
      if (markers.length === 0) return;
      if (lineHeight <= 0) measureLineHeight();
      isSyncingRef.current = true;
      const line = previewTopToEditorLine(preview.scrollTop);
      editor.scrollTop = Math.max(0, (line - 1) * lineHeight);
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    };

    measureLineHeight();
    rebuildMarkers();

    const mo = new MutationObserver(scheduleRebuild);
    mo.observe(preview, { childList: true, subtree: true, attributes: false });

    const ro = new ResizeObserver(scheduleRebuild);
    ro.observe(preview);

    // Images shift layout after async load; trigger a rebuild (capture phase to catch descendant loads)
    const onDescendantLoad = () => scheduleRebuild();
    preview.addEventListener("load", onDescendantLoad, true);
    preview.addEventListener("error", onDescendantLoad, true);

    editor.addEventListener("input", onEditorInput);
    editor.addEventListener("scroll", syncFromEditor, { passive: true });
    preview.addEventListener("scroll", syncFromPreview, { passive: true });

    return () => {
      editor.removeEventListener("input", onEditorInput);
      editor.removeEventListener("scroll", syncFromEditor);
      preview.removeEventListener("scroll", syncFromPreview);
      preview.removeEventListener("load", onDescendantLoad, true);
      preview.removeEventListener("error", onDescendantLoad, true);
      mo.disconnect();
      ro.disconnect();
      if (editorEditingTimerRef.current) clearTimeout(editorEditingTimerRef.current);
    };
  }, [scrollSync, editorVisible, editorRef, previewRef, activeTabId]);
}
