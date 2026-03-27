import { create } from "zustand";
import type { FileEntry } from "@/shared/types";

interface ClipboardEntry {
  path: string;
  mode: "cut" | "copy";
}

interface DragState {
  sourcePath: string;
  dropTargetPath: string | null;
}

interface FileState {
  /** 現在アクティブなフォルダパス（tab-store の activeFolderPath と同期） */
  folderPath: string | null;
  activeFile: string | null;
  /** フォルダパスごとのファイルツリーキャッシュ */
  fileTrees: Record<string, FileEntry[]>;
  /** フォルダパスごとのディレクトリ展開状態 (dirPath → expanded) */
  expandedDirs: Record<string, Record<string, boolean>>;
  /** クリップボード（切り取り/コピー対象） */
  clipboardEntry: ClipboardEntry | null;
  /** ドラッグ中の状態 */
  dragState: DragState | null;

  setFolderPath: (path: string | null) => void;
  setActiveFile: (path: string | null) => void;
  /** 特定フォルダのファイルツリーを設定 */
  setFileTree: (folderPath: string, tree: FileEntry[]) => void;
  /** 特定フォルダのキャッシュを削除 */
  removeFileTree: (folderPath: string) => void;
  /** 現在のフォルダのファイルツリーを取得 */
  getActiveFileTree: () => FileEntry[];
  /** ディレクトリの展開状態をトグル */
  toggleDir: (dirPath: string, defaultExpanded: boolean) => void;
  /** ディレクトリが展開されているか（未設定時はdefaultExpandedを返す） */
  isDirExpanded: (dirPath: string, defaultExpanded: boolean) => boolean;
  /** 現在のフォルダの全ディレクトリを折りたたむ */
  collapseAllDirs: () => void;
  /** クリップボードにセット */
  setClipboard: (path: string, mode: "cut" | "copy") => void;
  /** クリップボードをクリア */
  clearClipboard: () => void;
  /** ドラッグ状態を更新 */
  setDragState: (sourcePath: string, dropTargetPath: string | null) => void;
  /** ドラッグ状態をクリア */
  clearDragState: () => void;
}

export const useFileStore = create<FileState>()((set, get) => ({
  folderPath: null,
  activeFile: null,
  fileTrees: {},
  expandedDirs: {},
  clipboardEntry: null,
  dragState: null,

  setFolderPath: (path) => set({ folderPath: path }),
  setActiveFile: (path) => set({ activeFile: path }),
  setFileTree: (folderPath, tree) =>
    set((s) => ({
      fileTrees: { ...s.fileTrees, [folderPath]: tree },
    })),
  removeFileTree: (folderPath) =>
    set((s) => {
      const { [folderPath]: _, ...restTrees } = s.fileTrees;
      const { [folderPath]: __, ...restExpanded } = s.expandedDirs;
      return { fileTrees: restTrees, expandedDirs: restExpanded };
    }),
  getActiveFileTree: () => {
    const { folderPath, fileTrees } = get();
    return folderPath ? fileTrees[folderPath] ?? [] : [];
  },
  toggleDir: (dirPath, defaultExpanded) => {
    const { folderPath, expandedDirs } = get();
    if (!folderPath) return;
    const folderExpanded = expandedDirs[folderPath] ?? {};
    const current = folderExpanded[dirPath];
    set({
      expandedDirs: {
        ...expandedDirs,
        [folderPath]: {
          ...folderExpanded,
          [dirPath]: current === undefined ? !defaultExpanded : !current,
        },
      },
    });
  },
  isDirExpanded: (dirPath, defaultExpanded) => {
    const { folderPath, expandedDirs } = get();
    if (!folderPath) return defaultExpanded;
    const val = expandedDirs[folderPath]?.[dirPath];
    return val === undefined ? defaultExpanded : val;
  },
  collapseAllDirs: () => {
    const { folderPath, expandedDirs, fileTrees } = get();
    if (!folderPath) return;
    const tree = fileTrees[folderPath] ?? [];
    const collapsed: Record<string, boolean> = {};
    const collectDirs = (entries: FileEntry[]) => {
      for (const e of entries) {
        if (e.is_dir) {
          collapsed[e.path] = false;
          if (e.children) collectDirs(e.children);
        }
      }
    };
    collectDirs(tree);
    set({
      expandedDirs: { ...expandedDirs, [folderPath]: collapsed },
    });
  },
  setClipboard: (path, mode) => set({ clipboardEntry: { path, mode } }),
  clearClipboard: () => set({ clipboardEntry: null }),
  setDragState: (sourcePath, dropTargetPath) =>
    set({ dragState: { sourcePath, dropTargetPath } }),
  clearDragState: () => set({ dragState: null }),
}));
