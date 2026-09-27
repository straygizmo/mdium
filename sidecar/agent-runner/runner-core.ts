import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { Availability, RunnerInbound, RunnerOutbound, RunnerProvider, ToolRequest } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter } from "./adapter";
import { checkToolRequest } from "./guard";
import { imagesWithinRoot, parseInbound, type ParsedInbound, type ParsedSend } from "./protocol";

interface ActiveTurn {
  controller: AbortController;
  timedOut: boolean;
  /** Set when the abort was caused by close_session, so its rejection does not emit turn_cancelled. */
  suppressCancelEvent: boolean;
  /** Set when the safety guard blocked a tool call; the turn then fails with GUARD_BLOCKED. */
  guardBlocked: boolean;
  /** A guard_violation was already sent for this turn. */
  violationSent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface SessionEntry {
  session: AdapterSession;
  /** Images of a turn must resolve inside this directory: the guard root, else the working directory. */
  imageRoot: string;
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
  adapters: Partial<Record<RunnerProvider, ProviderAdapter>>;
  send: (message: RunnerOutbound) => void;
  newId?: () => string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Longest guard_violation summary sent to mdium. */
const MAX_VIOLATION_SUMMARY = 2048;
const REDACTED = "[REDACTED]";
/** Token-like substrings removed from a blocked command before it is reported. */
const SECRET_PATTERNS: RegExp[] = [
  /(\bauthorization\s*[:=]\s*)[^\r\n"'`]+/gi,
  /(\bbearer\s+)[^\s"'`]+/gi,
  /(\b[\w-]*(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s&"'`]+/gi,
  /()\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_\w{16,}|sk-[\w-]{16,})/g,
];
/** Long runs of base64/hex-like characters. */
const TOKEN_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

/** Hex runs, or base64-like runs mixing cases and digits without word or path separators. */
function looksLikeSecret(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return true;
  const longest = Math.max(...run.split(/[/_-]/).map((part) => part.length));
  return longest >= 20 && /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/** Redact token-like text and bound the length of a summary reported in guard_violation. */
export function reportableSummary(summary: string): string {
  // Only the reported prefix matters; bound the redaction work on oversized input.
  let text = summary.slice(0, MAX_VIOLATION_SUMMARY * 8);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, `$1${REDACTED}`);
  text = text.replace(TOKEN_RUN, (run) => (looksLikeSecret(run) ? REDACTED : run));
  return text.length > MAX_VIOLATION_SUMMARY ? `${text.slice(0, MAX_VIOLATION_SUMMARY - 1)}…` : text;
}

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

  /** Look up the adapter for a provider; undefined when the provider has no adapter wired up. */
  private adapter(provider: RunnerProvider): ProviderAdapter | undefined {
    return this.deps.adapters[provider];
  }

  async handleLine(line: string): Promise<void> {
    let msg: ParsedInbound;
    try {
      msg = parseInbound(line);
    } catch (error) {
      this.deps.send({ type: "error", message: message(error) });
      return;
    }
    switch (msg.type) {
      case "probe": {
        const adapter = this.adapter(msg.provider);
        if (!adapter) {
          this.deps.send({ type: "error", requestId: msg.requestId, message: "PROVIDER_UNAVAILABLE" });
          return;
        }
        let availability: Availability;
        try {
          availability = await adapter.probe();
        } catch (error) {
          availability = { kind: "error", detail: message(error) };
        }
        this.deps.send({ type: "availability", requestId: msg.requestId, provider: msg.provider, availability });
        return;
      }
      case "start_session":
        return this.startSession(msg);
      case "send":
        return this.send(msg);
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
        const adapter = this.adapter(msg.provider);
        if (!adapter) {
          this.deps.send({ type: "error", requestId: msg.requestId, message: "PROVIDER_UNAVAILABLE" });
          return;
        }
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
    // Dispose adapters in parallel with the session closes, so a hung close
    // cannot keep a shared server alive. The same adapter may serve several
    // providers; dispose each one once. A synchronous throw is swallowed too.
    const adapters = new Set(Object.values(this.deps.adapters).filter((a): a is ProviderAdapter => Boolean(a)));
    const disposals = [...adapters]
      .filter((adapter) => adapter.dispose)
      .map((adapter) =>
        withTimeout(Promise.resolve().then(() => adapter.dispose!()), CLOSE_TIMEOUT_MS, "DISPOSE_TIMEOUT").catch(() => undefined),
      );
    await Promise.all([...[...this.sessions.keys()].map((id) => this.closeSession(id)), ...disposals]);
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
    const adapter = this.adapter(msg.provider);
    if (!adapter) {
      this.starting.delete(msg.sessionId);
      this.deps.send({ type: "error", ...ids, message: "PROVIDER_UNAVAILABLE" });
      return;
    }
    const permissions = new Map<string, (allow: boolean) => void>();
    // Captured by the callbacks below (as a variable, not a snapshot): once
    // the session is created and assigned, closeSession can flip its
    // `closed` flag and have late adapter callbacks observe it immediately.
    let entry: SessionEntry | undefined;
    try {
      const session = await adapter.startSession(
        {
          workingDirectory: msg.workingDirectory,
          permission: msg.permission,
          ...(msg.model ? { model: msg.model } : {}),
          ...(msg.resumeNativeId ? { resumeNativeId: msg.resumeNativeId } : {}),
          ...(msg.env ? { env: msg.env } : {}),
          guarded: Boolean(msg.guard),
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
          // Before the session is registered there is no turn to abort; still
          // report a guarded session's blocked calls as denied.
          checkTool: (request: ToolRequest) => this.checkTool(msg.sessionId, entry, msg.guard, request),
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
      entry = {
        session,
        imageRoot: msg.guard?.workspaceRoot ?? msg.workingDirectory,
        timeoutMs: msg.timeoutMs,
        permissions,
        closed: false,
      };
      this.sessions.set(msg.sessionId, entry);
      this.deps.send({ type: "session_started", ...ids, ...(nativeSessionId ? { nativeSessionId } : {}) });
    } catch (error) {
      this.starting.delete(msg.sessionId);
      this.deps.send({ type: "error", ...ids, message: message(error) });
    }
  }

  private async send({ sessionId, text, images: requested = [], invalidImages }: ParsedSend): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.deps.send({ type: "error", sessionId, message: "NO_SESSION" });
      return;
    }
    if (entry.turn) {
      this.deps.send({ type: "error", sessionId, message: "TURN_IN_PROGRESS" });
      return;
    }
    // Rejected only after the session and turn checks, so a bad send cannot fail a running turn.
    const images = invalidImages ? undefined : requested.length > 0 ? imagesWithinRoot(requested, entry.imageRoot) : [];
    if (!images) {
      this.deps.send({ type: "error", sessionId, message: "INVALID_IMAGES" });
      return;
    }
    const turn: ActiveTurn = {
      controller: new AbortController(),
      timedOut: false,
      suppressCancelEvent: false,
      guardBlocked: false,
      violationSent: false,
    };
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
      .runTurn(text, turn.controller.signal, images)
      .then((finalResponse) => {
        // The session may have been closed (close_session) while this turn
        // was still resolving, e.g. if the adapter's runTurn does not itself
        // observe the abort signal. Its outcome no longer matters to a gone
        // session.
        if (entry.closed) return;
        // A guard-blocked turn fails even if the adapter still resolved it.
        if (turn.guardBlocked) {
          this.deps.send({ type: "turn_failed", sessionId, message: "GUARD_BLOCKED" });
          return;
        }
        const nativeSessionId = entry.session.nativeSessionId();
        this.deps.send({ type: "turn_completed", sessionId, finalResponse, ...(nativeSessionId ? { nativeSessionId } : {}) });
      })
      .catch((error: unknown) => {
        // A guard block also aborts the turn; its outcome takes precedence
        // over cancelled/timeout. A closed session reports nothing.
        if (turn.guardBlocked) {
          if (!entry.closed) this.deps.send({ type: "turn_failed", sessionId, message: "GUARD_BLOCKED" });
        } else if (turn.timedOut) this.deps.send({ type: "turn_failed", sessionId, message: "TIMEOUT" });
        else if (turn.controller.signal.aborted) {
          // A close_session-triggered abort already reported its own outcome;
          // do not also emit turn_cancelled for a session that is now gone.
          if (!turn.suppressCancelEvent) this.deps.send({ type: "turn_cancelled", sessionId });
        } else if (!entry.closed) this.deps.send({ type: "turn_failed", sessionId, message: message(error) });
      })
      .finally(() => {
        if (turn.timer) clearTimeout(turn.timer);
        entry.turn = undefined;
        this.denyPending(entry);
      });
  }

  /** Run the safety guard for a session's tool call; true means allowed. */
  private checkTool(
    sessionId: string,
    entry: SessionEntry | undefined,
    guard: { workspaceRoot: string } | undefined,
    request: ToolRequest,
  ): boolean {
    if (!guard) return true;
    const verdict = checkToolRequest(request, {
      workspaceRoot: guard.workspaceRoot,
      homeDir: os.homedir(),
      platform: process.platform,
      extraWritableRoots: [os.tmpdir()],
    });
    if (verdict.ok) return true;
    const turn = entry?.turn;
    if (entry && turn && !entry.closed) {
      if (!turn.violationSent) {
        turn.violationSent = true;
        this.deps.send({ type: "guard_violation", sessionId, rule: verdict.rule, summary: reportableSummary(request.summary) });
      }
      turn.guardBlocked = true;
      turn.controller.abort();
      // Deny immediately; do not wait for the turn's rejection to propagate.
      this.denyPending(entry);
    }
    return false;
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
