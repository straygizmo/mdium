// Tool definitions and dispatch for the mdium-rag MCP server. Every tool is a
// thin proxy to a route on mdium's local HTTP bridge.
import { toolText, type McpToolDef, type McpToolResult } from "../mcp-lib/jsonrpc-server";
import type { BridgeInfo, callBridge as callBridgeFn } from "./bridge-client";

export type RagPermission = "read-only" | "ask" | "auto";

export function parsePermission(raw: string | undefined): RagPermission {
  return raw === "read-only" || raw === "auto" || raw === "ask" ? raw : "ask";
}

const WRITE_TOOLS = new Set(["convert_office_docs", "rag_update_index"]);

const TOOLS: McpToolDef[] = [
  {
    name: "rag_search",
    description:
      "Search the document index of the current folder for passages relevant to a query. " +
      "Delegates to the running mdium app, which embeds the query with the user's configured model " +
      "and runs hybrid (vector + BM25) search. Returns matching chunks with file path, heading, " +
      "content, line number and relevance score.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        search_mode: {
          type: "string",
          description:
            "'hybrid' fuses vector similarity with BM25 keyword ranking; 'vector' uses embeddings only. Defaults to the app's configured mode.",
        },
        bm25_weight: {
          type: "number",
          description:
            "Hybrid mode only: weight of the BM25 keyword rank vs the vector rank, 0.0-1.0. Defaults to the app's configured value.",
        },
        top_k: {
          type: "number",
          description: "Number of top results to return. Defaults to the app's configured value.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "rag_status",
    description:
      "Report the state of the document index for the current folder: index state, Office documents " +
      "not yet converted, and any background job. Call this first for any question about the documents " +
      "in the folder. If `unconverted_office_docs` is not empty, tell the user how many and which files, " +
      "and ask whether to convert them before searching. If `state` is `empty`, ask whether to build the " +
      "index. Never start a conversion or index update without the user's consent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "convert_office_docs",
    description:
      "Convert Office documents (docx, xlsx, pptx, ...) in the folder to Markdown so they can be indexed. " +
      "This starts a background job and returns immediately; poll progress with `rag_status` until " +
      "`job.state` is `done` or `failed`. Only call this with the user's consent.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to convert, as listed in `unconverted_office_docs`.",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "rag_update_index",
    description:
      "Build or update the document index for the folder. This starts a background job and returns " +
      "immediately; poll progress with `rag_status` until `job.state` is `done` or `failed`. " +
      "Only call this with the user's consent.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function listRagTools(permission: RagPermission): McpToolDef[] {
  return permission === "read-only" ? TOOLS.filter((t) => !WRITE_TOOLS.has(t.name)) : TOOLS;
}

export interface RagToolDeps {
  permission: RagPermission;
  folderPath: string;
  readBridgeInfo: () => Promise<BridgeInfo | null>;
  callBridge: typeof callBridgeFn;
}

const LONG_TIMEOUT_MS = 150_000;
const STATUS_TIMEOUT_MS = 30_000;

async function execute(name: string, args: unknown, deps: RagToolDeps): Promise<McpToolResult> {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const isWrite = WRITE_TOOLS.has(name);
  if (isWrite && deps.permission === "read-only") {
    return toolText(`${name} is not available in a read-only session.`, true);
  }

  const approval = deps.permission === "auto" ? "auto" : "ask";
  let route: string;
  let body: Record<string, unknown>;
  let timeout = LONG_TIMEOUT_MS;
  switch (name) {
    case "rag_search":
      route = "/rag/search";
      body = {
        folder_path: deps.folderPath,
        query: a.query,
        limit: a.top_k,
        search_mode: a.search_mode,
        bm25_weight: a.bm25_weight,
      };
      break;
    case "rag_status":
      route = "/rag/status";
      body = { folder_path: deps.folderPath };
      timeout = STATUS_TIMEOUT_MS;
      break;
    case "convert_office_docs":
      route = "/rag/convert";
      body = { folder_path: deps.folderPath, paths: a.paths, approval };
      break;
    case "rag_update_index":
      route = "/rag/update";
      body = { folder_path: deps.folderPath, approval };
      break;
    default:
      return toolText(`Unknown tool: ${name}`, true);
  }

  const info = await deps.readBridgeInfo();
  if (!info) {
    return toolText("Cannot reach mdium (is the app running?). Fall back to the built-in file tools.", true);
  }

  const { status, json } = await deps.callBridge(info, route, body, timeout);
  const data = (typeof json === "object" && json !== null ? json : {}) as {
    ok?: boolean;
    error?: string;
    message?: string;
    results?: unknown[];
  };
  if (status < 200 || status >= 300) {
    return toolText(
      `${name} failed: ${data.error ?? "HTTP " + status}${data.message ? ": " + data.message : ""}`,
      true,
    );
  }

  if (name === "rag_search") {
    const results = data.results ?? [];
    if (results.length === 0) {
      return toolText(
        `No documents found related to "${String(a.query)}". Try the built-in file search tools instead.`,
      );
    }
    return toolText(JSON.stringify(results, null, 2));
  }
  return toolText(JSON.stringify(json, null, 2));
}

/** Run a tool; any thrown error (network, abort, ...) becomes an error result. */
export async function callRagTool(name: string, args: unknown, deps: RagToolDeps): Promise<McpToolResult> {
  try {
    return await execute(name, args, deps);
  } catch (e) {
    return toolText(`${name} failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
