import type {
  AgentEvent,
  AgentPermission,
  AgentSessionSummary,
  Availability,
  ToolRequest,
} from "../../src/shared/types/agent-runner";

export interface SessionOptions {
  workingDirectory: string;
  permission: AgentPermission;
  model?: string;
  resumeNativeId?: string;
  env?: Record<string, string>;
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
  close(): Promise<void>;
}
export interface ProviderAdapter {
  probe(): Promise<Availability>;
  startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession>;
  listSessions?(workingDirectory: string): Promise<AgentSessionSummary[]>;
  /** Release adapter-wide resources (e.g. shared servers) when the runner shuts down. */
  dispose?(): Promise<void>;
}
