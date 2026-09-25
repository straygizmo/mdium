import { describe, expect, it, vi } from "vitest";
import { RunnerCore } from "../runner-core";
import type { AdapterSession, ProviderAdapter, SessionCallbacks } from "../adapter";
import type { RunnerOutbound } from "../../../src/shared/types/agent-runner";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const sent: RunnerOutbound[] = [];
  let callbacks!: SessionCallbacks;
  let turn = deferred<string>();
  let lastSignal: AbortSignal | undefined;
  const session: AdapterSession = {
    nativeSessionId: () => "native-1",
    runTurn: vi.fn((_text: string, signal: AbortSignal) => {
      lastSignal = signal;
      signal.addEventListener("abort", () => turn.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      return turn.promise;
    }),
    close: vi.fn(async () => {}),
  };
  const adapter: ProviderAdapter = {
    probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
    startSession: vi.fn(async (_o, cb) => { callbacks = cb; return session; }),
    listSessions: vi.fn(async () => [{ nativeSessionId: "a" }]),
  };
  let n = 0;
  const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m), newId: () => `p${++n}` });
  const line = (m: object) => core.handleLine(JSON.stringify(m));
  const start = () => line({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" });
  const startGuarded = () =>
    line({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/wt", permission: "full-access", guard: { workspaceRoot: "C:/wt" } });
  return {
    core, sent, session, adapter, line, start, startGuarded,
    callbacks: () => callbacks,
    signal: () => lastSignal,
    finishTurn: (v: string) => turn.resolve(v),
    failTurn: (e: unknown) => turn.reject(e),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RunnerCore", () => {
  it("answers probe", async () => {
    const t = setup();
    await t.line({ type: "probe", requestId: "r0", provider: "copilot" });
    expect(t.sent).toContainEqual({ type: "availability", requestId: "r0", provider: "copilot", availability: { kind: "available", version: "1.0.0" } });
  });

  it("answers probe with an error availability when the adapter's probe rejects", async () => {
    const t = setup();
    (t.adapter.probe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await t.line({ type: "probe", requestId: "r9", provider: "codex" });
    expect(t.sent).toContainEqual({
      type: "availability",
      requestId: "r9",
      provider: "codex",
      availability: { kind: "error", detail: "boom" },
    });
  });

  it("starts a session and completes a turn with forwarded events", async () => {
    const t = setup();
    await t.start();
    expect(t.sent).toContainEqual({ type: "session_started", requestId: "r1", sessionId: "s1", nativeSessionId: "native-1" });
    await t.line({ type: "send", sessionId: "s1", text: "hi" });
    t.callbacks().onEvent({ type: "assistant_message", text: "yo" });
    t.finishTurn("yo");
    await flush();
    expect(t.sent).toContainEqual({ type: "event", sessionId: "s1", event: { type: "assistant_message", text: "yo" } });
    expect(t.sent).toContainEqual({ type: "turn_completed", sessionId: "s1", finalResponse: "yo", nativeSessionId: "native-1" });
  });

  it("rejects a second send while a turn is running", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    await t.line({ type: "send", sessionId: "s1", text: "b" });
    expect(t.sent.filter((m) => m.type === "error" && m.sessionId === "s1")).toHaveLength(1);
  });

  it("cancels a running turn", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    await t.line({ type: "cancel", sessionId: "s1" });
    await flush();
    expect(t.signal()?.aborted).toBe(true);
    expect(t.sent).toContainEqual({ type: "turn_cancelled", sessionId: "s1" });
  });

  it("fails a turn with TIMEOUT when timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.line({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "read-only", timeoutMs: 1000 });
      await t.line({ type: "send", sessionId: "s1", text: "a" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.sent).toContainEqual({ type: "turn_failed", sessionId: "s1", message: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports adapter failures as turn_failed", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    t.failTurn(new Error("quota"));
    await flush();
    expect(t.sent).toContainEqual({ type: "turn_failed", sessionId: "s1", message: "quota" });
  });

  it("round-trips permission requests and denies leftovers when the turn ends", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    const first = t.callbacks().requestPermission({ kind: "shell", summary: "ls" });
    const second = t.callbacks().requestPermission({ kind: "shell", summary: "rm" });
    expect(t.sent).toContainEqual({ type: "permission_request", sessionId: "s1", permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    await t.line({ type: "respond_permission", sessionId: "s1", permissionId: "p1", allow: true });
    await expect(first).resolves.toBe(true);
    t.finishTurn("done");
    await expect(second).resolves.toBe(false);
  });

  it("lists sessions and closes sessions", async () => {
    const t = setup();
    await t.line({ type: "list_sessions", requestId: "r2", provider: "copilot", workingDirectory: "C:/w" });
    expect(t.sent).toContainEqual({ type: "session_list", requestId: "r2", sessions: [{ nativeSessionId: "a" }] });
    await t.start();
    await t.line({ type: "close_session", sessionId: "s1" });
    expect(t.session.close).toHaveBeenCalled();
    await t.line({ type: "send", sessionId: "s1", text: "x" });
    expect(t.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s1" });
  });

  it("reports invalid lines and duplicate sessions", async () => {
    const t = setup();
    await t.core.handleLine("nope");
    expect(t.sent.at(-1)).toMatchObject({ type: "error" });
    await t.start();
    await t.start();
    expect(t.sent.at(-1)).toMatchObject({ type: "error", requestId: "r1", sessionId: "s1" });
  });

  it("denies pending permissions immediately on cancel, before the turn settles", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    const pending = t.callbacks().requestPermission({ kind: "shell", summary: "ls" });
    await t.line({ type: "cancel", sessionId: "s1" });
    // Must resolve without needing the turn's own rejection to propagate first.
    await expect(pending).resolves.toBe(false);
  });

  it("suppresses turn_cancelled for a turn aborted by close_session", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    await t.line({ type: "close_session", sessionId: "s1" });
    await flush();
    expect(t.session.close).toHaveBeenCalled();
    expect(t.sent.some((m) => m.type === "turn_cancelled")).toBe(false);
  });

  it("closes a session whose start_session is still pending, without sending session_started", async () => {
    const sent: RunnerOutbound[] = [];
    const startDeferred = deferred<AdapterSession>();
    const session: AdapterSession = {
      nativeSessionId: () => "native-1",
      runTurn: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const adapter: ProviderAdapter = {
      probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
      startSession: vi.fn(() => startDeferred.promise),
    };
    const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m) });
    const starting = core.handleLine(
      JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
    );
    await core.handleLine(JSON.stringify({ type: "close_session", sessionId: "s1" }));
    startDeferred.resolve(session);
    await starting;
    await flush();
    expect(session.close).toHaveBeenCalled();
    expect(sent).toContainEqual({ type: "error", requestId: "r1", sessionId: "s1", message: "SESSION_CLOSED" });
    expect(sent.some((m) => m.type === "session_started")).toBe(false);
  });

  it("rejects a concurrent duplicate start_session while the first is still starting", async () => {
    const sent: RunnerOutbound[] = [];
    const startDeferred = deferred<AdapterSession>();
    const session: AdapterSession = {
      nativeSessionId: () => "native-1",
      runTurn: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const startSession = vi.fn(() => startDeferred.promise);
    const adapter: ProviderAdapter = { probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })), startSession };
    const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m) });
    const first = core.handleLine(
      JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
    );
    await core.handleLine(
      JSON.stringify({ type: "start_session", requestId: "r2", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
    );
    expect(sent).toContainEqual({ type: "error", requestId: "r2", sessionId: "s1", message: "SESSION_EXISTS" });
    expect(startSession).toHaveBeenCalledTimes(1);
    startDeferred.resolve(session);
    await first;
  });

  it("closes a session whose start_session resolves after shutdown, without sending session_started", async () => {
    const sent: RunnerOutbound[] = [];
    const startDeferred = deferred<AdapterSession>();
    const session: AdapterSession = {
      nativeSessionId: () => "native-1",
      runTurn: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const adapter: ProviderAdapter = {
      probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
      startSession: vi.fn(() => startDeferred.promise),
    };
    const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m) });
    const starting = core.handleLine(
      JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
    );
    const shuttingDown = core.shutdown();
    startDeferred.resolve(session);
    await starting;
    await shuttingDown;
    expect(session.close).toHaveBeenCalled();
    expect(sent.some((m) => m.type === "session_started")).toBe(false);
  });

  it("silences a closed session: onEvent drops events and requestPermission resolves false", async () => {
    const t = setup();
    await t.start();
    await t.line({ type: "close_session", sessionId: "s1" });
    t.callbacks().onEvent({ type: "assistant_message", text: "late" });
    expect(t.sent.some((m) => m.type === "event")).toBe(false);
    await expect(t.callbacks().requestPermission({ kind: "shell", summary: "ls" })).resolves.toBe(false);
    expect(t.sent.some((m) => m.type === "permission_request")).toBe(false);
  });

  it("frees the session id after a failed start_session so retrying with the same id succeeds", async () => {
    const t = setup();
    (t.adapter.startSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await t.start();
    expect(t.sent).toContainEqual({ type: "error", requestId: "r1", sessionId: "s1", message: "boom" });
    await t.start();
    expect(t.sent).toContainEqual({ type: "session_started", requestId: "r1", sessionId: "s1", nativeSessionId: "native-1" });
  });

  it("bounds close_session to 5s even when the adapter's close() never resolves", async () => {
    vi.useFakeTimers();
    try {
      const sent: RunnerOutbound[] = [];
      const session: AdapterSession = {
        nativeSessionId: () => "native-1",
        runTurn: vi.fn(),
        close: vi.fn(() => new Promise<void>(() => {})),
      };
      const adapter: ProviderAdapter = {
        probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
        startSession: vi.fn(async () => session),
      };
      const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m) });
      await core.handleLine(
        JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
      );
      const closing = core.handleLine(JSON.stringify({ type: "close_session", sessionId: "s1" }));
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
      expect(session.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit turn_completed when the session is closed before an in-flight turn resolves", async () => {
    const sent: RunnerOutbound[] = [];
    const turn = deferred<string>();
    const session: AdapterSession = {
      nativeSessionId: () => "native-1",
      // Deliberately ignores the abort signal, to simulate a race where the
      // underlying turn keeps running (and later settles) after close_session.
      runTurn: vi.fn(() => turn.promise),
      close: vi.fn(async () => {}),
    };
    const adapter: ProviderAdapter = {
      probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
      startSession: vi.fn(async () => session),
    };
    const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m) });
    await core.handleLine(
      JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
    );
    await core.handleLine(JSON.stringify({ type: "send", sessionId: "s1", text: "a" }));
    await core.handleLine(JSON.stringify({ type: "close_session", sessionId: "s1" }));

    turn.resolve("late success");
    await flush();

    expect(sent.some((m) => m.type === "turn_completed")).toBe(false);
  });

  it("does not emit turn_failed for a non-abort error when the session is closed before an in-flight turn rejects", async () => {
    const sent: RunnerOutbound[] = [];
    const turn = deferred<string>();
    const session: AdapterSession = {
      nativeSessionId: () => "native-1",
      // Deliberately ignores the abort signal.
      runTurn: vi.fn(() => turn.promise),
      close: vi.fn(async () => {}),
    };
    const adapter: ProviderAdapter = {
      probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
      startSession: vi.fn(async () => session),
    };
    const core = new RunnerCore({ adapters: { codex: adapter, copilot: adapter }, send: (m) => sent.push(m) });
    await core.handleLine(
      JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
    );
    await core.handleLine(JSON.stringify({ type: "send", sessionId: "s1", text: "a" }));
    await core.handleLine(JSON.stringify({ type: "close_session", sessionId: "s1" }));

    turn.reject(new Error("late failure, unrelated to the abort"));
    await flush();

    expect(sent.some((m) => m.type === "turn_failed")).toBe(false);
  });

  it("reports PROVIDER_UNAVAILABLE for a provider without an adapter", async () => {
    const sent: RunnerOutbound[] = [];
    const core = new RunnerCore({ adapters: {}, send: (m) => sent.push(m) });
    await core.handleLine(JSON.stringify({ type: "probe", requestId: "r1", provider: "claude" }));
    expect(sent).toContainEqual({ type: "error", requestId: "r1", message: "PROVIDER_UNAVAILABLE" });
  });

  it("denies pending permissions immediately when the turn timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.line({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "read-only", timeoutMs: 1000 });
      await t.line({ type: "send", sessionId: "s1", text: "a" });
      const pending = t.callbacks().requestPermission({ kind: "shell", summary: "ls" });
      await vi.advanceTimersByTimeAsync(1000);
      // Must resolve without needing the turn's own rejection to propagate first.
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes guarded to the adapter and allows every tool when no guard is configured", async () => {
    const t = setup();
    await t.start();
    expect(t.adapter.startSession).toHaveBeenCalledWith(expect.objectContaining({ guarded: false }), expect.anything());
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    const before = t.sent.length;
    expect(t.callbacks().checkTool({ kind: "shell", summary: "git push" })).toBe(true);
    expect(t.sent.length).toBe(before);
  });

  it("blocks a guard violation, aborts the turn, and reports GUARD_BLOCKED instead of turn_cancelled", async () => {
    const t = setup();
    await t.startGuarded();
    expect(t.adapter.startSession).toHaveBeenCalledWith(expect.objectContaining({ guarded: true }), expect.anything());
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    const pending = t.callbacks().requestPermission({ kind: "shell", summary: "ls" });
    expect(t.callbacks().checkTool({ kind: "shell", summary: "npm test" })).toBe(true);
    expect(t.callbacks().checkTool({ kind: "shell", summary: "git push" })).toBe(false);
    expect(t.sent).toContainEqual({ type: "guard_violation", sessionId: "s1", rule: "git-remote", summary: "git push" });
    expect(t.signal()?.aborted).toBe(true);
    await expect(pending).resolves.toBe(false);
    await flush();
    expect(t.sent).toContainEqual({ type: "turn_failed", sessionId: "s1", message: "GUARD_BLOCKED" });
    expect(t.sent.some((m) => m.type === "turn_cancelled")).toBe(false);
  });

  it("sends only one guard_violation per turn", async () => {
    const t = setup();
    await t.startGuarded();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    expect(t.callbacks().checkTool({ kind: "shell", summary: "git push" })).toBe(false);
    expect(t.callbacks().checkTool({ kind: "shell", summary: "gh pr create" })).toBe(false);
    await flush();
    expect(t.sent.filter((m) => m.type === "guard_violation")).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === "turn_failed")).toHaveLength(1);
  });

  it("reports GUARD_BLOCKED even when the adapter resolves the blocked turn", async () => {
    const t = setup();
    await t.startGuarded();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    // Detach the abort-driven rejection so the fake turn resolves instead.
    t.finishTurn("done anyway");
    t.callbacks().checkTool({ kind: "shell", summary: "git push" });
    await flush();
    expect(t.sent).toContainEqual({ type: "turn_failed", sessionId: "s1", message: "GUARD_BLOCKED" });
    expect(t.sent.some((m) => m.type === "turn_completed")).toBe(false);
  });

  it("emits nothing for a guard violation on a closed session", async () => {
    const t = setup();
    await t.startGuarded();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    await t.line({ type: "close_session", sessionId: "s1" });
    expect(t.callbacks().checkTool({ kind: "shell", summary: "git push" })).toBe(false);
    await flush();
    expect(t.sent.some((m) => m.type === "guard_violation" || m.type === "turn_failed" || m.type === "turn_cancelled")).toBe(false);
  });

  it("disposes adapters that define dispose() on shutdown", async () => {
    const t = setup();
    const dispose = vi.fn(async () => {});
    const disposable: ProviderAdapter = { ...t.adapter, dispose };
    const core = new RunnerCore({ adapters: { codex: disposable, copilot: t.adapter, claude: disposable }, send: () => {} });
    await core.shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("replies PROVIDER_UNAVAILABLE to start_session without an adapter and releases the reservation", async () => {
    const t = setup();
    await t.line({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "claude", workingDirectory: "C:/w", permission: "cli-default" });
    expect(t.sent).toContainEqual({ type: "error", requestId: "r1", sessionId: "s1", message: "PROVIDER_UNAVAILABLE" });
    await t.start();
    expect(t.sent).toContainEqual({ type: "session_started", requestId: "r1", sessionId: "s1", nativeSessionId: "native-1" });
  });

  it("replies PROVIDER_UNAVAILABLE to list_sessions without an adapter", async () => {
    const t = setup();
    await t.line({ type: "list_sessions", requestId: "r3", provider: "opencode", workingDirectory: "C:/w" });
    expect(t.sent).toContainEqual({ type: "error", requestId: "r3", message: "PROVIDER_UNAVAILABLE" });
  });

  it("disposes adapters even while a session close never resolves", async () => {
    vi.useFakeTimers();
    try {
      const session: AdapterSession = {
        nativeSessionId: () => "native-1",
        runTurn: vi.fn(),
        close: vi.fn(() => new Promise<void>(() => {})),
      };
      const dispose = vi.fn(async () => {});
      const adapter: ProviderAdapter = {
        probe: vi.fn(async () => ({ kind: "available" as const, version: "1.0.0" })),
        startSession: vi.fn(async () => session),
        dispose,
      };
      const core = new RunnerCore({ adapters: { codex: adapter }, send: () => {} });
      await core.handleLine(
        JSON.stringify({ type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" }),
      );
      const shuttingDown = core.shutdown();
      await vi.advanceTimersByTimeAsync(0);
      // dispose must not wait for the hung close.
      expect(dispose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      await shuttingDown;
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a synchronous throw from dispose()", async () => {
    const t = setup();
    const dispose = vi.fn((): Promise<void> => {
      throw new Error("sync boom");
    });
    const core = new RunnerCore({ adapters: { codex: { ...t.adapter, dispose } }, send: () => {} });
    await expect(core.shutdown()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports GUARD_BLOCKED when the guard blocks a turn whose timeout already fired", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.line({
        type: "start_session", requestId: "r1", sessionId: "s1", provider: "codex", workingDirectory: "C:/wt",
        permission: "full-access", timeoutMs: 1000, guard: { workspaceRoot: "C:/wt" },
      });
      await t.line({ type: "send", sessionId: "s1", text: "a" });
      // Fire the timeout synchronously; the turn's rejection has not settled yet.
      vi.advanceTimersByTime(1000);
      expect(t.callbacks().checkTool({ kind: "shell", summary: "git push" })).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.sent).toContainEqual({ type: "guard_violation", sessionId: "s1", rule: "git-remote", summary: "git push" });
      expect(t.sent).toContainEqual({ type: "turn_failed", sessionId: "s1", message: "GUARD_BLOCKED" });
      expect(t.sent.some((m) => m.type === "turn_failed" && m.message === "TIMEOUT")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports GUARD_BLOCKED when the guard blocks a turn the user just cancelled", async () => {
    const t = setup();
    await t.startGuarded();
    await t.line({ type: "send", sessionId: "s1", text: "a" });
    // The cancel line aborts synchronously; the turn's rejection has not settled yet.
    void t.line({ type: "cancel", sessionId: "s1" });
    expect(t.signal()?.aborted).toBe(true);
    expect(t.callbacks().checkTool({ kind: "shell", summary: "git push" })).toBe(false);
    await flush();
    expect(t.sent).toContainEqual({ type: "turn_failed", sessionId: "s1", message: "GUARD_BLOCKED" });
    expect(t.sent.some((m) => m.type === "turn_cancelled")).toBe(false);
  });
});
