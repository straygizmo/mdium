// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  attach: vi.fn(),
  listWorkflows: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  intakeList: vi.fn(),
}));
const listen = vi.hoisted(() => vi.fn());
vi.mock("../lib/workflow-api", () => ({ workflowApi: api, subscribeWorkflowEvents: vi.fn() }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { WORKFLOW_OPEN_TASK_EVENT, type OpenTaskEvent } from "@/shared/types/workflow";
import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { startWorkflowFolderSync, startWorkflowOpenTaskListener } from "../folder-sync";
import { useWorkflowStore } from "../workflow-store";

const initialState = useWorkflowStore.getState();

describe("startWorkflowFolderSync", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState(initialState, true);
    useTabStore.setState({ activeFolderPath: "C:/a" });
    api.attach.mockImplementation(async (folder: string) => folder);
    api.listWorkflows.mockResolvedValue({ workflows: [], warnings: [] });
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    api.intakeList.mockResolvedValue({ sessions: [], warnings: [] });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    useTabStore.setState({ activeFolderPath: null });
  });

  it("activates the current folder and follows folder changes", async () => {
    stop = startWorkflowFolderSync();
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRoot).toBe("C:/a"));
    useWorkflowStore.getState().openTask("t1");

    useTabStore.setState({ activeFolderPath: "C:/b" });
    // Cleared in the same update as the folder change: no frame shows the old board.
    expect(useWorkflowStore.getState().activeRoot).toBeNull();
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRoot).toBe("C:/b"));
    expect(api.attach).toHaveBeenLastCalledWith("C:/b");
  });

  it("ignores unrelated tab store changes and stops on release", async () => {
    stop = startWorkflowFolderSync();
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRoot).toBe("C:/a"));
    useTabStore.setState({ activeFolderPath: "C:/a" });
    expect(api.attach).toHaveBeenCalledTimes(1);
    stop();
    stop = null;
    useTabStore.setState({ activeFolderPath: "C:/c" });
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(useWorkflowStore.getState().activeRoot).toBe("C:/a");
  });
});

describe("startWorkflowOpenTaskListener", () => {
  let emit: (payload: OpenTaskEvent) => void;
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState(initialState, true);
    useTabStore.setState({ activeFolderPath: "C:/a", folderLeftPanel: {} });
    useUiStore.getState().setLeftPanel("folder");
    api.attach.mockImplementation(async (folder: string) => folder);
    api.listWorkflows.mockResolvedValue({ workflows: [], warnings: [] });
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    api.intakeList.mockResolvedValue({ sessions: [], warnings: [] });
    listen.mockImplementation(async (_event: string, handler: (e: { payload: OpenTaskEvent }) => void) => {
      emit = (payload) => handler({ payload });
      return unlisten;
    });
  });

  afterEach(() => {
    useTabStore.setState({ activeFolderPath: null });
  });

  it("opens the task of the active project in the workflow view", async () => {
    await useWorkflowStore.getState().activate("C:/a");
    const release = await startWorkflowOpenTaskListener();
    expect(listen).toHaveBeenCalledWith(WORKFLOW_OPEN_TASK_EVENT, expect.any(Function));
    api.listTasks.mockClear();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await vi.waitFor(() => expect(useWorkflowStore.getState().selectedTaskId).toBe("t9"));
    expect(useUiStore.getState().leftPanel).toBe("workflow");
    expect(useTabStore.getState().folderLeftPanel["C:/a"]).toBe("workflow");
    // The created task is listed at once.
    expect(api.listTasks).toHaveBeenCalledWith("C:/a");
    release();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("attaches the active folder first when it is not attached yet", async () => {
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await vi.waitFor(() => expect(useWorkflowStore.getState().selectedTaskId).toBe("t9"));
    expect(useWorkflowStore.getState().activeRoot).toBe("C:/a");
    expect(useUiStore.getState().leftPanel).toBe("workflow");
  });

  it("joins an attach in flight instead of attaching again", async () => {
    let resolve!: (root: string) => void;
    api.attach.mockReturnValueOnce(new Promise<string>((r) => (resolve = r)));
    const activation = useWorkflowStore.getState().activate("C:/a");
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await new Promise((r) => setTimeout(r, 10));
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
    resolve("C:/a");
    await activation;
    await vi.waitFor(() => expect(useWorkflowStore.getState().selectedTaskId).toBe("t9"));
    expect(api.attach).toHaveBeenCalledTimes(1);
  });

  it("ignores the task when the folder changes while it attaches", async () => {
    let resolve!: (root: string) => void;
    api.attach.mockReturnValueOnce(new Promise<string>((r) => (resolve = r)));
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await new Promise((r) => setTimeout(r, 10));
    useTabStore.setState({ activeFolderPath: "C:/b" });
    resolve("C:/a");
    await new Promise((r) => setTimeout(r, 10));
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
    expect(useUiStore.getState().leftPanel).toBe("folder");
  });

  it("ignores a task of another project", async () => {
    await useWorkflowStore.getState().activate("C:/a");
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/b", taskId: "t9" });
    await new Promise((r) => setTimeout(r, 10));
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
    expect(useUiStore.getState().leftPanel).toBe("folder");
  });

  it("ignores the event while no folder is open", async () => {
    useTabStore.setState({ activeFolderPath: null });
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.attach).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
  });
});
