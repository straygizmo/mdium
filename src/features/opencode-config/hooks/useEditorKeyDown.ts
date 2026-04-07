import { useRef, useCallback } from "react";
import { useInputUndoRedo } from "./useInputUndoRedo";

/**
 * Shared keyboard handler for editor textareas in opencode config sections.
 * Handles Tab (2-space indent), Ctrl+Z (undo), Ctrl+Y (redo), Ctrl+V (paste passthrough).
 */
export function useEditorKeyDown(
  content: string,
  setContent: (v: string) => void
) {
  const { undo, redo } = useInputUndoRedo(content, setContent);
  const contentRef = useRef(content);
  contentRef.current = content;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        e.stopPropagation();
        undo();
        return;
      }
      if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }
      if (e.ctrlKey && e.key === "v") {
        e.stopPropagation();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const c = contentRef.current;
        const newContent = c.substring(0, start) + "  " + c.substring(end);
        setContent(newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    },
    [undo, redo, setContent]
  );

  return handleKeyDown;
}
