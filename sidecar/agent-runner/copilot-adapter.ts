import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { AgentSessionSummary, Availability, ToolRequest } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { copilotDecision, toolRequestFromCopilot } from "./permissions";
import { resolveCopilotPath } from "./resolve-cli";
import { MINIMUM_COPILOT_VERSION, isAtLeast } from "./availability";

type CopilotEvent = { type: string; data?: unknown };
type PermissionResult = { kind: "approve-once" } | { kind: "reject" };
interface CopilotSessionConfigLike {
  workingDirectory: string;
  model?: string;
  onPermissionRequest: (request: { kind: string; [k: string]: unknown }) => Promise<PermissionResult>;
}

export interface CopilotSessionLike {
  readonly sessionId: string;
  on(handler: (event: CopilotEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getStatus(): Promise<{ version: string }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  createSession(config: CopilotSessionConfigLike): Promise<CopilotSessionLike>;
  resumeSession(id: string, config: CopilotSessionConfigLike): Promise<CopilotSessionLike>;
  listSessions(): Promise<Array<{ sessionId: string; summary?: string; modifiedTime?: Date }>>;
}

export interface CopilotAdapterDeps {
  createClient: (options: { cliPath: string; workingDirectory: string; env?: Record<string, string> }) => CopilotClientLike;
  resolvePath: () => Promise<string | null>;
}

function abortError(): Error {
  return Object.assign(new Error("Turn cancelled"), { name: "AbortError" });
}

function eventData<T>(event: CopilotEvent): T {
  return (event.data ?? {}) as T;
}

class CopilotAgentSession implements AdapterSession {
  constructor(
    private readonly client: CopilotClientLike,
    private readonly session: CopilotSessionLike,
    private readonly callbacks: SessionCallbacks,
  ) {}

  nativeSessionId(): string | undefined {
    return this.session.sessionId;
  }

  runTurn(text: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const messages: string[] = [];
      const finish = (fn: () => void) => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        void this.session.abort().catch(() => undefined);
        finish(() => reject(abortError()));
      };
      const unsubscribe = this.session.on((event) => {
        switch (event.type) {
          case "assistant.message_delta":
            this.callbacks.onEvent({ type: "assistant_delta", text: eventData<{ deltaContent: string }>(event).deltaContent });
            break;
          case "assistant.message": {
            const content = eventData<{ content: string }>(event).content;
            messages.push(content);
            this.callbacks.onEvent({ type: "assistant_message", text: content });
            break;
          }
          case "tool.execution_start": {
            const d = eventData<{ toolCallId: string; toolName: string }>(event);
            this.callbacks.onEvent({ type: "tool_started", toolId: d.toolCallId, title: d.toolName });
            break;
          }
          case "tool.execution_complete": {
            const d = eventData<{ toolCallId: string; success: boolean }>(event);
            this.callbacks.onEvent({ type: "tool_finished", toolId: d.toolCallId, ok: d.success });
            break;
          }
          case "session.error":
            finish(() => reject(new Error(eventData<{ message?: string }>(event).message ?? "Copilot session error")));
            break;
          case "session.idle":
            finish(() => resolve(messages.join("\n\n")));
            break;
        }
      });
      signal.addEventListener("abort", onAbort);
      this.session.send({ prompt: text }).catch((error: unknown) => finish(() => reject(error)));
    });
  }

  async close(): Promise<void> {
    await this.session.disconnect().catch(() => undefined);
    await this.client.stop().catch(() => undefined);
  }
}

export class CopilotAdapter implements ProviderAdapter {
  constructor(private readonly deps: CopilotAdapterDeps = {
    createClient: ({ cliPath, workingDirectory, env }) =>
      new CopilotClient({
        workingDirectory,
        useLoggedInUser: true,
        connection: RuntimeConnection.forStdio({ path: cliPath, ...(env ? { env } : {}) }),
      }) as unknown as CopilotClientLike,
    resolvePath: () => resolveCopilotPath(),
  }) {}

  async probe(): Promise<Availability> {
    const cliPath = await this.deps.resolvePath();
    if (!cliPath) return { kind: "missing", detail: "copilot" };
    const client = this.deps.createClient({ cliPath, workingDirectory: process.cwd() });
    try {
      await client.start();
      const { version } = await client.getStatus();
      if (!isAtLeast(version, MINIMUM_COPILOT_VERSION)) {
        return { kind: "too_old", detail: MINIMUM_COPILOT_VERSION, detectedVersion: version };
      }
      const { isAuthenticated } = await client.getAuthStatus();
      if (!isAuthenticated) return { kind: "unauthenticated", detail: "copilot login", detectedVersion: version };
      return { kind: "available", version };
    } catch (error) {
      return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  async startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession> {
    const cliPath = await this.deps.resolvePath();
    if (!cliPath) throw new Error("COPILOT_NOT_FOUND");
    const env = options.env
      ? { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), ...options.env }
      : undefined;
    const client = this.deps.createClient({ cliPath, workingDirectory: options.workingDirectory, ...(env ? { env } : {}) });
    await client.start();
    const onPermissionRequest = async (request: { kind: string; [k: string]: unknown }): Promise<PermissionResult> => {
      const normalized: ToolRequest = toolRequestFromCopilot(request);
      const decision = copilotDecision(options.permission, normalized);
      const allow = decision === "approve" || (decision === "ask" && (await callbacks.requestPermission(normalized)));
      return allow ? { kind: "approve-once" } : { kind: "reject" };
    };
    const config: CopilotSessionConfigLike = {
      workingDirectory: options.workingDirectory,
      onPermissionRequest,
      ...(options.model ? { model: options.model } : {}),
    };
    try {
      const session = options.resumeNativeId
        ? await client.resumeSession(options.resumeNativeId, config)
        : await client.createSession(config);
      return new CopilotAgentSession(client, session, callbacks);
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  async listSessions(workingDirectory: string): Promise<AgentSessionSummary[]> {
    const cliPath = await this.deps.resolvePath();
    if (!cliPath) throw new Error("COPILOT_NOT_FOUND");
    const client = this.deps.createClient({ cliPath, workingDirectory });
    try {
      await client.start();
      const sessions = await client.listSessions();
      return sessions.map((s) => ({
        nativeSessionId: s.sessionId,
        ...(s.summary ? { title: s.summary } : {}),
        ...(s.modifiedTime ? { updatedAt: new Date(s.modifiedTime).toISOString() } : {}),
      }));
    } finally {
      await client.stop().catch(() => undefined);
    }
  }
}
