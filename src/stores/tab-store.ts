import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useOpencodeServerStore } from "./opencode-server-store";
import { useOpencodeConfigStore } from "./opencode-config-store";
import { useUiStore, type LeftPanel } from "./ui-store";
import type { editor } from "monaco-editor";

export interface Tab {
  id: string;
  filePath: string;
  folderPath: string;
  fileName: string;
  content: string;
  dirty: boolean;
  undoStack: string[];
  redoStack: string[];
  /** Binary data for Office files (.docx/.xlsx etc.) */
  binaryData?: Uint8Array;
  /** Office file extension (e.g., ".docx") */
  officeFileType?: string;
  /** Mindmap file extension (e.g., ".km") */
  mindmapFileType?: string;
  /** Image file extension (e.g., ".png") */
  imageFileType?: string;
  /** CSV/TSV file extension (e.g., ".csv") */
  csvFileType?: ".csv" | ".tsv";
  /** Image file blob URL (for preview) */
  imageBlobUrl?: string;
  /** Fabric.js JSON for image canvas (for preserving state across tab switches) */
  imageCanvasJson?: string;
  /** Whether this tab should use the code editor (non-markdown text file) */
  isCodeFile?: boolean;
  /** Whether the editor pane is visible for this tab (default: true) */
  editorVisible?: boolean;
  /** Whether this tab displays a diff view */
  isDiffTab?: boolean;
  /** Original file content for diff (left side) */
  diffOriginal?: string;
  /** Modified file content for diff (right side) */
  diffModified?: string;
  /** Monaco language ID for diff syntax highlighting */
  diffLanguage?: string;
  /** Label for the original (left) pane */
  diffOriginalLabel?: string;
  /** Label for the modified (right) pane */
  diffModifiedLabel?: string;
  /** Git status code for display in tab (e.g. "M", "A", "D") */
  diffStatus?: string;
  /** Monaco view state (scroll/cursor/selection). Set by CodeEditorPanel; restored on remount. */
  editorViewState?: editor.ICodeEditorViewState | null;
  /** CSV preview scroll position in pixels. */
  csvPreviewScrollTop?: number;
  /** CSV preview "treat first row as header" toggle. Defaults to true when undefined. */
  csvHeaderMode?: boolean;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Currently active folder path */
  activeFolderPath: string | null;
  /** Last active tab ID per folder */
  folderLastActiveTab: Record<string, string>;
  /** Last active left panel per folder */
  folderLeftPanel: Record<string, LeftPanel>;
  /** List of open folder paths (managed independently from tabs) */
  openFolderPaths: string[];

  openTab: (tab: Omit<Tab, "id" | "dirty" | "undoStack" | "redoStack">) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  undoContent: (id: string) => void;
  redoContent: (id: string) => void;
  markClean: (id: string) => void;
  updateImageCanvasState: (id: string, canvasJson: string) => void;
  updateTabEditorViewState: (id: string, state: editor.ICodeEditorViewState | null) => void;
  updateTabCsvPreview: (id: string, partial: { scrollTop?: number; headerMode?: boolean }) => void;
  updateTabFilePath: (id: string, filePath: string, fileName: string) => void;
  /** Update only the tab display name (preserves dirty state) */
  updateTabFileName: (id: string, fileName: string) => void;
  getActiveTab: () => Tab | undefined;
  /** Toggle editor visibility for the active tab and sync to UI store */
  toggleTabEditor: () => void;
  /** Open a diff tab (or reuse existing one for the same file+staged combination) */
  openDiffTab: (params: {
    folderPath: string;
    filePath: string;
    fileName: string;
    original: string;
    modified: string;
    language: string;
    originalLabel: string;
    modifiedLabel: string;
    staged: boolean;
    status: string;
  }) => void;

  /** Save current folder's left panel selection */
  setFolderLeftPanel: (panel: LeftPanel) => void;

