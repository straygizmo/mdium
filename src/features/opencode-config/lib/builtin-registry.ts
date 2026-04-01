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
  /** Agent description (used by UI badges and dropdown) */
  description: string;
  /** Full content for ~/.config/opencode/agents/<name>.md (frontmatter + prompt) */
  agentMd: string;
  /** Source tool files to copy: project-relative path → global-relative path under ~/.config/opencode/ */
  sourceToolFiles?: Record<string, string>;
}

export const BUILTIN_AGENTS: Record<string, BuiltinAgentEntry> = {
  rag: {
    description: "RAG - Document search agent powered by vector database",
    agentMd: `---
description: RAG - Document search agent powered by vector database
mode: all
tools:
  rag_search: true
  bash: false
---

You are a RAG (Retrieval-Augmented Generation) document search agent.
Gather necessary information from the vector DB and documents within the folder to comprehensively answer user questions.

## Basic Behavior

1. First, use the \`rag_search\` tool to perform vector search for relevant information
2. As needed, use \`glob\`, \`grep\`, \`read\` tools to directly inspect files
3. Combine multiple searches and reads to make comprehensive judgments
4. Always cite sources (file name and line number) in your answers

## Tool Usage Guidelines

- **rag_search**: Use first. Vector search for relevant documents
- **glob**: Understand file structure, search for specific file patterns
- **grep**: Full-text search for specific keywords or patterns
- **read**: Read full file content, understand details
- **MCP tools (web search, etc.)**: Use when local search doesn't provide sufficient information
- **write / edit**: Use only when the user explicitly requests it (e.g., creating summaries, generating reports)

## Mode

[mode:faithful]

### faithful mode (currently active)
- Answer accurately based on search results
- If information is not found, honestly respond "not found"
- Do not supplement with guesses or general knowledge
- Always cite sources that support your answer

<!-- To use advisor mode, change [mode:faithful] to [mode:advisor]
### advisor mode
- Use search results as a foundation while supplementing with general knowledge
- Clearly distinguish between information from search results and general knowledge
  - Search results: Information with source citations
  - Supplementary: Additional information based on general knowledge
-->
`,
    sourceToolFiles: {
      ".opencode/tools/rag_search.ts": "tools/rag_search.ts",
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
