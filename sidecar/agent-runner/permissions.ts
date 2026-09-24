import type { AgentPermission, ToolRequest } from "../../src/shared/types/agent-runner";

/** Codex sandbox for a permission mode; undefined leaves the user's CLI config in charge. */
export function codexSandbox(permission: AgentPermission): "read-only" | "danger-full-access" | undefined {
  if (permission === "read-only") return "read-only";
  if (permission === "full-access") return "danger-full-access";
  return undefined;
}

function field(request: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = request[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Normalize a Copilot SDK permission request into a provider-neutral ToolRequest. */
export function toolRequestFromCopilot(request: { kind: string; [k: string]: unknown }): ToolRequest {
  switch (request.kind) {
    case "shell":
      return { kind: "shell", summary: field(request, "fullCommandText", "intention") ?? "shell" };
    case "write":
      return { kind: "write", summary: field(request, "fileName") ?? "write" };
    case "read":
      return { kind: "read", summary: field(request, "path") ?? "read" };
    case "url":
      return { kind: "network", summary: field(request, "url") ?? "url" };
    case "mcp": {
      const server = field(request, "serverName");
      const tool = field(request, "toolName");
      return { kind: "other", summary: server && tool ? `${server}/${tool}` : (tool ?? server ?? "mcp") };
    }
    default:
      return { kind: "other", summary: request.kind };
  }
}

/** Decide a Copilot permission request for a mode; "ask" routes it to the user. */
export function copilotDecision(permission: AgentPermission, request: ToolRequest): "approve" | "reject" | "ask" {
  if (request.kind === "read") return "approve";
  if (permission === "read-only") return "reject";
  if (permission === "full-access") return "approve";
  return "ask";
}
