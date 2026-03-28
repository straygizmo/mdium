import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useOpencodeServerStore } from "./opencode-server-store";

export interface Tab {
  id: string;
  filePath: string;
  folderPath: string;
  fileName: string;
  content: string;
  dirty: boolean;
  undoStack: string[];
  redoStack: string[];
  /** Office ファイル（.docx/.xlsx 等）のバイナリデータ */
  binaryData?: Uint8Array;
  /** Office ファイルの拡張子（例: ".docx"） */
  officeFileType?: string;
  /** マインドマップファイルの拡張子（例: ".km"） */
  mindmapFileType?: string;
  /** 画像ファイルの拡張子（例: ".png"） */
  imageFileType?: string;
  /** 画像ファイルの blob URL（プレビュー用） */
  imageBlobUrl?: string;
  /** 画像キャンバスの fabric.js JSON（タブ切替時の状態保持用） */
  imageCanvasJson?: string;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  /** 現在アクティブなフォルダパス */
  activeFolderPath: string | null;
  /** フォルダごとの最後にアクティブだったタブID */
  folderLastActiveTab: Record<string, string>;
  /** 開いているフォルダパスの一覧（タブとは独立して管理） */
  openFolderPaths: string[];

  openTab: (tab: Omit<Tab, "id" | "dirty" | "undoStack" | "redoStack">) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  undoContent: (id: string) => void;
  redoContent: (id: string) => void;
  markClean: (id: string) => void;
  updateImageCanvasState: (id: string, canvasJson: string) => void;
  updateTabFilePath: (id: string, filePath: string, fileName: string) => void;
  /** タブの表示名だけを更新する（dirty 状態は維持） */
  updateTabFileName: (id: string, fileName: string) => void;
  getActiveTab: () => Tab | undefined;

  /** フォルダを開いた際にフォルダタブを追加（空タブも作成） */
  openFolder: (folderPath: string) => void;
  /** フォルダタブを切り替える */
  switchFolder: (folderPath: string) => void;
  /** フォルダタブを閉じる（配下のファイルタブもすべて閉じる） */
  closeFolder: (folderPath: string) => void;
  /** 開いているフォルダ一覧 */
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
  openFolderPaths: [],

  openTab: (tabData) => {
    const { tabs, folderLastActiveTab } = get();
    const existing = tabs.find(
      (t) => t.filePath && t.filePath === tabData.filePath && t.folderPath === tabData.folderPath
    );
    if (existing) {
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
    // 画像タブの blob URL を解放
    const closingTab = get().tabs.find((t) => t.id === id);
    if (closingTab?.imageBlobUrl) {
      URL.revokeObjectURL(closingTab.imageBlobUrl);
    }
    set((s) => {
      const closedTab = s.tabs.find((t) => t.id === id);
      const newTabs = s.tabs.filter((t) => t.id !== id);
      let newActiveId = s.activeTabId;

      if (s.activeTabId === id) {
        // 同じフォルダ内で隣のタブを選ぶ
        const sameFolderTabs = newTabs.filter(
          (t) => t.folderPath === closedTab?.folderPath
        );
        if (sameFolderTabs.length > 0) {
          newActiveId = sameFolderTabs[sameFolderTabs.length - 1].id;
        } else {
          // 同じフォルダにタブがない場合はnull（フォルダは開いたまま）
          newActiveId = null;
        }
      }

      const newActiveTab = newTabs.find((t) => t.id === newActiveId);
      const newActiveFolderPath = newActiveTab?.folderPath ?? s.activeFolderPath;

      // folderLastActiveTab を更新
      const newFolderLast = { ...s.folderLastActiveTab };
      if (newActiveTab?.folderPath) {
        newFolderLast[newActiveTab.folderPath] = newActiveId!;
      }

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

  openFolder: (folderPath) => {
    const { tabs } = get();
    // 既にこのフォルダのタブがあれば切り替えるだけ
    const folderTabs = tabs.filter((t) => t.folderPath === folderPath);
    if (folderTabs.length > 0) {
      get().switchFolder(folderPath);
      return;
    }

    // 新しいフォルダ用に空タブを作成
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
    const { tabs, folderLastActiveTab } = get();
    const lastTabId = folderLastActiveTab[folderPath];
    const folderTabs = tabs.filter((t) => t.folderPath === folderPath);
    const target = folderTabs.find((t) => t.id === lastTabId) ?? folderTabs[0];

    set({
      activeFolderPath: folderPath,
      activeTabId: target?.id ?? null,
    });
  },

  closeFolder: (folderPath) => {
    const { tabs, openFolderPaths } = get();

    // opencode サーバーを停止
    useOpencodeServerStore.getState().removeServer(folderPath);

    // 未保存チェックはUI側で行う
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

    set({
      tabs: newTabs,
      activeTabId: newActiveId,
      activeFolderPath: newActiveFolderPath,
      openFolderPaths: newOpenFolderPaths,
      folderLastActiveTab: newFolderLast,
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
      }),
    }
  )
);
