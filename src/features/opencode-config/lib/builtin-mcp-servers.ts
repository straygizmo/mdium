import type { BuiltinMcpServer } from "@/shared/types";

export const BUILTIN_MCP_SERVERS: Record<string, BuiltinMcpServer> = {
  "image-generator": {
    serverName: "image-generator",
    type: "local",
    command: ["node", "<resources_path>/mcp-servers/image-generator/dist/index.js"],
    enabled: true,
    environment: {
      IMAGE_PROVIDER: "openai",
      IMAGE_API_KEY: "",
      IMAGE_MODEL: "dall-e-3",
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
