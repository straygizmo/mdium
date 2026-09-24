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

/**
 * Decide a Copilot permission request for a mode; "ask" routes it to the
 * user. Reads are auto-approved only under `read-only` and `full-access`;
 * under `cli-default` every request, including reads, is confirmed by the
 * user each time (spec 2.1).
 */
export function copilotDecision(permission: AgentPermission, request: ToolRequest): "approve" | "reject" | "ask" {
  if (permission === "read-only") return request.kind === "read" ? "approve" : "reject";
  if (permission === "full-access") return "approve";
  return "ask";
}
