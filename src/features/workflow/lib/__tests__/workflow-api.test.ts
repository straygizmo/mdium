// @vitest-environment happy-dom
// happy-dom: the client reuses format.ts, which initializes i18n (localStorage).
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { subscribeWorkflowEvents, workflowApi } from "../workflow-api";
import {
  WORKFLOW_PROGRESS_EVENT,
  WORKFLOW_RUN_CHANGED_EVENT,
  WORKFLOW_TASK_CHANGED_EVENT,
} from "@/shared/types/workflow";

const ROOT = "C:\\proj";
const FILE = { schemaVersion: 1, workflows: [] };

type Case = [name: string, call: () => Promise<unknown>, command: string, args?: Record<string, unknown>];

const cases: Case[] = [
  ["attach", () => workflowApi.attach(ROOT), "workflow_attach_project", { projectRoot: ROOT }],
  ["listWorkflows", () => workflowApi.listWorkflows(ROOT), "workflow_list_workflows", { projectRoot: ROOT }],
  ["saveWorkflows", () => workflowApi.saveWorkflows(ROOT, FILE), "workflow_save_workflows", { projectRoot: ROOT, file: FILE }],
  [
    "addStandard",
    () => workflowApi.addStandard(ROOT, "Std", "codex"),
    "workflow_add_standard",
    { projectRoot: ROOT, name: "Std", provider: "codex" },
  ],
  [
    "activeRunCount",
    () => workflowApi.activeRunCount(ROOT, "wf1"),
    "workflow_active_run_count",
    { projectRoot: ROOT, workflowId: "wf1" },
  ],
  ["listTasks", () => workflowApi.listTasks(ROOT), "workflow_list_tasks", { projectRoot: ROOT }],
  ["listRuns", () => workflowApi.listRuns(ROOT), "workflow_list_runs", { projectRoot: ROOT }],
  ["taskDetail", () => workflowApi.taskDetail(ROOT, "t1"), "workflow_task_detail", { projectRoot: ROOT, taskId: "t1" }],
  [
    "createTask",
    () => workflowApi.createTask(ROOT, "Title", "Body", "wf1"),
    "workflow_create_task",
    { projectRoot: ROOT, title: "Title", body: "Body", workflowId: "wf1" },
  ],
  ["cancelTask", () => workflowApi.cancelTask(ROOT, "t1"), "workflow_cancel_task", { projectRoot: ROOT, taskId: "t1" }],
  ["holdTask", () => workflowApi.holdTask(ROOT, "t1"), "workflow_hold_task", { projectRoot: ROOT, taskId: "t1" }],
  ["resumeTask", () => workflowApi.resumeTask(ROOT, "t1"), "workflow_resume_task", { projectRoot: ROOT, taskId: "t1" }],
  ["markComplete", () => workflowApi.markComplete(ROOT, "t1"), "workflow_mark_complete", { projectRoot: ROOT, taskId: "t1" }],
  ["approvePlan", () => workflowApi.approvePlan(ROOT, "t1"), "workflow_approve_plan", { projectRoot: ROOT, taskId: "t1" }],
  ["archiveTask", () => workflowApi.archiveTask(ROOT, "t1"), "workflow_archive_task", { projectRoot: ROOT, taskId: "t1" }],
  ["deleteTask", () => workflowApi.deleteTask(ROOT, "t1"), "workflow_delete_task", { projectRoot: ROOT, taskId: "t1" }],
  [
    "retryTask",
    () => workflowApi.retryTask(ROOT, "t1", { acceptScreening: true, acceptAgentConfig: false, acceptIntegrity: true }),
    "workflow_retry_task",
    { projectRoot: ROOT, taskId: "t1", acceptScreening: true, acceptAgentConfig: false, acceptIntegrity: true },
  ],
  [
    "requestRevision",
    () => workflowApi.requestRevision(ROOT, "t1", "fix it"),
    "workflow_request_revision",
    { projectRoot: ROOT, taskId: "t1", instruction: "fix it" },
  ],
  [
    "answerQuestion",
    () => workflowApi.answerQuestion(ROOT, "t1", "yes"),
    "workflow_answer_question",
    { projectRoot: ROOT, taskId: "t1", answer: "yes" },
  ],
  [
    "mergePreview",
    () => workflowApi.mergePreview(ROOT, "r1"),
    "workflow_merge_preview",
    { projectRoot: ROOT, rootTaskId: "r1" },
  ],
  [
    "mergeRun",
    () => workflowApi.mergeRun(ROOT, "r1", ["a.txt"], true),
    "workflow_merge_run",
    { projectRoot: ROOT, rootTaskId: "r1", acknowledgedPaths: ["a.txt"], acknowledgeIntegrity: true },
  ],
  ["discardRun", () => workflowApi.discardRun(ROOT, "r1"), "workflow_discard_run", { projectRoot: ROOT, rootTaskId: "r1" }],
  ["probeProviders", () => workflowApi.probeProviders(), "workflow_probe_providers", undefined],
  ["gitignoreStatus", () => workflowApi.gitignoreStatus(ROOT), "workflow_gitignore_status", { projectRoot: ROOT }],
];

