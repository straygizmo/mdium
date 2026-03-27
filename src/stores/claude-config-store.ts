import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { McpServer, SkillInfo } from "@/shared/types";

interface ClaudeConfigState {
  // Global MCP
  globalMcpServers: Record<string, McpServer>;
  // Project MCP
  projectMcpServers: Record<string, McpServer>;
  // Global Skills
  globalSkills: SkillInfo[];
  // Project Skills
  projectSkills: SkillInfo[];

  // Load
  loadGlobalMcp: () => Promise<void>;
  loadProjectMcp: (folderPath: string) => Promise<void>;
  loadGlobalSkills: () => Promise<void>;
  loadProjectSkills: (folderPath: string) => Promise<void>;

  // Global MCP mutations
  saveGlobalMcpServer: (name: string, server: McpServer) => Promise<void>;
  deleteGlobalMcpServer: (name: string) => Promise<void>;
  toggleGlobalMcpServer: (name: string) => Promise<void>;

  // Project MCP mutations
  saveProjectMcpServer: (folderPath: string, name: string, server: McpServer) => Promise<void>;
  deleteProjectMcpServer: (folderPath: string, name: string) => Promise<void>;
  toggleProjectMcpServer: (folderPath: string, name: string) => Promise<void>;

  // Global Skills mutations
  saveGlobalSkill: (skill: SkillInfo) => Promise<void>;
  deleteGlobalSkill: (dirName: string) => Promise<void>;

  // Project Skills mutations
  saveProjectSkill: (folderPath: string, skill: SkillInfo) => Promise<void>;
  deleteProjectSkill: (folderPath: string, dirName: string) => Promise<void>;
}

async function getHomePath(): Promise<string> {
  return invoke<string>("get_home_dir");
}

async function readMcpFromFile(path: string): Promise<Record<string, McpServer>> {
  const raw = await invoke<string>("read_json_file", { path });
  try {
    const json = JSON.parse(raw);
    return json.mcpServers ?? {};
  } catch {
    return {};
  }
}

async function writeMcpToFile(path: string, servers: Record<string, McpServer>): Promise<void> {
  const raw = await invoke<string>("read_json_file", { path });
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    json = {};
  }
  json.mcpServers = servers;
  await invoke("write_json_file", { path, content: JSON.stringify(json, null, 2) });
}

function buildSkillContent(skill: SkillInfo): string {
  const lines: string[] = ["---"];
  lines.push(`name: "${skill.name}"`);
  if (skill.description) lines.push(`description: "${skill.description}"`);
  if (skill.userInvocable) lines.push("user_invocable: true");
  if (skill.allowedTools.length > 0) {
    lines.push(`allowed_tools: [${skill.allowedTools.map((t) => `"${t}"`).join(", ")}]`);
  }
  lines.push("---");
  // Extract body after frontmatter
  const content = skill.content;
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const endIdx = content.indexOf("\n---", 4);
    if (endIdx !== -1) {
      const body = content.substring(endIdx + 4).replace(/^\r?\n/, "");
      lines.push("");
      lines.push(body);
    }
  } else if (content && !content.startsWith("---")) {
    lines.push("");
    lines.push(content);
  }
  return lines.join("\n");
}

