import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

const emitLine = (id: number, msg: object) => handlers.get("agent-runner://line")?.({ payload: { id, line: JSON.stringify(msg) } });
const flush = () => new Promise((r) => setTimeout(r, 0));

// `spawnBehavior` lets each test control exactly when (or whether) the mocked
// `spawn_agent_runner` emits the "ready" line relative to its own resolution,
// which is what the ready/race and timeout tests below need to control.
async function loadClient(spawnBehavior: (id: number) => void = (id) => { setTimeout(() => emitLine(id, { type: "ready" }), 0); }) {
  vi.resetModules();
  handlers.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "resolve_agent_runner_path") return "C:/runner.mjs";
    if (cmd === "spawn_agent_runner") {
      spawnBehavior(7);
      return 7;
    }
    return undefined;
  });
  return import("../agent-runner-client");
}

describe("agent runner client", () => {
  beforeEach(() => vi.useRealTimers());

  it("spawns once, waits for ready, and writes JSON lines", async () => {
    const client = await loadClient();
    await client.sendToRunner({ type: "cancel", sessionId: "s1" });
    await client.sendToRunner({ type: "cancel", sessionId: "s2" });
    expect(invoke.mock.calls.filter(([c]) => c === "spawn_agent_runner")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("write_agent_runner", { id: 7, line: JSON.stringify({ type: "cancel", sessionId: "s1" }) });
  });

  it("resolves requests by requestId and rejects on matching errors", async () => {
    const client = await loadClient();
    const ok = client.requestRunner({ type: "probe", requestId: "r1", provider: "codex" }, "availability");
    const bad = client.requestRunner({ type: "list_sessions", requestId: "r2", provider: "codex", workingDirectory: "C:/w" }, "session_list");
    await flush();
    emitLine(7, { type: "availability", requestId: "r1", provider: "codex", availability: { kind: "available", version: "1" } });
    emitLine(7, { type: "error", requestId: "r2", message: "LIST_UNSUPPORTED" });
    await expect(ok).resolves.toMatchObject({ requestId: "r1" });
    await expect(bad).rejects.toThrow("LIST_UNSUPPORTED");
  });

  it("fans out messages and ignores other processes", async () => {
    const client = await loadClient();
    const seen: unknown[] = [];
    client.onRunnerMessage((m) => seen.push(m));
    await client.sendToRunner({ type: "cancel", sessionId: "s1" });
    emitLine(7, { type: "turn_cancelled", sessionId: "s1" });
    emitLine(8, { type: "turn_cancelled", sessionId: "other" });
    expect(seen).toContainEqual({ type: "turn_cancelled", sessionId: "s1" });
    expect(seen).not.toContainEqual({ type: "turn_cancelled", sessionId: "other" });
  });

  it("reports exit, rejects pending requests, and respawns on next use", async () => {
    const client = await loadClient();
    const seen: unknown[] = [];
    client.onRunnerMessage((m) => seen.push(m));
    const pending = client.requestRunner({ type: "probe", requestId: "r1", provider: "codex" }, "availability");
    await flush();
    handlers.get("agent-runner://exit")?.({ payload: { id: 7, code: 1 } });
    await expect(pending).rejects.toThrow("RUNNER_EXITED");
    expect(seen).toContainEqual({ type: "error", message: "RUNNER_EXITED" });
    await client.sendToRunner({ type: "cancel", sessionId: "s1" });
    expect(invoke.mock.calls.filter(([c]) => c === "spawn_agent_runner")).toHaveLength(2);
  });

  it("does not drop a ready that arrives before spawn_agent_runner resolves", async () => {
    // Emit "ready" synchronously from inside the spawn_agent_runner mock,
    // i.e. before the id (7) is assigned to runnerId in the client. A naive
    // `if (payload.id !== runnerId) return;` check would drop this line
    // forever (runnerId is still null), hanging ensureRunner/sendToRunner.
    const client = await loadClient((id) => emitLine(id, { type: "ready" }));
    await expect(client.sendToRunner({ type: "cancel", sessionId: "s1" })).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("write_agent_runner", { id: 7, line: JSON.stringify({ type: "cancel", sessionId: "s1" }) });
  });

  it("times out a start that never gets ready, kills the process, and resets for the next call", async () => {
    vi.useFakeTimers();
    try {
      // spawn_agent_runner resolves but never emits a "ready" line.
      const client = await loadClient(() => undefined);
      const pending = client.sendToRunner({ type: "cancel", sessionId: "s1" });
      // Attach the rejection assertion before advancing time so the promise
      // is never briefly unobserved (fake-timer time jumps can otherwise
      // trip Node's unhandled-rejection detector between the two awaits).
      const rejection = expect(pending).rejects.toThrow("RUNNER_START_TIMEOUT");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(invoke).toHaveBeenCalledWith("kill_agent_runner", { id: 7 });

      // State must be reset so the next call starts a fresh process.
      invoke.mockClear();
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "resolve_agent_runner_path") return "C:/runner.mjs";
        if (cmd === "spawn_agent_runner") {
          emitLine(7, { type: "ready" });
          return 7;
        }
        return undefined;
      });
      await client.sendToRunner({ type: "cancel", sessionId: "s2" });
      expect(invoke.mock.calls.filter(([c]) => c === "spawn_agent_runner")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
