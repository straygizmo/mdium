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
  /** Currently active folder path (synced with tab-store's activeFolderPath) */
  folderPath: string | null;
  activeFile: string | null;
  /** File tree cache per folder path */
  fileTrees: Record<string, FileEntry[]>;
  /** Directory expanded state per folder path (dirPath → expanded) */
  expandedDirs: Record<string, Record<string, boolean>>;
  /** Clipboard (cut/copy target) */
  clipboardEntry: ClipboardEntry | null;
  /** Drag state */
  dragState: DragState | null;

  setFolderPath: (path: string | null) => void;
  setActiveFile: (path: string | null) => void;
  /** Set file tree for a specific folder */
  setFileTree: (folderPath: string, tree: FileEntry[]) => void;
  /** Remove cache for a specific folder */
  removeFileTree: (folderPath: string) => void;
  /** Get file tree for the current folder */
  getActiveFileTree: () => FileEntry[];
  /** Toggle directory expanded state */
  toggleDir: (dirPath: string, defaultExpanded: boolean) => void;
  /** Whether directory is expanded (returns defaultExpanded if not set) */
  isDirExpanded: (dirPath: string, defaultExpanded: boolean) => boolean;
  /** Collapse all directories in the current folder */
  collapseAllDirs: () => void;
  /** Set to clipboard */
  setClipboard: (path: string, mode: "cut" | "copy") => void;
  /** Clear clipboard */
  clearClipboard: () => void;
  /** Update drag state */
  setDragState: (sourcePath: string, dropTargetPath: string | null) => void;
  /** Clear drag state */
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
