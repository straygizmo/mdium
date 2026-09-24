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
interface ReadyWaiter {
  resolve: () => void;
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
let readyWaiter: ReadyWaiter | null = null;
// Non-null for the whole duration of a start attempt (from just before it
// subscribes/spawns until it settles, success or failure). Two jobs:
//  1. While `runnerId` is still null, the line/exit listeners buffer into
//     it instead of dropping events -- `spawn_agent_runner` can emit its
//     first line (typically "ready") before the invoke promise carrying
//     its id resolves, and a naive id check would drop that line forever.
//  2. It doubles as the "a start is in flight" flag, which the stderr
//     listener uses to log without filtering by id while the process is
//     still proving itself (before/while we know its real id).
let startBuffer: BufferedEvent[] | null = null;
// Incremented every time a new start attempt begins. Each attempt captures
// its own value at the top and checks it before mutating shared state
// (`runnerId`/`starting`/`readyWaiter`/`startBuffer`) in its catch/finally,
// so a stale/superseded start (e.g. one aborted by `shutdownRunner`, or one
// that lost a race to a newer start) can never clobber state that no longer
// belongs to it.
let generation = 0;

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
    readyWaiter?.resolve();
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

/** The runner process is gone: reject anything waiting on it and tell everyone. */
function handleExit(): void {
  readyWaiter?.reject(new Error("RUNNER_EXITED"));
  readyWaiter = null;
  runnerId = null;
  starting = null;
  for (const req of pending.values()) req.reject(new Error("RUNNER_EXITED"));
  pending.clear();
  listeners.forEach((listener) => listener({ type: "error", message: "RUNNER_EXITED" }));
}

function subscribe(): Promise<void> {
  subscribed ??= Promise.all([
    listen<LinePayload>("agent-runner://line", (e) => {
      if (runnerId === null) {
        startBuffer?.push({ kind: "line", payload: e.payload });
        return;
      }
      if (e.payload.id !== runnerId) return;
      processLine(e.payload.line);
    }),
    listen<LinePayload>("agent-runner://stderr", (e) => {
      // While a start is in flight, log regardless of id -- the process
      // isn't confirmed "ours" by id yet, but its stderr is still useful.
      if (startBuffer !== null || e.payload.id === runnerId) {
        console.warn("[agent-runner]", e.payload.line);
      }
    }),
    listen<ExitPayload>("agent-runner://exit", (e) => {
      if (runnerId === null) {
        startBuffer?.push({ kind: "exit", payload: e.payload });
        return;
      }
      if (e.payload.id === runnerId) handleExit();
    }),
  ]).then(() => undefined);
  return subscribed;
}

function startRunner(): Promise<number> {
  const myGeneration = ++generation;
  return (async () => {
    let spawnedId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      try {
        await subscribe();
      } catch (subscribeError) {
        // The Tauri event bindings never got established. Let a later call
        // retry `listen(...)` instead of reusing this broken promise forever.
        subscribed = null;
        throw subscribeError;
      }

      if (generation !== myGeneration) {
        // Superseded (e.g. `shutdownRunner` ran) while we were still
        // subscribing. Bail out before writing any shared state.
        throw new Error("RUNNER_EXITED");
      }

      startBuffer = [];
      const ready = new Promise<void>((resolve, reject) => {
        readyWaiter = { resolve, reject };
      });
      // Attach a no-op handler immediately: a shutdown-triggered rejection
      // can arrive before `await ready` is reached below (e.g. while still
      // resolving the script path or spawning), and without an early
      // handler that would surface as an unhandled rejection even though
      // `await ready` goes on to observe the same rejection normally.
      ready.catch(() => undefined);

      const scriptPath = await invoke<string>("resolve_agent_runner_path");
      if (generation !== myGeneration) {
        // Superseded while resolving the script path. Bail out before
        // spawning a process nobody wants anymore.
        throw new Error("RUNNER_EXITED");
      }

      spawnedId = await invoke<number>("spawn_agent_runner", { scriptPath });
      if (generation !== myGeneration) {
        // Superseded (e.g. `shutdownRunner` ran) while we were spawning.
        // Don't claim ownership of shared state; the catch below still
        // kills the process we just spawned.
        throw new Error("RUNNER_EXITED");
      }
      runnerId = spawnedId;

      // Replay whatever arrived for this id while we were still waiting on
      // the spawn promise; discard anything from a stale/other process.
      const buffered = startBuffer;
      startBuffer = [];
      for (const event of buffered) {
        if (event.payload.id !== spawnedId) continue;
        if (event.kind === "line") {
          processLine(event.payload.line);
        } else {
          // The process is already gone; ignore anything buffered after it.
          handleExit();
          break;
        }
      }

      timer = setTimeout(() => {
        readyWaiter?.reject(new Error("RUNNER_START_TIMEOUT"));
        readyWaiter = null;
      }, START_TIMEOUT_MS);
      await ready;
      return spawnedId;
    } catch (error) {
      if (generation === myGeneration) {
        readyWaiter = null;
        runnerId = null;
        // Clear `starting` here (before the kill below, which can take a
        // moment) so a caller that calls `ensureRunner()` while we're
        // still killing the process starts a fresh attempt instead of
        // joining this one, which is only going to reject anyway.
        starting = null;
        startBuffer = null;
      }
      if (spawnedId !== null) {
        await invoke("kill_agent_runner", { id: spawnedId }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (generation === myGeneration) {
        starting = null;
        startBuffer = null;
      }
    }
  })();
}

async function ensureRunner(): Promise<number> {
  if (runnerId !== null) return runnerId;
  starting ??= startRunner();
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
  const id = runnerId;
  if (id === null && starting === null) return;

  // Invalidate any in-flight start (its ownership check will fail from
  // here on) and unblock its ready-wait immediately rather than leaving it
  // to time out.
  generation++;
  readyWaiter?.reject(new Error("RUNNER_EXITED"));
  readyWaiter = null;
  starting = null;
  runnerId = null;
  startBuffer = null;

  for (const req of pending.values()) req.reject(new Error("RUNNER_EXITED"));
  pending.clear();
  listeners.forEach((listener) => listener({ type: "error", message: "RUNNER_EXITED" }));

  if (id !== null) {
    await invoke("kill_agent_runner", { id }).catch(() => undefined);
  }
}
