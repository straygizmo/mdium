import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RunnerInbound, RunnerOutbound } from "@/shared/types/agent-runner";

interface LinePayload { id: number; line: string }
interface ExitPayload { id: number; code: number | null }
interface PendingRequest {
  expect: RunnerOutbound["type"];
  resolve: (msg: RunnerOutbound) => void;
  reject: (error: Error) => void;
}
type BufferedEvent =
  | { kind: "line"; payload: LinePayload }
  | { kind: "exit"; payload: ExitPayload };

/** How long to wait for the runner's `ready` line before giving up on a start. */
const START_TIMEOUT_MS = 15_000;

const listeners = new Set<(msg: RunnerOutbound) => void>();
const pending = new Map<string, PendingRequest>();
let runnerId: number | null = null;
let starting: Promise<number> | null = null;
let subscribed: Promise<void> | null = null;
let readyWaiter: (() => void) | null = null;
// Non-null only while a start is in progress and `runnerId` is not yet
// known. `spawn_agent_runner` can emit its first line (typically "ready")
// before the invoke promise that carries its id resolves; without this
// buffer that line would be dropped (its id doesn't match anything yet)
// and `ensureRunner` would hang forever waiting for `ready`.
let startBuffer: BufferedEvent[] | null = null;

function processLine(line: string): void {
  try {
    const msg = JSON.parse(line) as RunnerOutbound;
    if (msg && typeof msg.type === "string") dispatch(msg);
  } catch {
    console.warn("[agent-runner] unparseable line:", line);
  }
}

function dispatch(msg: RunnerOutbound): void {
  if (msg.type === "ready") {
    readyWaiter?.();
    readyWaiter = null;
    return;
  }
  const requestId = "requestId" in msg ? msg.requestId : undefined;
  if (requestId) {
    const req = pending.get(requestId);
    if (req && (msg.type === req.expect || msg.type === "error")) {
      pending.delete(requestId);
      if (msg.type === "error") req.reject(new Error(msg.message));
      else req.resolve(msg);
    }
  }
  listeners.forEach((listener) => listener(msg));
}

function handleExit(): void {
  runnerId = null;
  starting = null;
  for (const req of pending.values()) req.reject(new Error("RUNNER_EXITED"));
  pending.clear();
  listeners.forEach((listener) => listener({ type: "error", message: "RUNNER_EXITED" }));
}

function subscribe(): Promise<void> {
  subscribed ??= Promise.all([
    listen<LinePayload>("agent-runner://line", (e) => {
      if (startBuffer !== null && runnerId === null) {
        startBuffer.push({ kind: "line", payload: e.payload });
        return;
      }
      if (e.payload.id !== runnerId) return;
      processLine(e.payload.line);
    }),
    listen<LinePayload>("agent-runner://stderr", (e) => {
      if (e.payload.id === runnerId) console.warn("[agent-runner]", e.payload.line);
    }),
    listen<ExitPayload>("agent-runner://exit", (e) => {
      if (startBuffer !== null && runnerId === null) {
        startBuffer.push({ kind: "exit", payload: e.payload });
        return;
      }
      if (e.payload.id === runnerId) handleExit();
    }),
  ]).then(() => undefined);
  return subscribed;
}

async function ensureRunner(): Promise<number> {
  if (runnerId !== null) return runnerId;
  starting ??= (async () => {
    await subscribe();
    startBuffer = [];
    let spawnedId: number | null = null;
    try {
      const ready = new Promise<void>((resolve) => { readyWaiter = resolve; });
      const scriptPath = await invoke<string>("resolve_agent_runner_path");
      spawnedId = await invoke<number>("spawn_agent_runner", { scriptPath });
      runnerId = spawnedId;

      // Replay whatever arrived for this id while we were still waiting on
      // the spawn promise; discard anything from a stale/other process.
      const buffered = startBuffer;
      startBuffer = null;
      for (const event of buffered) {
        if (event.payload.id !== spawnedId) continue;
        if (event.kind === "line") processLine(event.payload.line);
        else handleExit();
      }

      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("RUNNER_START_TIMEOUT")), START_TIMEOUT_MS);
      });
      await Promise.race([ready, timeout]);
      return spawnedId;
    } catch (error) {
      readyWaiter = null;
      startBuffer = null;
      runnerId = null;
      if (spawnedId !== null) {
        await invoke("kill_agent_runner", { id: spawnedId }).catch(() => undefined);
      }
      throw error;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

export function onRunnerMessage(listener: (msg: RunnerOutbound) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function sendToRunner(msg: RunnerInbound): Promise<void> {
  const id = await ensureRunner();
  await invoke("write_agent_runner", { id, line: JSON.stringify(msg) });
}

export function requestRunner<T extends RunnerOutbound["type"]>(
  msg: RunnerInbound & { requestId: string },
  expect: T,
): Promise<Extract<RunnerOutbound, { type: T }>> {
  return new Promise((resolve, reject) => {
    pending.set(msg.requestId, { expect, resolve: resolve as (m: RunnerOutbound) => void, reject });
    sendToRunner(msg).catch((error: unknown) => {
      pending.delete(msg.requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function newRunnerId(): string {
  return globalThis.crypto.randomUUID();
}

export async function shutdownRunner(): Promise<void> {
  if (runnerId === null) return;
  const id = runnerId;
  runnerId = null;
  starting = null;
  await invoke("kill_agent_runner", { id }).catch(() => undefined);
}
