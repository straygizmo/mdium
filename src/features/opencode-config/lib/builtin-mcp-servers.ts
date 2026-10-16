import type { BuiltinMcpServer } from "@/shared/types";

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
  // Office/PDF -> Markdown (`convert_to_markdown` tool); bundled by
  // scripts/build-doc-converter.mjs, needs no configuration.
  "mdium-docs": {
    serverName: "mdium-docs",
    type: "local",
    command: ["node", "<mcp_servers_path>\\mdium-docs\\dist\\index.js"],
    enabled: true,
    environment: {},
  },
};

/** Resolve <mcp_servers_path> placeholder with actual path */
export function resolveBuiltinCommand(
  command: string[],
  mcpServersPath: string
): string[] {
  return command.map((part) => part.replace("<mcp_servers_path>", mcpServersPath));
}
