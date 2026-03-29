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

    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    const currentFolder = folderPath;

    // Defer watcher setup to avoid overwhelming IPC during folder switches
    const timer = setTimeout(() => {
      if (cancelled) return;

      const setup = async () => {
        try {
          await invoke("watch_folder", { folderPath: currentFolder });
          if (cancelled) return;
          const fn = await listen<string>("folder-changed", (event) => {
            if (!cancelled && event.payload === currentFolder) {
              callbackRef.current();
            }
          });
          if (cancelled) {
            fn();
          } else {
            unlistenFn = fn;
          }
        } catch (e) {
          console.error("Folder watcher setup failed:", e);
        }
      };

      setup();
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unlistenFn?.();
      invoke("unwatch_folder", { folderPath: currentFolder }).catch(() => {});
    };
  }, [folderPath]);
}
