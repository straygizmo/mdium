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
import folderGlobToolSrc from "../../../../.opencode/tools/folder_glob.ts?raw";
import folderGrepToolSrc from "../../../../.opencode/tools/folder_grep.ts?raw";
import ragStatusToolSrc from "../../../../.opencode/tools/rag_status.ts?raw";
import convertOfficeDocsToolSrc from "../../../../.opencode/tools/convert_office_docs.ts?raw";
import ragUpdateIndexToolSrc from "../../../../.opencode/tools/rag_update_index.ts?raw";
import vbaListToolSrc from "../../../../.opencode/tools/vba_list.ts?raw";
import vbaPullToolSrc from "../../../../.opencode/tools/vba_pull.ts?raw";
import vbaPushToolSrc from "../../../../.opencode/tools/vba_push.ts?raw";
import vbaRunToolSrc from "../../../../.opencode/tools/vba_run.ts?raw";
import xlsxReadToolSrc from "../../../../.opencode/tools/xlsx_read.ts?raw";

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
    requiredBuiltinTools: ["rag_search", "rag_status", "convert_office_docs", "rag_update_index", "folder_glob", "folder_grep"],
    agentMd: `---
# mdium-agent-version: 3
description: RAG - Document search agent powered by vector database
mode: all
tools:
  rag_search: true
  rag_status: true
  convert_office_docs: true
  rag_update_index: true
  folder_glob: true
  folder_grep: true
  glob: false
  grep: false
  list: false
  bash: false
---

You are a RAG (Retrieval-Augmented Generation) document search agent.
Gather necessary information from the vector DB and documents within the folder to comprehensively answer user questions.

## Basic Behavior

**For EVERY user question, your FIRST tool call MUST be \`rag_status\`, followed by \`rag_search\` (see "Office documents and index").** The documents are already indexed, so never begin by listing or scanning files — that is slower and misses semantic matches. Check \`rag_status\` first, then search with \`rag_search\`.

1. Call \`rag_search\` with the user's question to retrieve the most relevant document chunks (hybrid vector + BM25 search).
2. ONLY IF \`rag_search\` does not return enough to answer, then \`read\` the cited files, or use \`folder_glob\`/\`folder_grep\` to locate additional files.
3. Combine multiple searches and reads to make comprehensive judgments.
4. Always cite sources (file name and line number) in your answers.

## Tool Usage Guidelines

- **rag_search**: Call right after \`rag_status\` (see Office documents and index), before any file tools. Hybrid search (vector similarity + BM25 keyword ranking, fused via RRF) for relevant documents. Defaults to hybrid mode; pass \`search_mode: "vector"\` for pure semantic search, or tune \`bm25_weight\` (0.0-1.0) to favor keyword vs. semantic matches
- **folder_glob**: Use ONLY after rag_search, to locate additional files by name/pattern. Searches ONLY the open folder (never its parents or other folders). Never use it as the first step
- **folder_grep**: Use ONLY after rag_search, for exact keyword/pattern matches in files. Searches ONLY the open folder
- **read**: Read full file content, e.g. files cited by rag_search, to understand details
- **MCP tools (web search, etc.)**: Use when local search doesn't provide sufficient information
- **write / edit**: Use only when the user explicitly requests it (e.g., creating summaries, generating reports)

## Office documents and index

Before searching, check whether the index is complete. Never start a conversion or an index update without the user's consent.

1. Call \`rag_status\` first for any question about the documents in the folder.
2. If \`unconverted_office_docs\` is not empty, tell the user how many and which files, and ask whether to convert them before searching.
3. On consent, call \`convert_office_docs\` with those paths, then poll \`rag_status\` until \`job.state\` is \`done\` or \`failed\`.
4. Then call \`rag_update_index\` and poll \`rag_status\` the same way, then use \`rag_search\`.
5. If \`state\` is \`empty\`, ask the user whether to build the index; on consent call \`rag_update_index\` and poll.
6. A \`job_running\` error means another job is in progress: wait and poll \`rag_status\`.
7. If the user declines, answer from the existing index and the folder tools.

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
  rag_status: {
    description:
      "Report RAG index state, unconverted Office documents and background jobs via mdium. Pairs with the built-in rag agent.",
    fileName: "rag_status.ts",
    content: ragStatusToolSrc,
  },
  convert_office_docs: {
    description:
      "Convert Office documents to Markdown for indexing (asks the user in mdium). Pairs with the built-in rag agent.",
    fileName: "convert_office_docs.ts",
    content: convertOfficeDocsToolSrc,
  },
  rag_update_index: {
    description:
      "Build or update the RAG document index (asks the user in mdium). Pairs with the built-in rag agent.",
    fileName: "rag_update_index.ts",
    content: ragUpdateIndexToolSrc,
  },
  folder_glob: {
    description:
      "Find files by glob pattern, scoped strictly to the open folder. Pairs with the built-in rag agent.",
    fileName: "folder_glob.ts",
    content: folderGlobToolSrc,
  },
  folder_grep: {
    description:
      "Search file contents by regex, scoped strictly to the open folder. Pairs with the built-in rag agent.",
    fileName: "folder_grep.ts",
    content: folderGrepToolSrc,
  },
  vba_list: {
    description: "List the VBA modules of an .xlsm/.xlam workbook via mdium. Pairs with the vba-mdium-flow skill.",
    fileName: "vba_list.ts",
    content: vbaListToolSrc,
  },
  vba_pull: {
    description: "Extract VBA modules of a workbook into <stem>_assets/macros/ via mdium.",
    fileName: "vba_pull.ts",
    content: vbaPullToolSrc,
  },
  vba_push: {
    description: "Write edited .bas/.cls files back into the workbook (add/remove supported) via mdium.",
    fileName: "vba_push.ts",
    content: vbaPushToolSrc,
  },
  vba_run: {
    description: "Run macros of an .xlsm/.xlam on a disposable copy through hidden Excel and return results and cell values via mdium.",
    fileName: "vba_run.ts",
    content: vbaRunToolSrc,
  },
  xlsx_read: {
    description: "Read saved cell values of an .xlsx/.xlsm/.xlam without Excel via mdium.",
    fileName: "xlsx_read.ts",
    content: xlsxReadToolSrc,
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

// Built-in plugins (opencode `plugin` array entries). Re-exported here so
// sections import all built-in catalogs from one module, matching BUILTIN_MCP etc.
export {
  BUILTIN_PLUGINS,
  basePluginSpec,
  isBuiltinPlugin,
  getMissingBuiltinPlugins,
  getBuiltinPluginIdBySpec,
} from "./builtin-plugins";
export type { BuiltinPluginEntry } from "./builtin-plugins";
