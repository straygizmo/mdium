import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { AgentSessionSummary, Availability, ToolRequest } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { copilotDecision, toolRequestFromCopilot } from "./permissions";
import { resolveCopilotPath } from "./resolve-cli";
import { MINIMUM_COPILOT_VERSION, isAtLeast } from "./availability";

// Sub-agent instance identifier. Absent for events from the root/main agent.
type CopilotEvent = { type: string; data?: unknown; agentId?: string };
type PermissionResult = { kind: "approve-once" } | { kind: "reject" };
interface CopilotSessionConfigLike {
  workingDirectory: string;
  model?: string;
  /** Required for assistant.message_delta streaming events to be emitted (SDK default is false). */
  streaming?: boolean;
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
  listSessions(filter?: { workingDirectory?: string }): Promise<Array<{ sessionId: string; summary?: string; modifiedTime?: Date }>>;
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

/**
 * A sub-agent event carries a top-level `agentId` (absent for the main agent),
 * or, on older/legacy payloads, `data.parentToolCallId`. Sub-agent assistant
 * text must not be surfaced as (or mixed into) the main turn's output.
 */
function isSubAgentEvent(event: CopilotEvent): boolean {
  if (event.agentId) return true;
  const data = event.data as { parentToolCallId?: string } | undefined;
  return Boolean(data?.parentToolCallId);
}

const LIVENESS_INTERVAL_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 10_000;
const ABORT_IDLE_WAIT_MS = 5_000;

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
      // Set once this turn calls session.abort(), so a subsequent session.idle
      // (or the 5s bound) is known to be this turn's cancellation confirmation,
      // not a stale aborted idle left over from an earlier, unrelated turn.
      let aborted = false;
      let idleWaitTimer: ReturnType<typeof setTimeout> | undefined;
      let livenessTimer: ReturnType<typeof setInterval> | undefined;
      // Require two consecutive failed/timed-out liveness checks before
      // declaring the CLI disconnected, so one slow response doesn't fail
      // the turn; a successful check resets the count.
      let consecutiveLivenessFailures = 0;
      const finish = (fn: () => void) => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        if (idleWaitTimer) clearTimeout(idleWaitTimer);
        if (livenessTimer) clearInterval(livenessTimer);
        fn();
      };
      const onAbort = () => {
        aborted = true;
        void this.session.abort().catch(() => undefined);
        // Wait for the CLI's cancellation-confirming session.idle so a later
        // turn cannot observe it as a stale event; give up after 5s.
        idleWaitTimer = setTimeout(() => finish(() => reject(abortError())), ABORT_IDLE_WAIT_MS);
      };
      // Detects a dead CLI process while a turn is in flight: getStatus() is
      // raced against a timeout, since the SDK has no public connection-state
      // or process-exit API to observe directly (see report for details).
      const checkLiveness = async () => {
        let raceTimeout: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, rejectTimeout) => {
          raceTimeout = setTimeout(() => rejectTimeout(new Error("Liveness check timed out")), LIVENESS_TIMEOUT_MS);
        });
        try {
          await Promise.race([this.client.getStatus(), timeout]);
          consecutiveLivenessFailures = 0;
        } catch {
          consecutiveLivenessFailures += 1;
          if (consecutiveLivenessFailures < 2) return;
          void this.session.abort().catch(() => undefined);
          finish(() => reject(new Error("COPILOT_DISCONNECTED")));
        } finally {
          if (raceTimeout) clearTimeout(raceTimeout);
        }
      };
      const unsubscribe = this.session.on((event) => {
        switch (event.type) {
          case "assistant.message_delta": {
            if (isSubAgentEvent(event)) break;
            const delta = eventData<{ deltaContent?: string }>(event).deltaContent ?? "";
            this.callbacks.onEvent({ type: "assistant_delta", text: delta });
            break;
          }
          case "assistant.message": {
            if (isSubAgentEvent(event)) break;
            const content = eventData<{ content?: string }>(event).content ?? "";
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
            const d = eventData<{ toolCallId: string; success?: boolean }>(event);
            this.callbacks.onEvent({ type: "tool_finished", toolId: d.toolCallId, ok: d.success ?? false });
            break;
          }
          case "session.error": {
            // Sub-agent errors don't end the main turn.
            if (isSubAgentEvent(event)) break;
            const d = eventData<{ message?: string; errorType?: string; eligibleForAutoSwitch?: boolean }>(event);
            // If this turn is already aborting, an error racing in before the
            // cancellation-confirming idle must not override the AbortError,
            // and session.abort() was already called by onAbort.
            if (aborted) {
              finish(() => reject(abortError()));
              break;
            }
            // The runtime follows this with an auto_mode_switch and recovers
            // on its own; do not abort or settle the turn for it.
            if (d.eligibleForAutoSwitch === true) break;
            void this.session.abort().catch(() => undefined);
            const message = d.message ?? "Copilot session error";
            finish(() => reject(new Error(d.errorType ? `${d.errorType}: ${message}` : message)));
            break;
          }
          case "session.shutdown":
            finish(() => reject(new Error("COPILOT_DISCONNECTED")));
            break;
          case "session.idle": {
            const d = eventData<{ aborted?: boolean; mode?: string }>(event);
            // Mirrors the SDK's own sendAndWait, which does not treat an
            // autopilot-mode idle as turn-terminal.
            if (d.mode === "autopilot") break;
            // A stale aborted idle from an earlier, already-finished turn's
            // cancellation must not end this fresh turn.
            if (d.aborted === true && !aborted) break;
            finish(() => (aborted ? reject(abortError()) : resolve(messages.join("\n\n"))));
            break;
          }
        }
      });
      signal.addEventListener("abort", onAbort);
      livenessTimer = setInterval(() => void checkLiveness(), LIVENESS_INTERVAL_MS);
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
      // The safety guard wins over every permission mode.
      if (!callbacks.checkTool(normalized)) return { kind: "reject" };
      const decision = copilotDecision(options.permission, normalized);
      const allow = decision === "approve" || (decision === "ask" && (await callbacks.requestPermission(normalized)));
      return allow ? { kind: "approve-once" } : { kind: "reject" };
    };
    const config: CopilotSessionConfigLike = {
      workingDirectory: options.workingDirectory,
      // SessionConfigBase.streaming defaults to false; without it the SDK
      // never emits assistant.message_delta events.
      streaming: true,
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
      const sessions = await client.listSessions({ workingDirectory });
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