  /** Add folder tab when opening a folder (also creates an empty tab) */
  openFolder: (folderPath: string) => void;
  /** Switch folder tab */
  switchFolder: (folderPath: string) => void;
  /** Close folder tab (also closes all file tabs under it) */
  closeFolder: (folderPath: string) => void;
  /** List of open folders */
  getOpenFolders: () => string[];
}

function generateId(): string {
  return crypto.randomUUID();
}

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activeTabId: null,
  activeFolderPath: null,
  folderLastActiveTab: {},
  folderLeftPanel: {},
  openFolderPaths: [],

  openTab: (tabData) => {
    const { tabs, folderLastActiveTab } = get();
    const existing = tabs.find(
      (t) => t.filePath && t.filePath === tabData.filePath && t.folderPath === tabData.folderPath
    );
    if (existing) {
      useUiStore.getState().setEditorVisible(existing.editorVisible ?? true);
      set({
        activeTabId: existing.id,
        activeFolderPath: existing.folderPath || get().activeFolderPath,
        folderLastActiveTab: existing.folderPath
          ? { ...folderLastActiveTab, [existing.folderPath]: existing.id }
          : folderLastActiveTab,
      });
      return;
    }
    const newTab: Tab = { ...tabData, id: generateId(), dirty: false, undoStack: [], redoStack: [] };
    useUiStore.getState().setEditorVisible(newTab.editorVisible ?? true);
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
      activeFolderPath: newTab.folderPath || s.activeFolderPath,
      folderLastActiveTab: newTab.folderPath
        ? { ...s.folderLastActiveTab, [newTab.folderPath]: newTab.id }
        : s.folderLastActiveTab,
    }));
  },

  closeTab: (id) => {
    // Revoke blob URL for image tab
    const closingTab = get().tabs.find((t) => t.id === id);
    if (closingTab?.imageBlobUrl) {
      URL.revokeObjectURL(closingTab.imageBlobUrl);
    }
    set((s) => {
      const closedTab = s.tabs.find((t) => t.id === id);
      const newTabs = s.tabs.filter((t) => t.id !== id);
      let newActiveId = s.activeTabId;

      if (s.activeTabId === id) {
        // Select adjacent tab within the same folder
        const sameFolderTabs = newTabs.filter(
          (t) => t.folderPath === closedTab?.folderPath
        );
        if (sameFolderTabs.length > 0) {
          newActiveId = sameFolderTabs[sameFolderTabs.length - 1].id;
        } else {
          // null if no tabs in the same folder (folder stays open)
          newActiveId = null;
        }
      }

      const newActiveTab = newTabs.find((t) => t.id === newActiveId);
      const newActiveFolderPath = newActiveTab?.folderPath ?? s.activeFolderPath;

      // Update folderLastActiveTab
      const newFolderLast = { ...s.folderLastActiveTab };
      if (newActiveTab?.folderPath) {
        newFolderLast[newActiveTab.folderPath] = newActiveId!;
      }

      // Restore editorVisible for the new active tab
      useUiStore.getState().setEditorVisible(newActiveTab?.editorVisible ?? true);

      return {
        tabs: newTabs,
        activeTabId: newActiveId,
        activeFolderPath: newActiveFolderPath,
        folderLastActiveTab: newFolderLast,
      };
    });
  },

  setActiveTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    useUiStore.getState().setEditorVisible(tab?.editorVisible ?? true);
    set((s) => ({
      activeTabId: id,
      activeFolderPath: tab?.folderPath ?? s.activeFolderPath,
      folderLastActiveTab: tab?.folderPath
        ? { ...s.folderLastActiveTab, [tab.folderPath]: id }
        : s.folderLastActiveTab,
    }));
  },

  updateTabContent: (id, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const undoStack = [...t.undoStack, t.content];
        if (undoStack.length > 200) undoStack.shift();
        return { ...t, content, dirty: true, undoStack, redoStack: [] };
      }),
    }));
  },

  undoContent: (id) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id || t.undoStack.length === 0) return t;
        const undoStack = [...t.undoStack];
        const prev = undoStack.pop()!;
        const redoStack = [...t.redoStack, t.content];
        return { ...t, content: prev, undoStack, redoStack };
      }),
    }));
  },

  redoContent: (id) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id || t.redoStack.length === 0) return t;
        const redoStack = [...t.redoStack];
        const next = redoStack.pop()!;
        const undoStack = [...t.undoStack, t.content];
        return { ...t, content: next, undoStack, redoStack };
      }),
    }));
  },

  markClean: (id) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty: false } : t)),
    }));
  },

  updateImageCanvasState: (id, canvasJson) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, imageCanvasJson: canvasJson, dirty: true } : t
      ),
    }));
  },

  updateTabEditorViewState: (id, state) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, editorViewState: state } : t)),
    }));
  },

  updateTabCsvPreview: (id, partial) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t };
        if (partial.scrollTop !== undefined) next.csvPreviewScrollTop = partial.scrollTop;
        if (partial.headerMode !== undefined) next.csvHeaderMode = partial.headerMode;
        return next;
      }),
    }));
  },

  updateTabFilePath: (id, filePath, fileName) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, filePath, fileName, dirty: false } : t)),
    }));
  },

  updateTabFileName: (id, fileName) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, fileName } : t)),
    }));
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId);
  },

  toggleTabEditor: () => {
    const activeTab = get().getActiveTab();
    const newVisible = !useUiStore.getState().editorVisible;
    useUiStore.getState().setEditorVisible(newVisible);
    if (activeTab) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTab.id ? { ...t, editorVisible: newVisible } : t
        ),
      }));
    }
  },

  openDiffTab: ({ folderPath, filePath, fileName, original, modified, language, originalLabel, modifiedLabel, staged, status }) => {
    const diffId = `diff:${staged ? "staged" : "unstaged"}:${filePath}`;
    const { tabs, folderLastActiveTab } = get();
    const existing = tabs.find((t) => t.id === diffId && t.folderPath === folderPath);
    if (existing) {
      // Update content and reactivate
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === diffId && t.folderPath === folderPath
            ? { ...t, diffOriginal: original, diffModified: modified, diffOriginalLabel: originalLabel, diffModifiedLabel: modifiedLabel }
            : t
        ),
        activeTabId: diffId,
        activeFolderPath: folderPath,
        folderLastActiveTab: { ...folderLastActiveTab, [folderPath]: diffId },
      }));
      useUiStore.getState().setEditorVisible(false);
      return;
    }
    const newTab: Tab = {
      id: diffId,
      filePath,
      folderPath,
      fileName,
      content: "",
      dirty: false,
      undoStack: [],
      redoStack: [],
      isDiffTab: true,
      diffOriginal: original,
      diffModified: modified,
      diffLanguage: language,
      diffOriginalLabel: originalLabel,
      diffModifiedLabel: modifiedLabel,
      diffStatus: status,
      editorVisible: false,
    };
    useUiStore.getState().setEditorVisible(false);
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: diffId,
      activeFolderPath: folderPath,
      folderLastActiveTab: { ...s.folderLastActiveTab, [folderPath]: diffId },
    }));
  },

  setFolderLeftPanel: (panel) => {
    const { activeFolderPath } = get();
    if (activeFolderPath) {
      set((s) => ({
        folderLeftPanel: { ...s.folderLeftPanel, [activeFolderPath]: panel },
      }));
    }
  },

  openFolder: (folderPath) => {
    const { tabs } = get();
    // If tabs for this folder already exist, just switch
    const folderTabs = tabs.filter((t) => t.folderPath === folderPath);
    if (folderTabs.length > 0) {
      get().switchFolder(folderPath);
      return;
    }

    // Load opencode config for this folder
    const ocStore = useOpencodeConfigStore.getState();
    ocStore.loadConfig();
    ocStore.loadProjectMcpServers(folderPath);

    // Create empty tab for new folder
    const newTab: Tab = {
      id: generateId(),
      filePath: "",
      folderPath,
      fileName: "",
      content: "",
      dirty: false,
      undoStack: [],
      redoStack: [],
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeFolderPath: folderPath,
      activeTabId: newTab.id,
      openFolderPaths: s.openFolderPaths.includes(folderPath)
        ? s.openFolderPaths
        : [...s.openFolderPaths, folderPath],
      folderLastActiveTab: { ...s.folderLastActiveTab, [folderPath]: newTab.id },
    }));
  },

  switchFolder: (folderPath) => {
    const { tabs, folderLastActiveTab, folderLeftPanel } = get();
    const lastTabId = folderLastActiveTab[folderPath];
    const folderTabs = tabs.filter((t) => t.folderPath === folderPath);
    const target = folderTabs.find((t) => t.id === lastTabId) ?? folderTabs[0];

    // Load opencode config for this folder
    const ocStore = useOpencodeConfigStore.getState();
    ocStore.loadConfig();
    ocStore.loadProjectMcpServers(folderPath);

    const uiStore = useUiStore.getState();
    uiStore.setEditorVisible(target?.editorVisible ?? true);
    // Restore left panel selection for this folder (default: "folder")
    uiStore.setLeftPanel(folderLeftPanel[folderPath] ?? "folder");
    set({
      activeFolderPath: folderPath,
      activeTabId: target?.id ?? null,
    });
  },

  closeFolder: (folderPath) => {
    const { tabs, openFolderPaths } = get();

    // Stop opencode server
    useOpencodeServerStore.getState().removeServer(folderPath);

    // Revoke blob URLs for image tabs being removed (prevent memory leak)
    for (const tab of tabs) {
      if (tab.folderPath === folderPath && tab.imageBlobUrl) {
        URL.revokeObjectURL(tab.imageBlobUrl);
      }
    }

    // Unsaved changes check is done on the UI side
    const newTabs = tabs.filter((t) => t.folderPath !== folderPath);
    const newOpenFolderPaths = openFolderPaths.filter((p) => p !== folderPath);

    let newActiveId: string | null = null;
    let newActiveFolderPath: string | null = null;

    if (newOpenFolderPaths.length > 0) {
      newActiveFolderPath = newOpenFolderPaths[0];
      const folderTabsNew = newTabs.filter((t) => t.folderPath === newActiveFolderPath);
      newActiveId = folderTabsNew[0]?.id ?? null;
    }

    const newFolderLast = { ...get().folderLastActiveTab };
    delete newFolderLast[folderPath];
    const newFolderLeftPanel = { ...get().folderLeftPanel };
    delete newFolderLeftPanel[folderPath];

    const newActiveTab = newTabs.find((t) => t.id === newActiveId);
    const uiStore = useUiStore.getState();
    uiStore.setEditorVisible(newActiveTab?.editorVisible ?? true);
    // Restore left panel for the new active folder
    if (newActiveFolderPath) {
      const savedLeftPanel = newFolderLeftPanel[newActiveFolderPath];
      if (savedLeftPanel) {
        uiStore.setLeftPanel(savedLeftPanel);
      }
    }

    set({
      tabs: newTabs,
      activeTabId: newActiveId,
      activeFolderPath: newActiveFolderPath,
      openFolderPaths: newOpenFolderPaths,
      folderLastActiveTab: newFolderLast,
      folderLeftPanel: newFolderLeftPanel,
    });
  },

  getOpenFolders: () => {
    return get().openFolderPaths;
  },
    }),
    {
      name: "mdium-tab-folders",
      skipHydration: true,
      partialize: (state) => ({
        openFolderPaths: state.openFolderPaths,
        activeFolderPath: state.activeFolderPath,
        folderLeftPanel: state.folderLeftPanel,
      }),
    }
  )
);
