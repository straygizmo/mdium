import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { CopilotMcpServer, SkillInfo } from "@/shared/types";
import type { Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { joinPath } from "@/features/claude-config/lib/config-paths";
import {
  parseMcpServers,
  readSettingsList,
  removeMcpServer,
  setSettingsListEntry,
  upsertMcpServer,
} from "@/features/copilot-config/lib/config-files";
import { buildSkillMarkdown } from "@/shared/lib/skill-md";
import { guardWrite } from "./claude-config-write-guard";

/** A skill with the enabled flag taken from settings.json `disabledSkills`. */
export interface CopilotSkill extends SkillInfo {
  enabled: boolean;
}

interface CopilotConfigState {
  globalMcpServers: CopilotMcpServer[];
  projectMcpServers: CopilotMcpServer[];
  globalSkills: CopilotSkill[];
  projectSkills: CopilotSkill[];

  loadGlobalMcp: () => Promise<void>;
  loadProjectMcp: (folderPath: string) => Promise<void>;
  saveMcpServer: (scope: Scope, folderPath: string, server: CopilotMcpServer) => Promise<void>;
  deleteMcpServer: (scope: Scope, folderPath: string, name: string) => Promise<void>;
  setMcpServerEnabled: (scope: Scope, folderPath: string, name: string, enabled: boolean) => Promise<void>;

  loadGlobalSkills: () => Promise<void>;
  loadProjectSkills: (folderPath: string) => Promise<void>;
  saveSkill: (scope: Scope, folderPath: string, skill: SkillInfo) => Promise<void>;
  deleteSkill: (scope: Scope, folderPath: string, dirName: string) => Promise<void>;
  setSkillEnabled: (scope: Scope, folderPath: string, name: string, enabled: boolean) => Promise<void>;
}

/** ~/.copilot (COPILOT_HOME is not honoured; the CLI default is used). */
async function copilotHome(): Promise<string> {
  const home = await invoke<string>("get_home_dir");
  return joinPath(home, ".copilot");
}

/** User settings file holding the disabled lists. */
async function settingsPath(): Promise<string> {
  return joinPath(await copilotHome(), "settings.json");
}

/** User servers live in ~/.copilot/mcp-config.json, project servers in .github/mcp.json. */
async function mcpConfigPath(scope: Scope, folderPath: string): Promise<string> {
  return scope === "global"
    ? joinPath(await copilotHome(), "mcp-config.json")
    : joinPath(folderPath, ".github", "mcp.json");
}

/** Directory whose `skills/` subfolder holds the scope's skills: ~/.copilot or <project>/.github. */
async function skillsBase(scope: Scope, folderPath: string): Promise<string> {
  return scope === "global" ? copilotHome() : joinPath(folderPath, ".github");
}

async function readJson(path: string): Promise<string> {
  return invoke<string>("read_json_file", { path });
}

async function writeJson(path: string, content: string): Promise<void> {
  await invoke("write_json_file", { path, content });
}

async function disabledList(key: "disabledMcpServers" | "disabledSkills"): Promise<string[]> {
  return readSettingsList(await readJson(await settingsPath()), key);
}

async function setDisabled(key: "disabledMcpServers" | "disabledSkills", name: string, disabled: boolean): Promise<void> {
  const path = await settingsPath();
  await writeJson(path, setSettingsListEntry(await readJson(path), key, name, disabled));
}

function mapSkillEntry(
  e: { dir_name?: string; dirName?: string; name: string; description: string; content: string },
  disabled: string[],
): CopilotSkill {
  const dirName = e.dir_name ?? e.dirName ?? "";
  const name = e.name || dirName;
  return {
    dirName,
    name,
    description: e.description,
    userInvocable: false,
    allowedTools: [],
    content: e.content,
    enabled: !disabled.includes(name) && !disabled.includes(dirName),
  };
}

export const useCopilotConfigStore = create<CopilotConfigState>()((set) => {
  const loadMcp = async (scope: Scope, folderPath: string) => {
    const [raw, disabled] = await Promise.all([readJson(await mcpConfigPath(scope, folderPath)), disabledList("disabledMcpServers")]);
    const servers = parseMcpServers(raw, disabled);
    set(scope === "global" ? { globalMcpServers: servers } : { projectMcpServers: servers });
  };
  const loadSkills = async (scope: Scope, folderPath: string) => {
    const [entries, disabled] = await Promise.all([
      invoke<SkillInfo[]>("list_skills", { baseDir: await skillsBase(scope, folderPath) }),
      disabledList("disabledSkills"),
    ]);
    const skills = entries.map((e) => mapSkillEntry(e, disabled));
    set(scope === "global" ? { globalSkills: skills } : { projectSkills: skills });
  };
  const reloadAllMcp = async (folderPath: string) => {
    await loadMcp("global", folderPath);
    if (folderPath) await loadMcp("project", folderPath);
  };
  const reloadAllSkills = async (folderPath: string) => {
    await loadSkills("global", folderPath);
    if (folderPath) await loadSkills("project", folderPath);
  };

  return {
    globalMcpServers: [],
    projectMcpServers: [],
    globalSkills: [],
    projectSkills: [],

    loadGlobalMcp: () => loadMcp("global", ""),
    loadProjectMcp: (folderPath) => loadMcp("project", folderPath),

    saveMcpServer: async (scope, folderPath, server) =>
      guardWrite(async () => {
        const path = await mcpConfigPath(scope, folderPath);
        await writeJson(path, upsertMcpServer(await readJson(path), server));
        await loadMcp(scope, folderPath);
      }),

    deleteMcpServer: async (scope, folderPath, name) =>
      guardWrite(async () => {
        const path = await mcpConfigPath(scope, folderPath);
        await writeJson(path, removeMcpServer(await readJson(path), name));
        await loadMcp(scope, folderPath);
      }),

    // The disabled list is global by name, so both scopes refresh.
    setMcpServerEnabled: async (_scope, folderPath, name, enabled) =>
      guardWrite(async () => {
        await setDisabled("disabledMcpServers", name, !enabled);
        await reloadAllMcp(folderPath);
      }),

    loadGlobalSkills: () => loadSkills("global", ""),
    loadProjectSkills: (folderPath) => loadSkills("project", folderPath),

    saveSkill: async (scope, folderPath, skill) =>
      guardWrite(async () => {
        await invoke("write_skill", {
          baseDir: await skillsBase(scope, folderPath),
          dirName: skill.dirName,
          content: buildSkillMarkdown(skill.name, skill.description, skill.content),
        });
        await loadSkills(scope, folderPath);
      }),

    deleteSkill: async (scope, folderPath, dirName) =>
      guardWrite(async () => {
        await invoke("delete_skill", { baseDir: await skillsBase(scope, folderPath), dirName });
        await loadSkills(scope, folderPath);
      }),

    setSkillEnabled: async (_scope, folderPath, name, enabled) =>
      guardWrite(async () => {
        await setDisabled("disabledSkills", name, !enabled);
        await reloadAllSkills(folderPath);
      }),
  };
});
