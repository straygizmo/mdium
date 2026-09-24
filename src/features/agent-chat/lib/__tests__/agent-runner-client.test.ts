import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const emitLine = (id: number, msg: object) => handlers.get("agent-runner://line")?.({ payload: { id, line: JSON.stringify(msg) } });
const emitExit = (id: number, code: number | null) => handlers.get("agent-runner://exit")?.({ payload: { id, code } });
const emitStderr = (id: number, line: string) => handlers.get("agent-runner://stderr")?.({ payload: { id, line } });
const flush = () => new Promise((r) => setTimeout(r, 0));

// `spawnBehavior` lets each test control exactly when (or whether) the mocked
// `spawn_agent_runner` emits the "ready" line (or an exit) relative to its
// own resolution, which is what the race/ownership/timeout tests below need
// to control precisely.
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
  listen.mockReset();
  listen.mockImplementation(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
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
    emitExit(7, 1);
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

  // --- Fix round 1 ---------------------------------------------------

  it("rejects a start promptly with RUNNER_EXITED when the process exits before ready (no 15s wait)", async () => {
    const client = await loadClient((id) => {
      setTimeout(() => emitExit(id, 1), 0);
    });
    const startedAt = Date.now();
    await expect(client.sendToRunner({ type: "cancel", sessionId: "s1" })).rejects.toThrow("RUNNER_EXITED");
    // A buggy implementation would only settle this once the 15s timeout
    // fires; a real-timer wall-clock check keeps this test fast either way
    // while still catching a regression.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("clears a stale start's 15s timer so it cannot reject a newer, still-waiting start", async () => {
    vi.useFakeTimers();
    try {
      // Old start (id 7): spawn resolves, then the process exits before ready.
      const client = await loadClient((id) => emitExit(id, 1));
      await expect(client.sendToRunner({ type: "cancel", sessionId: "s1" })).rejects.toThrow("RUNNER_EXITED");

      // Let a little virtual time pass so the new start's own 15s deadline
      // lands strictly after where the OLD start's timer (registered at
      // t=0, deadline t=15000) would fire if it leaked.
      await vi.advanceTimersByTimeAsync(100);

      // New start (id 9): spawn resolves but "ready" is withheld, so it is
      // still waiting exactly when the old deadline would hit.
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "resolve_agent_runner_path") return "C:/runner.mjs";
        if (cmd === "spawn_agent_runner") return 9;
        return undefined;
      });
      let newSettled = false;
      const newStart = client.sendToRunner({ type: "cancel", sessionId: "s2" });
      newStart.then(() => { newSettled = true; }, () => { newSettled = true; });
      await vi.advanceTimersByTimeAsync(0); // let the new start reach its own ready-wait

      // Advance to the old start's absolute deadline (t=15000). If its
      // timer wasn't cleared, it fires now and rejects whichever ready-wait
      // is currently pending -- the new start's.
      await vi.advanceTimersByTimeAsync(14_900);
      expect(newSettled).toBe(false);

      // The new runner's real "ready" must still be honored.
      emitLine(9, { type: "ready" });
      await newStart;
      expect(newSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a pending request when shutdownRunner aborts an in-flight start", async () => {
    const client = await loadClient(() => undefined); // spawn resolves; ready withheld
    const pending = client.requestRunner({ type: "probe", requestId: "r1", provider: "codex" }, "availability");
    await flush();
    await client.shutdownRunner();
    await expect(pending).rejects.toThrow("RUNNER_EXITED");
    expect(invoke).toHaveBeenCalledWith("kill_agent_runner", { id: 7 });
  });

  it("retries subscribing to runner events after a failed subscribe attempt", async () => {
    const client = await loadClient();
    listen.mockRejectedValueOnce(new Error("LISTEN_FAILED"));
    await expect(client.sendToRunner({ type: "cancel", sessionId: "s1" })).rejects.toThrow("LISTEN_FAILED");
    // No spawn attempt should have happened yet -- subscribe() failed first.
    expect(invoke.mock.calls.filter(([c]) => c === "spawn_agent_runner")).toHaveLength(0);
    await client.sendToRunner({ type: "cancel", sessionId: "s2" });
    expect(invoke.mock.calls.filter(([c]) => c === "spawn_agent_runner")).toHaveLength(1);
  });

  it("logs stderr lines during an in-flight start regardless of process id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = await loadClient(() => undefined); // ready withheld -> stays in flight
      const send = client.sendToRunner({ type: "cancel", sessionId: "s1" });
      send.catch(() => undefined); // never settles in this test; keep it observed
      await flush();
      emitStderr(999, "boot diagnostic");
      expect(warnSpy).toHaveBeenCalledWith("[agent-runner]", "boot diagnostic");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("shares a single spawn across concurrent sendToRunner calls started in the same tick", async () => {
    const client = await loadClient();
    await Promise.all([
      client.sendToRunner({ type: "cancel", sessionId: "s1" }),
      client.sendToRunner({ type: "cancel", sessionId: "s2" }),
    ]);
    expect(invoke.mock.calls.filter(([c]) => c === "spawn_agent_runner")).toHaveLength(1);
  });

  it("lets a later call retry after spawn_agent_runner rejects", async () => {
    const client = await loadClient();
    let spawnCalls = 0;
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "resolve_agent_runner_path") return "C:/runner.mjs";
      if (cmd === "spawn_agent_runner") {
        spawnCalls += 1;
        if (spawnCalls === 1) throw new Error("SPAWN_FAILED");
        setTimeout(() => emitLine(7, { type: "ready" }), 0);
        return 7;
      }
      return undefined;
    });
    await expect(client.sendToRunner({ type: "cancel", sessionId: "s1" })).rejects.toThrow("SPAWN_FAILED");
    await client.sendToRunner({ type: "cancel", sessionId: "s2" });
    expect(spawnCalls).toBe(2);
  });
});
