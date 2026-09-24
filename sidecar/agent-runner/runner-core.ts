import { randomUUID } from "node:crypto";
import type { AgentProvider, Availability, RunnerInbound, RunnerOutbound, ToolRequest } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter } from "./adapter";
import { parseInbound } from "./protocol";

interface ActiveTurn {
  controller: AbortController;
  timedOut: boolean;
  /** Set when the abort was caused by close_session, so its rejection does not emit turn_cancelled. */
  suppressCancelEvent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface SessionEntry {
  session: AdapterSession;
  timeoutMs?: number;
  turn?: ActiveTurn;
  permissions: Map<string, (allow: boolean) => void>;
  /** Set by closeSession; once true, late adapter callbacks are silenced. */
  closed: boolean;
}

/** A session id reserved while its start_session is still pending. */
interface StartingEntry {
  closed: boolean;
}

export interface RunnerCoreDeps {
  adapters: Record<AgentProvider, ProviderAdapter>;
  send: (message: RunnerOutbound) => void;
  newId?: () => string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Bound on close(), so a hung adapter/CLI cannot block shutdown forever. */
const CLOSE_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutError)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Protocol brain of the agent runner, free of stdio so it can be unit-tested. */
export class RunnerCore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly starting = new Map<string, StartingEntry>();
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
        let availability: Availability;
        try {
          availability = await this.deps.adapters[msg.provider].probe();
        } catch (error) {
          availability = { kind: "error", detail: message(error) };
        }
        this.deps.send({ type: "availability", requestId: msg.requestId, provider: msg.provider, availability });
        return;
      }
      case "start_session":
        return this.startSession(msg);
      case "send":
        return this.send(msg.sessionId, msg.text);
      case "cancel": {
        const entry = this.sessions.get(msg.sessionId);
        if (entry?.turn) {
          entry.turn.controller.abort();
          // Deny immediately rather than waiting for the turn's rejection to
          // propagate, so a caller awaiting the permission promise is not
          // stuck behind the adapter's own abort handling.
          this.denyPending(entry);
        }
        return;
      }
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
    // Mark every still-pending start closed first, so a start_session that
    // resolves after shutdown has begun closes itself instead of publishing
    // session_started for a process that is already on its way out.
    for (const reservation of this.starting.values()) reservation.closed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  private async startSession(msg: Extract<RunnerInbound, { type: "start_session" }>): Promise<void> {
    const ids = { requestId: msg.requestId, sessionId: msg.sessionId };
    // Reserve the id synchronously (before awaiting the adapter) so a second
    // start_session for the same id — arriving while this one is still
    // pending — is rejected instead of racing to create a second session.
    if (this.sessions.has(msg.sessionId) || this.starting.has(msg.sessionId)) {
      this.deps.send({ type: "error", ...ids, message: "SESSION_EXISTS" });
      return;
    }
    const reservation: StartingEntry = { closed: false };
    this.starting.set(msg.sessionId, reservation);
    const permissions = new Map<string, (allow: boolean) => void>();
    // Captured by the callbacks below (as a variable, not a snapshot): once
    // the session is created and assigned, closeSession can flip its
    // `closed` flag and have late adapter callbacks observe it immediately.
    let entry: SessionEntry | undefined;
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
          onEvent: (event) => {
            if (entry?.closed) return;
            this.deps.send({ type: "event", sessionId: msg.sessionId, event });
          },
          requestPermission: (request: ToolRequest) =>
            new Promise<boolean>((resolve) => {
              if (entry?.closed) {
                resolve(false);
                return;
              }
              const permissionId = this.newId();
              permissions.set(permissionId, resolve);
              this.deps.send({ type: "permission_request", sessionId: msg.sessionId, permissionId, request });
            }),
        },
      );
      this.starting.delete(msg.sessionId);
      if (reservation.closed) {
        // close_session arrived while startSession() was still pending.
        await withTimeout(session.close(), CLOSE_TIMEOUT_MS, "CLOSE_TIMEOUT").catch(() => undefined);
        this.deps.send({ type: "error", ...ids, message: "SESSION_CLOSED" });
        return;
      }
      const nativeSessionId = session.nativeSessionId();
      entry = { session, timeoutMs: msg.timeoutMs, permissions, closed: false };
      this.sessions.set(msg.sessionId, entry);
      this.deps.send({ type: "session_started", ...ids, ...(nativeSessionId ? { nativeSessionId } : {}) });
    } catch (error) {
      this.starting.delete(msg.sessionId);
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
    const turn: ActiveTurn = { controller: new AbortController(), timedOut: false, suppressCancelEvent: false };
    if (entry.timeoutMs) {
      turn.timer = setTimeout(() => {
        turn.timedOut = true;
        turn.controller.abort();
        // Deny immediately; do not wait for the turn's rejection to propagate.
        this.denyPending(entry);
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
        else if (turn.controller.signal.aborted) {
          // A close_session-triggered abort already reported its own outcome;
          // do not also emit turn_cancelled for a session that is now gone.
          if (!turn.suppressCancelEvent) this.deps.send({ type: "turn_cancelled", sessionId });
        } else this.deps.send({ type: "turn_failed", sessionId, message: message(error) });
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
    const reservation = this.starting.get(sessionId);
    if (reservation) {
      // start_session is still pending; mark it closed so startSession()
      // closes the adapter session as soon as it resolves, instead of
      // publishing session_started for a session mdium already gave up on.
      reservation.closed = true;
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.closed = true;
    if (entry.turn) {
      entry.turn.suppressCancelEvent = true;
      entry.turn.controller.abort();
    }
    // Deny immediately; do not wait for the turn's rejection to propagate.
    this.denyPending(entry);
    await withTimeout(entry.session.close(), CLOSE_TIMEOUT_MS, "CLOSE_TIMEOUT").catch(() => undefined);
  }
}