export const useClaudeConfigStore = create<ClaudeConfigState>()((set, get) => ({
  globalMcpServers: {},
  projectMcpServers: {},
  globalSkills: [],
  projectSkills: [],

  loadGlobalMcp: async () => {
    const home = await getHomePath();
    const path = `${home}/.claude.json`;
    const servers = await readMcpFromFile(path);
    set({ globalMcpServers: servers });
  },

  loadProjectMcp: async (folderPath: string) => {
    const path = `${folderPath}/.mcp.json`;
    const servers = await readMcpFromFile(path);
    set({ projectMcpServers: servers });
  },

  loadGlobalSkills: async () => {
    const home = await getHomePath();
    const baseDir = `${home}/.claude`;
    const skills = await invoke<SkillInfo[]>("list_skills", { baseDir });
    set({ globalSkills: skills.map(mapSkillEntry) });
  },

  loadProjectSkills: async (folderPath: string) => {
    const baseDir = `${folderPath}/.claude`;
    const skills = await invoke<SkillInfo[]>("list_skills", { baseDir });
    set({ projectSkills: skills.map(mapSkillEntry) });
  },

  // Global MCP
  saveGlobalMcpServer: async (name, server) => {
    const home = await getHomePath();
    const path = `${home}/.claude.json`;
    const servers = { ...get().globalMcpServers, [name]: server };
    await writeMcpToFile(path, servers);
    set({ globalMcpServers: servers });
  },

  deleteGlobalMcpServer: async (name) => {
    const home = await getHomePath();
    const path = `${home}/.claude.json`;
    const servers = { ...get().globalMcpServers };
    delete servers[name];
    await writeMcpToFile(path, servers);
    set({ globalMcpServers: servers });
  },

  toggleGlobalMcpServer: async (name) => {
    const home = await getHomePath();
    const path = `${home}/.claude.json`;
    const servers = { ...get().globalMcpServers };
    if (servers[name]) {
      servers[name] = { ...servers[name], disabled: !servers[name].disabled };
    }
    await writeMcpToFile(path, servers);
    set({ globalMcpServers: servers });
  },

  // Project MCP
  saveProjectMcpServer: async (folderPath, name, server) => {
    const path = `${folderPath}/.mcp.json`;
    const servers = { ...get().projectMcpServers, [name]: server };
    await writeMcpToFile(path, servers);
    set({ projectMcpServers: servers });
  },

  deleteProjectMcpServer: async (folderPath, name) => {
    const path = `${folderPath}/.mcp.json`;
    const servers = { ...get().projectMcpServers };
    delete servers[name];
    await writeMcpToFile(path, servers);
    set({ projectMcpServers: servers });
  },

  toggleProjectMcpServer: async (folderPath, name) => {
    const path = `${folderPath}/.mcp.json`;
    const servers = { ...get().projectMcpServers };
    if (servers[name]) {
      servers[name] = { ...servers[name], disabled: !servers[name].disabled };
    }
    await writeMcpToFile(path, servers);
    set({ projectMcpServers: servers });
  },

  // Global Skills
  saveGlobalSkill: async (skill) => {
    const home = await getHomePath();
    const baseDir = `${home}/.claude`;
    const content = buildSkillContent(skill);
    await invoke("write_skill", { baseDir, dirName: skill.dirName, content });
    await get().loadGlobalSkills();
  },

  deleteGlobalSkill: async (dirName) => {
    const home = await getHomePath();
    const baseDir = `${home}/.claude`;
    await invoke("delete_skill", { baseDir, dirName });
    await get().loadGlobalSkills();
  },

  // Project Skills
  saveProjectSkill: async (folderPath, skill) => {
    const baseDir = `${folderPath}/.claude`;
    const content = buildSkillContent(skill);
    await invoke("write_skill", { baseDir, dirName: skill.dirName, content });
    await get().loadProjectSkills(folderPath);
  },

  deleteProjectSkill: async (folderPath, dirName) => {
    const baseDir = `${folderPath}/.claude`;
    await invoke("delete_skill", { baseDir, dirName });
    await get().loadProjectSkills(folderPath);
  },
}));

function mapSkillEntry(e: { dir_name?: string; dirName?: string; name: string; description: string; user_invocable?: boolean; userInvocable?: boolean; allowed_tools?: string[]; allowedTools?: string[]; content: string }): SkillInfo {
  return {
    dirName: e.dir_name ?? e.dirName ?? "",
    name: e.name,
    description: e.description,
    userInvocable: e.user_invocable ?? e.userInvocable ?? false,
    allowedTools: e.allowed_tools ?? e.allowedTools ?? [],
    content: e.content,
  };
}
