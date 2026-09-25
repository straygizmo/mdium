import { describe, expect, it, vi } from "vitest";
import { CopilotAdapter, type CopilotClientLike, type CopilotSessionLike } from "../copilot-adapter";
import type { AgentEvent } from "../../../src/shared/types/agent-runner";

type Handler = (event: { type: string; data?: unknown; agentId?: string }) => void;

function fakeSession(script: Array<{ type: string; data?: unknown; agentId?: string }>) {
  let handler: Handler | null = null;
  const session: CopilotSessionLike & { emit: Handler } = {
    sessionId: "native-1",
    on: vi.fn((h: Handler) => { handler = h; return () => { handler = null; }; }),
    send: vi.fn(async () => { queueMicrotask(() => script.forEach((e) => handler?.(e))); return "msg-1"; }),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    emit: (e) => handler?.(e),
  };
  return session;
}

function fakeClient(session: CopilotSessionLike, overrides: Partial<CopilotClientLike> = {}) {
  let permissionHandler: ((req: { kind: string; [k: string]: unknown }) => Promise<unknown>) | undefined;
  const client: CopilotClientLike = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    getStatus: vi.fn(async () => ({ version: "1.0.88" })),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true })),
    createSession: vi.fn(async (config) => { permissionHandler = config.onPermissionRequest as typeof permissionHandler; return session; }),
    resumeSession: vi.fn(async (_id, config) => { permissionHandler = config.onPermissionRequest as typeof permissionHandler; return session; }),
    listSessions: vi.fn(async () => [{ sessionId: "a", summary: "Fix bug", modifiedTime: new Date("2026-09-01T00:00:00Z") }]),
    ...overrides,
  };
  return { client, permission: (req: { kind: string; [k: string]: unknown }) => permissionHandler!(req) };
}

const make = (client: CopilotClientLike, path: string | null = "C:/copilot/npm-loader.js") =>
  new CopilotAdapter({ createClient: vi.fn(() => client), resolvePath: async () => path });

const opts = { workingDirectory: "C:/w", permission: "cli-default" as const, guarded: false };
const cbs = (onEvent: (e: AgentEvent) => void = () => {}) => ({ onEvent, requestPermission: async () => true, checkTool: () => true });

