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
}
export interface SessionCallbacks {
  onEvent(event: AgentEvent): void;
  /** Ask the user (via mdium) to approve a tool request. Resolves true to allow. */
  requestPermission(request: ToolRequest): Promise<boolean>;
}
export interface AdapterSession {
  /** Provider-native id, known after the first turn for Codex. */
  nativeSessionId(): string | undefined;
  /** Run one turn; resolves with the final assistant text. Rejects on failure; aborting `signal` cancels. */
  runTurn(text: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
export interface ProviderAdapter {
  probe(): Promise<Availability>;
  startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession>;
  listSessions?(workingDirectory: string): Promise<AgentSessionSummary[]>;
}
