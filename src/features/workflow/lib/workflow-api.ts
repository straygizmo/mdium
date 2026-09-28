import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  WORKFLOW_INTAKE_CHANGED_EVENT,
  WORKFLOW_PROGRESS_EVENT,
  WORKFLOW_RUN_CHANGED_EVENT,
  WORKFLOW_TASK_CHANGED_EVENT,
  WORKFLOW_WORKFLOWS_CHANGED_EVENT,
  type AttachmentMeta,
  type CommandError,
  type ForgeProbe,
  type GitignoreStatus,
  type IntakeChangedEvent,
  type IntakeKind,
  type IntakeList,
  type IntakeSessionView,
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
  type WorkflowsChangedEvent,
  type WorkflowsFileInput,
} from "@/shared/types/workflow";
import { isCommandError } from "./errors";

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
  mergeRun: (
    projectRoot: string,
    rootTaskId: string,
    acknowledgedPaths: string[],
    acknowledgeIntegrity: boolean,
    expectedHead: string | null,
  ) =>
    call<WorkflowRun>("workflow_merge_run", {
      projectRoot,
      rootTaskId,
      acknowledgedPaths,
      acknowledgeIntegrity,
      expectedHead,
    }),
  acknowledgeIntegrity: (projectRoot: string, rootTaskId: string) =>
    call<WorkflowRun>("workflow_acknowledge_integrity", { projectRoot, rootTaskId }),
  discardRun: (projectRoot: string, rootTaskId: string) =>
    call<WorkflowRun>("workflow_discard_run", { projectRoot, rootTaskId }),
  probeProviders: () => call<ProviderProbe[]>("workflow_probe_providers"),
  gitignoreStatus: (projectRoot: string) => call<GitignoreStatus>("workflow_gitignore_status", { projectRoot }),
  forgeProbe: (projectRoot: string) => call<ForgeProbe>("workflow_forge_probe", { projectRoot }),
  intakeCreate: (
    projectRoot: string,
    workflowId: string,
    kind: IntakeKind,
    provider: Provider,
    model: string | null,
  ) => call<IntakeSessionView>("workflow_intake_create", { projectRoot, workflowId, kind, provider, model }),
  intakeList: (projectRoot: string) => call<IntakeList>("workflow_intake_list", { projectRoot }),
  intakeGet: (projectRoot: string, intakeId: string) =>
    call<IntakeSessionView>("workflow_intake_get", { projectRoot, intakeId }),
  /**
   * Appends a user message and starts the agent's turn in the background
   * (rejects with `INTAKE_TURN_BUSY` while one runs); the reply arrives with
   * the `workflow://intake-changed` event that ends the turn.
   */
  intakeSend: (projectRoot: string, intakeId: string, text: string, draftIds: string[]) =>
    call<IntakeSessionView>("workflow_intake_send", { projectRoot, intakeId, text, draftIds }),
  /** Runs the turn answering the latest user message again, in the background. */
  intakeRetry: (projectRoot: string, intakeId: string) =>
    call<IntakeSessionView>("workflow_intake_retry", { projectRoot, intakeId }),
  /** Cancels the running turn; resolves to false when none runs. */
  intakeCancelTurn: (projectRoot: string, intakeId: string) =>
    call<boolean>("workflow_intake_cancel_turn", { projectRoot, intakeId }),
  intakeAbandon: (projectRoot: string, intakeId: string) =>
    call<IntakeSessionView>("workflow_intake_abandon", { projectRoot, intakeId }),
  intakeAddDraftPath: (projectRoot: string, intakeId: string, path: string) =>
    call<AttachmentMeta>("workflow_intake_add_draft_path", { projectRoot, intakeId, path }),
  /** Adds base64-encoded content (at most 20 MiB decoded) as a draft named `name`. */
  intakeAddDraftBytes: (projectRoot: string, intakeId: string, name: string, bytesBase64: string) =>
    call<AttachmentMeta>("workflow_intake_add_draft_bytes", { projectRoot, intakeId, name, bytesBase64 }),
  intakeRemoveDraft: (projectRoot: string, intakeId: string, draftId: string) =>
    call<void>("workflow_intake_remove_draft", { projectRoot, intakeId, draftId }),
  intakeListDrafts: (projectRoot: string, intakeId: string) =>
    call<AttachmentMeta[]>("workflow_intake_list_drafts", { projectRoot, intakeId }),
  intakeApplyDocUpdate: (projectRoot: string, intakeId: string, proposalId: string, accept: boolean) =>
    call<IntakeSessionView>("workflow_intake_apply_doc_update", { projectRoot, intakeId, proposalId, accept }),
  intakeFinalize: (projectRoot: string, intakeId: string, skipIssue: boolean) =>
    call<IntakeSessionView>("workflow_intake_finalize", { projectRoot, intakeId, skipIssue }),
  /** Replaces the proposal with the user's edit (rejects with `INTAKE_TURN_BUSY` while a turn runs). */
  intakeUpdateProposal: (projectRoot: string, intakeId: string, title: string, body: string) =>
    call<IntakeSessionView>("workflow_intake_update_proposal", { projectRoot, intakeId, title, body }),
  /** Returns a finalize that stopped before the Issue was created to the conversation. */
  intakeReopen: (projectRoot: string, intakeId: string) =>
    call<IntakeSessionView>("workflow_intake_reopen", { projectRoot, intakeId }),
  /** Verified absolute path of a draft's content (for `convertFileSrc` or opening it). */
  intakeDraftPath: (projectRoot: string, intakeId: string, draftId: string) =>
    call<string>("workflow_intake_draft_path", { projectRoot, intakeId, draftId }),
  listAttachments: (projectRoot: string, rootTaskId: string) =>
    call<AttachmentMeta[]>("workflow_list_attachments", { projectRoot, rootTaskId }),
  /** Verified absolute path of a committed attachment's content (for `convertFileSrc` or opening it). */
  attachmentPath: (projectRoot: string, rootTaskId: string, attachmentId: string) =>
    call<string>("workflow_attachment_path", { projectRoot, rootTaskId, attachmentId }),
  retryIssueSync: taskAction("workflow_retry_issue_sync"),
  skipIssueSync: taskAction("workflow_skip_issue_sync"),
  retryIssueClose: (projectRoot: string, rootTaskId: string) =>
    call<WorkflowRun>("workflow_retry_issue_close", { projectRoot, rootTaskId }),
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

/**
 * Listens to `workflow://intake-changed` (every intake session change, and
 * the start and end of every agent turn); resolves to the unlisten function.
 */
export async function subscribeIntakeChanged(handler: (e: IntakeChangedEvent) => void): Promise<() => void> {
  return listen<IntakeChangedEvent>(WORKFLOW_INTAKE_CHANGED_EVENT, (e) => handler(e.payload));
}

/**
 * Listens to `workflow://workflows-changed` (`workflows.json` was rewritten,
 * e.g. from another window); resolves to the unlisten function.
 */
export async function subscribeWorkflowsChanged(handler: (e: WorkflowsChangedEvent) => void): Promise<() => void> {
  return listen<WorkflowsChangedEvent>(WORKFLOW_WORKFLOWS_CHANGED_EVENT, (e) => handler(e.payload));
}
