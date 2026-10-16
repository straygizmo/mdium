import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Case- and separator-insensitive key so the same workbook maps to one chat. */
export function workbookKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

interface MacroChatState {
  /** opencode session id bound to each workbook (keyed by workbookKey). */
  sessionByWorkbook: Record<string, string>;
  /** Width of the sheet preview pane in percent. */
  splitRatio: number;
  /** Latest check_workbook_lock result per workbook (not persisted). */
  lockedByWorkbook: Record<string, boolean>;
  getSession: (path: string) => string | null;
  setSession: (path: string, sessionId: string | null) => void;
  setSplitRatio: (ratio: number) => void;
  setLocked: (path: string, locked: boolean) => void;
  isLocked: (path: string) => boolean;
}

export const useMacroChatStore = create<MacroChatState>()(
  persist(
    (set, get) => ({
      sessionByWorkbook: {},
      splitRatio: 50,
      lockedByWorkbook: {},
      getSession: (path) => get().sessionByWorkbook[workbookKey(path)] ?? null,
      setSession: (path, sessionId) =>
        set((s) => {
          const next = { ...s.sessionByWorkbook };
          if (sessionId) next[workbookKey(path)] = sessionId;
          else delete next[workbookKey(path)];
          return { sessionByWorkbook: next };
        }),
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(20, Math.min(80, ratio)) }),
      setLocked: (path, locked) =>
        set((s) => ({ lockedByWorkbook: { ...s.lockedByWorkbook, [workbookKey(path)]: locked } })),
      isLocked: (path) => get().lockedByWorkbook[workbookKey(path)] ?? false,
    }),
    {
      name: "mdium-macro-chat",
      partialize: (s) => ({ sessionByWorkbook: s.sessionByWorkbook, splitRatio: s.splitRatio }),
    },
  ),
);
