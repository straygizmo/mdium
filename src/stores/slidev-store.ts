import { create } from "zustand";
import type { SlidevSession } from "@/shared/types";

interface SlidevState {
  /** Map from filePath to SlidevSession */
  sessions: Record<string, SlidevSession>;
  setSession: (filePath: string, session: SlidevSession) => void;
  updateSession: (filePath: string, partial: Partial<SlidevSession>) => void;
  removeSession: (filePath: string) => void;
}

export const useSlidevStore = create<SlidevState>()((set) => ({
  sessions: {},
  setSession: (filePath, session) =>
    set((s) => ({ sessions: { ...s.sessions, [filePath]: session } })),
  updateSession: (filePath, partial) =>
    set((s) => {
      const existing = s.sessions[filePath];
      if (!existing) return s;
      return { sessions: { ...s.sessions, [filePath]: { ...existing, ...partial } } };
    }),
  removeSession: (filePath) =>
    set((s) => {
      const { [filePath]: _, ...rest } = s.sessions;
      return { sessions: rest };
    }),
}));
