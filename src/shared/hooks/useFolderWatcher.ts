import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

export function useFolderWatcher(
  folderPath: string | null,
  onFolderChanged: () => void
) {
  const callbackRef = useRef(onFolderChanged);
  callbackRef.current = onFolderChanged;

  useEffect(() => {
    if (!folderPath) return;

    let unlisten: (() => void) | null = null;
    const currentFolder = folderPath;

    const setup = async () => {
      try {
        await invoke("watch_folder", { folderPath: currentFolder });
        unlisten = await listen<string>("folder-changed", (event) => {
          if (event.payload === currentFolder) {
            callbackRef.current();
          }
        });
      } catch (e) {
        console.error("Folder watcher setup failed:", e);
      }
    };

    setup();

    return () => {
      unlisten?.();
      invoke("unwatch_folder", { folderPath: currentFolder }).catch(() => {});
    };
  }, [folderPath]);
}
