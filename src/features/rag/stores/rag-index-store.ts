import { create } from "zustand";
import type { RagIndexState, RagJobInfo } from "@/shared/types/rag-bridge";

export interface BuildProgress {
  phase: "scanning" | "preparing" | "embedding" | "saving";
  current: number;
  total: number;
  currentFile: string;
}

export interface RagIndexStoreState {
  folder: string | null;
  state: "unknown" | RagIndexState;
  totalChunks: number;
  totalFiles: number;
  progress: BuildProgress | null;
  error: string | null;
  job: RagJobInfo | null;
  patch(p: Partial<Omit<RagIndexStoreState, "patch" | "resetFor">>): void;
  resetFor(folder: string | null): void;
}

export const useRagIndexStore = create<RagIndexStoreState>((set) => ({
  folder: null,
  state: "unknown",
  totalChunks: 0,
  totalFiles: 0,
  progress: null,
  error: null,
  job: null,
  patch: (p) => set(p),
  // Switching folders clears per-folder state; a running job is kept so its
  // completion stays observable.
  resetFor: (folder) =>
    set({ folder, state: "unknown", totalChunks: 0, totalFiles: 0, progress: null, error: null }),
}));
