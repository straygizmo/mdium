import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentPermission, AgentProvider } from "@/shared/types/agent-runner";

/** Per-folder session options for a runner-backed provider (Codex, Copilot), chosen in its settings tab. */
export interface RunnerFolderSettings {
  /** "" means "use the CLI default model". */
  model: string;
  /** cli-default keeps the CLI's own behaviour; the others override it per session. */
  permission: AgentPermission;
}

export const DEFAULT_RUNNER_FOLDER_SETTINGS: RunnerFolderSettings = {
  model: "",
  permission: "cli-default",
};

interface RunnerSessionState {
  /** Keyed by `${provider}::${folder}`. */
  folders: Record<string, RunnerFolderSettings>;
  getFolderSettings: (provider: AgentProvider, folder: string) => RunnerFolderSettings;
  setModel: (provider: AgentProvider, folder: string, model: string) => void;
  setPermission: (provider: AgentProvider, folder: string, permission: AgentPermission) => void;
}

export const settingsKey = (provider: AgentProvider, folder: string) => `${provider}::${folder}`;

export const useRunnerSessionStore = create<RunnerSessionState>()(
  persist(
    (set, get) => {
      const update = (provider: AgentProvider, folder: string, patch: Partial<RunnerFolderSettings>) =>
        set((s) => {
          const key = settingsKey(provider, folder);
          return { folders: { ...s.folders, [key]: { ...DEFAULT_RUNNER_FOLDER_SETTINGS, ...s.folders[key], ...patch } } };
        });
      return {
        folders: {},
        getFolderSettings: (provider, folder) => get().folders[settingsKey(provider, folder)] ?? DEFAULT_RUNNER_FOLDER_SETTINGS,
        setModel: (provider, folder, model) => update(provider, folder, { model }),
        setPermission: (provider, folder, permission) => update(provider, folder, { permission }),
      };
    },
    { name: "mdium-runner-sessions" },
  ),
);
