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
  return {
    core, sent, session, adapter, line, start,
    callbacks: () => callbacks,
    signal: () => lastSignal,
    finishTurn: (v: string) => turn.resolve(v),
    failTurn: (e: unknown) => turn.reject(e),
    resetTurn: () => { turn = deferred<string>(); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RunnerCore", () => {
  it("answers probe", async () => {
    const t = setup();
    await t.line({ type: "probe", requestId: "r0", provider: "copilot" });
    expect(t.sent).toContainEqual({ type: "availability", requestId: "r0", provider: "copilot", availability: { kind: "available", version: "1.0.0" } });
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
});
