// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  attach: vi.fn(),
  listWorkflows: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
}));
vi.mock("../lib/workflow-api", () => ({ workflowApi: api, subscribeWorkflowEvents: vi.fn() }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));

import { useTabStore } from "@/stores/tab-store";
import { startWorkflowFolderSync } from "../folder-sync";
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
