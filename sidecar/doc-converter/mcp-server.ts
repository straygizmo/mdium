// Minimal MCP server (stdio transport, newline-delimited JSON-RPC 2.0) with a
// single tool, `convert_to_markdown`, so any MCP-capable agent can read
// Office/PDF documents. Kept dependency-free: only initialize, ping,
// tools/list and tools/call are needed.
import * as path from "node:path";
import { CONVERTIBLE_EXTENSIONS } from "../../src/features/export/lib/core";
import { convertFile, convertFileToMarkdown } from "./convert-file";

export const SERVER_NAME = "mdium-docs";
export const SERVER_VERSION = "1.0.0";
export const TOOL_NAME = "convert_to_markdown";

/** Default cap on the Markdown returned inline, in characters. */
export const DEFAULT_MAX_CHARS = 200_000;

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL = {
  name: TOOL_NAME,
  description:
    "Convert an Office or PDF document (" +
    CONVERTIBLE_EXTENSIONS.map((e) => `.${e}`).join(", ") +
    ") to Markdown and return the Markdown text. Use this to read binary documents such as Word, Excel, " +
    "PowerPoint or PDF files. Optionally also writes the Markdown (with extracted images) to output_path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the document to convert." },
      output_path: {
        type: "string",
        description: "Optional absolute path of a .md file to write; images are written next to it.",
      },
      max_chars: {
        type: "number",
        description: `Maximum number of characters of Markdown to return (default ${DEFAULT_MAX_CHARS}).`,
      },
    },
    required: ["path"],
  },
};

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** Run the tool; failures become a tool result with `isError`, as MCP expects. */
export async function callConvertTool(args: unknown) {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const input = a.path;
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    return toolText("`path` must be an absolute file path.", true);
  }
  const outputPath = a.output_path;
  if (outputPath !== undefined && (typeof outputPath !== "string" || !path.isAbsolute(outputPath))) {
    return toolText("`output_path` must be an absolute file path.", true);
  }
  const maxChars =
    typeof a.max_chars === "number" && Number.isFinite(a.max_chars) && a.max_chars > 0
      ? Math.floor(a.max_chars)
      : DEFAULT_MAX_CHARS;
  try {
    const { markdown } = await convertFile(input);
    let note = "";
    if (typeof outputPath === "string") {
      const written = await convertFileToMarkdown(input, outputPath);
      note = `\n\n<!-- Markdown written to ${written.markdownPath} (${written.assetCount} assets) -->`;
    }
    const truncated = markdown.length > maxChars;
    const body = truncated
      ? `${markdown.slice(0, maxChars)}\n\n<!-- Truncated: returned ${maxChars} of ${markdown.length} characters. -->`
      : markdown;
    return toolText(body + note);
  } catch (error) {
    return toolText(`Conversion failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

/**
 * Handle one incoming JSON-RPC message. Returns the response to send, or
 * undefined for notifications (messages without an id).
 */
export async function handleMcpMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
  if (!message || typeof message !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const req = message as JsonRpcRequest;
  const isNotification = req.id === undefined;
  const id: JsonRpcId = req.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

  if (isNotification) return undefined;
  switch (req.method) {
    case "initialize": {
      const requested = (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (params.name !== TOOL_NAME) return fail(-32602, `Unknown tool: ${String(params.name)}`);
      return ok(await callConvertTool(params.arguments));
    }
    default:
      return fail(-32601, `Method not found: ${String(req.method)}`);
  }
}

/** Parse one stdin line and handle it; a parse error yields a JSON-RPC error. */
export async function handleMcpLine(line: string): Promise<JsonRpcResponse | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }
  return handleMcpMessage(parsed);
}
