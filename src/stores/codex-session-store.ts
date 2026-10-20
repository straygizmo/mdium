import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentPermission } from "@/shared/types/agent-runner";

export interface CodexFolderSettings {
  /** "" means "use the CLI default model" (config.toml / Codex default). */
  model: string;
  /** cli-default keeps the CLI's own sandbox setting; the others override it per session. */
  permission: AgentPermission;
}

export const DEFAULT_CODEX_FOLDER_SETTINGS: CodexFolderSettings = {
  model: "",
  permission: "cli-default",
};

interface CodexSessionState {
  folders: Record<string, CodexFolderSettings>;
  getFolderSettings: (folder: string) => CodexFolderSettings;
  setModel: (folder: string, model: string) => void;
  setPermission: (folder: string, permission: AgentPermission) => void;
}

export const useCodexSessionStore = create<CodexSessionState>()(
  persist(
    (set, get) => {
      const update = (folder: string, patch: Partial<CodexFolderSettings>) =>
        set((s) => ({
          folders: {
            ...s.folders,
            [folder]: { ...DEFAULT_CODEX_FOLDER_SETTINGS, ...s.folders[folder], ...patch },
          },
        }));
      return {
        folders: {},
        getFolderSettings: (folder) => get().folders[folder] ?? DEFAULT_CODEX_FOLDER_SETTINGS,
        setModel: (folder, model) => update(folder, { model }),
        setPermission: (folder, permission) => update(folder, { permission }),
      };
    },
    { name: "mdium-codex-sessions" },
  ),
);
