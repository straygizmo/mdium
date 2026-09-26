import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  WORKFLOW_PROGRESS_EVENT,
  WORKFLOW_RUN_CHANGED_EVENT,
  WORKFLOW_TASK_CHANGED_EVENT,
  type CommandError,
  type GitignoreStatus,
  type MergePreview,
  type ProgressEvent,
  type Provider,
  type ProviderProbe,
  type RunChangedEvent,
  type RunList,
  type Task,
  type TaskChangedEvent,
  type TaskDetail,
  type TaskList,
  type Workflow,
  type WorkflowList,
  type WorkflowRun,
  type WorkflowsFileInput,
} from "@/shared/types/workflow";
import { isCommandError } from "./format";

/**
 * Converts a rejection value into a `CommandError` when it is one (an object
 * with `code`/`message`, or a JSON string of one); returns `null` otherwise.
 */
function toCommandError(value: unknown): CommandError | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isCommandError(candidate) ? { code: candidate.code, message: candidate.message } : null;
}

/** Invokes a workflow command, normalizing command errors to `CommandError`. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await (args === undefined ? invoke<T>(command) : invoke<T>(command, args));
  } catch (err) {
    throw toCommandError(err) ?? err;
  }
}

/** Calls a task action command that takes `projectRoot` + `taskId` and returns the task. */
function taskAction(command: string) {
  return (projectRoot: string, taskId: string) => call<Task>(command, { projectRoot, taskId });
}

/** Typed wrappers of the `workflow_*` Tauri commands. */
export const workflowApi = {
  attach: (projectRoot: string) => call<string>("workflow_attach_project", { projectRoot }),
  listWorkflows: (projectRoot: string) => call<WorkflowList>("workflow_list_workflows", { projectRoot }),
  saveWorkflows: (projectRoot: string, file: WorkflowsFileInput) =>
    call<void>("workflow_save_workflows", { projectRoot, file }),
  addStandard: (projectRoot: string, name: string, provider: Provider) =>
    call<Workflow>("workflow_add_standard", { projectRoot, name, provider }),
  activeRunCount: (projectRoot: string, workflowId: string) =>
    call<number>("workflow_active_run_count", { projectRoot, workflowId }),
  listTasks: (projectRoot: string) => call<TaskList>("workflow_list_tasks", { projectRoot }),
  listRuns: (projectRoot: string) => call<RunList>("workflow_list_runs", { projectRoot }),
  taskDetail: (projectRoot: string, taskId: string) =>
    call<TaskDetail>("workflow_task_detail", { projectRoot, taskId }),
  createTask: (projectRoot: string, title: string, body: string, workflowId: string) =>
    call<Task>("workflow_create_task", { projectRoot, title, body, workflowId }),
  cancelTask: taskAction("workflow_cancel_task"),
  holdTask: taskAction("workflow_hold_task"),
  resumeTask: taskAction("workflow_resume_task"),
  markComplete: taskAction("workflow_mark_complete"),
  approvePlan: taskAction("workflow_approve_plan"),
  archiveTask: taskAction("workflow_archive_task"),
  deleteTask: (projectRoot: string, taskId: string) => call<void>("workflow_delete_task", { projectRoot, taskId }),
  retryTask: (
    projectRoot: string,
    taskId: string,
    opts: { acceptScreening: boolean; acceptAgentConfig: boolean; acceptIntegrity: boolean },
  ) =>
    call<Task>("workflow_retry_task", {
      projectRoot,
      taskId,
      acceptScreening: opts.acceptScreening,
      acceptAgentConfig: opts.acceptAgentConfig,
      acceptIntegrity: opts.acceptIntegrity,
    }),
  requestRevision: (projectRoot: string, taskId: string, instruction: string) =>
    call<Task>("workflow_request_revision", { projectRoot, taskId, instruction }),
  answerQuestion: (projectRoot: string, taskId: string, answer: string) =>
    call<Task>("workflow_answer_question", { projectRoot, taskId, answer }),
  mergePreview: (projectRoot: string, rootTaskId: string) =>
    call<MergePreview>("workflow_merge_preview", { projectRoot, rootTaskId }),
  mergeRun: (projectRoot: string, rootTaskId: string, acknowledgedPaths: string[], acknowledgeIntegrity: boolean) =>
    call<WorkflowRun>("workflow_merge_run", { projectRoot, rootTaskId, acknowledgedPaths, acknowledgeIntegrity }),
  discardRun: (projectRoot: string, rootTaskId: string) =>
    call<WorkflowRun>("workflow_discard_run", { projectRoot, rootTaskId }),
  probeProviders: () => call<ProviderProbe[]>("workflow_probe_providers"),
  /** The backend command lands in a later task (gitignore guidance). */
  gitignoreStatus: (projectRoot: string) => call<GitignoreStatus>("workflow_gitignore_status", { projectRoot }),
};

export interface WorkflowEventHandlers {
  onTaskChanged?(e: TaskChangedEvent): void;
  onRunChanged?(e: RunChangedEvent): void;
  onProgress?(e: ProgressEvent): void;
}

/**
 * Listens to the three orchestrator events; resolves to a function that
 * removes every listener. Payloads are forwarded unfiltered (callers compare
 * `projectRoot` with `sameRoot`).
 */
export async function subscribeWorkflowEvents(handlers: WorkflowEventHandlers): Promise<() => void> {
  const results = await Promise.allSettled([
    listen<TaskChangedEvent>(WORKFLOW_TASK_CHANGED_EVENT, (e) => handlers.onTaskChanged?.(e.payload)),
    listen<RunChangedEvent>(WORKFLOW_RUN_CHANGED_EVENT, (e) => handlers.onRunChanged?.(e.payload)),
    listen<ProgressEvent>(WORKFLOW_PROGRESS_EVENT, (e) => handlers.onProgress?.(e.payload)),
  ]);
  const unlisteners: UnlistenFn[] = [];
  for (const r of results) if (r.status === "fulfilled") unlisteners.push(r.value);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    // Do not leak the listeners that did register.
    for (const unlisten of unlisteners) unlisten();
    throw failed.reason;
  }
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
