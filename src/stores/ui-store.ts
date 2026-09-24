import { create } from "zustand";
import type { OpencodeConfigTab, OpencodeTopTab, ClaudeTopTab, ClaudeSettingsTab } from "@/shared/types";
import type { TerminalKind, TerminalSession } from "@/features/terminal/terminal-session";

export type LeftPanel = "folder" | "outline" | "rag" | "opencode-config" | "git" | "replacement" | "claude";
type ViewTab = "preview" | "table" | "pdf-preview" | "docx-preview" | "html-preview" | "xlsx-preview" | "slidev-preview" | "video";
type FolderPanelTab = "terminal" | "rag";
export type SearchMode = "search" | "replace";

function newTerminalSession(kind: TerminalKind, folderPath: string): TerminalSession {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return { id: `terminal-${kind}-${suffix}`, kind, folderPath };
}

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
  terminalSessions: TerminalSession[];
  activeTerminalSessionId: string | null;
  /** Last selected terminal session for each folder. */
  activeTerminalSessionIdsByFolder: Record<string, string>;
  opencodeConfigTab: OpencodeConfigTab;
  opencodeTopTab: OpencodeTopTab;
  claudeTopTab: ClaudeTopTab;
  claudeSettingsTab: ClaudeSettingsTab;
  isZennMode: boolean;
  gitGraphRatio: number;
  setGitGraphRatio: (ratio: number) => void;

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
  initializeTerminalSessions: (folderPath: string) => void;
  addTerminalSession: (kind: TerminalKind, folderPath: string) => void;
  setActiveTerminalSession: (id: string) => void;
  removeTerminalSession: (id: string) => void;
  /** Remove sessions whose folder is no longer open. Returns the removed session ids. */
  pruneTerminalSessions: (openFolderPaths: string[]) => string[];
  ragChatInput: string;
  setRagChatInput: (text: string) => void;
  setOpencodeConfigTab: (tab: OpencodeConfigTab) => void;
  setOpencodeTopTab: (tab: OpencodeTopTab) => void;
  setClaudeTopTab: (tab: ClaudeTopTab) => void;
  setClaudeSettingsTab: (tab: ClaudeSettingsTab) => void;
  setZennMode: (mode: boolean) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
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
  terminalSessions: [],
  activeTerminalSessionId: null,
  activeTerminalSessionIdsByFolder: {},
  opencodeConfigTab: "rules" as OpencodeConfigTab,
  opencodeTopTab: "chat" as OpencodeTopTab,
  claudeTopTab: "chat" as ClaudeTopTab,
  claudeSettingsTab: "general" as ClaudeSettingsTab,
  isZennMode: false,
  gitGraphRatio: 0.5,

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
  initializeTerminalSessions: (folderPath) =>
    set((s) => {
      const folderSessions = s.terminalSessions.filter((session) => session.folderPath === folderPath);
      if (folderSessions.length > 0) {
        const saved = s.activeTerminalSessionIdsByFolder[folderPath];
        const active = folderSessions.find((session) => session.id === saved) ?? folderSessions[0];
        return {
          activeTerminalSessionId: active.id,
          activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [folderPath]: active.id },
        };
      }
      const session = newTerminalSession("terminal", folderPath);
      return {
        terminalSessions: [...s.terminalSessions, session],
        activeTerminalSessionId: session.id,
        activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [folderPath]: session.id },
      };
    }),
  addTerminalSession: (kind, folderPath) =>
    set((s) => {
      const session = newTerminalSession(kind, folderPath);
      return {
        terminalSessions: [...s.terminalSessions, session],
        activeTerminalSessionId: session.id,
        activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [folderPath]: session.id },
        bottomTerminalVisible: true,
      };
    }),
  setActiveTerminalSession: (id) =>
    set((s) => {
      const session = s.terminalSessions.find((candidate) => candidate.id === id);
      if (!session) return s;
      return {
        activeTerminalSessionId: id,
        activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [session.folderPath]: id },
      };
    }),
  removeTerminalSession: (id) =>
    set((s) => {
      const index = s.terminalSessions.findIndex((session) => session.id === id);
      if (index < 0) return s;
      const removed = s.terminalSessions[index];
      const terminalSessions = s.terminalSessions.filter((session) => session.id !== id);
      const folderSessions = terminalSessions.filter((session) => session.folderPath === removed.folderPath);
      // Position of the removed session among its folder's sessions: the right
      // neighbor now occupies that index; fall back to the left neighbor.
      const folderIndex = s.terminalSessions
        .slice(0, index)
        .filter((session) => session.folderPath === removed.folderPath).length;
      const nextActive = folderSessions[folderIndex] ?? folderSessions[folderIndex - 1] ?? null;
      const activeTerminalSessionIdsByFolder = { ...s.activeTerminalSessionIdsByFolder };
      if (activeTerminalSessionIdsByFolder[removed.folderPath] === id) {
        if (nextActive) activeTerminalSessionIdsByFolder[removed.folderPath] = nextActive.id;
        else delete activeTerminalSessionIdsByFolder[removed.folderPath];
      }
      return {
        terminalSessions,
        activeTerminalSessionId: s.activeTerminalSessionId === id ? nextActive?.id ?? null : s.activeTerminalSessionId,
        activeTerminalSessionIdsByFolder,
      };
    }),
  pruneTerminalSessions: (openFolderPaths) => {
    const open = new Set(openFolderPaths);
    const s = get();
    const stale = s.terminalSessions.filter((session) => session.folderPath !== "" && !open.has(session.folderPath));
    if (stale.length === 0) return [];
    const staleIds = new Set(stale.map((session) => session.id));
    const activeTerminalSessionIdsByFolder = Object.fromEntries(
      Object.entries(s.activeTerminalSessionIdsByFolder).filter(([folder]) => folder === "" || open.has(folder)),
    );
    set({
      terminalSessions: s.terminalSessions.filter((session) => !staleIds.has(session.id)),
      activeTerminalSessionId: s.activeTerminalSessionId && staleIds.has(s.activeTerminalSessionId)
        ? null
        : s.activeTerminalSessionId,
      activeTerminalSessionIdsByFolder,
    });
    return [...staleIds];
  },
  ragChatInput: "",
  setRagChatInput: (text) => set({ ragChatInput: text }),
  setOpencodeConfigTab: (tab) => set({ opencodeConfigTab: tab }),
  setOpencodeTopTab: (tab) => set({ opencodeTopTab: tab }),
  setClaudeTopTab: (tab) => set({ claudeTopTab: tab }),
  setClaudeSettingsTab: (tab) => set({ claudeSettingsTab: tab }),
  setZennMode: (mode) => set({ isZennMode: mode }),
  setGitGraphRatio: (ratio) => set({ gitGraphRatio: ratio }),
}));
