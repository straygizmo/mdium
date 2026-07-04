import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ClaudePermissionMode } from "@/shared/types/claude-sidecar";

export interface ClaudeFolderSettings {
  lastSessionId: string | null;
  model: string; // "" means "use the CLI default model"
  permissionMode: ClaudePermissionMode;
}

export const DEFAULT_CLAUDE_FOLDER_SETTINGS: ClaudeFolderSettings = {
  lastSessionId: null,
  model: "",
  permissionMode: "default",
};

interface ClaudeSessionState {
  folders: Record<string, ClaudeFolderSettings>;
  getFolderSettings: (folder: string) => ClaudeFolderSettings;
  setLastSessionId: (folder: string, id: string | null) => void;
  setModel: (folder: string, model: string) => void;
  setPermissionMode: (folder: string, mode: ClaudePermissionMode) => void;
}

export const useClaudeSessionStore = create<ClaudeSessionState>()(
  persist(
    (set, get) => {
      const update = (folder: string, patch: Partial<ClaudeFolderSettings>) =>
        set((s) => ({
          folders: {
            ...s.folders,
            [folder]: { ...DEFAULT_CLAUDE_FOLDER_SETTINGS, ...s.folders[folder], ...patch },
          },
        }));
      return {
        folders: {},
        getFolderSettings: (folder) =>
          get().folders[folder] ?? DEFAULT_CLAUDE_FOLDER_SETTINGS,
        setLastSessionId: (folder, id) => update(folder, { lastSessionId: id }),
        setModel: (folder, model) => update(folder, { model }),
        setPermissionMode: (folder, mode) => update(folder, { permissionMode: mode }),
      };
    },
    { name: "mdium-claude-sessions" },
  ),
);
