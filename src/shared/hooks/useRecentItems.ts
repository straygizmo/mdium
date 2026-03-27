import { useCallback, useState } from "react";
import type { RecentFile, RecentFolder } from "@/shared/types";

const MAX_RECENT = 10;

export function useRecentItems() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("mdium-recent-files") || "[]");
    } catch {
      return [];
    }
  });

  const addRecentFile = useCallback((filePath: string) => {
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setRecentFiles((prev) => {
      const filtered = prev.filter((f) => f.path !== filePath);
      const next = [{ path: filePath, name, ts: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      localStorage.setItem("mdium-recent-files", JSON.stringify(next));
      return next;
    });
  }, []);

  const removeRecentFile = useCallback((filePath: string) => {
    setRecentFiles((prev) => {
      const next = prev.filter((f) => f.path !== filePath);
      localStorage.setItem("mdium-recent-files", JSON.stringify(next));
      return next;
    });
  }, []);

  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("mdium-recent-folders") || "[]");
    } catch {
      return [];
    }
  });

  const addRecentFolder = useCallback((folderPath: string) => {
    const name = folderPath.split(/[\\/]/).pop() ?? folderPath;
    setRecentFolders((prev) => {
      const filtered = prev.filter((f) => f.path !== folderPath);
      const next = [{ path: folderPath, name, ts: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      localStorage.setItem("mdium-recent-folders", JSON.stringify(next));
      return next;
    });
  }, []);

  const removeRecentFolder = useCallback((folderPath: string) => {
    setRecentFolders((prev) => {
      const next = prev.filter((f) => f.path !== folderPath);
      localStorage.setItem("mdium-recent-folders", JSON.stringify(next));
      return next;
    });
  }, []);

  return {
    recentFiles,
    addRecentFile,
    removeRecentFile,
    recentFolders,
    addRecentFolder,
    removeRecentFolder,
  } as const;
}
