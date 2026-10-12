import { create } from "zustand";

/** One step of the drill-down trail: the file shown and the crumb label. */
export interface FlowStackEntry {
  path: string;
  label: string;
}

interface FlowViewState {
  /** Selected flow file (project-relative path) per open folder. */
  selected: Record<string, string>;
  /** Drill-down trail per folder: the root flow first, the shown file last. */
  stack: Record<string, FlowStackEntry[]>;
  /** Selects a file from the list; this starts a new trail. */
  setSelected: (folder: string, path: string | null) => void;
  /** Appends an entry to the trail and selects its file. */
  push: (folder: string, entry: FlowStackEntry) => void;
  /** Drops the entries after `index` and selects that entry's file. */
  popTo: (folder: string, index: number) => void;
  reset: (folder: string) => void;
}

function without<T>(record: Record<string, T>, folder: string): Record<string, T> {
  const next = { ...record };
  delete next[folder];
  return next;
}

/** UI state shared by the flow list (left panel) and the flow workspace. */
export const useFlowViewStore = create<FlowViewState>()((set) => ({
  selected: {},
  stack: {},
  setSelected: (folder, path) =>
    set((state) => {
      const selected = without(state.selected, folder);
      if (path !== null) selected[folder] = path;
      return { selected, stack: without(state.stack, folder) };
    }),
  push: (folder, entry) =>
    set((state) => ({
      stack: { ...state.stack, [folder]: [...(state.stack[folder] ?? []), entry] },
      selected: { ...state.selected, [folder]: entry.path },
    })),
  popTo: (folder, index) =>
    set((state) => {
      const trail = (state.stack[folder] ?? []).slice(0, index + 1);
      const target = trail[index];
      if (!target) return state;
      return { stack: { ...state.stack, [folder]: trail }, selected: { ...state.selected, [folder]: target.path } };
    }),
  reset: (folder) => set((state) => ({ stack: without(state.stack, folder) })),
}));
