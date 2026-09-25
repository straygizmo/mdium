import * as path from "node:path";
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
    // Claude's Bash tool runs Git Bash on Windows, so it is always lexed as posix.
    case "Bash":
      return { kind: "shell", summary: field(input, "command") ?? toolName, shell: "posix" };
    case "PowerShell":
      return { kind: "shell", summary: field(input, "command") ?? toolName, shell: "powershell" };
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

/** An opencode permission request (v1 `permission.updated` shape; `permission.asked` is normalized into it). */
export interface OpencodePermissionLike {
  type: string;
  pattern?: string | string[];
  title?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Where an opencode session runs. opencode reports read/edit/apply_patch paths
 * relative to the git worktree root and glob/grep paths relative to the
 * session directory, while the guard resolves relative paths against the
 * workspace root; requests are therefore made absolute first.
 */
export interface OpencodePaths {
  directory: string;
  worktree: string;
}

function opencodePatterns(permission: OpencodePermissionLike): string[] {
  const { pattern } = permission;
  if (typeof pattern === "string") return pattern ? [pattern] : [];
  return Array.isArray(pattern) ? pattern.filter((p): p is string => typeof p === "string" && p !== "") : [];
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** Resolve `p` against `base` with the path flavor of `base`; absolute paths are kept. */
function absolute(base: string | undefined, p: string): string {
  if (!base || isWindowsPath(p) || path.posix.isAbsolute(p)) return p;
  return isWindowsPath(base) ? path.win32.resolve(base, p) : path.posix.resolve(base, p);
}

/** Normalize an opencode permission request into a provider-neutral ToolRequest. */
export function toolRequestFromOpencode(permission: OpencodePermissionLike, paths?: OpencodePaths): ToolRequest {
  return { ...normalizeOpencode(permission, paths), rawKind: permission.type };
}

function normalizeOpencode(permission: OpencodePermissionLike, paths?: OpencodePaths): Omit<ToolRequest, "rawKind"> {
  const metadata = permission.metadata ?? {};
  const patterns = opencodePatterns(permission);
  const first = patterns[0];
  const fromWorktree = (p: string) => absolute(paths?.worktree, p);
  const fromDirectory = (p: string) => absolute(paths?.directory, p);
  switch (permission.type) {
    case "bash":
      // opencode's bash tool runs a posix shell (Git Bash on Windows).
      return {
        kind: "shell",
        summary: field(metadata, "command") ?? (patterns.length ? patterns.join("\n") : undefined) ?? permission.title ?? "bash",
        shell: "posix",
      };
    case "edit":
    case "write": {
      // A multi-file apply_patch joins its (worktree-relative) paths into `filepath`; use the first pattern then.
      const file = patterns.length > 1 ? first : (field(metadata, "filePath", "filepath") ?? first);
      return { kind: "write", summary: file ? fromWorktree(file) : permission.type };
    }
    case "external_directory": {
      // Treated as a write so the guard's outside-workspace rule applies.
      const dir = field(metadata, "filepath", "filePath", "path") ?? first;
      return { kind: "write", summary: dir ? fromDirectory(dir) : permission.type };
    }
    case "read":
    case "list": {
      const file = field(metadata, "filePath", "filepath", "path") ?? first;
      return { kind: "read", summary: file ? fromWorktree(file) : permission.type };
    }
    case "glob":
      // The glob pattern is not a path; the searched directory is.
      return { kind: "read", summary: fromDirectory(field(metadata, "path") ?? ".") };
    case "grep": {
      // The search pattern is not a path; an include glob names the files grep reads.
      const dir = fromDirectory(field(metadata, "path") ?? ".");
      const include = field(metadata, "include");
      return { kind: "read", summary: include ? `${dir.replace(/[\\/]+$/, "")}/${include}` : dir };
    }
    case "todowrite":
      // Task-list bookkeeping with no side effects outside the session.
      return { kind: "read", summary: permission.type };
    case "webfetch":
      return { kind: "network", summary: field(metadata, "url") ?? first ?? permission.type };
    case "websearch":
      return { kind: "network", summary: field(metadata, "query") ?? first ?? permission.type };
    default:
      return { kind: "other", summary: permission.title ?? permission.type };
  }
}

/**
 * Requests the safety guard must check for an opencode permission: one per
 * path for multi-path writes (a patch touching several files, a shell
 * command reaching several outside directories), else the single request.
 */
export function toolRequestsFromOpencode(permission: OpencodePermissionLike, paths?: OpencodePaths): ToolRequest[] {
  const request = toolRequestFromOpencode(permission, paths);
  const patterns = opencodePatterns(permission);
  if (request.kind === "write" && patterns.length > 1) {
    const base = permission.type === "external_directory" ? paths?.directory : paths?.worktree;
    return patterns.map((p) => ({ kind: "write", summary: absolute(base, p), rawKind: permission.type }));
  }
  return [request];
}

/** Env files that opencode itself asks about before reading; templates are exempt. */
function isEnvFile(summary: string): boolean {
  const name = summary.split(/[\\/]/).pop() ?? "";
  return /^\.env(\..+)?$/i.test(name) && !/^\.env\.(example|sample|template)$/i.test(name);
}

/**
 * Decide an opencode permission request for a mode; "ask" routes it to the
 * user. The dedicated server makes reads ask too, only so that the safety
 * guard sees them first; they are approved in every mode, except env files
 * under cli-default (which opencode itself would ask about).
 */
export function opencodeDecision(permission: AgentPermission, request: ToolRequest): "once" | "reject" | "ask" {
  if (request.kind === "read") return permission === "cli-default" && isEnvFile(request.summary) ? "ask" : "once";
  if (permission === "read-only") return "reject";
  if (permission === "full-access") return "once";
  return "ask";
}

export interface OpencodeAgentNames {
  readOnly: string;
  guarded: string;
  open: string;
}

/** Rules of the read-only and guarded agents. `"*"` must stay first: opencode applies the last matching rule. */
function opencodeRestrictedRules(readOnly: boolean): Record<string, string> {
  const write = readOnly ? "deny" : "ask";
  return {
    "*": "deny",
    invalid: "allow",
    todowrite: "allow",
    skill: "allow",
    read: "ask",
    glob: "ask",
    grep: "ask",
    list: "ask",
    lsp: "ask",
    doom_loop: "ask",
    edit: write,
    bash: write,
    webfetch: write,
    websearch: write,
    external_directory: write,
  };
}

/** The OPENCODE_CONFIG_CONTENT of the dedicated server (see opencode-adapter.ts for the rationale). */
export function opencodeServerConfig(agents: OpencodeAgentNames) {
  return {
    // Workflow sessions are never uploaded, whatever the user's share setting is.
    share: "disabled",
    // Formatters and language servers run project-controlled programs outside the
    // permission flow; one server serves every session, so they are off server-wide.
    formatter: false,
    lsp: false,
    permission: { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" },
    agent: {
      [agents.readOnly]: { mode: "primary", description: "MDium read-only workflow stage", permission: opencodeRestrictedRules(true) },
      [agents.guarded]: { mode: "primary", description: "MDium guarded workflow stage", permission: opencodeRestrictedRules(false) },
      // Unguarded stages: every tool that asks is routed to the adapter; sub-agents are allowed.
      [agents.open]: {
        mode: "primary",
        description: "MDium workflow stage",
        permission: { "*": "ask", invalid: "allow", todowrite: "allow", question: "deny", plan_enter: "deny", plan_exit: "deny" },
      },
    },
  };
}
