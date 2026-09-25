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
    case "PowerShell":
    case "Monitor":
      return { kind: "shell", summary: field(input, "command") ?? toolName };
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return { kind: "write", summary: field(input, "file_path", "notebook_path") ?? toolName };
    case "Read":
      return { kind: "read", summary: field(input, "file_path") ?? toolName };
    case "Grep": {
      // The search pattern is not a path; an absent path means the working directory.
      // A glob filter names the files Grep reads, so the guard must see it.
      const dir = field(input, "path") ?? ".";
      const glob = field(input, "glob");
      return { kind: "read", summary: glob ? `${dir.replace(/[\\/]+$/, "")}/${glob}` : dir };
    }
    case "Glob":
      // Glob only lists file names; its pattern is not a path.
      return { kind: "read", summary: field(input, "path") ?? "." };
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

/** Built-in Claude tools that run code or schedule work the guard cannot inspect. */
const OPAQUE_CLAUDE_TOOLS = ["REPL", "RemoteTrigger", "CronCreate", "CronDelete", "Workflow"];

/**
 * `other`-kind Claude tools allowed in guarded or read-only sessions: sub-agents
 * (whose own tool calls pass the PreToolUse hook) and session bookkeeping.
 * Every other `other`-kind tool (MCP, artifacts, notifications, worktrees,
 * schedulers, unknown future tools) is denied there.
 */
const ALLOWED_OTHER_CLAUDE_TOOLS = new Set([
  "Agent",
  "Task",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "AskUserQuestion",
  "ExitPlanMode",
]);

/**
 * Decision of the PreToolUse hook, which sees every tool call (including ones
 * that settings, hooks, or the CLI pre-approve and never reach canUseTool).
 * "deny" blocks the call; "none" leaves it to the normal permission flow.
 * Guarded or read-only sessions deny `other`-kind tools outside an allowlist,
 * since the guard cannot inspect their effects.
 */
export function claudeHookDecision(permission: AgentPermission, guarded: boolean, request: ToolRequest): "deny" | "none" {
  const restricted = guarded || permission === "read-only";
  if (restricted && request.kind === "other" && !ALLOWED_OTHER_CLAUDE_TOOLS.has(request.rawKind ?? "")) return "deny";
  if (permission === "read-only" && claudeDecision(permission, request) === "deny") return "deny";
  return "none";
}

/** Built-in tools removed from the model's context in guarded or read-only sessions. */
export function claudeDisallowedTools(permission: AgentPermission, guarded: boolean): string[] {
  return guarded || permission === "read-only" ? [...OPAQUE_CLAUDE_TOOLS] : [];
}
