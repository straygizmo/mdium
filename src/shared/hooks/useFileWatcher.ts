import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

export function useFileWatcher(
  filePath: string | null,
  onFileChanged: (changedPath: string) => void
) {
  const callbackRef = useRef(onFileChanged);
  callbackRef.current = onFileChanged;

  useEffect(() => {
    if (!filePath) return;

    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    const setup = async () => {
      try {
        await invoke("watch_file", { filePath });
        if (cancelled) return;
        const fn = await listen<string>("file-changed", (event) => {
          if (!cancelled) {
            callbackRef.current(event.payload);
          }
        });
        if (cancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      } catch (e) {
        console.error("File watcher setup failed:", e);
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlistenFn?.();
      invoke("unwatch_file").catch(() => {});
    };
  }, [filePath]);
}