describe("CopilotAdapter", () => {
  it("streams a turn and resolves with the final message on idle", async () => {
    const session = fakeSession([
      { type: "assistant.message_delta", data: { deltaContent: "Hel", messageId: "m" } },
      { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash" } },
      { type: "tool.execution_complete", data: { toolCallId: "t1", success: true } },
      { type: "assistant.message", data: { content: "Hello", messageId: "m" } },
      { type: "session.idle", data: {} },
    ]);
    const { client } = fakeClient(session);
    const events: AgentEvent[] = [];
    const s = await make(client).startSession(opts, cbs((e) => events.push(e)));
    await expect(s.runTurn("hi", new AbortController().signal)).resolves.toBe("Hello");
    expect(s.nativeSessionId()).toBe("native-1");
    expect(events).toEqual([
      { type: "assistant_delta", text: "Hel" },
      { type: "tool_started", toolId: "t1", title: "bash" },
      { type: "tool_finished", toolId: "t1", ok: true },
      { type: "assistant_message", text: "Hello" },
    ]);
  });

  it("rejects the turn on session.error", async () => {
    const session = fakeSession([{ type: "session.error", data: { message: "boom" } }]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    await expect(s.runTurn("hi", new AbortController().signal)).rejects.toThrow("boom");
  });

  it("aborts the session and includes the SDK errorType on session.error", async () => {
    const session = fakeSession([{ type: "session.error", data: { message: "boom", errorType: "rate_limit" } }]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    await expect(s.runTurn("hi", new AbortController().signal)).rejects.toThrow("rate_limit: boom");
    expect(session.abort).toHaveBeenCalled();
  });

  it("aborts the session when the signal fires", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    const controller = new AbortController();
    const turn = s.runTurn("hi", controller.signal);
    controller.abort();
    // The CLI confirms cancellation with a session.idle event; the turn should
    // reject once it arrives, without waiting for the 5s bound.
    session.emit({ type: "session.idle", data: { aborted: true } });
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(session.abort).toHaveBeenCalled();
  });

  it("ignores a stale aborted idle left over from an earlier turn", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    const turn = s.runTurn("hi", new AbortController().signal);
    // A stale session.idle (aborted: true) from a previous, already-finished
    // turn's cancellation must not end this fresh, non-aborted turn.
    session.emit({ type: "session.idle", data: { aborted: true } });
    session.emit({ type: "assistant.message", data: { content: "Hello", messageId: "m" } });
    session.emit({ type: "session.idle", data: {} });
    await expect(turn).resolves.toBe("Hello");
  });

  it("ignores idle events in autopilot mode", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    const turn = s.runTurn("hi", new AbortController().signal);
    session.emit({ type: "session.idle", data: { mode: "autopilot" } });
    session.emit({ type: "assistant.message", data: { content: "Hello", messageId: "m" } });
    session.emit({ type: "session.idle", data: {} });
    await expect(turn).resolves.toBe("Hello");
  });

  it("rejects after waiting up to 5s for the idle following abort", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession([]);
      const { client } = fakeClient(session);
      const s = await make(client).startSession(opts, cbs());
      const controller = new AbortController();
      const turn = s.runTurn("hi", controller.signal);
      let settled = false;
      turn.catch(() => { settled = true; });
      controller.abort();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the turn with COPILOT_DISCONNECTED on session.shutdown", async () => {
    const session = fakeSession([{ type: "session.shutdown", data: {} }]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    await expect(s.runTurn("hi", new AbortController().signal)).rejects.toThrow("COPILOT_DISCONNECTED");
  });

  it("rejects the turn with COPILOT_DISCONNECTED after two consecutive failed liveness checks", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession([]);
      const getStatus = vi.fn(async () => { throw new Error("down"); });
      const { client } = fakeClient(session, { getStatus });
      const s = await make(client).startSession(opts, cbs());
      const turn = s.runTurn("hi", new AbortController().signal);
      turn.catch(() => {});
      // First failed check (interval fires at 30s; getStatus rejects immediately).
      await vi.advanceTimersByTimeAsync(30_000);
      // Second interval tick, second failed check: only now must it reject.
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(turn).rejects.toThrow("COPILOT_DISCONNECTED");
      expect(session.abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the turn with COPILOT_DISCONNECTED after two consecutive liveness timeouts", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession([]);
      // getStatus never resolves; every check must time out at 10s.
      const getStatus = vi.fn(() => new Promise<{ version: string }>(() => {}));
      const { client } = fakeClient(session, { getStatus });
      const s = await make(client).startSession(opts, cbs());
      const turn = s.runTurn("hi", new AbortController().signal);
      turn.catch(() => {});
      // First interval tick (30s) + its 10s race timeout = first failed check.
      await vi.advanceTimersByTimeAsync(40_000);
      // Second interval tick (60s) + its 10s race timeout = second failed check.
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(turn).rejects.toThrow("COPILOT_DISCONNECTED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reject when a single failed liveness check is followed by a success", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession([]);
      let call = 0;
      const getStatus = vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("down");
        return { version: "1.0.88" };
      });
      const { client } = fakeClient(session, { getStatus });
      const s = await make(client).startSession(opts, cbs());
      const turn = s.runTurn("hi", new AbortController().signal);
      let settled = false;
      turn.catch(() => { settled = true; });
      turn.then(() => { settled = true; });
      // First check fails, second (a fresh interval tick) succeeds and must
      // reset the consecutive-failure count instead of rejecting.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      session.emit({ type: "assistant.message", data: { content: "Hello", messageId: "m" } });
      session.emit({ type: "session.idle", data: {} });
      await expect(turn).resolves.toBe("Hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the liveness interval once the turn resolves normally", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession([]);
      const { client } = fakeClient(session);
      const s = await make(client).startSession(opts, cbs());
      const turn = s.runTurn("hi", new AbortController().signal);
      session.emit({ type: "assistant.message", data: { content: "Hello", messageId: "m" } });
      session.emit({ type: "session.idle", data: {} });
      await expect(turn).resolves.toBe("Hello");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(client.getStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a session.error from a sub-agent", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    const turn = s.runTurn("hi", new AbortController().signal);
    session.emit({ type: "session.error", data: { message: "sub-agent failure" }, agentId: "agent-2" });
    session.emit({ type: "assistant.message", data: { content: "Hello", messageId: "m" } });
    session.emit({ type: "session.idle", data: {} });
    await expect(turn).resolves.toBe("Hello");
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("does not settle or abort on an auto-switch-eligible session.error", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    const turn = s.runTurn("hi", new AbortController().signal);
    session.emit({ type: "session.error", data: { message: "rate limited", errorType: "rate_limit", eligibleForAutoSwitch: true } });
    session.emit({ type: "assistant.message", data: { content: "Hello", messageId: "m" } });
    session.emit({ type: "session.idle", data: {} });
    await expect(turn).resolves.toBe("Hello");
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("rejects with AbortError, not the session.error, when an error arrives during the abort wait", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    const controller = new AbortController();
    const turn = s.runTurn("hi", controller.signal);
    controller.abort();
    session.emit({ type: "session.error", data: { message: "boom" } });
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("ignores sub-agent assistant events (top-level agentId and legacy parentToolCallId)", async () => {
    const session = fakeSession([
      { type: "assistant.message_delta", data: { deltaContent: "sub", messageId: "s1" }, agentId: "agent-2" },
      { type: "assistant.message", data: { content: "Sub result", messageId: "s1" }, agentId: "agent-2" },
      { type: "assistant.message_delta", data: { deltaContent: "legacy", messageId: "s2", parentToolCallId: "t9" } },
      { type: "assistant.message", data: { content: "Legacy sub result", messageId: "s2", parentToolCallId: "t9" } },
      { type: "assistant.message_delta", data: { deltaContent: "Hel", messageId: "m" } },
      { type: "assistant.message", data: { content: "Hello", messageId: "m" } },
      { type: "session.idle", data: {} },
    ]);
    const { client } = fakeClient(session);
    const events: AgentEvent[] = [];
    const s = await make(client).startSession(opts, cbs((e) => events.push(e)));
    await expect(s.runTurn("hi", new AbortController().signal)).resolves.toBe("Hello");
    expect(events).toEqual([
      { type: "assistant_delta", text: "Hel" },
      { type: "assistant_message", text: "Hello" },
    ]);
  });

  it("defaults missing delta text, message content, and tool result fields", async () => {
    const session = fakeSession([
      { type: "assistant.message_delta", data: { messageId: "m" } },
      { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash" } },
      { type: "tool.execution_complete", data: { toolCallId: "t1" } },
      { type: "assistant.message", data: { messageId: "m" } },
      { type: "session.idle", data: {} },
    ]);
    const { client } = fakeClient(session);
    const events: AgentEvent[] = [];
    const s = await make(client).startSession(opts, cbs((e) => events.push(e)));
    await expect(s.runTurn("hi", new AbortController().signal)).resolves.toBe("");
    expect(events).toEqual([
      { type: "assistant_delta", text: "" },
      { type: "tool_started", toolId: "t1", title: "bash" },
      { type: "tool_finished", toolId: "t1", ok: false },
      { type: "assistant_message", text: "" },
    ]);
  });

  it("asks the user for every request under cli-default, including reads", async () => {
    const session = fakeSession([]);
    const { client, permission } = fakeClient(session);
    const ask = vi.fn(async () => false);
    await make(client).startSession(opts, { onEvent: () => {}, requestPermission: ask, checkTool: () => true });
    await expect(permission({ kind: "read", path: "a" })).resolves.toEqual({ kind: "reject" });
    expect(ask).toHaveBeenCalledWith({ kind: "read", summary: "a", rawKind: "read" });
    await expect(permission({ kind: "shell", fullCommandText: "ls" })).resolves.toEqual({ kind: "reject" });
    expect(ask).toHaveBeenCalledWith({ kind: "shell", summary: "ls", rawKind: "shell" });
  });

  it("rejects writes without asking in read-only mode", async () => {
    const session = fakeSession([]);
    const { client, permission } = fakeClient(session);
    const ask = vi.fn(async () => true);
    await make(client).startSession({ workingDirectory: "C:/w", permission: "read-only", guarded: false }, { onEvent: () => {}, requestPermission: ask, checkTool: () => true });
    await expect(permission({ kind: "write", fileName: "a" })).resolves.toEqual({ kind: "reject" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("rejects a guard-blocked request without consulting the mode, even under full-access", async () => {
    const session = fakeSession([]);
    const { client, permission } = fakeClient(session);
    const ask = vi.fn(async () => true);
    const checkTool = vi.fn(() => false);
    await make(client).startSession(
      { workingDirectory: "C:/w", permission: "full-access", guarded: true },
      { onEvent: () => {}, requestPermission: ask, checkTool },
    );
    await expect(permission({ kind: "shell", fullCommandText: "git push" })).resolves.toEqual({ kind: "reject" });
    expect(checkTool).toHaveBeenCalledWith({ kind: "shell", summary: "git push", rawKind: "shell" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("probes version and auth", async () => {
    const { client } = fakeClient(fakeSession([]), { getAuthStatus: vi.fn(async () => ({ isAuthenticated: false })) });
    await expect(make(client).probe()).resolves.toMatchObject({ kind: "unauthenticated", detectedVersion: "1.0.88" });
    await expect(make(client, null).probe()).resolves.toMatchObject({ kind: "missing" });
  });

  it("stops the client after probing an outdated version", async () => {
    const { client } = fakeClient(fakeSession([]), { getStatus: vi.fn(async () => ({ version: "0.9.0" })) });
    await expect(make(client).probe()).resolves.toMatchObject({ kind: "too_old" });
    expect(client.stop).toHaveBeenCalled();
  });

  it("stops the client when probing throws", async () => {
    const { client } = fakeClient(fakeSession([]), { start: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(make(client).probe()).resolves.toMatchObject({ kind: "error", detail: "boom" });
    expect(client.stop).toHaveBeenCalled();
  });

  it("lists sessions filtered by working directory", async () => {
    const { client } = fakeClient(fakeSession([]));
    await expect(make(client).listSessions!("C:/w")).resolves.toEqual([
      { nativeSessionId: "a", title: "Fix bug", updatedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(client.listSessions).toHaveBeenCalledWith({ workingDirectory: "C:/w" });
  });

  it("enables streaming when creating a session", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    await make(client).startSession(opts, cbs());
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ streaming: true }));
  });

  it("enables streaming when resuming a session", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession({ ...opts, resumeNativeId: "native-9" }, cbs());
    expect(client.resumeSession).toHaveBeenCalledWith(
      "native-9",
      expect.objectContaining({ streaming: true, workingDirectory: "C:/w" }),
    );
    expect(s.nativeSessionId()).toBe("native-1");
  });

  it("closes the session by disconnecting then stopping the client", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    await s.close();
    expect(session.disconnect).toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalled();
    const disconnectOrder = (session.disconnect as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const stopOrder = (client.stop as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(disconnectOrder).toBeLessThan(stopOrder);
  });

  it("stops the client when createSession rejects", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session, { createSession: vi.fn(async () => { throw new Error("nope"); }) });
    await expect(make(client).startSession(opts, cbs())).rejects.toThrow("nope");
    expect(client.stop).toHaveBeenCalled();
  });

  it("rejects the turn when send() rejects", async () => {
    const session = fakeSession([]);
    session.send = vi.fn(async () => { throw new Error("send failed"); });
    const { client } = fakeClient(session);
    const s = await make(client).startSession(opts, cbs());
    await expect(s.runTurn("hi", new AbortController().signal)).rejects.toThrow("send failed");
  });
});
