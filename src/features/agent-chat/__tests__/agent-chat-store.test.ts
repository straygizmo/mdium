import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerOutbound } from "@/shared/types/agent-runner";

const client = vi.hoisted(() => {
  const listeners = new Set<(m: RunnerOutbound) => void>();
  let n = 0;
  return {
    listeners,
    sendToRunner: vi.fn(async (_msg: { type: string; [key: string]: unknown }) => {}),
    requestRunner: vi.fn(async (msg: { type: string; requestId: string; sessionId?: string; provider?: string }) => {
      if (msg.type === "start_session") return { type: "session_started", requestId: msg.requestId, sessionId: msg.sessionId };
      if (msg.type === "probe") return { type: "availability", requestId: msg.requestId, provider: msg.provider, availability: { kind: "available", version: "1" } };
      return { type: "session_list", requestId: msg.requestId, sessions: [{ nativeSessionId: "n1" }] };
    }),
    onRunnerMessage: vi.fn((l: (m: RunnerOutbound) => void) => { listeners.add(l); return () => listeners.delete(l); }),
    newRunnerId: vi.fn(() => `id${++n}`),
    emit: (m: RunnerOutbound) => listeners.forEach((l) => l(m)),
  };
});
vi.mock("../lib/agent-runner-client", () => client);

import { chatKey, emptyChat, useAgentChatStore } from "../agent-chat-store";

const key = chatKey("C:/w", "codex");
const chat = () => useAgentChatStore.getState().chats[key] ?? emptyChat;

