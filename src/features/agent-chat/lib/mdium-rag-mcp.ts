import { invoke } from "@tauri-apps/api/core";
import type { AgentPermission } from "@/shared/types/agent-runner";
import type { ClaudePermissionMode } from "@/shared/types/claude-sidecar";
import type { StdioMcpServerSpec } from "@/shared/types/rag-bridge";
import { useSettingsStore, type MdiumRagProvider } from "@/stores/settings-store";

export type MdiumRagPermission = "read-only" | "ask" | "auto";

export const MDIUM_RAG_SERVER_NAME = "mdium-rag";

export function mdiumRagPermissionFor(p: AgentPermission): MdiumRagPermission {
  switch (p) {
    case "read-only":
      return "read-only";
    case "full-access":
      return "auto";
    default:
      return "ask";
  }
}

export function mdiumRagPermissionForClaude(m: ClaudePermissionMode): MdiumRagPermission {
  if (m === "plan") return "read-only";
  if (m === "bypassPermissions") return "auto";
  return "ask";
}

export function buildMdiumRagServer(
  mcpServersPath: string,
  permission: MdiumRagPermission,
): StdioMcpServerSpec {
  // Reuse the separator already present in the resolved path.
  const sep = mcpServersPath.includes("\\") ? "\\" : "/";
  const entry = [mcpServersPath, "mdium-rag", "dist", "index.js"].join(sep);
  return { command: "node", args: [entry], env: { MDIUM_RAG_PERMISSION: permission } };
}

/** Returns the MCP server map for a session, or undefined when disabled or unresolvable. */
export async function mdiumRagServerFor(
  provider: MdiumRagProvider,
  permission: MdiumRagPermission,
): Promise<Record<string, StdioMcpServerSpec> | undefined> {
  if (!useSettingsStore.getState().mdiumRagTools[provider]) return undefined;
  try {
    const path = await invoke<string>("resolve_mcp_servers_path");
    return { [MDIUM_RAG_SERVER_NAME]: buildMdiumRagServer(path, permission) };
  } catch (e) {
    console.warn("[mdium-rag] could not resolve the MCP servers path:", e);
    return undefined;
  }
}
