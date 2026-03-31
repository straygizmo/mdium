import type {
  OpencodeAgent,
  OpencodeCommand,
  OpencodeMcpServer,
  OpencodeSkill,
} from "@/shared/types";
import { BUILTIN_COMMANDS as SRC_COMMANDS } from "./builtin-commands";
import { BUILTIN_MCP_SERVERS as SRC_MCP } from "./builtin-mcp-servers";
import { BUILTIN_SKILLS as SRC_SKILLS } from "./builtin-skills";

export interface BuiltinAgentEntry {
  agent: OpencodeAgent;
  /** Tool file paths relative to ~/.config/opencode/ (created during auto-registration) */
  toolFiles?: Record<string, string>;
  /** Prompt file paths relative to ~/.config/opencode/ (created during auto-registration) */
  promptFiles?: Record<string, string>;
  /** Source file paths relative to project root (templates to copy from) */
  sourceToolFiles?: Record<string, string>;
  /** Source prompt file paths relative to project root (templates to copy from) */
  sourcePromptFiles?: Record<string, string>;
}

export const BUILTIN_AGENTS: Record<string, BuiltinAgentEntry> = {
  rag: {
    agent: {
      description: "RAG - Document search agent powered by vector database",
      mode: "all",
      prompt: "{file:prompts/rag.md}",
      tools: {
        rag_search: true,
        bash: false,
      },
    },
    toolFiles: {
      "tools/rag_search.ts": "rag_search",
    },
    promptFiles: {
      "prompts/rag.md": "rag",
    },
    sourceToolFiles: {
      ".opencode/tools/rag_search.ts": "tools/rag_search.ts",
    },
    sourcePromptFiles: {
      ".opencode/prompts/rag.md": "prompts/rag.md",
    },
  },
};

export const BUILTIN_COMMANDS: Record<string, OpencodeCommand> = Object.fromEntries(
  Object.entries(SRC_COMMANDS).map(([k, v]) => [
    k,
    { template: v.template, description: v.description } satisfies OpencodeCommand,
  ])
);

export const BUILTIN_MCP: Record<string, OpencodeMcpServer> = Object.fromEntries(
  Object.entries(SRC_MCP).map(([k, v]) => [
    k,
    { type: v.type, command: v.command, enabled: v.enabled, environment: v.environment } satisfies OpencodeMcpServer,
  ])
);

export const BUILTIN_SKILLS: Record<string, OpencodeSkill> = Object.fromEntries(
  Object.entries(SRC_SKILLS).map(([k, v]) => [
    k,
    { content: v.content, description: v.description } satisfies OpencodeSkill,
  ])
);

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
