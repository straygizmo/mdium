/** Markdown テーブル1つ分のデータ */
export interface MarkdownTable {
  heading: string | null;
  headers: string[];
  alignments: string[];
  rows: string[][];
  start_line: number;
  end_line: number;
}

/** Markdown ドキュメント全体のパース結果 */
export interface ParsedDocument {
  lines: string[];
  tables: MarkdownTable[];
}

/** ファイルツリーのエントリ */
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[] | null;
}

/** セルの位置 */
export interface CellPosition {
  tableIndex: number;
  row: number;
  col: number;
}

/** コンテキストメニューの位置と状態 */
export interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
  tableIndex: number;
  row: number;
  col: number;
}

/** Undo/Redo 用のスナップショット */
export type TablesSnapshot = MarkdownTable[];

/** 最近開いたファイルのエントリ */
export interface RecentFile {
  path: string;
  name: string;
  ts: number;
}

/** 最近開いたフォルダのエントリ */
export interface RecentFolder {
  path: string;
  name: string;
  ts: number;
}

/** MCP サーバー設定 */
export interface McpServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  disabled?: boolean;
}

/** スキル情報 */
export interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
  userInvocable: boolean;
  allowedTools: string[];
  content: string;
}

/** AI API 設定 */
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

/** RAG 設定 */
export interface RagSettings {
  embeddingModel: "Xenova/multilingual-e5-large" | "Xenova/multilingual-e5-base" | "Xenova/multilingual-e5-small" | "sirasagi62/ruri-v3-30m-ONNX" | "sirasagi62/ruri-v3-130m-ONNX";
  minChunkLength: number;
  fileExtensions: string;
  retrieveTopK: number;
  retrieveMinScore: number;
}

/** Opencode エージェント定義 */
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

/** Opencode カスタムコマンド */
export interface OpencodeCommand {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
}

/** Opencode MCP サーバー */
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
}

/** Opencode カスタムツール */
export interface OpencodeCustomTool {
  description?: string;
  command: string;
}

/** Opencode スキル */
export interface OpencodeSkill {
  description?: string;
  content: string;
}

/** Opencode WebUI 設定 */
export interface OpencodeWebUi {
  enabled?: boolean;
  port?: number;
  host?: string;
}

/** Opencode 設定全体 */
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

/** Opencode 設定タブ */
export type OpencodeConfigTab = "rules" | "tools" | "agents" | "commands" | "mcp" | "skills" | "custom-tools" | "webui";

/** Opencode 上位タブ */
export type OpencodeTopTab = "chat" | "settings";
