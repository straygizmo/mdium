// Generic, dependency-free JSON-RPC handler for a stdio MCP server. A server
// supplies its tool list and tool dispatcher; this module owns the protocol.

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

/** Wrap text as a tool result; failures are results with `isError`, not JSON-RPC errors. */
export function toolText(text: string, isError = false): McpToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export interface McpHandlerOptions {
  serverName: string;
  serverVersion: string;
  /** A function so a server can vary its tool list (e.g. by permission). */
  listTools: () => McpToolDef[];
  callTool: (name: string, args: unknown) => Promise<McpToolResult>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createMcpHandler(opts: McpHandlerOptions): {
  handleMcpMessage(message: unknown): Promise<JsonRpcResponse | undefined>;
  handleMcpLine(line: string): Promise<JsonRpcResponse | undefined>;
} {
  async function handleMcpMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof message !== "object" || message === null) {
      return rpcError(null, -32600, "Invalid Request");
    }
    const { id, method, params } = message as {
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    // A message without an id is a notification: never answered.
    if (id === undefined) return undefined;

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: opts.serverName, version: opts.serverVersion },
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: opts.listTools() } };
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !opts.listTools().some((t) => t.name === name)) {
          return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        }
        return { jsonrpc: "2.0", id, result: await opts.callTool(name, params?.arguments) };
      }
      default:
        return rpcError(id, -32601, `Method not found: ${String(method)}`);
    }
  }

  async function handleMcpLine(line: string): Promise<JsonRpcResponse | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    return handleMcpMessage(message);
  }

  return { handleMcpMessage, handleMcpLine };
}
