/** Providers driven by the agent runner sidecar. opencode keeps its own server/panel. */
export type AgentProvider = "codex" | "copilot";

/** Providers the agent-runner protocol can address, including workflow-only providers. */
export type RunnerProvider = "codex" | "copilot" | "opencode" | "claude";

/** Guard rule ids that can trigger a `guard_violation`. */
export type GuardRule = "git-remote" | "forge-cli" | "outside-workspace" | "credentials" | "network-send" | "system-config";

/**
 * cli-default: do not override the CLI's own configuration (AGENT CHAT).
 * read-only: enforce read-only tools.
 * full-access: no restriction (only used together with the Part 3 safety guard).
 */
export type AgentPermission = "cli-default" | "read-only" | "full-access";

export type Availability =
  | { kind: "available"; version: string }
  | { kind: "missing" | "unauthenticated" | "too_old" | "error"; detail: string; detectedVersion?: string };

/** Normalized tool call that needs a permission decision. */
export interface ToolRequest {
  kind: "shell" | "write" | "read" | "network" | "other";
  /** Command line, path, or tool name shown to the user. */
  summary: string;
  /** Provider-specific request kind or tool name, used by provider policies. */
  rawKind?: string;
}

export type AgentEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_started"; toolId: string; title: string }
  | { type: "tool_finished"; toolId: string; ok: boolean };

export interface AgentSessionSummary {
  nativeSessionId: string;
  title?: string;
  updatedAt?: string;
}

/** mdium -> runner (one JSON object per stdin line). */
export type RunnerInbound =
  | { type: "probe"; requestId: string; provider: RunnerProvider }
  | {
      type: "start_session";
      requestId: string;
      /** Chosen by mdium; unique per runner process. */
      sessionId: string;
      provider: RunnerProvider;
      workingDirectory: string;
      permission: AgentPermission;
      model?: string;
      /** Resume an existing provider-native session instead of creating one. */
      resumeNativeId?: string;
      /** Extra environment for the agent's child processes. */
      env?: Record<string, string>;
      /** Per-turn timeout; omitted means no timeout. */
      timeoutMs?: number;
      /** Enable the runtime safety guard; paths outside workspaceRoot are blocked. */
      guard?: { workspaceRoot: string };
    }
  | { type: "send"; sessionId: string; text: string }
  | { type: "cancel"; sessionId: string }
  | { type: "respond_permission"; sessionId: string; permissionId: string; allow: boolean }
  | { type: "list_sessions"; requestId: string; provider: RunnerProvider; workingDirectory: string }
  | { type: "close_session"; sessionId: string };

/** runner -> mdium (one JSON object per stdout line). */
export type RunnerOutbound =
  | { type: "ready" }
  | { type: "availability"; requestId: string; provider: RunnerProvider; availability: Availability }
  | { type: "session_started"; requestId: string; sessionId: string; nativeSessionId?: string }
  | { type: "event"; sessionId: string; event: AgentEvent }
  | { type: "permission_request"; sessionId: string; permissionId: string; request: ToolRequest }
  | { type: "turn_completed"; sessionId: string; finalResponse: string; nativeSessionId?: string }
  | { type: "turn_failed"; sessionId: string; message: string }
  | { type: "turn_cancelled"; sessionId: string }
  | { type: "session_list"; requestId: string; sessions: AgentSessionSummary[] }
  | { type: "guard_violation"; sessionId: string; rule: GuardRule; summary: string }
  | { type: "error"; message: string; requestId?: string; sessionId?: string };
