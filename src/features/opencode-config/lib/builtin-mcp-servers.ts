import type { BuiltinMcpServer } from "@/shared/types";
import { invoke } from "@tauri-apps/api/core";

export const BUILTIN_MCP_SERVERS: Record<string, BuiltinMcpServer> = {
  "nano-banana-2": {
    serverName: "nano-banana-2",
    type: "local",
    command: ["node", "<mcp_servers_path>\\nano-banana-2\\dist\\index.js"],
    enabled: true,
    environment: {
      GEMINI_API_KEY: "{env:GEMINI_API_KEY}",
      GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image-preview",
    },
  },
  "mdium-vba": {
    serverName: "mdium-vba",
    type: "local",
    command: ["node", "<mcp_servers_path>\\mdium-vba\\dist\\index.js"],
    enabled: false,
    environment: {
      MDIUM_VBA_PORT: "<placeholder>",
      MDIUM_VBA_TOKEN: "<placeholder>",
    },
  },
};

/** Resolve <mcp_servers_path> placeholder with actual path */
export function resolveBuiltinCommand(
  command: string[],
  mcpServersPath: string
): string[] {
  return command.map((part) => part.replace("<mcp_servers_path>", mcpServersPath));
}

/**
 * Resolve mdium-vba MCP server with concrete env vars.
 * Port/token are fetched from the HTTP bridge; xlsm is determined at tool-call
 * time by the MCP server itself via GET /active-xlsm (not baked in).
 * Returns null if the HTTP bridge is not yet started.
 */
export async function resolveMdiumVbaMcpServer(
  mcpServersPath: string
): Promise<{
  serverName: string;
  type: "local";
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
} | null> {
  const bridge = await invoke<{ port: number; token: string } | null>(
    "get_http_bridge_info"
  ).catch(() => null);
  if (!bridge) return null;

  const template = BUILTIN_MCP_SERVERS["mdium-vba"];
  return {
    serverName: template.serverName,
    type: "local",
    command: resolveBuiltinCommand(template.command, mcpServersPath),
    enabled: true,
    environment: {
      MDIUM_VBA_PORT: String(bridge.port),
      MDIUM_VBA_TOKEN: bridge.token,
    },
  };
}
