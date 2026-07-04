/** Permission modes accepted by the Claude Agent SDK. */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/** mdium -> sidecar messages (one JSON object per stdin line). */
export interface StartSessionMessage {
  type: "start_session";
  cwd: string;
  /** Empty/undefined means "use the CLI default model". */
  model?: string;
  permissionMode: ClaudePermissionMode;
  resumeSessionId?: string;
  systemPromptAppend?: string;
}
export interface UserMessageMessage {
  type: "user_message";
  text: string;
}
export interface PermissionResponseMessage {
  type: "permission_response";
  id: string;
  behavior: "allow" | "deny";
  message?: string;
}
export type SidecarInbound =
  | StartSessionMessage
  | UserMessageMessage
  | PermissionResponseMessage
  | { type: "interrupt" }
  | { type: "stop" };

/** sidecar -> mdium messages (one JSON object per stdout line). */
export interface SidecarPermissionRequest {
  type: "permission_request";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}
export type SidecarOutbound =
  | { type: "ready" }
  /** Raw SDKMessage passthrough; UI-side mapping happens in claude-message-mapper. */
  | { type: "sdk_event"; event: Record<string, unknown> }
  | SidecarPermissionRequest
  | { type: "session_closed" }
  | { type: "error"; message: string; fatal?: boolean };