describe("workflowApi", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it.each(cases)("%s invokes the right command with camelCase args", async (_name, call, command, args) => {
    invoke.mockResolvedValue("result");
    await expect(call()).resolves.toBe("result");
    expect(invoke).toHaveBeenCalledTimes(1);
    if (args === undefined) {
      expect(invoke).toHaveBeenCalledWith(command);
    } else {
      expect(invoke).toHaveBeenCalledWith(command, args);
    }
  });

  it("rejects with a CommandError when the rejection is an error object", async () => {
    invoke.mockRejectedValue({ code: "TRANSITION_CONFLICT", message: "changed", extra: 1 });
    await expect(workflowApi.holdTask(ROOT, "t1")).rejects.toEqual({ code: "TRANSITION_CONFLICT", message: "changed" });
  });

  it("parses a JSON string rejection into a CommandError", async () => {
    invoke.mockRejectedValue(JSON.stringify({ code: "WORKFLOW_PROJECT_INVALID", message: "bad root" }));
    await expect(workflowApi.listTasks(ROOT)).rejects.toEqual({ code: "WORKFLOW_PROJECT_INVALID", message: "bad root" });
  });

  it("rethrows a plain string rejection unchanged", async () => {
    invoke.mockRejectedValue("boom");
    await expect(workflowApi.listTasks(ROOT)).rejects.toBe("boom");
  });

  it("rethrows a JSON string that is not a CommandError unchanged", async () => {
    invoke.mockRejectedValue('{"other":1}');
    await expect(workflowApi.listTasks(ROOT)).rejects.toBe('{"other":1}');
  });

  it("rethrows an Error unchanged", async () => {
    const err = new Error("ipc down");
    invoke.mockRejectedValue(err);
    await expect(workflowApi.listTasks(ROOT)).rejects.toBe(err);
  });
});

describe("subscribeWorkflowEvents", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("registers three listeners, forwards payloads and unlistens all", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();
    listen.mockImplementation(async (name: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      const un = vi.fn();
      unlisteners.set(name, un);
      return un;
    });
    const onTaskChanged = vi.fn();
    const onRunChanged = vi.fn();
    const onProgress = vi.fn();

    const unsubscribe = await subscribeWorkflowEvents({ onTaskChanged, onRunChanged, onProgress });

    expect(listen).toHaveBeenCalledTimes(3);
    expect([...handlers.keys()].sort()).toEqual(
      [WORKFLOW_TASK_CHANGED_EVENT, WORKFLOW_RUN_CHANGED_EVENT, WORKFLOW_PROGRESS_EVENT].sort(),
    );

    const task = { projectRoot: ROOT, taskId: "t1", rootId: "t1", status: "running" };
    const run = { projectRoot: ROOT, rootTaskId: "t1", status: "active" };
    const progress = { projectRoot: ROOT, taskId: "t1", attemptId: "a1", kind: "message", text: "hi" };
    handlers.get(WORKFLOW_TASK_CHANGED_EVENT)?.({ payload: task });
    handlers.get(WORKFLOW_RUN_CHANGED_EVENT)?.({ payload: run });
    handlers.get(WORKFLOW_PROGRESS_EVENT)?.({ payload: progress });
    expect(onTaskChanged).toHaveBeenCalledWith(task);
    expect(onRunChanged).toHaveBeenCalledWith(run);
    expect(onProgress).toHaveBeenCalledWith(progress);

    unsubscribe();
    for (const un of unlisteners.values()) expect(un).toHaveBeenCalledTimes(1);
  });

  it("unlistens the registered listeners when one registration fails", async () => {
    const un = vi.fn();
    listen.mockImplementation(async (name: string) => {
      if (name === WORKFLOW_PROGRESS_EVENT) throw new Error("listen failed");
      return un;
    });
    await expect(subscribeWorkflowEvents({})).rejects.toThrow("listen failed");
    expect(un).toHaveBeenCalledTimes(2);
  });

  it("does not fail when a handler is omitted", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    listen.mockImplementation(async (name: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return vi.fn();
    });
    await subscribeWorkflowEvents({});
    expect(() => handlers.get(WORKFLOW_PROGRESS_EVENT)?.({ payload: {} })).not.toThrow();
  });
});
