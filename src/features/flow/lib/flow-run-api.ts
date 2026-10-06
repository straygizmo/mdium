import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  FLOW_APPROVAL_REQUESTED_EVENT,
  FLOW_NODE_CHANGED_EVENT,
  FLOW_PROGRESS_EVENT,
  FLOW_RUN_CHANGED_EVENT,
  type ApprovalRequestedEvent,
  type CommandReview,
  type FlowRunError,
  type NodeChangedEvent,
  type ProgressEvent,
  type RunChangedEvent,
  type RunSnapshot,
  type RunSummary,
} from "@/shared/types/flow-run";
import { isFlowCommandError } from "./flow-api";

/** Normalizes a rejection into a `FlowRunError` (keeping `details`), or rethrows it. */
export function toFlowRunError(err: unknown): FlowRunError | null {
  let candidate: unknown = err;
  if (typeof err === "string") {
    try {
      candidate = JSON.parse(err);
    } catch {
      return null;
    }
  }
  if (!isFlowCommandError(candidate)) return null;
  const details = (candidate as { details?: unknown }).details;
  return {
    code: candidate.code,
    message: candidate.message,
    ...(Array.isArray(details) ? { details: details as FlowRunError["details"] } : {}),
  };
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toFlowRunError(err) ?? err;
  }
}

/** Run commands of the flow engine. Paths are project-relative. */
export const flowRunApi = {
  reviewCommands: (projectRoot: string, path: string) =>
    call<CommandReview>("flow_command_review", { projectRoot, path }),
  confirmCommands: (projectRoot: string, path: string, sha256: string) =>
    call<void>("flow_confirm_commands", { projectRoot, path, sha256 }),
  start: (projectRoot: string, path: string, params: Record<string, unknown>, sha256: string) =>
    call<RunSummary>("flow_run_start", { projectRoot, path, params, sha256 }),
  list: (projectRoot: string) => call<RunSummary[]>("flow_run_list", { projectRoot }),
  get: (projectRoot: string, runId: string) => call<RunSnapshot>("flow_run_get", { projectRoot, runId }),
  stop: (projectRoot: string, runId: string) => call<void>("flow_run_stop", { projectRoot, runId }),
  resume: (projectRoot: string, runId: string) => call<void>("flow_run_resume", { projectRoot, runId }),
  cancel: (projectRoot: string, runId: string) => call<void>("flow_run_cancel", { projectRoot, runId }),
  approve: (projectRoot: string, runId: string, nodeKey: string | null, choice: string, comment: string | null) =>
    call<void>("flow_run_approve", { projectRoot, runId, nodeKey, choice, comment }),
  rerunNode: (projectRoot: string, runId: string, nodeKey: string) =>
    call<void>("flow_run_rerun_node", { projectRoot, runId, nodeKey }),
  markSucceeded: (projectRoot: string, runId: string, nodeKey: string) =>
    call<void>("flow_run_mark_succeeded", { projectRoot, runId, nodeKey }),
  delete: (projectRoot: string, runId: string) => call<void>("flow_run_delete", { projectRoot, runId }),
  log: (projectRoot: string, runId: string, nodeKey: string, attempt: number, stream: "stdout" | "stderr", maxBytes: number) =>
    call<string>("flow_run_log", { projectRoot, runId, nodeKey, attempt, stream, maxBytes }),
  gitignoreStatus: (projectRoot: string) => call<{ ignored: boolean }>("flow_gitignore_status", { projectRoot }),
};

export interface FlowRunEventHandlers {
  onRunChanged?: (event: RunChangedEvent) => void;
  onNodeChanged?: (event: NodeChangedEvent) => void;
  onProgress?: (event: ProgressEvent) => void;
  onApprovalRequested?: (event: ApprovalRequestedEvent) => void;
}

/** Subscribes to the flow run events; resolves to an unsubscribe function. */
export async function subscribeFlowRunEvents(handlers: FlowRunEventHandlers): Promise<UnlistenFn> {
  const unlisten: UnlistenFn[] = [];
  const add = async <T,>(name: string, handler?: (payload: T) => void) => {
    if (handler) unlisten.push(await listen<T>(name, (e) => handler(e.payload)));
  };
  await add(FLOW_RUN_CHANGED_EVENT, handlers.onRunChanged);
  await add(FLOW_NODE_CHANGED_EVENT, handlers.onNodeChanged);
  await add(FLOW_PROGRESS_EVENT, handlers.onProgress);
  await add(FLOW_APPROVAL_REQUESTED_EVENT, handlers.onApprovalRequested);
  return () => unlisten.forEach((fn) => fn());
}
