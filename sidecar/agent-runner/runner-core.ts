import { randomUUID } from "node:crypto";
import type { AgentProvider, RunnerInbound, RunnerOutbound, ToolRequest } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter } from "./adapter";
import { parseInbound } from "./protocol";

interface ActiveTurn {
  controller: AbortController;
  timedOut: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface SessionEntry {
  session: AdapterSession;
  timeoutMs?: number;
  turn?: ActiveTurn;
  permissions: Map<string, (allow: boolean) => void>;
}

export interface RunnerCoreDeps {
  adapters: Record<AgentProvider, ProviderAdapter>;
  send: (message: RunnerOutbound) => void;
  newId?: () => string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Protocol brain of the agent runner, free of stdio so it can be unit-tested. */
export class RunnerCore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly newId: () => string;

  constructor(private readonly deps: RunnerCoreDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  async handleLine(line: string): Promise<void> {
    let msg: RunnerInbound;
    try {
      msg = parseInbound(line);
    } catch (error) {
      this.deps.send({ type: "error", message: message(error) });
      return;
    }
    switch (msg.type) {
      case "probe": {
        const availability = await this.deps.adapters[msg.provider].probe();
        this.deps.send({ type: "availability", requestId: msg.requestId, provider: msg.provider, availability });
        return;
      }
      case "start_session":
        return this.startSession(msg);
      case "send":
        return this.send(msg.sessionId, msg.text);
      case "cancel":
        this.sessions.get(msg.sessionId)?.turn?.controller.abort();
        return;
      case "respond_permission": {
        const entry = this.sessions.get(msg.sessionId);
        const resolve = entry?.permissions.get(msg.permissionId);
        if (resolve) {
          entry!.permissions.delete(msg.permissionId);
          resolve(msg.allow);
        }
        return;
      }
      case "list_sessions": {
        const adapter = this.deps.adapters[msg.provider];
        if (!adapter.listSessions) {
          this.deps.send({ type: "error", requestId: msg.requestId, message: "LIST_UNSUPPORTED" });
          return;
        }
        try {
          const sessions = await adapter.listSessions(msg.workingDirectory);
          this.deps.send({ type: "session_list", requestId: msg.requestId, sessions });
        } catch (error) {
          this.deps.send({ type: "error", requestId: msg.requestId, message: message(error) });
        }
        return;
      }
      case "close_session":
        return this.closeSession(msg.sessionId);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  private async startSession(msg: Extract<RunnerInbound, { type: "start_session" }>): Promise<void> {
    const ids = { requestId: msg.requestId, sessionId: msg.sessionId };
    if (this.sessions.has(msg.sessionId)) {
      this.deps.send({ type: "error", ...ids, message: "SESSION_EXISTS" });
      return;
    }
    const permissions = new Map<string, (allow: boolean) => void>();
    try {
      const session = await this.deps.adapters[msg.provider].startSession(
        {
          workingDirectory: msg.workingDirectory,
          permission: msg.permission,
          ...(msg.model ? { model: msg.model } : {}),
          ...(msg.resumeNativeId ? { resumeNativeId: msg.resumeNativeId } : {}),
          ...(msg.env ? { env: msg.env } : {}),
        },
        {
          onEvent: (event) => this.deps.send({ type: "event", sessionId: msg.sessionId, event }),
          requestPermission: (request: ToolRequest) =>
            new Promise<boolean>((resolve) => {
              const permissionId = this.newId();
              permissions.set(permissionId, resolve);
              this.deps.send({ type: "permission_request", sessionId: msg.sessionId, permissionId, request });
            }),
        },
      );
      this.sessions.set(msg.sessionId, { session, timeoutMs: msg.timeoutMs, permissions });
      const nativeSessionId = session.nativeSessionId();
      this.deps.send({ type: "session_started", ...ids, ...(nativeSessionId ? { nativeSessionId } : {}) });
    } catch (error) {
      this.deps.send({ type: "error", ...ids, message: message(error) });
    }
  }

  private async send(sessionId: string, text: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.deps.send({ type: "error", sessionId, message: "NO_SESSION" });
      return;
    }
    if (entry.turn) {
      this.deps.send({ type: "error", sessionId, message: "TURN_IN_PROGRESS" });
      return;
    }
    const turn: ActiveTurn = { controller: new AbortController(), timedOut: false };
    if (entry.timeoutMs) {
      turn.timer = setTimeout(() => {
        turn.timedOut = true;
        turn.controller.abort();
      }, entry.timeoutMs);
    }
    entry.turn = turn;
    // Run the turn without blocking the line handler so cancel/permission lines are processed.
    void entry.session
      .runTurn(text, turn.controller.signal)
      .then((finalResponse) => {
        const nativeSessionId = entry.session.nativeSessionId();
        this.deps.send({ type: "turn_completed", sessionId, finalResponse, ...(nativeSessionId ? { nativeSessionId } : {}) });
      })
      .catch((error: unknown) => {
        if (turn.timedOut) this.deps.send({ type: "turn_failed", sessionId, message: "TIMEOUT" });
        else if (turn.controller.signal.aborted) this.deps.send({ type: "turn_cancelled", sessionId });
        else this.deps.send({ type: "turn_failed", sessionId, message: message(error) });
      })
      .finally(() => {
        if (turn.timer) clearTimeout(turn.timer);
        entry.turn = undefined;
        this.denyPending(entry);
      });
  }

  private denyPending(entry: SessionEntry): void {
    for (const resolve of entry.permissions.values()) resolve(false);
    entry.permissions.clear();
  }

  private async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.turn?.controller.abort();
    this.denyPending(entry);
    await entry.session.close().catch(() => undefined);
  }
}
