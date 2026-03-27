import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";

export interface OpencodeServerEntry {
  folderPath: string;
  port: number;
  pid: number;
}

interface OpencodeServerState {
  servers: Record<string, OpencodeServerEntry>;
  nextPort: number;

  /** Allocate a port for a folder (returns existing if already allocated) */
  allocatePort: (folderPath: string) => number;

  /** Register a running server with its PID */
  registerServer: (folderPath: string, port: number, pid: number) => void;

  /** Get server entry for a folder */
  getServer: (folderPath: string) => OpencodeServerEntry | undefined;

  /** Remove server entry and kill the process */
  removeServer: (folderPath: string) => Promise<void>;

  /** Kill all servers (for app shutdown) */
  removeAllServers: () => Promise<void>;
}

export const useOpencodeServerStore = create<OpencodeServerState>()(
  persist(
    (set, get) => ({
      servers: {},
      nextPort: 4096,

      allocatePort: (folderPath: string) => {
        const existing = get().servers[folderPath];
        if (existing) return existing.port;

        const port = get().nextPort;
        // Register immediately with pid=0 to prevent duplicate allocation
        set((s) => ({
          nextPort: s.nextPort + 1,
          servers: {
            ...s.servers,
            [folderPath]: { folderPath, port, pid: 0 },
          },
        }));
        return port;
      },

      registerServer: (folderPath: string, port: number, pid: number) => {
        set((s) => ({
          servers: {
            ...s.servers,
            [folderPath]: { folderPath, port, pid },
          },
        }));
      },

      getServer: (folderPath: string) => {
        return get().servers[folderPath];
      },

      removeServer: async (folderPath: string) => {
        const entry = get().servers[folderPath];
        if (!entry) return;

        if (entry.pid > 0) {
          try {
            await invoke("kill_background_process", { pid: entry.pid });
            console.log(`[opencode-server] killed server for ${folderPath} (pid=${entry.pid})`);
          } catch (e) {
            console.warn(`[opencode-server] failed to kill pid=${entry.pid}:`, e);
          }
        }

        set((s) => {
          const { [folderPath]: _, ...rest } = s.servers;
          return { servers: rest };
        });
      },

      removeAllServers: async () => {
        const entries = Object.values(get().servers);
        for (const entry of entries) {
          if (entry.pid > 0) {
            try {
              await invoke("kill_background_process", { pid: entry.pid });
              console.log(`[opencode-server] killed server pid=${entry.pid}`);
            } catch (e) {
              console.warn(`[opencode-server] failed to kill pid=${entry.pid}:`, e);
            }
          }
        }
        set({ servers: {} });
      },
    }),
    {
      name: "mdium-opencode-servers",
      // PID is invalid after app restart — discard stale server entries
      // but preserve nextPort to avoid port collisions with zombie processes
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<OpencodeServerState> | undefined;
        // Compute nextPort that is safely above any previously used port
        let nextPort = persisted?.nextPort ?? currentState.nextPort;
        if (persisted?.servers) {
          for (const entry of Object.values(persisted.servers)) {
            if (entry.port >= nextPort) nextPort = entry.port + 1;
          }
        }
        return {
          ...currentState,
          nextPort,
          servers: {},  // Clear stale entries — old processes are dead after restart
        };
      },
    }
  )
);
