import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { CodexMcpServer, SkillInfo } from "@/shared/types";
import type { Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { joinPath } from "@/features/claude-config/lib/config-paths";
import { parseCodexModels, type CodexModel } from "@/features/codex-config/lib/models-cache";
import { guardWrite } from "./claude-config-write-guard";

interface CodexConfigState {
  globalMcpServers: CodexMcpServer[];
  projectMcpServers: CodexMcpServer[];
  globalSkills: SkillInfo[];
  projectSkills: SkillInfo[];
  /** Models Codex advertises in ~/.codex/models_cache.json; empty until loaded or when absent. */
  models: CodexModel[];

  loadModels: () => Promise<void>;
  loadGlobalMcp: () => Promise<void>;
  loadProjectMcp: (folderPath: string) => Promise<void>;
  saveMcpServer: (scope: Scope, folderPath: string, server: CodexMcpServer) => Promise<void>;
  deleteMcpServer: (scope: Scope, folderPath: string, name: string) => Promise<void>;
  setMcpServerEnabled: (scope: Scope, folderPath: string, name: string, enabled: boolean) => Promise<void>;

  loadGlobalSkills: () => Promise<void>;
  loadProjectSkills: (folderPath: string) => Promise<void>;
  saveSkill: (scope: Scope, folderPath: string, skill: SkillInfo) => Promise<void>;
  deleteSkill: (scope: Scope, folderPath: string, dirName: string) => Promise<void>;
}

async function codexHome(): Promise<string> {
  const home = await invoke<string>("get_home_dir");
  return joinPath(home, ".codex");
}

/** Codex config directory for a scope: ~/.codex or <project>/.codex. */
async function codexDir(scope: Scope, folderPath: string): Promise<string> {
  return scope === "global" ? codexHome() : joinPath(folderPath, ".codex");
}

async function configPath(scope: Scope, folderPath: string): Promise<string> {
  return joinPath(await codexDir(scope, folderPath), "config.toml");
}

/** SKILL.md with the frontmatter Codex reads (name, description) followed by the body. */
export function buildCodexSkillContent(skill: SkillInfo): string {
  const lines = ["---", `name: ${skill.name}`];
  if (skill.description) lines.push(`description: ${skill.description}`);
  lines.push("---");
  const body = skill.content.trim();
  if (body) lines.push("", body);
  return lines.join("\n") + "\n";
}

function mapSkillEntry(e: { dir_name?: string; dirName?: string; name: string; description: string; content: string }): SkillInfo {
  return {
    dirName: e.dir_name ?? e.dirName ?? "",
    name: e.name,
    description: e.description,
    userInvocable: false,
    allowedTools: [],
    content: e.content,
  };
}

export const useCodexConfigStore = create<CodexConfigState>()((set, get) => {
  const reloadMcp = async (scope: Scope, folderPath: string) => {
    if (scope === "global") await get().loadGlobalMcp();
    else await get().loadProjectMcp(folderPath);
  };
  const reloadSkills = async (scope: Scope, folderPath: string) => {
    if (scope === "global") await get().loadGlobalSkills();
    else await get().loadProjectSkills(folderPath);
  };

  return {
    globalMcpServers: [],
    projectMcpServers: [],
    globalSkills: [],
    projectSkills: [],
    models: [],

    loadModels: async () => {
      try {
        const raw = await invoke<string>("read_text_file", { path: joinPath(await codexHome(), "models_cache.json") });
        set({ models: parseCodexModels(raw) });
      } catch {
        set({ models: [] });
      }
    },

    loadGlobalMcp: async () => {
      const servers = await invoke<CodexMcpServer[]>("codex_read_mcp_servers", { path: await configPath("global", "") });
      set({ globalMcpServers: servers });
    },

    loadProjectMcp: async (folderPath) => {
      const servers = await invoke<CodexMcpServer[]>("codex_read_mcp_servers", { path: await configPath("project", folderPath) });
      set({ projectMcpServers: servers });
    },

    saveMcpServer: async (scope, folderPath, server) =>
      guardWrite(async () => {
        await invoke("codex_write_mcp_server", { path: await configPath(scope, folderPath), server });
        await reloadMcp(scope, folderPath);
      }),

    deleteMcpServer: async (scope, folderPath, name) =>
      guardWrite(async () => {
        await invoke("codex_delete_mcp_server", { path: await configPath(scope, folderPath), name });
        await reloadMcp(scope, folderPath);
      }),

    setMcpServerEnabled: async (scope, folderPath, name, enabled) =>
      guardWrite(async () => {
        await invoke("codex_set_mcp_server_enabled", { path: await configPath(scope, folderPath), name, enabled });
        await reloadMcp(scope, folderPath);
      }),

    loadGlobalSkills: async () => {
      const skills = await invoke<SkillInfo[]>("list_skills", { baseDir: await codexHome() });
      set({ globalSkills: skills.map(mapSkillEntry) });
    },

    loadProjectSkills: async (folderPath) => {
      const skills = await invoke<SkillInfo[]>("list_skills", { baseDir: joinPath(folderPath, ".codex") });
      set({ projectSkills: skills.map(mapSkillEntry) });
    },

    saveSkill: async (scope, folderPath, skill) =>
      guardWrite(async () => {
        await invoke("write_skill", {
          baseDir: await codexDir(scope, folderPath),
          dirName: skill.dirName,
          content: buildCodexSkillContent(skill),
        });
        await reloadSkills(scope, folderPath);
      }),

    deleteSkill: async (scope, folderPath, dirName) =>
      guardWrite(async () => {
        await invoke("delete_skill", { baseDir: await codexDir(scope, folderPath), dirName });
        await reloadSkills(scope, folderPath);
      }),
  };
});
