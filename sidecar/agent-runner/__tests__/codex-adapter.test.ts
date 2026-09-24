import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, type CodexLike } from "../codex-adapter";
import type { AgentEvent } from "../../../src/shared/types/agent-runner";

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

const callbacks = (events: AgentEvent[]) => ({ onEvent: (e: AgentEvent) => events.push(e), requestPermission: async () => false });

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
      { workingDirectory: "C:/work", permission: "read-only", model: "gpt-x" },
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
      { workingDirectory: "C:/work", permission: "cli-default", resumeNativeId: "t-9" },
      callbacks([]),
    );
    expect(fake.resumeThread).toHaveBeenCalledWith("t-9", { workingDirectory: "C:/work", skipGitRepoCheck: true });
  });

  it("merges env over process.env when env is given", async () => {
    const fake = fakeCodex([]);
    await adapter(fake.createCodex).startSession(
      { workingDirectory: "C:/work", permission: "full-access", env: { GH_TOKEN: "x" } },
      callbacks([]),
    );
    const arg = fake.createCodex.mock.calls[0][0] as { env?: Record<string, string> };
    expect(arg.env?.GH_TOKEN).toBe("x");
    expect(Object.keys(arg.env ?? {}).length).toBeGreaterThan(1);
  });

  it("rejects when the turn fails", async () => {
    const fake = fakeCodex([{ type: "turn.failed", error: { message: "quota" } }]);
    const session = await adapter(fake.createCodex).startSession({ workingDirectory: "C:/w", permission: "cli-default" }, callbacks([]));
    await expect(session.runTurn("x", new AbortController().signal)).rejects.toThrow("quota");
  });

  it("refuses to start when Codex cannot be resolved", async () => {
    const a = new CodexAdapter({ createCodex: vi.fn(), resolvePath: async () => null, probe: async () => ({ kind: "missing", detail: "codex" }) });
    await expect(a.startSession({ workingDirectory: "C:/w", permission: "cli-default" }, callbacks([]))).rejects.toThrow("CODEX_NOT_FOUND");
    await expect(a.probe()).resolves.toMatchObject({ kind: "missing" });
  });
});
