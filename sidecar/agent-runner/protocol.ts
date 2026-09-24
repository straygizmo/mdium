import type { AgentPermission, AgentProvider, RunnerInbound } from "../../src/shared/types/agent-runner";

const PROVIDERS: readonly AgentProvider[] = ["codex", "copilot"];
const PERMISSIONS: readonly AgentPermission[] = ["cli-default", "read-only", "full-access"];

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}`);
  return value;
}

function provider(value: unknown): AgentProvider {
  if (!PROVIDERS.includes(value as AgentProvider)) throw new Error("Invalid provider");
  return value as AgentProvider;
}

/** Parse and validate one inbound JSON line. Throws on any invalid shape. */
export function parseInbound(line: string): RunnerInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid message");
  const m = parsed as Record<string, unknown>;
  switch (m.type) {
    case "probe":
      return { type: "probe", requestId: str(m.requestId, "requestId"), provider: provider(m.provider) };
    case "start_session": {
      if (!PERMISSIONS.includes(m.permission as AgentPermission)) throw new Error("Invalid permission");
      if (m.env !== undefined) {
        if (!m.env || typeof m.env !== "object" || Object.values(m.env).some((v) => typeof v !== "string")) {
          throw new Error("Invalid env");
        }
      }
      if (m.timeoutMs !== undefined && (typeof m.timeoutMs !== "number" || !(m.timeoutMs > 0))) {
        throw new Error("Invalid timeoutMs");
      }
      if (m.model !== undefined && typeof m.model !== "string") throw new Error("Invalid model");
      if (m.resumeNativeId !== undefined) str(m.resumeNativeId, "resumeNativeId");
      return {
        type: "start_session",
        requestId: str(m.requestId, "requestId"),
        sessionId: str(m.sessionId, "sessionId"),
        provider: provider(m.provider),
        workingDirectory: str(m.workingDirectory, "workingDirectory"),
        permission: m.permission as AgentPermission,
        ...(m.model ? { model: m.model as string } : {}),
        ...(m.resumeNativeId ? { resumeNativeId: m.resumeNativeId as string } : {}),
        ...(m.env ? { env: m.env as Record<string, string> } : {}),
        ...(m.timeoutMs ? { timeoutMs: m.timeoutMs as number } : {}),
      };
    }
    case "send":
      if (typeof m.text !== "string") throw new Error("Invalid text");
      return { type: "send", sessionId: str(m.sessionId, "sessionId"), text: m.text };
    case "cancel":
      return { type: "cancel", sessionId: str(m.sessionId, "sessionId") };
    case "respond_permission":
      if (typeof m.allow !== "boolean") throw new Error("Invalid allow");
      return {
        type: "respond_permission",
        sessionId: str(m.sessionId, "sessionId"),
        permissionId: str(m.permissionId, "permissionId"),
        allow: m.allow,
      };
    case "list_sessions":
      return {
        type: "list_sessions",
        requestId: str(m.requestId, "requestId"),
        provider: provider(m.provider),
        workingDirectory: str(m.workingDirectory, "workingDirectory"),
      };
    case "close_session":
      return { type: "close_session", sessionId: str(m.sessionId, "sessionId") };
    default:
      throw new Error("Unknown message type");
  }
}
