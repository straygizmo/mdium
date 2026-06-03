import type {
  OpencodeAgent,
  OpencodeCommand,
  OpencodeMcpServer,
  OpencodeSkill,
} from "@/shared/types";
import { BUILTIN_COMMANDS as SRC_COMMANDS } from "./builtin-commands";
import { BUILTIN_MCP_SERVERS as SRC_MCP } from "./builtin-mcp-servers";
import { BUILTIN_SKILLS as SRC_SKILLS } from "./builtin-skills";
// Inline the canonical tool source at build time (?raw → string). This keeps the
// builtin tool in sync with .opencode/tools/rag_search.ts without copying from
// the user's project folder (which only exists when the mdium repo itself is open).
import ragSearchToolSrc from "../../../../.opencode/tools/rag_search.ts?raw";

export interface BuiltinAgentEntry {
  /** Agent description (used by UI badges and dropdown) */
  description: string;
  /** Full content for ~/.config/opencode/agents/<name>.md (frontmatter + prompt) */
  agentMd: string;
  /**
   * Builtin custom tool names this agent needs to function (keys of
   * BUILTIN_CUSTOM_TOOLS). Used to prompt the user to install the tool when the
   * agent is added.
   */
  requiredBuiltinTools?: string[];
}

export interface BuiltinCustomToolEntry {
  /** Tool description (used by UI badges and the "+ Built-in" dropdown) */
  description: string;
  /** File name written under the opencode tools/ directory */
  fileName: string;
  /** Full TypeScript source of the tool */
  content: string;
}

export const BUILTIN_AGENTS: Record<string, BuiltinAgentEntry> = {
  rag: {
    description: "RAG - Document search agent powered by vector database",
    requiredBuiltinTools: ["rag_search"],
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

**For EVERY user question, your FIRST tool call MUST be \`rag_search\`.** The documents are already indexed, so never begin by listing or scanning files with \`glob\` or \`grep\` — that is slower and misses semantic matches. Start with \`rag_search\`, always.

1. Call \`rag_search\` with the user's question to retrieve the most relevant document chunks (hybrid vector + BM25 search).
2. ONLY IF \`rag_search\` does not return enough to answer, then \`read\` the cited files, or use \`glob\`/\`grep\` to locate additional files.
3. Combine multiple searches and reads to make comprehensive judgments.
4. Always cite sources (file name and line number) in your answers.

## Tool Usage Guidelines

- **rag_search**: ALWAYS call this first, before any other tool. Hybrid search (vector similarity + BM25 keyword ranking, fused via RRF) for relevant documents. Defaults to hybrid mode; pass \`search_mode: "vector"\` for pure semantic search, or tune \`bm25_weight\` (0.0-1.0) to favor keyword vs. semantic matches
- **glob**: Use ONLY after rag_search, to locate additional files by name/pattern. Never use it as the first step
- **grep**: Use ONLY after rag_search, for exact keyword/pattern matches in files
- **read**: Read full file content, e.g. files cited by rag_search, to understand details
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
  },
};

export const BUILTIN_CUSTOM_TOOLS: Record<string, BuiltinCustomToolEntry> = {
  rag_search: {
    description:
      "RAG hybrid search (vector + BM25) over the project's .mdium indexes. Pairs with the built-in rag agent.",
    fileName: "rag_search.ts",
    content: ragSearchToolSrc,
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

/** Returns builtin custom tool names whose tool file is not present yet */
export function getMissingBuiltinCustomTools(currentToolNames: string[]): string[] {
  const present = new Set(currentToolNames);
  return Object.keys(BUILTIN_CUSTOM_TOOLS).filter((name) => !present.has(name));
}

/** Check if a given tool name is a builtin custom tool */
export function isBuiltinCustomTool(name: string): boolean {
  return name in BUILTIN_CUSTOM_TOOLS;
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
