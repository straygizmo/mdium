import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  OpencodeConfig,
  OpencodeAgent,
  OpencodeCommand,
  OpencodeMcpServer,
  OpencodeCustomTool,
  OpencodeSkill,
  OpencodeWebUi,
} from "@/shared/types";

interface OpencodeConfigState {
  config: OpencodeConfig;
  projectCommands: Record<string, OpencodeCommand>;
  projectMcpServers: Record<string, OpencodeMcpServer>;
  projectSkillNames: string[];
  globalSkillNames: string[];
  loading: boolean;

  loadConfig: () => Promise<void>;
  loadGlobalSkills: () => Promise<void>;
  // Rules
  setRules: (rules: string[]) => Promise<void>;
  // Tools
  setToolEnabled: (name: string, enabled: boolean) => Promise<void>;
  // Agents
  saveAgent: (name: string, agent: OpencodeAgent) => Promise<void>;
  deleteAgent: (name: string) => Promise<void>;
  // Commands (Global)
  saveCommand: (name: string, cmd: OpencodeCommand) => Promise<void>;
  deleteCommand: (name: string) => Promise<void>;
  // Commands (Project)
  loadProjectCommands: (folderPath: string) => Promise<void>;
  saveProjectCommand: (folderPath: string, name: string, cmd: OpencodeCommand) => Promise<void>;
  deleteProjectCommand: (folderPath: string, name: string) => Promise<void>;
  // MCP Servers (Global)
  saveMcpServer: (name: string, server: OpencodeMcpServer) => Promise<void>;
  deleteMcpServer: (name: string) => Promise<void>;
  // MCP Servers (Project)
  loadProjectMcpServers: (folderPath: string) => Promise<void>;
  saveProjectMcpServer: (folderPath: string, name: string, server: OpencodeMcpServer) => Promise<void>;
  deleteProjectMcpServer: (folderPath: string, name: string) => Promise<void>;
  // Skills
  loadProjectSkills: (folderPath: string) => Promise<void>;
  saveSkill: (name: string, skill: OpencodeSkill) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  // Custom Tools
  saveCustomTool: (name: string, tool: OpencodeCustomTool) => Promise<void>;
  deleteCustomTool: (name: string) => Promise<void>;
  // WebUI
  setWebUi: (webui: OpencodeWebUi) => Promise<void>;
}

