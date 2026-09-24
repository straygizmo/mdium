import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerOutbound } from "@/shared/types/agent-runner";

const client = vi.hoisted(() => {
  const listeners = new Set<(m: RunnerOutbound) => void>();
  let n = 0;
  return {
    listeners,
    sendToRunner: vi.fn(async () => {}),
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
    await useAgentChatStore.getState().send("C:/w", "codex", "hello");
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

  it("surfaces permission requests and answers them", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "permission_request", sessionId, permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    expect(chat().pendingPermission).toEqual({ permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    await useAgentChatStore.getState().respondPermission("C:/w", "codex", true);
    expect(client.sendToRunner).toHaveBeenCalledWith({ type: "respond_permission", sessionId, permissionId: "p1", allow: true });
    expect(chat().pendingPermission).toBeNull();
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

  it("clears a pending permission and idles the old chat before starting a new session", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    const sessionId = chat().sessionId!;
    client.emit({ type: "permission_request", sessionId, permissionId: "p1", request: { kind: "shell", summary: "ls" } });
    expect(chat().pendingPermission).not.toBeNull();

    await useAgentChatStore.getState().newSession("C:/w", "codex");
    expect(chat().pendingPermission).toBeNull();
    expect(chat().status).not.toBe("running");
  });

  it("ignores send while a turn is already running", async () => {
    await useAgentChatStore.getState().send("C:/w", "codex", "hi");
    expect(chat().status).toBe("running");
    client.sendToRunner.mockClear();
    client.requestRunner.mockClear();

    await useAgentChatStore.getState().send("C:/w", "codex", "again");

    expect(client.sendToRunner).not.toHaveBeenCalled();
    expect(client.requestRunner).not.toHaveBeenCalled();
    expect(chat().entries.map((e) => e.text)).toEqual(["hi"]);
  });
});
