import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Local mirrors of FTP folders. A mirror is an ordinary local folder (the
 * one opened in the app); the backend keeps it in sync with `uri`.
 */
export interface MirrorInfo {
  uri: string;
  root: string;
}

export type ConflictKind = "bothChanged" | "bothNew" | "remoteDeleted";

export interface SyncStatus {
  root: string;
  uri: string;
  syncing: boolean;
  /** Unix milliseconds of the last successful sync */
  lastSync: number | null;
  error: string | null;
  fileErrors: string[];
  conflicts: { path: string; kind: ConflictKind; copy: string | null }[];
  pendingDeletes: string[];
  progress: { done: number; total: number } | null;
}

export type ResolveAction = "keepLocal" | "useRemote" | "approveDelete" | "restore";

/** Result of checking a file against the server before opening it. */
export type FileFreshness = "fresh" | "updated" | "conflict" | "deleted" | "offline";

/** Changes in a mirror that have not reached the server yet. */
export interface MirrorPending {
  uploads: number;
  deletes: number;
  conflicts: number;
}

interface FtpMirrorState {
  /** Local mirror folder -> ftp:// URI */
  mirrors: Record<string, string>;
  /** Latest status per mirror folder */
  statuses: Record<string, SyncStatus>;
  load: () => Promise<void>;
  /** Mirror `uri` locally (initial sync included) and return the local folder. */
  open: (uri: string) => Promise<string>;
  start: (root: string) => Promise<void>;
  stop: (root: string) => Promise<void>;
  sync: (root: string) => Promise<void>;
  resolve: (root: string, path: string, action: ResolveAction) => Promise<void>;
  /** Bring one file up to date with the server (before opening it). */
  checkFile: (root: string, path: string) => Promise<FileFreshness>;
  /** Push once more and report what is still not on the server. */
  pending: (root: string) => Promise<MirrorPending>;
  /** Delete the local copy (refused by the backend while changes are pending). */
  remove: (root: string) => Promise<void>;
}

export const useFtpMirrorStore = create<FtpMirrorState>()((set, get) => ({
  mirrors: {},
  statuses: {},

  load: async () => {
    const list = await invoke<MirrorInfo[]>("ftp_mirror_list");
    set({ mirrors: Object.fromEntries(list.map((m) => [m.root, m.uri])) });
  },

  open: async (uri) => {
    const root = await invoke<string>("ftp_mirror_open", { uri });
    set((s) => ({ mirrors: { ...s.mirrors, [root]: uri } }));
    return root;
  },

  start: async (root) => {
    if (!get().mirrors[root]) return;
    await invoke("ftp_mirror_start", { root });
  },

  stop: async (root) => {
    if (!get().mirrors[root]) return;
    await invoke("ftp_mirror_stop", { root });
  },

  sync: async (root) => {
    const status = await invoke<SyncStatus>("ftp_mirror_sync", { root });
    set((s) => ({ statuses: { ...s.statuses, [root]: status } }));
  },

  resolve: async (root, path, action) => {
    const status = await invoke<SyncStatus>("ftp_mirror_resolve", { root, path, action });
    set((s) => ({ statuses: { ...s.statuses, [root]: status } }));
  },

  checkFile: (root, path) => invoke<FileFreshness>("ftp_mirror_check_file", { root, path }),

  pending: (root) => invoke<MirrorPending>("ftp_mirror_pending", { root }),

  remove: async (root) => {
    await invoke("ftp_mirror_remove", { root });
    set((s) => {
      const { [root]: _uri, ...mirrors } = s.mirrors;
      const { [root]: _status, ...statuses } = s.statuses;
      return { mirrors, statuses };
    });
  },
}));

/** Listen for status updates from the backend; returns the unlisten function. */
export async function startFtpMirrorStatusListener(): Promise<() => void> {
  return listen<SyncStatus>("ftp-sync-status", (event) => {
    const status = event.payload;
    useFtpMirrorStore.setState((s) => ({
      statuses: { ...s.statuses, [status.root]: status },
      mirrors: s.mirrors[status.root] ? s.mirrors : { ...s.mirrors, [status.root]: status.uri },
    }));
  });
}

/** Default minutes between automatic pulls of open FTP mirrors. */
export const DEFAULT_FTP_SYNC_INTERVAL_MINUTES = 5;
export const MAX_FTP_SYNC_INTERVAL_MINUTES = 1440;

/** The ftp:// URI of a mirror folder, or null for an ordinary folder. */
export function mirrorUri(root: string | null | undefined): string | null {
  if (!root) return null;
  return useFtpMirrorStore.getState().mirrors[root] ?? null;
}