async function getConfigPath(): Promise<string> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}.config${sep}opencode${sep}opencode.jsonc`;
}

function stripJsoncComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    // String literal – copy as-is
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { result += text[i++]; }   // escape char
        if (i < text.length) { result += text[i++]; }
      }
      if (i < text.length) { result += text[i++]; }       // closing "
    // Line comment
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    // Block comment
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      result += text[i++];
    }
  }
  return result;
}

async function readJsonc<T>(path: string): Promise<T | null> {
  try {
    const raw = await invoke<string>("read_text_file", { path });
    return JSON.parse(stripJsoncComments(raw)) as T;
  } catch {
    return null;
  }
}

async function readConfig(): Promise<OpencodeConfig> {
  return (await readJsonc<OpencodeConfig>(await getConfigPath())) ?? {};
}

async function writeConfig(config: OpencodeConfig): Promise<void> {
  const path = await getConfigPath();
  await invoke("write_text_file_with_dirs", {
    path,
    content: JSON.stringify(config, null, 2),
  });
}

function getProjectConfigPath(folderPath: string): string {
  const sep = folderPath.includes("\\") ? "\\" : "/";
  return `${folderPath}${sep}opencode.jsonc`;
}

async function readProjectConfig(folderPath: string): Promise<OpencodeConfig> {
  return (await readJsonc<OpencodeConfig>(getProjectConfigPath(folderPath))) ?? {};
}

async function writeProjectConfig(folderPath: string, config: OpencodeConfig): Promise<void> {
  const path = getProjectConfigPath(folderPath);
  await invoke("write_text_file_with_dirs", {
    path,
    content: JSON.stringify(config, null, 2),
  });
}

export const useOpencodeConfigStore = create<OpencodeConfigState>()((set) => ({
  config: {},
  projectCommands: {},
  projectMcpServers: {},
  projectSkillNames: [],
  globalSkillNames: [],
  loading: false,

  loadConfig: async () => {
    set({ loading: true });
    const config = await readConfig();
    set({ config, loading: false });
  },

  loadGlobalSkills: async () => {
    try {
      const home = await invoke<string>("get_home_dir");
      const sep = home.includes("\\") ? "\\" : "/";
      const baseDir = `${home}${sep}.config${sep}opencode`;
      const entries = await invoke<{ dir_name: string; name: string }[]>("list_skills", { baseDir });
      set({ globalSkillNames: entries.map((e) => e.name || e.dir_name) });
    } catch {
      set({ globalSkillNames: [] });
    }
  },

  setRules: async (rules) => {
    const fresh = await readConfig();
    fresh.rules = rules;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  setToolEnabled: async (name, enabled) => {
    const fresh = await readConfig();
    if (!fresh.tools) fresh.tools = {};
    fresh.tools[name] = enabled;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  saveAgent: async (name, agent) => {
    const fresh = await readConfig();
    if (!fresh.agents) fresh.agents = {};
    fresh.agents[name] = agent;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  deleteAgent: async (name) => {
    const fresh = await readConfig();
    if (fresh.agents) delete fresh.agents[name];
    await writeConfig(fresh);
    set({ config: fresh });
  },

  saveCommand: async (name, cmd) => {
    const fresh = await readConfig();
    if (!fresh.command) fresh.command = {};
    fresh.command[name] = cmd;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  deleteCommand: async (name) => {
    const fresh = await readConfig();
    if (fresh.command) delete fresh.command[name];
    await writeConfig(fresh);
    set({ config: fresh });
  },

  loadProjectCommands: async (folderPath) => {
    const projConfig = await readProjectConfig(folderPath);
    set({ projectCommands: projConfig.command ?? {} });
  },

  saveProjectCommand: async (folderPath, name, cmd) => {
    const fresh = await readProjectConfig(folderPath);
    if (!fresh.command) fresh.command = {};
    fresh.command[name] = cmd;
    await writeProjectConfig(folderPath, fresh);
    set({ projectCommands: fresh.command });
  },

  deleteProjectCommand: async (folderPath, name) => {
    const fresh = await readProjectConfig(folderPath);
    if (fresh.command) delete fresh.command[name];
    await writeProjectConfig(folderPath, fresh);
    set({ projectCommands: fresh.command ?? {} });
  },

  saveMcpServer: async (name, server) => {
    const fresh = await readConfig();
    if (!fresh.mcp) fresh.mcp = {};
    fresh.mcp[name] = server;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  deleteMcpServer: async (name) => {
    const fresh = await readConfig();
    if (fresh.mcp) delete fresh.mcp[name];
    await writeConfig(fresh);
    set({ config: fresh });
  },

  loadProjectMcpServers: async (folderPath) => {
    const projConfig = await readProjectConfig(folderPath);
    set({ projectMcpServers: projConfig.mcp ?? {} });
  },

  saveProjectMcpServer: async (folderPath, name, server) => {
    const fresh = await readProjectConfig(folderPath);
    if (!fresh.mcp) fresh.mcp = {};
    fresh.mcp[name] = server;
    await writeProjectConfig(folderPath, fresh);
    set({ projectMcpServers: fresh.mcp });
  },

  deleteProjectMcpServer: async (folderPath, name) => {
    const fresh = await readProjectConfig(folderPath);
    if (fresh.mcp) delete fresh.mcp[name];
    await writeProjectConfig(folderPath, fresh);
    set({ projectMcpServers: fresh.mcp ?? {} });
  },

  loadProjectSkills: async (folderPath) => {
    const sep = folderPath.includes("\\") ? "\\" : "/";
    const baseDir = `${folderPath}${sep}.opencode`;
    try {
      const entries = await invoke<{ dir_name: string; name: string }[]>("list_skills", { baseDir });
      set({ projectSkillNames: entries.map((e) => e.name || e.dir_name) });
    } catch {
      set({ projectSkillNames: [] });
    }
  },

  saveSkill: async (name, skill) => {
    const fresh = await readConfig();
    if (!fresh.skills) fresh.skills = {};
    fresh.skills[name] = skill;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  deleteSkill: async (name) => {
    const fresh = await readConfig();
    if (fresh.skills) delete fresh.skills[name];
    await writeConfig(fresh);
    set({ config: fresh });
  },

  saveCustomTool: async (name, tool) => {
    const fresh = await readConfig();
    if (!fresh.customTools) fresh.customTools = {};
    fresh.customTools[name] = tool;
    await writeConfig(fresh);
    set({ config: fresh });
  },

  deleteCustomTool: async (name) => {
    const fresh = await readConfig();
    if (fresh.customTools) delete fresh.customTools[name];
    await writeConfig(fresh);
    set({ config: fresh });
  },

  setWebUi: async (webui) => {
    const fresh = await readConfig();
    fresh.webui = webui;
    await writeConfig(fresh);
    set({ config: fresh });
  },
}));
