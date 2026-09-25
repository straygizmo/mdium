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
  return { ...normalizeCopilot(request), rawKind: request.kind };
}

function normalizeCopilot(request: { kind: string; [k: string]: unknown }): Omit<ToolRequest, "rawKind"> {
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

/** Copilot request kinds that change the agent's own tooling or environment; never auto-approved. */
const EXTENSION_KINDS = new Set([
  "extension-management",
  "extension-permission-access",
  "extension-env-access",
  "factory",
  "custom-tool",
  "hook",
]);

/**
 * Decide a Copilot permission request for a mode; "ask" routes it to the
 * user. Reads are auto-approved only under `read-only` and `full-access`;
 * under `cli-default` every request, including reads, is confirmed by the
 * user each time (spec 2.1). Under `full-access`, extension, factory,
 * custom-tool, and hook requests are always rejected.
 */
export function copilotDecision(permission: AgentPermission, request: ToolRequest): "approve" | "reject" | "ask" {
  if (permission === "read-only") return request.kind === "read" ? "approve" : "reject";
  if (permission === "full-access") return request.rawKind && EXTENSION_KINDS.has(request.rawKind) ? "reject" : "approve";
  return "ask";
}

/** Normalize a Claude Agent SDK tool call (tool name + input) into a provider-neutral ToolRequest. */
export function toolRequestFromClaude(toolName: string, input: Record<string, unknown>): ToolRequest {
  return { ...normalizeClaude(toolName, input), rawKind: toolName };
}

function normalizeClaude(toolName: string, input: Record<string, unknown>): Omit<ToolRequest, "rawKind"> {
  switch (toolName) {
    case "Bash":
      return { kind: "shell", summary: field(input, "command") ?? toolName };
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return { kind: "write", summary: field(input, "file_path", "notebook_path") ?? toolName };
    case "Read":
    case "Grep":
    case "Glob":
      return { kind: "read", summary: field(input, "file_path", "path", "pattern") ?? toolName };
    case "WebFetch":
      return { kind: "network", summary: field(input, "url") ?? toolName };
    case "WebSearch":
      return { kind: "network", summary: field(input, "query") ?? toolName };
    case "TodoWrite":
      // Task-list bookkeeping with no side effects outside the session.
      return { kind: "read", summary: toolName };
    default:
      // Sub-agent, MCP, cron, worktree, and other tools.
      return { kind: "other", summary: toolName };
  }
}

/**
 * Decide a Claude tool call for a mode; "ask" routes it to the user.
 * read-only allows reads and WebSearch only. full-access allows everything
 * (the safety guard runs before this decision). cli-default allows reads and
 * asks for everything else.
 */
export function claudeDecision(permission: AgentPermission, request: ToolRequest): "allow" | "deny" | "ask" {
  if (permission === "read-only") {
    return request.kind === "read" || (request.kind === "network" && request.rawKind === "WebSearch") ? "allow" : "deny";
  }
  if (permission === "full-access") return "allow";
  return request.kind === "read" ? "allow" : "ask";
}
