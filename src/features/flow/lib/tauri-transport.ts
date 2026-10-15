import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ArtifactLocation, ArtifactRef } from "@/shared/types/flow-run";
import { normalizeFolder, sameFolder } from "./folder-path";
import { registerDefaultTransport, type FlowEventName, type FlowTransport } from "./transport";

/** Folders with a live backend watcher: the spelling it was registered with and its subscriber count. */
const watched = new Map<string, { folder: string; count: number }>();

/** Drops one subscriber; the backend watcher stops with the last one. */
function release(key: string): void {
  const entry = watched.get(key);
  if (!entry) return;
  if (--entry.count > 0) return;
  watched.delete(key);
  void invoke("unwatch_folder", { folderPath: entry.folder }).catch(() => {});
}

/** The desktop transport: Tauri commands and events. */
export function createTauriTransport(): FlowTransport {
  return {
    call: <T,>(command: string, args: Record<string, unknown>) => invoke<T>(command, args),
    subscribe: async <T,>(event: FlowEventName, handler: (payload: T) => void) =>
      listen<T>(event, (e) => handler(e.payload)),
    artifactUrl: async (projectRoot: string, ref: ArtifactRef) => {
      const location = await invoke<ArtifactLocation>("flow_artifact_path", { projectRoot, ...ref });
      return convertFileSrc(location.path, "asset");
    },
    watchFolder: async (folder: string, handler: () => void) => {
      const key = normalizeFolder(folder);
      const existing = watched.get(key);
      if (existing) {
        existing.count++;
      } else {
        await invoke("watch_folder", { folderPath: folder });
        // A concurrent subscriber may have registered while we awaited.
        const raced = watched.get(key);
        if (raced) raced.count++;
        else watched.set(key, { folder, count: 1 });
      }
      let unlisten: () => void;
      try {
        unlisten = await listen<string>("folder-changed", (e) => {
          if (sameFolder(e.payload, folder)) handler();
        });
      } catch (err) {
        release(key);
        throw err;
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        unlisten();
        release(key);
      };
    },
  };
}

registerDefaultTransport(createTauriTransport);
