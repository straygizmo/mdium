import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "@/shared/types";

/**
 * State of the FTP panel: which saved connection is browsed and the lazily
 * loaded server tree. Browsing reads the server directly; a folder is only
 * mirrored locally once it is opened as a working folder.
 */
interface FtpBrowserState {
  /** Connection keys (`user@host:port`), most recently used first. Persisted. */
  recent: string[];
  /** Remote folder the tree starts at, per connection key. Persisted. */
  rootPaths: Record<string, string>;
  /** The connection being browsed and the ftp:// URI of its tree root. */
  connection: { key: string; uri: string } | null;
  /** Loaded children per directory URI. */
  children: Record<string, FileEntry[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  /** URI of the last clicked file or folder (the tree root after connecting). */
  selected: string | null;
  /** Start browsing `uri` (returned by `ftp_connect`) for connection `key`. */
  setConnected: (key: string, uri: string, remotePath: string) => void;
  disconnect: () => void;
  /** Forget a connection deleted from the saved list. */
  forget: (key: string) => void;
  loadDir: (uri: string) => Promise<void>;
  toggle: (uri: string) => void;
  select: (uri: string) => void;
  /** Reload every directory loaded so far. */
  refresh: () => Promise<void>;
}

const MAX_RECENT = 20;

export const useFtpBrowserStore = create<FtpBrowserState>()(
  persist(
    (set, get) => ({
      recent: [],
      rootPaths: {},
      connection: null,
      children: {},
      expanded: {},
      loading: {},
      errors: {},
      selected: null,

      setConnected: (key, uri, remotePath) => {
        set((s) => ({
          recent: [key, ...s.recent.filter((k) => k !== key)].slice(0, MAX_RECENT),
          rootPaths: { ...s.rootPaths, [key]: remotePath },
          connection: { key, uri },
          children: {},
          expanded: { [uri]: true },
          loading: {},
          errors: {},
          selected: uri,
        }));
        get().loadDir(uri);
      },

      disconnect: () => set({ connection: null, children: {}, expanded: {}, loading: {}, errors: {}, selected: null }),

      forget: (key) => {
        set((s) => {
          const { [key]: _path, ...rootPaths } = s.rootPaths;
          return { recent: s.recent.filter((k) => k !== key), rootPaths };
        });
        if (get().connection?.key === key) get().disconnect();
      },

      loadDir: async (uri) => {
        set((s) => ({ loading: { ...s.loading, [uri]: true } }));
        try {
          const entries = await invoke<FileEntry[]>("get_file_tree", {
            path: uri,
            showAll: true,
            includeEmptyDirs: true,
            expandedDirs: [],
          });
          set((s) => {
            const { [uri]: _err, ...errors } = s.errors;
            return { children: { ...s.children, [uri]: entries }, errors };
          });
        } catch (e) {
          set((s) => ({ errors: { ...s.errors, [uri]: String(e) } }));
        } finally {
          set((s) => {
            const { [uri]: _l, ...loading } = s.loading;
            return { loading };
          });
        }
      },

      toggle: (uri) => {
        const open = !get().expanded[uri];
        set((s) => ({ expanded: { ...s.expanded, [uri]: open } }));
        if (open && !get().children[uri] && !get().loading[uri]) get().loadDir(uri);
      },

      select: (uri) => set({ selected: uri }),

      refresh: async () => {
        const { connection, children } = get();
        if (!connection) return;
        const dirs = new Set([connection.uri, ...Object.keys(children)]);
        await Promise.all([...dirs].map((d) => get().loadDir(d)));
      },
    }),
    {
      name: "mdium-ftp-browser",
      partialize: (s) => ({ recent: s.recent, rootPaths: s.rootPaths }),
    },
  ),
);
