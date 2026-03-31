import type {
  OpencodeAgent,
  OpencodeCommand,
  OpencodeMcpServer,
  OpencodeSkill,
} from "@/shared/types";

export interface BuiltinAgentEntry {
  agent: OpencodeAgent;
  /** Tool file paths relative to project root (created during auto-registration) */
  toolFiles?: Record<string, string>;
  /** Prompt file paths relative to project root (created during auto-registration) */
  promptFiles?: Record<string, string>;
}

export const BUILTIN_AGENTS: Record<string, BuiltinAgentEntry> = {
  rag: {
    agent: {
      description: "RAG - ドキュメント検索エージェント",
      mode: "all",
      prompt: "{file:.opencode/prompts/rag.md}",
      tools: {
        rag_search: true,
        bash: false,
      },
    },
    toolFiles: {
      ".opencode/tools/rag_search.ts": "rag_search",
    },
    promptFiles: {
      ".opencode/prompts/rag.md": "rag",
    },
  },
};

export const BUILTIN_COMMANDS: Record<string, OpencodeCommand> = {};

export const BUILTIN_MCP: Record<string, OpencodeMcpServer> = {};

export const BUILTIN_SKILLS: Record<string, OpencodeSkill> = {};

/** Returns builtin agent names not present in current config */
export function getMissingBuiltinAgents(
  currentAgents: Record<string, OpencodeAgent>
): string[] {
  return Object.keys(BUILTIN_AGENTS).filter((name) => !(name in currentAgents));
}

/** Returns builtin command names not present in current config */
export function getMissingBuiltinCommands(
  currentCommands: Record<string, OpencodeCommand>
): string[] {
  return Object.keys(BUILTIN_COMMANDS).filter((name) => !(name in currentCommands));
}

/** Returns builtin MCP server names not present in current config */
export function getMissingBuiltinMcp(
  currentMcp: Record<string, OpencodeMcpServer>
): string[] {
  return Object.keys(BUILTIN_MCP).filter((name) => !(name in currentMcp));
}

/** Returns builtin skill names not present in current config */
export function getMissingBuiltinSkills(
  currentSkills: Record<string, OpencodeSkill>
): string[] {
  return Object.keys(BUILTIN_SKILLS).filter((name) => !(name in currentSkills));
}

/** Check if a given name is a builtin agent */
export function isBuiltinAgent(name: string): boolean {
  return name in BUILTIN_AGENTS;
}

/** Check if a given name is a builtin command */
export function isBuiltinCommand(name: string): boolean {
  return name in BUILTIN_COMMANDS;
}

/** Check if a given name is a builtin MCP server */
export function isBuiltinMcp(name: string): boolean {
  return name in BUILTIN_MCP;
}

/** Check if a given name is a builtin skill */
export function isBuiltinSkill(name: string): boolean {
  return name in BUILTIN_SKILLS;
}
