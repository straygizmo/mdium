/** Data for a single Markdown table */
export interface MarkdownTable {
  heading: string | null;
  headers: string[];
  alignments: string[];
  rows: string[][];
  start_line: number;
  end_line: number;
}

/** Parse result for the entire Markdown document */
export interface ParsedDocument {
  lines: string[];
  tables: MarkdownTable[];
}

/** File tree entry */
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[] | null;
}

/** Cell position */
export interface CellPosition {
  tableIndex: number;
  row: number;
  col: number;
}

/** Context menu position and state */
export interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
  tableIndex: number;
  row: number;
  col: number;
}

/** Snapshot for Undo/Redo */
export type TablesSnapshot = MarkdownTable[];

/** Recent file entry */
export interface RecentFile {
  path: string;
  name: string;
  ts: number;
}

/** Recent folder entry */
export interface RecentFolder {
  path: string;
  name: string;
  ts: number;
}

/** MCP server configuration */
export interface McpServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  disabled?: boolean;
}

/** Skill info */
export interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
  userInvocable: boolean;
  allowedTools: string[];
  content: string;
}

/** AI API settings */
export interface AiSettings {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  apiFormat: "openai" | "anthropic" | "azure";
  verifiedModels?: Record<string, string[]>;
  azureResourceName?: string;
  azureApiVersion?: string;
}

/** RAG settings */
export interface RagSettings {
  embeddingModel: "Xenova/multilingual-e5-large" | "Xenova/multilingual-e5-base" | "Xenova/multilingual-e5-small" | "sirasagi62/ruri-v3-30m-ONNX" | "sirasagi62/ruri-v3-130m-ONNX";
  minChunkLength: number;
  fileExtensions: string;
  retrieveTopK: number;
  retrieveMinScore: number;
}

/** Opencode agent definition */
export interface OpencodeAgent {
  description?: string;
  mode?: "primary" | "subagent" | "all";
  model?: string;
  prompt?: string;
  temperature?: number;
  top_p?: number;
  steps?: number;
  disable?: boolean;
  tools?: Record<string, boolean>;
  color?: string;
  hidden?: boolean;
}

/** Opencode custom command */
export interface OpencodeCommand {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
}

/** Opencode MCP server */
export interface OpencodeMcpServer {
  type?: "local" | "remote";
  enabled?: boolean;
  // local (command is string[] in opencode format; string in legacy/claude format)
  command?: string | string[];
  args?: string[];
  environment?: Record<string, string>;
  // remote
  url?: string;
  headers?: Record<string, string>;
  // timeout in milliseconds for tool calls (default: 10000)
  timeout?: number;
}

/** Opencode custom tool */
export interface OpencodeCustomTool {
  description?: string;
  command: string;
}

/** Opencode skill */
export interface OpencodeSkill {
  description?: string;
  content: string;
}

/** Opencode WebUI settings */
export interface OpencodeWebUi {
  enabled?: boolean;
  port?: number;
  host?: string;
}

/** Opencode configuration */
export interface OpencodeConfig {
  model?: string;
  rules?: string[];
  tools?: Record<string, boolean>;
  agents?: Record<string, OpencodeAgent>;
  command?: Record<string, OpencodeCommand>;
  mcp?: Record<string, OpencodeMcpServer>;
  skills?: Record<string, OpencodeSkill>;
  customTools?: Record<string, OpencodeCustomTool>;
  webui?: OpencodeWebUi;
}

/** Opencode config tab */
export type OpencodeConfigTab = "rules" | "tools" | "agents" | "commands" | "mcp" | "skills" | "custom-tools" | "webui";

/** Opencode top-level tab */
export type OpencodeTopTab = "chat" | "settings";

/** Slidev dev server state for a given markdown file */
export interface SlidevSession {
  /** Temp directory path */
  tempDir: string;
  /** Dev server port */
  port: number;
  /** Whether the dev server is ready */
  ready: boolean;
  /** Error message if startup failed */
  error?: string;
}

/** Built-in MCP server definition */
export interface BuiltinMcpServer {
  serverName: string;
  type: "local";
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
}

/** Built-in skill definition */
export interface BuiltinSkill {
  name: string;
  description: string;
  content: string;
}

/** Built-in command definition */
export interface BuiltinCommand {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
}
