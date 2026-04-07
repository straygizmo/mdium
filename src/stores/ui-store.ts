import { create } from "zustand";
import type { OpencodeConfigTab, OpencodeTopTab } from "@/shared/types";

export type LeftPanel = "folder" | "outline" | "rag" | "opencode-config" | "git";
type ViewTab = "preview" | "table" | "pdf-preview" | "docx-preview" | "html-preview" | "slidev-preview" | "video";
type FolderPanelTab = "terminal" | "rag";
type BottomTerminalTab = "terminal" | "claude-code";
export type SearchMode = "search" | "replace";

interface UiState {
  editorVisible: boolean;
  activeViewTab: ViewTab;
  leftPanel: LeftPanel;
  folderPanelTab: FolderPanelTab;
  folderPanelVisible: boolean;
  editorRatio: number;
  folderPanelRatio: number;
  showSearch: boolean;
  searchMode: SearchMode;
  searchText: string;
  currentMatchIndex: number;
  bottomTerminalVisible: boolean;
  bottomTerminalTab: BottomTerminalTab;
  bottomTerminalOpenTabs: BottomTerminalTab[];
  opencodeConfigTab: OpencodeConfigTab;
  opencodeTopTab: OpencodeTopTab;
  isZennMode: boolean;

  toggleEditor: () => void;
  setActiveViewTab: (tab: ViewTab) => void;
  setLeftPanel: (panel: LeftPanel) => void;
  setFolderPanelTab: (tab: FolderPanelTab) => void;
  setFolderPanelVisible: (visible: boolean) => void;
  setEditorRatio: (ratio: number) => void;
  setFolderPanelRatio: (ratio: number) => void;
  setEditorVisible: (visible: boolean) => void;
  setShowSearch: (show: boolean) => void;
  setSearchMode: (mode: SearchMode) => void;
  setSearchText: (text: string) => void;
  setCurrentMatchIndex: (index: number) => void;
  setBottomTerminalVisible: (visible: boolean) => void;
  setBottomTerminalTab: (tab: BottomTerminalTab) => void;
  openBottomTerminalTab: (tab: BottomTerminalTab) => void;
  closeBottomTerminalTab: (tab: BottomTerminalTab) => void;
  ragChatInput: string;
  setRagChatInput: (text: string) => void;
  setOpencodeConfigTab: (tab: OpencodeConfigTab) => void;
  setOpencodeTopTab: (tab: OpencodeTopTab) => void;
  setZennMode: (mode: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  editorVisible: true,
  activeViewTab: "preview",
  leftPanel: "folder",
  folderPanelTab: "terminal",
  folderPanelVisible: false,
  editorRatio: 50,
  folderPanelRatio: 0.3,
  showSearch: false,
  searchMode: "search" as SearchMode,
  searchText: "",
  currentMatchIndex: -1,
  bottomTerminalVisible: false,
  bottomTerminalTab: "terminal",
  bottomTerminalOpenTabs: ["terminal"],
  opencodeConfigTab: "rules" as OpencodeConfigTab,
  opencodeTopTab: "chat" as OpencodeTopTab,
  isZennMode: false,

  toggleEditor: () => set((s) => ({ editorVisible: !s.editorVisible })),
  setEditorVisible: (visible) => set({ editorVisible: visible }),
  setActiveViewTab: (tab) => set({ activeViewTab: tab }),
  setLeftPanel: (panel) => set({ leftPanel: panel }),
  setFolderPanelTab: (tab) => set({ folderPanelTab: tab }),
  setFolderPanelVisible: (visible) => set({ folderPanelVisible: visible }),
  setEditorRatio: (ratio) => set({ editorRatio: ratio }),
  setFolderPanelRatio: (ratio) => set({ folderPanelRatio: ratio }),
  setShowSearch: (show) => set({ showSearch: show }),
  setSearchMode: (mode) => set({ searchMode: mode }),
  setSearchText: (text) => set({ searchText: text, currentMatchIndex: -1 }),
  setCurrentMatchIndex: (index) => set({ currentMatchIndex: index }),
  setBottomTerminalVisible: (visible) => set({ bottomTerminalVisible: visible }),
  setBottomTerminalTab: (tab) => set({ bottomTerminalTab: tab }),
  openBottomTerminalTab: (tab) =>
    set((s) => ({
      bottomTerminalTab: tab,
      bottomTerminalOpenTabs: s.bottomTerminalOpenTabs.includes(tab)
        ? s.bottomTerminalOpenTabs
        : [...s.bottomTerminalOpenTabs, tab],
      bottomTerminalVisible: true,
    })),
  closeBottomTerminalTab: (tab) =>
    set((s) => {
      const remaining = s.bottomTerminalOpenTabs.filter((t) => t !== tab);
      if (remaining.length === 0) {
        return {
          bottomTerminalOpenTabs: ["terminal"],
          bottomTerminalTab: "terminal",
        };
      }
      return {
        bottomTerminalOpenTabs: remaining,
        bottomTerminalTab: s.bottomTerminalTab === tab ? remaining[0] : s.bottomTerminalTab,
      };
    }),
  ragChatInput: "",
  setRagChatInput: (text) => set({ ragChatInput: text }),
  setOpencodeConfigTab: (tab) => set({ opencodeConfigTab: tab }),
  setOpencodeTopTab: (tab) => set({ opencodeTopTab: tab }),
  setZennMode: (mode) => set({ isZennMode: mode }),
}));