describe("agent chat store", () => {
  beforeEach(() => {
    useAgentChatStore.setState({ chats: {}, availability: {}, selectedTab: "opencode" });
    client.sendToRunner.mockClear();
    client.requestRunner.mockClear();
  });

  it("probes availability", async () => {
    await useAgentChatStore.getState().probe("copilot");
    expect(useAgentChatStore.getState().availability.copilot).toEqual({ kind: "available", version: "1" });
  });

  it("auto-starts a cli-default session on first send", async () => {
    const sent = await useAgentChatStore.getState().send("C:/w", "codex", "hello");
    expect(sent).toBe(true);
    const start = client.requestRunner.mock.calls[0][0];
    expect(start).toMatchObject({ type: "start_session", provider: "codex", workingDirectory: "C:/w", permission: "cli-default" });
    expect(client.sendToRunner).toHaveBeenCalledWith({ type: "send", sessionId: start.sessionId, text: "hello" });
    expect(chat().status).toBe("running");
    expect(chat().entries.map((e) => [e.role, e.text])).toEqual([["user", "hello"]]);
  });

  it("streams deltas, finalizes the message, and tracks tools", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "event", sessionId, event: { type: "assistant_delta", text: "He" } });
    client.emit({ type: "event", sessionId, event: { type: "assistant_delta", text: "llo" } });
    expect(chat().entries.at(-1)).toMatchObject({ role: "assistant", text: "Hello" });
    client.emit({ type: "event", sessionId, event: { type: "assistant_message", text: "Hello!" } });
    client.emit({ type: "event", sessionId, event: { type: "tool_started", toolId: "t1", title: "npm test" } });
    client.emit({ type: "event", sessionId, event: { type: "tool_finished", toolId: "t1", ok: false } });
    client.emit({ type: "turn_completed", sessionId, finalResponse: "Hello!" });
    const roles = chat().entries.map((e) => [e.role, e.text, e.ok]);
    expect(roles).toEqual([["user", "hi", undefined], ["assistant", "Hello!", undefined], ["tool", "npm test", false]]);
    expect(chat().status).toBe("idle");
  });

  it("matches tool_finished to the most recent unresolved entry with the same toolId across turns", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "event", sessionId, event: { type: "tool_started", toolId: "t1", title: "first run" } });
    client.emit({ type: "event", sessionId, event: { type: "tool_finished", toolId: "t1", ok: true } });
    client.emit({ type: "turn_completed", sessionId, finalResponse: "" });

    await useAgentChatStore.getState().send("C:/w", "codex", "again");
    client.emit({ type: "event", sessionId, event: { type: "tool_started", toolId: "t1", title: "second run" } });
    client.emit({ type: "event", sessionId, event: { type: "tool_finished", toolId: "t1", ok: false } });

    const tools = chat().entries.filter((e) => e.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ text: "first run", ok: true });
    expect(tools[1]).toMatchObject({ text: "second run", ok: false });
    expect(tools[0].id).not.toBe(tools[1].id);
    // Entry ids are never the raw toolId now that both turns share it.
    expect(new Set(tools.map((t) => t.id)).size).toBe(2);
  });

  it("surfaces permission requests and answers them", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "permission_request", sessionId, permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    expect(chat().pendingPermissions).toEqual([{ permissionId: "p1", request: { kind: "shell", summary: "ls" } }]);
    await useAgentChatStore.getState().respondPermission("C:/w", "codex", true);
    expect(client.sendToRunner).toHaveBeenCalledWith({ type: "respond_permission", sessionId, permissionId: "p1", allow: true });
    expect(chat().pendingPermissions).toEqual([]);
  });

  it("queues concurrent permission requests and answers them in order", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "permission_request", sessionId, permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    client.emit({ type: "permission_request", sessionId, permissionId: "p2", request: { kind: "write", summary: "a.ts" } });
    expect(chat().pendingPermissions).toEqual([
      { permissionId: "p1", request: { kind: "shell", summary: "ls" } },
      { permissionId: "p2", request: { kind: "write", summary: "a.ts" } },
    ]);

    await useAgentChatStore.getState().respondPermission("C:/w", "codex", true);
    expect(client.sendToRunner).toHaveBeenLastCalledWith({ type: "respond_permission", sessionId, permissionId: "p1", allow: true });
    expect(chat().pendingPermissions).toEqual([{ permissionId: "p2", request: { kind: "write", summary: "a.ts" } }]);

    await useAgentChatStore.getState().respondPermission("C:/w", "codex", false);
    expect(client.sendToRunner).toHaveBeenLastCalledWith({ type: "respond_permission", sessionId, permissionId: "p2", allow: false });
    expect(chat().pendingPermissions).toEqual([]);
  });

  it("does not throw when responding to a permission fails to send, and records the error", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "permission_request", sessionId, permissionId: "p1", request: { kind: "shell", summary: "ls" } });

    client.sendToRunner.mockRejectedValueOnce(new Error("PIPE_CLOSED"));
    await expect(useAgentChatStore.getState().respondPermission("C:/w", "codex", true)).resolves.toBeUndefined();

    expect(chat().pendingPermissions).toEqual([]);
    expect(chat().status).toBe("idle");
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "PIPE_CLOSED" });
  });

  it("records failures and runner exits", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "turn_failed", sessionId, message: "TIMEOUT" });
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "TIMEOUT" });
    client.emit({ type: "error", message: "RUNNER_EXITED" });
    expect(chat().sessionId).toBeNull();
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "RUNNER_EXITED" });
  });

  it("does not append a RUNNER_EXITED entry to a chat with no session that is already idle", async () => {
    const idleKey = chatKey("C:/other", "codex");
    useAgentChatStore.setState((s) => ({
      chats: { ...s.chats, [idleKey]: { ...emptyChat, entries: [{ id: "x", role: "user" as const, text: "hi" }] } },
    }));
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");

    client.emit({ type: "error", message: "RUNNER_EXITED" });

    expect(useAgentChatStore.getState().chats[idleKey].entries).toEqual([{ id: "x", role: "user", text: "hi" }]);
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "RUNNER_EXITED" });
  });

  it("closes the previous session when starting a new one", async () => {
    await useAgentChatStore.getState().newSession("C:/w", "codex");
    const first = chat().sessionId!;
    await useAgentChatStore.getState().newSession("C:/w", "codex", "native-9");
    expect(client.sendToRunner).toHaveBeenCalledWith({ type: "close_session", sessionId: first });
    expect(client.requestRunner.mock.calls.at(-1)?.[0]).toMatchObject({ resumeNativeId: "native-9" });
    expect(chat().entries).toEqual([]);
  });

  it("reports a start failure as an error entry", async () => {
    client.requestRunner.mockRejectedValueOnce(new Error("CODEX_NOT_FOUND"));
    await useAgentChatStore.getState().newSession("C:/w", "codex");
    expect(chat()).toMatchObject({ sessionId: null, status: "idle" });
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "CODEX_NOT_FOUND" });
  });

  it("sets the old chat to starting (not idle) and clears pendingPermission at the moment close_session is sent", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "permission_request", sessionId, permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    expect(chat().pendingPermissions).not.toEqual([]);

    let statusAtClose: string | undefined;
    let pendingAtClose: unknown;
    client.sendToRunner.mockImplementationOnce(async (msg: { type: string }) => {
      if (msg.type === "close_session") {
        statusAtClose = chat().status;
        pendingAtClose = chat().pendingPermissions;
      }
    });

    await useAgentChatStore.getState().newSession("C:/w", "codex");

    expect(statusAtClose).toBe("starting");
    expect(pendingAtClose).toEqual([]);
  });

  it("blocks send while the previous session is still being closed", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");

    let resolveClose: (() => void) | undefined;
    client.sendToRunner.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveClose = resolve; }),
    );
    const newSessionPromise = useAgentChatStore.getState().newSession("C:/w", "codex");
    expect(chat().status).toBe("starting");

    const sent = await useAgentChatStore.getState().send("C:/w", "codex", "blocked");
    expect(sent).toBe(false);

    resolveClose?.();
    await newSessionPromise;
  });

  it("ignores send while a turn is already running", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    expect(chat().status).toBe("running");
    client.sendToRunner.mockClear();
    client.requestRunner.mockClear();

    const sent = await useAgentChatStore.getState().send("C:/w", "codex", "again");

    expect(sent).toBe(false);
    expect(client.sendToRunner).not.toHaveBeenCalled();
    expect(client.requestRunner).not.toHaveBeenCalled();
    expect(chat().entries.map((e) => e.text)).toEqual(["hi"]);
  });

  it("returns false when the auto-started session fails to start", async () => {
    client.requestRunner.mockRejectedValueOnce(new Error("CODEX_NOT_FOUND"));
    const sent = await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    expect(sent).toBe(false);
    expect(chat().sessionId).toBeNull();
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "CODEX_NOT_FOUND" });
  });

  it("returns false when the transport send fails", async () => {
    client.sendToRunner.mockRejectedValueOnce(new Error("PIPE_CLOSED"));
    const sent = await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    expect(sent).toBe(false);
    expect(chat().status).toBe("idle");
    expect(chat().entries.at(-1)).toMatchObject({ role: "error", text: "PIPE_CLOSED" });
  });

  it("ignores a stale newSession success after a newer session supersedes it", async () => {
    let resolveA: (() => void) | undefined;
    client.requestRunner.mockImplementationOnce(
      (msg: { type: string; requestId: string; sessionId?: string }) =>
        new Promise((resolve) => {
          resolveA = () => resolve({ type: "session_started", requestId: msg.requestId, sessionId: msg.sessionId });
        }),
    );
    const startA = useAgentChatStore.getState().newSession("C:/w", "codex");
    const sessionA = chat().sessionId!;

    await useAgentChatStore.getState().newSession("C:/w", "codex", "native-b");
    const sessionB = chat().sessionId!;
    expect(sessionB).not.toBe(sessionA);

    resolveA?.();
    await startA;

    expect(chat().sessionId).toBe(sessionB);
    expect(chat().status).toBe("idle");
  });

  it("ignores a stale newSession failure after a newer session supersedes it", async () => {
    let rejectA: ((e: Error) => void) | undefined;
    client.requestRunner.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectA = reject; }),
    );
    const startA = useAgentChatStore.getState().newSession("C:/w", "codex");

    await useAgentChatStore.getState().newSession("C:/w", "codex", "native-b");
    const sessionB = chat().sessionId!;

    rejectA?.(new Error("CODEX_NOT_FOUND"));
    await startA;

    expect(chat().sessionId).toBe(sessionB);
    expect(chat().entries).toEqual([]);
  });

  it("appends exactly one RUNNER_EXITED entry when the runner exits while a session is starting", async () => {
    let rejectStart: ((e: Error) => void) | undefined;
    client.requestRunner.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectStart = reject; }),
    );
    const starting = useAgentChatStore.getState().newSession("C:/w", "codex");
    expect(chat().status).toBe("starting");

    client.emit({ type: "error", message: "RUNNER_EXITED" });
    rejectStart?.(new Error("RUNNER_EXITED"));
    await starting;

    expect(chat().sessionId).toBeNull();
    const runnerExitedEntries = chat().entries.filter((e) => e.text === "RUNNER_EXITED");
    expect(runnerExitedEntries).toHaveLength(1);
  });
});
