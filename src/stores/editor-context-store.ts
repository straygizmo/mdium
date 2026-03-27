import { create } from "zustand";

interface EditorContextState {
  filePath: string | null;
  content: string;
  cursorLine: number;
  cursorColumn: number;
  selectionStart: number;
  selectionEnd: number;
  selectedText: string;

  updateCursor: (
    cursorLine: number,
    cursorColumn: number,
    selectionStart: number,
    selectionEnd: number,
    selectedText: string
  ) => void;
  updateContext: (filePath: string | null, content: string) => void;
}

export const useEditorContextStore = create<EditorContextState>()((set) => ({
  filePath: null,
  content: "",
  cursorLine: 1,
  cursorColumn: 1,
  selectionStart: 0,
  selectionEnd: 0,
  selectedText: "",

  updateCursor: (cursorLine, cursorColumn, selectionStart, selectionEnd, selectedText) =>
    set({ cursorLine, cursorColumn, selectionStart, selectionEnd, selectedText }),

  updateContext: (filePath, content) =>
    set({ filePath, content }),
}));
