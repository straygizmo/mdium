import type {
  AgentEvent,
  AgentModelInfo,
  AgentPermission,
  AgentSessionSummary,
  Availability,
  ToolRequest,
} from "../../src/shared/types/agent-runner";
import type { StdioMcpServerSpec } from "../../src/shared/types/rag-bridge";

export interface SessionOptions {
  workingDirectory: string;
  permission: AgentPermission;
  model?: string;
  resumeNativeId?: string;
  env?: Record<string, string>;
  /** Extra stdio MCP servers to attach to the session, keyed by server name. */
  mcpServers?: Record<string, StdioMcpServerSpec>;
  /** True when start_session enabled the runtime safety guard; the verdict itself comes from checkTool. */
  guarded: boolean;
}
export interface SessionCallbacks {
  onEvent(event: AgentEvent): void;
  /** Ask the user (via mdium) to approve a tool request. Resolves true to allow. */
  requestPermission(request: ToolRequest): Promise<boolean>;
  /**
   * Check a tool call against the runtime safety guard. Returns true when it is allowed
   * (always, when no guard is configured). A blocked call aborts the running turn.
   */
  checkTool(request: ToolRequest): boolean;
}
export interface AdapterSession {
  /** Provider-native id, known after the first turn for Codex. */
  nativeSessionId(): string | undefined;
  /**
   * Run one turn; resolves with the final assistant text. Rejects on failure; aborting `signal` cancels.
   * `images` are validated absolute image paths inside the session's workspace root.
   */
  runTurn(text: string, signal: AbortSignal, images?: readonly string[]): Promise<string>;
  /** Cost in USD of the last completed turn, when the provider reports it. */
  lastTurnCostUsd?(): number | undefined;
  close(): Promise<void>;
}
export interface ProviderAdapter {
  probe(): Promise<Availability>;
  startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession>;
  listSessions?(workingDirectory: string): Promise<AgentSessionSummary[]>;
  /** Models the provider offers, for the settings UI. */
  listModels?(workingDirectory: string): Promise<AgentModelInfo[]>;
  /** Release adapter-wide resources (e.g. shared servers) when the runner shuts down. */
  dispose?(): Promise<void>;
}
