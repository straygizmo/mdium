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
const emitTo = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mainWindow = vi.hoisted(() => ({
  unminimize: vi.fn(() => Promise.resolve()),
  setFocus: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/workflow-api", () => ({ workflowApi: api, subscribeWorkflowEvents: vi.fn() }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen, emitTo }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mainWindow }));
// Switching folders loads the folder's opencode config.
vi.mock("@/stores/opencode-config-store", () => ({
  useOpencodeConfigStore: {
    getState: () => ({ loadConfig: vi.fn(async () => {}), loadProjectMcpServers: vi.fn(async () => {}) }),
  },
}));

import {
  WORKFLOW_OPEN_TASK_ACK_EVENT,
  WORKFLOW_OPEN_TASK_EVENT,
  type OpenTaskEvent,
} from "@/shared/types/workflow";
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
  let emit: (payload: Omit<OpenTaskEvent, "sender">) => void;
  const unlisten = vi.fn();
  const SENDER = "intake-i1";
  const acked = (taskId: string, handled: boolean) =>
    expect(emitTo).toHaveBeenCalledWith(SENDER, WORKFLOW_OPEN_TASK_ACK_EVENT, { taskId, handled });
  const waitAck = (taskId: string, handled: boolean) => vi.waitFor(() => acked(taskId, handled));

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState(initialState, true);
    useTabStore.setState({ activeFolderPath: "C:/a", openFolderPaths: ["C:/a"], folderLeftPanel: {} });
    useUiStore.getState().setLeftPanel("folder");
    api.attach.mockImplementation(async (folder: string) => folder);
    api.listWorkflows.mockResolvedValue({ workflows: [], warnings: [] });
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    api.intakeList.mockResolvedValue({ sessions: [], warnings: [] });
    listen.mockImplementation(async (_event: string, handler: (e: { payload: OpenTaskEvent }) => void) => {
      emit = (payload) => handler({ payload: { ...payload, sender: SENDER } });
      return unlisten;
    });
  });

  afterEach(() => {
    useTabStore.setState({ activeFolderPath: null, openFolderPaths: [] });
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
    await waitAck("t9", true);
    expect(mainWindow.unminimize).toHaveBeenCalled();
    expect(mainWindow.setFocus).toHaveBeenCalled();
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
    await waitAck("t9", false);
  });

  it("ignores a task of a project that is not open", async () => {
    await useWorkflowStore.getState().activate("C:/a");
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/b", taskId: "t9" });
    await waitAck("t9", false);
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
    expect(useUiStore.getState().leftPanel).toBe("folder");
    expect(useTabStore.getState().activeFolderPath).toBe("C:/a");
  });

  it("switches to another open folder of the project and opens the task there", async () => {
    // The folder path differs from the normalized root the intake passed.
    api.attach.mockImplementation(async (folder: string) => (folder === "C:/b/" ? "C:/b" : folder));
    useTabStore.setState({ openFolderPaths: ["C:/a", "C:/b/"] });
    await useWorkflowStore.getState().activate("C:/a");
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/b", taskId: "t9" });
    await waitAck("t9", true);
    expect(useTabStore.getState().activeFolderPath).toBe("C:/b/");
    expect(useWorkflowStore.getState().activeRoot).toBe("C:/b");
    expect(useWorkflowStore.getState().selectedTaskId).toBe("t9");
    expect(useUiStore.getState().leftPanel).toBe("workflow");
    expect(useTabStore.getState().folderLeftPanel["C:/b/"]).toBe("workflow");
  });

  it("still opens the task when the main window cannot be focused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mainWindow.unminimize.mockRejectedValueOnce(new Error("not allowed"));
    mainWindow.setFocus.mockRejectedValueOnce(new Error("not allowed"));
    await useWorkflowStore.getState().activate("C:/a");
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await waitAck("t9", true);
    expect(useWorkflowStore.getState().selectedTaskId).toBe("t9");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("ignores the event while no folder is open", async () => {
    useTabStore.setState({ activeFolderPath: null, openFolderPaths: [] });
    await startWorkflowOpenTaskListener();
    emit({ projectRoot: "C:/a", taskId: "t9" });
    await waitAck("t9", false);
    expect(api.attach).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().selectedTaskId).toBeNull();
  });
});
