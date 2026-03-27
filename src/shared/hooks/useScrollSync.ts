import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/stores/settings-store";

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

    const onEditorInput = () => {
      editorEditingRef.current = true;
      if (editorEditingTimerRef.current) clearTimeout(editorEditingTimerRef.current);
      editorEditingTimerRef.current = setTimeout(() => {
        editorEditingRef.current = false;
      }, 1000);
    };

    const syncFromEditor = () => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      const ratio = editor.scrollTop / Math.max(editor.scrollHeight - editor.clientHeight, 1);
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      requestAnimationFrame(() => { isSyncingRef.current = false; });
    };

    const syncFromPreview = () => {
      if (isSyncingRef.current) return;
      if (preview.dataset.contentUpdating) return;
      if (editorEditingRef.current) return;
      isSyncingRef.current = true;
      const ratio = preview.scrollTop / Math.max(preview.scrollHeight - preview.clientHeight, 1);
      editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
      requestAnimationFrame(() => { isSyncingRef.current = false; });
    };

    editor.addEventListener("input", onEditorInput);
    editor.addEventListener("scroll", syncFromEditor, { passive: true });
    preview.addEventListener("scroll", syncFromPreview, { passive: true });
    return () => {
      editor.removeEventListener("input", onEditorInput);
      editor.removeEventListener("scroll", syncFromEditor);
      preview.removeEventListener("scroll", syncFromPreview);
      if (editorEditingTimerRef.current) clearTimeout(editorEditingTimerRef.current);
    };
  }, [scrollSync, editorVisible, editorRef, previewRef, activeTabId]);
}
