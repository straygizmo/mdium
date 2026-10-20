import { createMcpHandler } from "../mcp-lib/jsonrpc-server";
import { callBridge, readBridgeInfo } from "./bridge-client";
import { callRagTool, listRagTools, parsePermission, type RagToolDeps } from "./tools";

export const SERVER_NAME = "mdium-rag";
export const SERVER_VERSION = "1.0.0";

export function createRagServer(deps: Partial<RagToolDeps> = {}): ReturnType<typeof createMcpHandler> {
  const full: RagToolDeps = {
    permission: parsePermission(process.env.MDIUM_RAG_PERMISSION),
    folderPath: process.cwd(),
    readBridgeInfo: () => readBridgeInfo(),
    callBridge,
    ...deps,
  };
  return createMcpHandler({
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    listTools: () => listRagTools(full.permission),
    callTool: (name, args) => callRagTool(name, args, full),
  });
}
