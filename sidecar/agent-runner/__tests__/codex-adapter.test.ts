import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, type CodexLike } from "../codex-adapter";
import type { AgentEvent, ToolRequest } from "../../../src/shared/types/agent-runner";
import { checkToolRequest } from "../guard";

function fakeCodex(events: unknown[], threadId = "thread-1") {
  const startThread = vi.fn();
  const resumeThread = vi.fn();
  const runStreamed = vi.fn(async (_input: string, opts?: { signal?: AbortSignal }) => ({
    events: (async function* () {
      for (const e of events) {
        if (opts?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield e;
      }
    })(),
  }));
  const thread = { get id() { return threadId; }, runStreamed };
  startThread.mockReturnValue(thread);
  resumeThread.mockReturnValue(thread);
  const codex: CodexLike = { startThread, resumeThread };
  const createCodex = vi.fn((_options: { codexPathOverride?: string; env?: Record<string, string> }) => codex);
  return { createCodex, startThread, resumeThread, runStreamed };
}

function adapter(createCodex: ReturnType<typeof fakeCodex>["createCodex"]) {
  return new CodexAdapter({
    createCodex,
    resolvePath: async () => "C:/codex.exe",
    probe: async () => ({ kind: "available", version: "0.152.1" }),
  });
}

const callbacks = (events: AgentEvent[], checkTool: (request: ToolRequest) => boolean = () => true) => ({
  onEvent: (e: AgentEvent) => events.push(e),
  requestPermission: async () => false,
  checkTool,
});

describe("CodexAdapter", () => {
  it("starts a thread with the mapped sandbox and normalizes events", async () => {
    const fake = fakeCodex([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "completed" } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: {} },
    ]);
    const events: AgentEvent[] = [];
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/work", permission: "read-only", guarded: false, model: "gpt-x" },
      callbacks(events),
    );
    const final = await session.runTurn("hello", new AbortController().signal);

    expect(fake.createCodex).toHaveBeenCalledWith({ codexPathOverride: "C:/codex.exe" });
    expect(fake.startThread).toHaveBeenCalledWith({ workingDirectory: "C:/work", skipGitRepoCheck: true, sandboxMode: "read-only", model: "gpt-x" });
    expect(final).toBe("Done.");
    expect(session.nativeSessionId()).toBe("thread-1");
    expect(events).toEqual([
      { type: "tool_started", toolId: "c1", title: "npm test" },
      { type: "tool_finished", toolId: "c1", ok: true },
      { type: "assistant_message", text: "Done." },
    ]);
  });

  it("omits sandboxMode for cli-default and resumes by id", async () => {
    const fake = fakeCodex([{ type: "turn.completed", usage: {} }]);
    await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/work", permission: "cli-default", guarded: false, resumeNativeId: "t-9" },
      callbacks([]),
    );
    expect(fake.resumeThread).toHaveBeenCalledWith("t-9", { workingDirectory: "C:/work", skipGitRepoCheck: true });
  });

  it("merges env over process.env when env is given", async () => {
    const fake = fakeCodex([]);
    await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/work", permission: "full-access", guarded: false, env: { GH_TOKEN: "x" } },
      callbacks([]),
    );
    const arg = fake.createCodex.mock.calls[0][0] as { env?: Record<string, string> };
    expect(arg.env?.GH_TOKEN).toBe("x");
    expect(Object.keys(arg.env ?? {}).length).toBeGreaterThan(1);
  });

  it("rejects when the turn fails", async () => {
    const fake = fakeCodex([{ type: "turn.failed", error: { message: "quota" } }]);
    const session = await adapter(fake.createCodex).startSession({ workingDirectory: "C:/w", permission: "cli-default", guarded: false }, callbacks([]));
    await expect(session.runTurn("x", new AbortController().signal)).rejects.toThrow("quota");
  });

  it("refuses to start when Codex cannot be resolved", async () => {
    const a = new CodexAdapter({ createCodex: vi.fn(), resolvePath: async () => null, probe: async () => ({ kind: "missing", detail: "codex" }) });
    await expect(a.startSession({ workingDirectory: "C:/w", permission: "cli-default", guarded: false }, callbacks([]))).rejects.toThrow("CODEX_NOT_FOUND");
    await expect(a.probe()).resolves.toMatchObject({ kind: "missing" });
  });

  it("rejects when the signal is aborted mid-stream", async () => {
    const controller = new AbortController();
    const fake = fakeCodex([
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "completed" } },
    ]);
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/w", permission: "cli-default", guarded: false },
      { onEvent: () => controller.abort(), requestPermission: async () => false, checkTool: () => true },
    );
    await expect(session.runTurn("x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("synthesizes tool_started for a single-shot completed tool item", async () => {
    const fake = fakeCodex([
      {
        type: "item.completed",
        item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "update" }] },
      },
    ]);
    const events: AgentEvent[] = [];
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/w", permission: "cli-default", guarded: false },
      callbacks(events),
    );
    await session.runTurn("x", new AbortController().signal);

    expect(events).toEqual([
      { type: "tool_started", toolId: "f1", title: "file_change" },
      { type: "tool_finished", toolId: "f1", ok: true },
    ]);
  });

  it("checks a command_execution with the guard when it starts", async () => {
    const fake = fakeCodex([
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "completed" } },
    ]);
    const checkTool = vi.fn(() => true);
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/w", permission: "full-access", guarded: true },
      callbacks([], checkTool),
    );
    await session.runTurn("x", new AbortController().signal);
    expect(checkTool).toHaveBeenCalledTimes(1);
    expect(checkTool).toHaveBeenCalledWith({ kind: "shell", summary: "npm test", rawKind: "command_execution" });
  });

  it("checks every path of a single-shot file_change with the guard", async () => {
    const fake = fakeCodex([
      {
        type: "item.completed",
        item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "update" }, { path: "C:/x/b.ts", kind: "add" }] },
      },
    ]);
    const checkTool = vi.fn(() => true);
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/w", permission: "full-access", guarded: true },
      callbacks([], checkTool),
    );
    await session.runTurn("x", new AbortController().signal);
    expect(checkTool.mock.calls).toEqual([
      [{ kind: "write", summary: "a.ts", rawKind: "file_change" }],
      [{ kind: "write", summary: "C:/x/b.ts", rawKind: "file_change" }],
    ]);
  });

  it("reports MCP tool calls as opaque and web searches as network requests when they start", async () => {
    const fake = fakeCodex([
      { type: "item.started", item: { id: "p1", type: "mcp_tool_call", server: "fs", tool: "write", status: "in_progress" } },
      { type: "item.completed", item: { id: "p1", type: "mcp_tool_call", server: "fs", tool: "write", status: "completed" } },
      { type: "item.started", item: { id: "w1", type: "web_search", query: "vitest docs" } },
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "vitest docs" } },
    ]);
    const checkTool = vi.fn(() => true);
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/w", permission: "full-access", guarded: true },
      callbacks([], checkTool),
    );
    await session.runTurn("x", new AbortController().signal);
    expect(checkTool.mock.calls).toEqual([
      [{ kind: "other", summary: "fs/write", rawKind: "mcp_tool_call", opaque: true }],
      [{ kind: "network", summary: "vitest docs", rawKind: "web_search" }],
    ]);
  });

  it("aborts a guarded turn at an MCP tool call through the guard's opaque-tool rule", async () => {
    const controller = new AbortController();
    const fake = fakeCodex([
      { type: "item.started", item: { id: "p1", type: "mcp_tool_call", server: "fs", tool: "write", status: "in_progress" } },
    ]);
    const ctx = { workspaceRoot: "C:/w", homeDir: "C:/Users/u", platform: "win32" as const };
    const rules: string[] = [];
    const checkTool = (r: ToolRequest) => {
      const verdict = checkToolRequest(r, ctx);
      if (!verdict.ok) {
        rules.push(verdict.rule);
        controller.abort();
      }
      return verdict.ok;
    };
    const events: AgentEvent[] = [];
    const session = await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/w", permission: "full-access", guarded: true },
      callbacks(events, checkTool),
    );
    await expect(session.runTurn("x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(rules).toEqual(["opaque-tool"]);
    expect(events).toEqual([]);
  });

  it("stops emitting events once a guard block aborts the turn", async () => {
    const controller = new AbortController();
    const script = [
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "git push", aggregated_output: "", status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "git push", aggregated_output: "", status: "completed" } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Pushed." } },
    ];
    // A stream that ignores the abort signal, so only the adapter can stop emitting.
    const thread = {
      id: "thread-1",
      runStreamed: vi.fn(async () => ({ events: (async function* () { yield* script; })() })),
    };
    const codex: CodexLike = { startThread: vi.fn(() => thread), resumeThread: vi.fn(() => thread) };
    const events: AgentEvent[] = [];
    const checkTool = vi.fn(() => {
      controller.abort();
      return false;
    });
    const session = await adapter(vi.fn(() => codex)).startSession(
      { workingDirectory: "C:/w", permission: "full-access", guarded: true },
      callbacks(events, checkTool),
    );
    await expect(session.runTurn("x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual([]);
  });
});
