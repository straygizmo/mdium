import { describe, expect, it, vi } from "vitest";
import { CopilotAdapter, type CopilotClientLike, type CopilotSessionLike } from "../copilot-adapter";
import type { AgentEvent } from "../../../src/shared/types/agent-runner";

type Handler = (event: { type: string; data?: unknown }) => void;

function fakeSession(script: Array<{ type: string; data?: unknown }>) {
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
    const s = await make(client).startSession({ workingDirectory: "C:/w", permission: "cli-default" }, { onEvent: (e) => events.push(e), requestPermission: async () => true });
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
    const s = await make(client).startSession({ workingDirectory: "C:/w", permission: "cli-default" }, { onEvent: () => {}, requestPermission: async () => true });
    await expect(s.runTurn("hi", new AbortController().signal)).rejects.toThrow("boom");
  });

  it("aborts the session when the signal fires", async () => {
    const session = fakeSession([]);
    const { client } = fakeClient(session);
    const s = await make(client).startSession({ workingDirectory: "C:/w", permission: "cli-default" }, { onEvent: () => {}, requestPermission: async () => true });
    const controller = new AbortController();
    const turn = s.runTurn("hi", controller.signal);
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(session.abort).toHaveBeenCalled();
  });

  it("maps permission requests through the mode", async () => {
    const session = fakeSession([]);
    const { client, permission } = fakeClient(session);
    const ask = vi.fn(async () => false);
    await make(client).startSession({ workingDirectory: "C:/w", permission: "cli-default" }, { onEvent: () => {}, requestPermission: ask });
    await expect(permission({ kind: "read", path: "a" })).resolves.toEqual({ kind: "approve-once" });
    await expect(permission({ kind: "shell", fullCommandText: "ls" })).resolves.toEqual({ kind: "reject" });
    expect(ask).toHaveBeenCalledWith({ kind: "shell", summary: "ls" });
  });

  it("rejects writes without asking in read-only mode", async () => {
    const session = fakeSession([]);
    const { client, permission } = fakeClient(session);
    const ask = vi.fn(async () => true);
    await make(client).startSession({ workingDirectory: "C:/w", permission: "read-only" }, { onEvent: () => {}, requestPermission: ask });
    await expect(permission({ kind: "write", fileName: "a" })).resolves.toEqual({ kind: "reject" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("probes version and auth", async () => {
    const { client } = fakeClient(fakeSession([]), { getAuthStatus: vi.fn(async () => ({ isAuthenticated: false })) });
    await expect(make(client).probe()).resolves.toMatchObject({ kind: "unauthenticated", detectedVersion: "1.0.88" });
    await expect(make(client, null).probe()).resolves.toMatchObject({ kind: "missing" });
  });

  it("lists sessions for a folder", async () => {
    const { client } = fakeClient(fakeSession([]));
    await expect(make(client).listSessions!("C:/w")).resolves.toEqual([
      { nativeSessionId: "a", title: "Fix bug", updatedAt: "2026-09-01T00:00:00.000Z" },
    ]);
  });
});
