import { create } from "zustand";

interface FlowViewState {
  /** Selected flow file (project-relative path) per open folder. */
  selected: Record<string, string>;
  setSelected: (folder: string, path: string | null) => void;
}

/** UI state shared by the flow list (left panel) and the flow workspace. */
export const useFlowViewStore = create<FlowViewState>()((set) => ({
  selected: {},
  setSelected: (folder, path) =>
    set((state) => {
      const selected = { ...state.selected };
      if (path === null) delete selected[folder];
      else selected[folder] = path;
      return { selected };
    }),
}));
