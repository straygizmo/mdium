import type { BuiltinMcpServer } from "@/shared/types";

export const BUILTIN_MCP_SERVERS: Record<string, BuiltinMcpServer> = {
  "nano-banana-2": {
    serverName: "nano-banana-2",
    type: "local",
    command: ["node", "<resources_path>\\mcp-servers\\nano-banana-2\\dist\\index.js"],
    enabled: true,
    environment: {
      GEMINI_API_KEY: "{env:GEMINI_API_KEY}",
      GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image-preview",
      IMAGE_OUTPUT_DIR: "",
    },
  },
};

/** Resolve <resources_path> placeholder with actual path */
export function resolveBuiltinCommand(
  command: string[],
  resourcesPath: string
): string[] {
  return command.map((part) => part.replace("<resources_path>", resourcesPath));
}
